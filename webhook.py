#!/usr/bin/env python3
import hmac, json, os, secrets, shutil, stat, tempfile, time, zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

ROOT = '/var/lib/static-deploy'
TOKEN = os.environ.get('DEPLOY_TOKEN', '')

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
        self.send_json(200, {'ok': True}) if self.path == '/health' else self.send_json(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path != '/_deploy':
            return self.send_json(404, {'error': 'not_found'})
        if not TOKEN or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            return self.send_json(401, {'error': 'unauthorized'})
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/zip':
            return self.send_json(415, {'error': 'zip_required'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length < 1 or length > 100 * 1024 * 1024:
            return self.send_json(413, {'error': 'invalid_size'})

        upload = None
        stage = None
        try:
            fd, upload = tempfile.mkstemp(dir=ROOT + '/tmp', suffix='.zip')
            with os.fdopen(fd, 'wb') as f:
                left = length
                while left:
                    chunk = self.rfile.read(min(left, 1048576))
                    if not chunk:
                        raise ValueError('incomplete upload')
                    f.write(chunk)
                    left -= len(chunk)

            release = time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(4)
            stage = ROOT + '/releases/.staging-' + release
            os.mkdir(stage, 0o2750)
            total = 0
            files = 0
            has_index = False
            with zipfile.ZipFile(upload) as z:
                if len(z.infolist()) > 10000:
                    raise ValueError('too many files')
                for item in z.infolist():
                    name = item.filename
                    parts = name.rstrip('/').split('/')
                    if not name or name.startswith('/') or '\\' in name or any(x in ('', '.', '..') for x in parts):
                        raise ValueError('unsafe path')
                    mode = (item.external_attr >> 16) & 0xffff
                    if stat.S_ISLNK(mode):
                        raise ValueError('symlink rejected')
                    total += item.file_size
                    if total > 500 * 1024 * 1024:
                        raise ValueError('archive too large')
                    dest = os.path.join(stage, *parts)
                    if item.is_dir():
                        os.makedirs(dest, mode=0o750, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(dest), mode=0o750, exist_ok=True)
                    with z.open(item) as src, open(dest, 'xb') as dst:
                        shutil.copyfileobj(src, dst)
                    os.chmod(dest, 0o640)
                    files += 1
                    if name == 'index.html':
                        has_index = True
            if not has_index:
                raise ValueError('root index.html required')

            for base, dirs, names in os.walk(stage):
                os.chmod(base, 0o2750)
            final = ROOT + '/releases/' + release
            os.rename(stage, final)
            stage = None
            link = ROOT + '/.current-' + release
            os.symlink(final, link)
            os.replace(link, ROOT + '/current')
            return self.send_json(200, {'ok': True, 'release': release, 'files': files})
        except Exception as exc:
            self.log_error('deployment failed: %s', str(exc)[:120])
            return self.send_json(400, {'error': 'invalid_archive_or_deployment_failed'})
        finally:
            if upload and os.path.exists(upload):
                os.unlink(upload)
            if stage and os.path.isdir(stage):
                shutil.rmtree(stage, ignore_errors=True)

    def log_message(self, fmt, *args):
        print(self.client_address[0], fmt % args)

if __name__ == '__main__':
    if not TOKEN:
        raise SystemExit('DEPLOY_TOKEN required')
    Server(('127.0.0.1', 8765), Handler).serve_forever()
