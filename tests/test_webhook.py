import http.client
import json
import os
import tempfile
import threading
import unittest
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import webhook


class WebhookHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_root, self.old_token = webhook.ROOT, webhook.TOKEN
        webhook.ROOT, webhook.TOKEN = self.tempdir.name, 'unit-test-token'
        os.makedirs(os.path.join(webhook.ROOT, 'tmp'))
        self.server = webhook.Server(('127.0.0.1', 0), webhook.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        webhook.ROOT, webhook.TOKEN = self.old_root, self.old_token
        self.tempdir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse(); payload = response.read()
        result = (response.status, response.getheader('Content-Type'), json.loads(payload))
        connection.close(); return result

    def test_health_is_json_ok(self):
        status, content_type, body = self.request('GET', '/health')
        self.assertEqual((status, content_type, body), (200, 'application/json', {'ok': True}))

    def test_legacy_whole_site_endpoint_is_closed(self):
        status, _content_type, body = self.request('POST', '/_deploy', body=b'ignored')
        self.assertEqual((status, body), (404, {'error': 'not_found'}))

    def test_unknown_path_is_404(self):
        status, _content_type, body = self.request('GET', '/missing')
        self.assertEqual((status, body), (404, {'error': 'not_found'}))


if __name__ == '__main__':
    unittest.main()
