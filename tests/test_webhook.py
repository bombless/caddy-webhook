import http.client
import json
import os
import stat
import tempfile
import threading
import unittest
import sys
import io
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import webhook


class WebhookHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_root = webhook.ROOT
        self.old_token = webhook.TOKEN
        webhook.ROOT = self.tempdir.name
        webhook.TOKEN = 'unit-test-token'
        os.makedirs(os.path.join(webhook.ROOT, 'tmp'))
        os.makedirs(os.path.join(webhook.ROOT, 'releases'))
        self.server = webhook.Server(('127.0.0.1', 0), webhook.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        webhook.ROOT = self.old_root
        webhook.TOKEN = self.old_token
        self.tempdir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, response.getheader('Content-Type'), json.loads(payload))
        connection.close()
        return result

    def auth_headers(self, **extra):
        return {
            'Authorization': 'Bearer unit-test-token',
            'Content-Type': 'application/zip',
            **extra,
        }

    def test_health_is_json_ok(self):
        status, content_type, body = self.request('GET', '/health')
        self.assertEqual(status, 200)
        self.assertEqual(content_type, 'application/json')
        self.assertEqual(body, {'ok': True})

    def test_unauthorized_request_is_401(self):
        status, _content_type, body = self.request(
            'POST', '/_deploy', body=b'not a zip', headers={'Content-Type': 'application/zip'}
        )
        self.assertEqual((status, body), (401, {'error': 'unauthorized'}))

    def test_invalid_zip_is_400_and_does_not_change_current(self):
        old_release = os.path.join(webhook.ROOT, 'releases', 'old-release')
        os.mkdir(old_release)
        current = os.path.join(webhook.ROOT, 'current')
        os.symlink(old_release, current)
        invalid_archive = b'this is intentionally not a zip\n'
        status, _content_type, body = self.request(
            'POST', '/_deploy', body=invalid_archive,
            headers=self.auth_headers(**{'Content-Length': str(len(invalid_archive))}),
        )
        self.assertEqual((status, body), (400, {'error': 'invalid_archive'}))
        self.assertEqual(os.readlink(current), old_release)
        self.assertEqual(os.listdir(os.path.join(webhook.ROOT, 'releases')), ['old-release'])
        self.assertEqual(os.listdir(os.path.join(webhook.ROOT, 'tmp')), [])

    def make_zip(self, entries):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for name, contents, mode in entries:
                info = zipfile.ZipInfo(name)
                if mode is not None:
                    info.create_system = 3
                    info.external_attr = mode << 16
                archive.writestr(info, contents)
        return buffer.getvalue()

    def post_archive(self, payload):
        return self.request(
            'POST', '/_deploy', body=payload,
            headers=self.auth_headers(**{'Content-Length': str(len(payload))}),
        )

    def test_archive_without_root_index_is_400(self):
        payload = self.make_zip([('readme.txt', b'not a site entry point', None)])
        status, _content_type, body = self.post_archive(payload)
        self.assertEqual((status, body), (400, {'error': 'invalid_archive'}))

    def test_index_directory_does_not_satisfy_root_index_file(self):
        payload = self.make_zip([('index.html', b'', stat.S_IFDIR | 0o755)])
        status, _content_type, body = self.post_archive(payload)
        self.assertEqual((status, body), (400, {'error': 'invalid_archive'}))

    def test_path_traversal_is_400(self):
        payload = self.make_zip([
            ('index.html', b'not deployed', None),
            ('../outside.txt', b'blocked', None),
        ])
        status, _content_type, body = self.post_archive(payload)
        self.assertEqual((status, body), (400, {'error': 'invalid_archive'}))

    def test_symlink_entry_is_400(self):
        payload = self.make_zip([
            ('index.html', b'not deployed', None),
            ('link', b'target', stat.S_IFLNK | 0o777),
        ])
        status, _content_type, body = self.post_archive(payload)
        self.assertEqual((status, body), (400, {'error': 'invalid_archive'}))

    def test_archive_entry_limit_is_400(self):
        payload = self.make_zip([
            ('index.html', b'x', None),
            ('extra.txt', b'y', None),
        ])
        with mock.patch.object(webhook, 'MAX_ARCHIVE_FILES', 1):
            status, _content_type, body = self.post_archive(payload)
        self.assertEqual((status, body), (400, {'error': 'invalid_archive'}))

    def test_expanded_size_limit_is_400(self):
        payload = self.make_zip([('index.html', b'larger than limit', None)])
        with mock.patch.object(webhook, 'MAX_UNCOMPRESSED_BYTES', 2):
            status, _content_type, body = self.post_archive(payload)
        self.assertEqual((status, body), (400, {'error': 'invalid_archive'}))

    def test_internal_storage_error_is_500_without_details(self):
        with mock.patch.object(webhook.tempfile, 'mkstemp', side_effect=PermissionError('/private/path')):
            status, _content_type, body = self.request(
                'POST', '/_deploy', body=b'x', headers=self.auth_headers(**{'Content-Length': '1'}),
            )
        self.assertEqual((status, body), (500, {'error': 'internal_error'}))
        self.assertNotIn('/private/path', json.dumps(body))

    def test_content_type_and_size_errors(self):
        status, _content_type, body = self.request(
            'POST', '/_deploy', body=b'x',
            headers={'Authorization': 'Bearer unit-test-token', 'Content-Type': 'text/plain', 'Content-Length': '1'},
        )
        self.assertEqual((status, body), (415, {'error': 'zip_required'}))
        status, _content_type, body = self.request(
            'POST', '/_deploy', body=b'', headers=self.auth_headers(**{'Content-Length': '0'}),
        )
        self.assertEqual((status, body), (413, {'error': 'invalid_size'}))

    def test_unknown_path_is_404(self):
        status, _content_type, body = self.request('GET', '/missing')
        self.assertEqual((status, body), (404, {'error': 'not_found'}))


if __name__ == '__main__':
    unittest.main()
