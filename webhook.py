#!/usr/bin/env python3
import binascii
import hmac
import json
import logging
import os
import secrets
import shutil
import stat
import struct
import tempfile
import time
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

ROOT = '/var/lib/static-deploy'
TOKEN = os.environ.get('DEPLOY_TOKEN', '')
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_FILES = 10000
MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024
ARCHIVE_READ_ERRORS = (
    binascii.Error,
    EOFError,
    NotImplementedError,
    RuntimeError,
    struct.error,
    zipfile.BadZipFile,
    zipfile.LargeZipFile,
    zlib.error,
    OverflowError,
    ValueError,
)


class InvalidArchiveError(Exception):
    """The client supplied a ZIP archive that cannot be safely deployed."""


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, value):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self.send_json(200, {'ok': True})
        return self.send_json(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path != '/_deploy':
            return self.send_json(404, {'error': 'not_found'})
        if not TOKEN or not hmac.compare_digest(
            self.headers.get('Authorization', ''), 'Bearer ' + TOKEN
        ):
            return self.send_json(401, {'error': 'unauthorized'})
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/zip':
            return self.send_json(415, {'error': 'zip_required'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except (TypeError, ValueError):
            length = 0
        if length < 1 or length > MAX_UPLOAD_BYTES:
            return self.send_json(413, {'error': 'invalid_size'})

        upload = None
        stage = None
        pending_link = None
        try:
            try:
                fd, upload = tempfile.mkstemp(dir=ROOT + '/tmp', suffix='.zip')
                with os.fdopen(fd, 'wb') as target:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            raise InvalidArchiveError('incomplete upload')
                        target.write(chunk)
                        remaining -= len(chunk)
            except InvalidArchiveError:
                raise

            try:
                archive = zipfile.ZipFile(upload)
            except ARCHIVE_READ_ERRORS as exc:
                raise InvalidArchiveError('malformed or unsupported ZIP archive') from exc

            with archive:
                try:
                    entries = archive.infolist()
                except ARCHIVE_READ_ERRORS as exc:
                    raise InvalidArchiveError('malformed ZIP directory') from exc

                if len(entries) > MAX_ARCHIVE_FILES:
                    raise InvalidArchiveError('too many archive entries')

                total = 0
                has_index = False
                seen_paths = {}
                validated = []
                for item in entries:
                    name = item.filename
                    is_dir = item.is_dir()
                    path_name = name[:-1] if is_dir else name
                    parts = path_name.split('/')
                    if (
                        not name
                        or name.startswith('/')
                        or '\\' in name
                        or any(part in ('', '.', '..') for part in parts)
                    ):
                        raise InvalidArchiveError('unsafe archive path')

                    mode = (item.external_attr >> 16) & 0xffff
                    file_type = stat.S_IFMT(mode)
                    if stat.S_ISLNK(mode):
                        raise InvalidArchiveError('symbolic links are not allowed')
                    if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                        raise InvalidArchiveError('special files are not allowed')
                    if stat.S_ISDIR(mode):
                        is_dir = True
                    if item.file_size < 0 or item.compress_size < 0:
                        raise InvalidArchiveError('invalid archive entry size')

                    normalized = '/'.join(parts)
                    if normalized in seen_paths:
                        raise InvalidArchiveError('duplicate archive path')
                    for index in range(1, len(parts)):
                        parent = '/'.join(parts[:index])
                        if seen_paths.get(parent) is False:
                            raise InvalidArchiveError('file used as a directory')
                    if not is_dir and any(
                        existing.startswith(normalized + '/') for existing in seen_paths
                    ):
                        raise InvalidArchiveError('directory used as a file')
                    seen_paths[normalized] = is_dir

                    total += item.file_size
                    if total > MAX_UNCOMPRESSED_BYTES:
                        raise InvalidArchiveError('archive expands beyond size limit')
                    if name == 'index.html' and not is_dir:
                        has_index = True
                    validated.append((item, parts, is_dir))

                if not has_index:
                    raise InvalidArchiveError('root index.html is required')

                release = time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(4)
                stage = ROOT + '/releases/.staging-' + release
                os.mkdir(stage, 0o2750)
                files = 0
                for item, parts, is_dir in validated:
                    destination = os.path.join(stage, *parts)
                    if is_dir:
                        os.makedirs(destination, mode=0o750, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(destination), mode=0o750, exist_ok=True)
                    try:
                        with archive.open(item) as source, open(destination, 'xb') as target:
                            shutil.copyfileobj(source, target)
                    except ARCHIVE_READ_ERRORS as exc:
                        raise InvalidArchiveError('corrupt or unsupported ZIP entry') from exc
                    os.chmod(destination, 0o640)
                    files += 1

            for base, _dirs, _names in os.walk(stage):
                os.chmod(base, 0o2750)

            final = ROOT + '/releases/' + release
            os.rename(stage, final)
            stage = None
            pending_link = ROOT + '/.current-' + release
            os.symlink(final, pending_link)
            os.replace(pending_link, ROOT + '/current')
            pending_link = None
            return self.send_json(200, {'ok': True, 'release': release, 'files': files})

        except InvalidArchiveError as exc:
            self.log_error('invalid archive: %s', str(exc)[:120])
            return self.send_json(400, {'error': 'invalid_archive'})
        except Exception:
            logging.exception('internal deployment error')
            return self.send_json(500, {'error': 'internal_error'})
        finally:
            if upload and os.path.exists(upload):
                try:
                    os.unlink(upload)
                except OSError:
                    logging.exception('failed to remove temporary upload')
            if stage and os.path.isdir(stage):
                shutil.rmtree(stage, ignore_errors=True)
            if pending_link and os.path.islink(pending_link):
                try:
                    os.unlink(pending_link)
                except OSError:
                    logging.exception('failed to remove temporary current symlink')

    def log_message(self, fmt, *args):
        print(self.client_address[0], fmt % args)


if __name__ == '__main__':
    if not TOKEN:
        raise SystemExit('DEPLOY_TOKEN required')
    Server(('127.0.0.1', 8765), Handler).serve_forever()
