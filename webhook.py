#!/usr/bin/env python3
"""Authenticated static-site and immutable game-package deployment webhook."""
import binascii
import functools
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import stat
import struct
import tempfile
import threading
import time
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

ROOT = os.environ.get('DEPLOY_ROOT', '/var/lib/static-deploy')
TOKEN = os.environ.get('DEPLOY_TOKEN', '')
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_FILES = 10000
MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024
ID_PATTERN = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
VERSION_PATTERN = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$')
ARCHIVE_READ_ERRORS = (
    binascii.Error, EOFError, NotImplementedError, RuntimeError, struct.error,
    zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error, OverflowError, ValueError,
)
REGISTRY_LOCK = threading.Lock()


class InvalidArchiveError(Exception):
    """The client supplied an archive or package that is invalid."""


class DuplicateVersionError(Exception):
    """An immutable game version has already been published."""


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _version_parts(value):
    match = VERSION_PATTERN.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise InvalidArchiveError('version must be semantic version')
    major, minor, patch, prerelease, build = match.groups()
    if build is not None and any(not part for part in build.split('.')):
        raise InvalidArchiveError('invalid semantic version build metadata')
    pre = None
    if prerelease is not None:
        identifiers = prerelease.split('.')
        if any(not part for part in identifiers):
            raise InvalidArchiveError('invalid semantic version prerelease')
        if any(part.isdigit() and len(part) > 1 and part.startswith('0') for part in identifiers):
            raise InvalidArchiveError('numeric prerelease identifiers cannot have leading zeroes')
        pre = tuple((0, int(part)) if part.isdigit() else (1, part) for part in identifiers)
    return (int(major), int(minor), int(patch), pre)


def _compare_versions(left, right):
    a, b = _version_parts(left), _version_parts(right)
    for index in range(3):
        if a[index] != b[index]:
            return -1 if a[index] < b[index] else 1
    if a[3] == b[3]:
        return (left > right) - (left < right)
    if a[3] is None:
        return 1
    if b[3] is None:
        return -1
    for x, y in zip(a[3], b[3]):
        if x != y:
            return -1 if x < y else 1
    prerelease_length = (len(a[3]) > len(b[3])) - (len(a[3]) < len(b[3]))
    if prerelease_length:
        return prerelease_length
    # SemVer build metadata has equal precedence; use the full version string as a stable tie-breaker.
    return (left > right) - (left < right)


def _safe_relative_path(value):
    if not isinstance(value, str) or not value or len(value) > 240:
        return False
    if value.startswith('/') or '\\' in value or ':' in value or '%' in value or '?' in value or '#' in value:
        return False
    parts = value.split('/')
    return all(part not in ('', '.', '..') for part in parts)


def _validate_manifest(data):
    try:
        manifest = json.loads(data.decode('utf-8'), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise InvalidArchiveError('manifest is not strict UTF-8 JSON') from exc
    if not isinstance(manifest, dict):
        raise InvalidArchiveError('manifest must be an object')
    if set(manifest) - {'manifestVersion', 'id', 'name', 'version', 'pluginType', 'entry', 'runtime'}:
        raise InvalidArchiveError('unknown manifest field')
    if isinstance(manifest.get('manifestVersion'), bool) or manifest.get('manifestVersion') != 1:
        raise InvalidArchiveError('unsupported manifest version')
    game_id = manifest.get('id')
    if not isinstance(game_id, str) or not ID_PATTERN.fullmatch(game_id):
        raise InvalidArchiveError('invalid game id')
    name = manifest.get('name')
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise InvalidArchiveError('invalid game name')
    version = manifest.get('version')
    _version_parts(version)
    plugin_type = manifest.get('pluginType')
    if plugin_type not in ('vue3', 'wasm'):
        raise InvalidArchiveError('unsupported plugin type')
    entry = manifest.get('entry')
    if not _safe_relative_path(entry):
        raise InvalidArchiveError('unsafe package entry')
    runtime = manifest.get('runtime')
    if not isinstance(runtime, dict) or runtime.get('apiVersion') != '1':
        raise InvalidArchiveError('invalid runtime declaration')
    capabilities = runtime.get('capabilities')
    if (not isinstance(capabilities, list) or len(capabilities) > 16 or
            any(not isinstance(x, str) or x not in {'input.keyboard', 'input.pointer', 'audio', 'storage', 'score'} for x in capabilities) or
            len(set(capabilities)) != len(capabilities)):
        raise InvalidArchiveError('invalid runtime capabilities')
    if plugin_type == 'vue3':
        if set(runtime) - {'apiVersion', 'display', 'capabilities'}:
            raise InvalidArchiveError('unknown Vue3 runtime field')
        display = runtime.get('display')
        if not isinstance(display, dict):
            raise InvalidArchiveError('Vue3 runtime display declaration is required')
        if set(display) - {'aspectRatio', 'orientation', 'resize'}:
            raise InvalidArchiveError('unknown Vue3 display field')
        if display.get('orientation', 'any') not in ('landscape', 'portrait', 'any'):
            raise InvalidArchiveError('invalid display orientation')
        if display.get('resize', 'contain') not in ('contain', 'cover'):
            raise InvalidArchiveError('invalid display resize mode')
        ratio = display.get('aspectRatio')
        if ratio is not None and (not isinstance(ratio, str) or
                not re.fullmatch(r'\d+(?:\.\d+)?:\d+(?:\.\d+)?', ratio)):
            raise InvalidArchiveError('invalid display aspect ratio')
        if entry != 'index.html':
            raise InvalidArchiveError('Vue3 package entry must be index.html')
    else:
        if set(runtime) - {'apiVersion', 'display', 'capabilities', 'wasm'}:
            raise InvalidArchiveError('unknown WASM runtime field')
        display = runtime.get('display')
        wasm = runtime.get('wasm')
        if not entry.endswith('.wasm') or not isinstance(display, dict) or not isinstance(wasm, dict):
            raise InvalidArchiveError('invalid WASM runtime declaration')
        if set(display) - {'width', 'height', 'pixelScale', 'orientation'}:
            raise InvalidArchiveError('unknown WASM display field')
        if set(wasm) - {'abi', 'abiVersion', 'maxMemoryPages', 'maxOutputBytes', 'renderMode'}:
            raise InvalidArchiveError('unknown WASM ABI field')
        for dimension in ('width', 'height'):
            value = display.get(dimension)
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1024:
                raise InvalidArchiveError('invalid WASM display dimensions')
        if (wasm.get('abi') != 'bombless-game-abi' or isinstance(wasm.get('abiVersion'), bool) or wasm.get('abiVersion') != 1):
            raise InvalidArchiveError('unsupported WASM ABI')
        pages, output = wasm.get('maxMemoryPages'), wasm.get('maxOutputBytes')
        if isinstance(pages, bool) or not isinstance(pages, int) or not 1 <= pages <= 256:
            raise InvalidArchiveError('invalid WASM memory limit')
        if isinstance(output, bool) or not isinstance(output, int) or not 4 <= output <= 4194304:
            raise InvalidArchiveError('invalid WASM output limit')
        if display.get('pixelScale', 'fit') not in ('integer', 'fit') or display.get('orientation', 'any') not in ('landscape', 'portrait', 'any'):
            raise InvalidArchiveError('invalid WASM display options')
        if wasm.get('renderMode') != 'rgba':
            raise InvalidArchiveError('unsupported WASM render mode')
    return manifest


def _read_registry(path):
    try:
        with open(path, 'r', encoding='utf-8') as source:
            value = json.load(source, object_pairs_hook=_strict_object)
        if (not isinstance(value, dict) or value.get('registryVersion') != 1 or
                not isinstance(value.get('games'), list)):
            raise ValueError('unsupported registry schema')
        return value
    except FileNotFoundError:
        return {'registryVersion': 1, 'games': []}


def _write_registry(path, registry):
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix='.registry-', suffix='.json', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            json.dump(registry, target, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
            target.write('\n')
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary, 0o640)
        os.replace(temporary, path)
        try:
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            logging.warning('directory fsync is unavailable for registry directory')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _validate_archive(archive, require_index=False, require_manifest=False):
    try:
        entries = archive.infolist()
    except ARCHIVE_READ_ERRORS as exc:
        raise InvalidArchiveError('malformed ZIP directory') from exc
    if not entries or len(entries) > MAX_ARCHIVE_FILES:
        raise InvalidArchiveError('invalid archive entry count')
    total = 0
    seen = {}
    validated = []
    for item in entries:
        name = item.filename
        is_dir = item.is_dir()
        path_name = name[:-1] if is_dir else name
        parts = path_name.split('/')
        if (not name or name.startswith('/') or '\\' in name or
                any(part in ('', '.', '..') for part in parts)):
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
            raise InvalidArchiveError('invalid ZIP entry size')
        normalized = '/'.join(parts)
        if normalized in seen:
            raise InvalidArchiveError('duplicate ZIP path')
        for index in range(1, len(parts)):
            if seen.get('/'.join(parts[:index])) is False:
                raise InvalidArchiveError('file used as directory')
        if not is_dir and any(existing.startswith(normalized + '/') for existing in seen):
            raise InvalidArchiveError('directory used as file')
        seen[normalized] = is_dir
        total += item.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise InvalidArchiveError('archive expands beyond limit')
        validated.append((item, parts, is_dir))
    files = { '/'.join(parts) for _item, parts, is_dir in validated if not is_dir }
    if require_index and 'index.html' not in files:
        raise InvalidArchiveError('root index.html is required')
    if require_manifest and 'manifest.json' not in files:
        raise InvalidArchiveError('root manifest.json is required')
    return validated, files


def _extract(validated, destination, archive):
    os.mkdir(destination, 0o2750)
    count = 0
    for item, parts, is_dir in validated:
        target_path = os.path.join(destination, *parts)
        if is_dir:
            os.makedirs(target_path, mode=0o750, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target_path), mode=0o750, exist_ok=True)
        try:
            with archive.open(item) as source, open(target_path, 'xb') as target:
                shutil.copyfileobj(source, target)
        except ARCHIVE_READ_ERRORS as exc:
            raise InvalidArchiveError('corrupt ZIP entry') from exc
        os.chmod(target_path, 0o640)
        count += 1
    for base, _dirs, _files in os.walk(destination):
        os.chmod(base, 0o2750)
    return count


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        return bool(TOKEN) and hmac.compare_digest(
            self.headers.get('Authorization', ''), 'Bearer ' + TOKEN
        )

    def do_GET(self):
        if self.path == '/health':
            return self.send_json(200, {'ok': True})
        if self.path == '/_games/registry.json':
            try:
                registry = _read_registry(os.path.join(ROOT, 'games', 'registry.json'))
                return self.send_json(200, registry)
            except Exception:
                logging.exception('registry read failed')
                return self.send_json(500, {'error': 'registry_unavailable'})
        return self.send_json(404, {'error': 'not_found'})

    def _receive_upload(self):
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/zip':
            self.send_json(415, {'error': 'zip_required'})
            return None
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except (TypeError, ValueError):
            length = 0
        if length < 1 or length > MAX_UPLOAD_BYTES:
            self.send_json(413, {'error': 'invalid_size'})
            return None
        print('WEBHOOK Content-Length:', length, 'peer:', self.client_address)
        fd, upload = tempfile.mkstemp(dir=os.path.join(ROOT, 'tmp'), suffix='.zip')
        try:
            with os.fdopen(fd, 'wb') as target:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise InvalidArchiveError('incomplete upload')
                    target.write(chunk)
            return upload
        except Exception:
            if os.path.exists(upload):
                os.unlink(upload)
            raise

    def do_POST(self):
        if self.path not in ('/_deploy', '/_deploy/game'):
            return self.send_json(404, {'error': 'not_found'})
        if not self._authorized():
            return self.send_json(401, {'error': 'unauthorized'})
        upload = None
        stage = None
        pending_link = None
        try:
            upload = self._receive_upload()
            if upload is None:
                return
            try:
                archive = zipfile.ZipFile(upload)
            except ARCHIVE_READ_ERRORS as exc:
                raise InvalidArchiveError('malformed ZIP archive') from exc
            with archive:
                validated, files = _validate_archive(
                    archive,
                    require_index=self.path == '/_deploy',
                    require_manifest=self.path == '/_deploy/game',
                )
                if self.path == '/_deploy/game':
                    manifest_item = next(item for item, parts, is_dir in validated
                                         if not is_dir and parts == ['manifest.json'])
                    try:
                        with archive.open(manifest_item) as source:
                            manifest_bytes = source.read(1024 * 1024 + 1)
                    except ARCHIVE_READ_ERRORS as exc:
                        raise InvalidArchiveError('cannot read manifest') from exc
                    if len(manifest_bytes) > 1024 * 1024:
                        raise InvalidArchiveError('manifest too large')
                    manifest = _validate_manifest(manifest_bytes)
                    if manifest['entry'] not in files:
                        raise InvalidArchiveError('declared entry is missing')
                    game_root = os.path.join(ROOT, 'games')
                    os.makedirs(game_root, mode=0o2750, exist_ok=True)
                    stage = os.path.join(game_root, '.staging-' + secrets.token_hex(12))
                    count = _extract(validated, stage, archive)
                else:
                    release = time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(4)
                    stage = os.path.join(ROOT, 'releases', '.staging-' + release)
                    count = _extract(validated, stage, archive)

            if self.path == '/_deploy':
                final = os.path.join(ROOT, 'releases', release)
                os.rename(stage, final)
                stage = None
                pending_link = os.path.join(ROOT, '.current-' + release)
                os.symlink(final, pending_link)
                os.replace(pending_link, os.path.join(ROOT, 'current'))
                pending_link = None
                return self.send_json(200, {'ok': True, 'release': release, 'files': count})

            game_id, version = manifest['id'], manifest['version']
            game_root = os.path.join(ROOT, 'games')
            registry_path = os.path.join(game_root, 'registry.json')
            version_root = os.path.join(game_root, game_id)
            final = os.path.join(version_root, version)
            with REGISTRY_LOCK:
                registry = _read_registry(registry_path)
                existing_game = next((g for g in registry['games'] if g.get('id') == game_id), None)
                if existing_game and any(v.get('version') == version for v in existing_game.get('versions', [])):
                    raise DuplicateVersionError('version already published')
                if os.path.lexists(final):
                    raise DuplicateVersionError('version directory already exists')
                os.makedirs(version_root, mode=0o2750, exist_ok=True)
                os.rename(stage, final)
                stage = None
                package_url = f'/games/{game_id}/{version}/'
                manifest_url = package_url + 'manifest.json'
                if existing_game is None:
                    existing_game = {
                        'id': game_id,
                        'name': manifest['name'],
                        'pluginType': manifest['pluginType'],
                        'latestVersion': version,
                        'manifestUrl': manifest_url,
                        'versions': [],
                    }
                    registry['games'].append(existing_game)
                existing_game['versions'].append({'version': version, 'manifestUrl': manifest_url})
                existing_game['versions'].sort(
                    key=functools.cmp_to_key(lambda a, b: _compare_versions(a['version'], b['version']))
                )
                latest = max((v['version'] for v in existing_game['versions']),
                             key=functools.cmp_to_key(_compare_versions))
                latest_manifest_path = os.path.join(game_root, game_id, latest, 'manifest.json')
                with open(latest_manifest_path, 'r', encoding='utf-8') as source:
                    latest_manifest = json.load(source, object_pairs_hook=_strict_object)
                existing_game.update({
                    'name': latest_manifest['name'],
                    'pluginType': latest_manifest['pluginType'],
                    'latestVersion': latest,
                    'manifestUrl': f'/games/{game_id}/{latest}/manifest.json',
                })
                registry['games'].sort(key=lambda item: item['id'])
                _write_registry(registry_path, registry)
            return self.send_json(200, {
                'ok': True, 'id': game_id, 'version': version,
                'packageUrl': package_url, 'registryUrl': '/_games/registry.json',
                'files': count,
            })
        except DuplicateVersionError:
            return self.send_json(409, {'error': 'version_conflict'})
        except InvalidArchiveError as exc:
            self.log_error('invalid archive/package: %s', str(exc)[:120])
            return self.send_json(400, {'error': 'invalid_archive'})
        except Exception:
            logging.exception('deployment error')
            return self.send_json(500, {'error': 'internal_error'})
        finally:
            if upload and os.path.exists(upload):
                try:
                    os.unlink(upload)
                except OSError:
                    logging.exception('failed to remove upload')
            if stage and os.path.isdir(stage):
                shutil.rmtree(stage, ignore_errors=True)
            if pending_link and os.path.islink(pending_link):
                try:
                    os.unlink(pending_link)
                except OSError:
                    logging.exception('failed to remove pending symlink')

    def log_message(self, fmt, *args):
        print(self.client_address[0], fmt % args)


def initialize_storage():
    for directory in ('tmp', 'releases', 'games'):
        os.makedirs(os.path.join(ROOT, directory), mode=0o2750, exist_ok=True)
    registry_path = os.path.join(ROOT, 'games', 'registry.json')
    with REGISTRY_LOCK:
        if not os.path.exists(registry_path):
            _write_registry(registry_path, {'registryVersion': 1, 'games': []})


if __name__ == '__main__':
    if not TOKEN:
        raise SystemExit('DEPLOY_TOKEN required')
    initialize_storage()
    Server(('127.0.0.1', 8765), Handler).serve_forever()
