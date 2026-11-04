import io
import json
import os
import stat
import tempfile
import unittest
import zipfile
from unittest import mock
from email.message import Message
from concurrent.futures import ThreadPoolExecutor

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import webhook


class GameDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_root, self.old_token = webhook.ROOT, webhook.TOKEN
        webhook.ROOT = self.tempdir.name
        webhook.TOKEN = 'test-token'
        for name in ('tmp', 'releases', 'games'):
            os.makedirs(os.path.join(webhook.ROOT, name))
    def tearDown(self):
        webhook.ROOT, webhook.TOKEN = self.old_root, self.old_token
        self.tempdir.cleanup()

    def request(self, method, path, body=None, headers=None):
        class Harness(webhook.Handler):
            def __init__(self, request_path, request_body, request_headers):
                self.path = request_path
                self.headers = Message()
                self.headers['Authorization'] = request_headers.get('Authorization', '')
                self.headers['Content-Type'] = request_headers.get('Content-Type', '')
                self.headers['Content-Length'] = request_headers.get(
                    'Content-Length', str(len(request_body))
                )
                self.rfile = io.BytesIO(request_body)
                self.wfile = io.BytesIO()
                self.client_address = ('127.0.0.1', 0)
                self.response_status = None
                self.response_headers = {}

            def send_response(self, status, message=None):
                self.response_status = status

            def send_header(self, key, value):
                self.response_headers[key] = value

            def end_headers(self):
                pass

            def log_error(self, fmt, *args):
                print('HARNESS WEBHOOK ERROR:', fmt % args)

            def log_message(self, fmt, *args):
                pass

        request_body = body or b''
        request_headers = headers or {}
        handler = Harness(path, request_body, request_headers)
        if method == 'GET':
            handler.do_GET()
        elif method == 'POST':
            handler.do_POST()
        else:
            raise AssertionError('unsupported test HTTP method')
        payload = handler.wfile.getvalue()
        return (
            handler.response_status,
            handler.response_headers.get('Content-Type'),
            json.loads(payload),
        )

    def archive(self, manifest, extra=None):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            if manifest is not None:
                z.writestr('manifest.json', json.dumps(manifest))
            for name, contents in (extra or {}).items():
                z.writestr(name, contents)
        return buffer.getvalue()

    def vue_manifest(self, game_id='moonlight-courier', version='1.0.0', name='Moonlight Courier'):
        return {
            'manifestVersion': 1, 'id': game_id, 'name': name, 'version': version,
            'pluginType': 'vue3', 'entry': 'index.html',
            'runtime': {
                'apiVersion': '1',
                'display': {'aspectRatio': '16:9', 'orientation': 'landscape', 'resize': 'contain'},
                'capabilities': ['score']
            }
        }

    def wasm_manifest(self, game_id='pixel-snake', version='1.0.0'):
        return {
            'manifestVersion': 1, 'id': game_id, 'name': 'Pixel Snake', 'version': version,
            'pluginType': 'wasm', 'entry': 'game.wasm',
            'runtime': {
                'apiVersion': '1',
                'display': {'width': 320, 'height': 180, 'pixelScale': 'integer'},
                'capabilities': ['input.keyboard'],
                'wasm': {
                    'abi': 'bombless-game-abi', 'abiVersion': 1,
                    'maxMemoryPages': 16, 'maxOutputBytes': 230400, 'renderMode': 'rgba'
                }
            }
        }

    def post(self, path, payload, token='test-token'):
        return self.request('POST', path, payload, {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/zip',
        })

    def publish_vue(self, game_id='moonlight-courier', version='1.0.0'):
        payload = self.archive(self.vue_manifest(game_id, version), {'index.html': '<h1>game</h1>'})
        return self.post('/_deploy/game', payload)


    def test_storage_initialization_creates_public_empty_registry(self):
        path = os.path.join(webhook.ROOT, 'games', 'registry.json')
        self.assertFalse(os.path.exists(path))
        webhook.initialize_storage()
        with open(path, encoding='utf-8') as source:
            self.assertEqual(json.load(source), {'games': [], 'registryVersion': 1})

    def test_health_and_authentication(self):
        self.assertEqual(self.request('GET', '/health')[0], 200)
        payload = self.archive(self.vue_manifest(), {'index.html': 'x'})
        self.assertEqual(self.post('/_deploy/game', payload, token='wrong')[0], 401)

    def test_vue_and_wasm_packages_publish_to_separate_versioned_paths(self):
        status, _ctype, body = self.publish_vue()
        self.assertEqual(status, 200)
        self.assertEqual(body['packageUrl'], '/games/moonlight-courier/1.0.0/')
        wasm = self.archive(self.wasm_manifest(), {'game.wasm': b'not executed by importer'})
        status, _ctype, body = self.post('/_deploy/game', wasm)
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isfile(os.path.join(
            webhook.ROOT, 'games', 'pixel-snake', '1.0.0', 'game.wasm')))

    def test_multiple_games_and_versions_are_preserved_and_semver_selects_latest(self):
        self.assertEqual(self.publish_vue()[0], 200)
        self.assertEqual(self.publish_vue('moonlight-courier', '1.2.0')[0], 200)
        self.assertEqual(self.publish_vue('moonlight-courier', '1.1.0-beta.1')[0], 200)
        self.assertEqual(self.publish_vue('pixel-snake', '2.0.0')[0], 200)
        status, _ctype, registry = self.request('GET', '/_games/registry.json')
        self.assertEqual(status, 200)
        self.assertEqual([g['id'] for g in registry['games']], ['moonlight-courier', 'pixel-snake'])
        game = registry['games'][0]
        self.assertEqual(game['latestVersion'], '1.2.0')
        self.assertEqual([v['version'] for v in game['versions']],
                         ['1.0.0', '1.1.0-beta.1', '1.2.0'])
        for version in ('1.0.0', '1.1.0-beta.1', '1.2.0'):
            self.assertTrue(os.path.isfile(os.path.join(
                webhook.ROOT, 'games', 'moonlight-courier', version, 'index.html')))


    def test_build_metadata_ties_use_lexical_version_order(self):
        self.assertEqual(self.publish_vue('build-tie', '1.0.0+build.a')[0], 200)
        self.assertEqual(self.publish_vue('build-tie', '1.0.0+build.b')[0], 200)
        _status, _ctype, registry = self.request('GET', '/_games/registry.json')
        game = next(g for g in registry['games'] if g['id'] == 'build-tie')
        self.assertEqual(game['latestVersion'], '1.0.0+build.b')

    def test_duplicate_id_version_returns_conflict_without_overwrite(self):
        self.assertEqual(self.publish_vue()[0], 200)
        status, _ctype, body = self.publish_vue()
        self.assertEqual((status, body), (409, {'error': 'version_conflict'}))
        with open(os.path.join(webhook.ROOT, 'games', 'moonlight-courier', '1.0.0', 'index.html')) as f:
            self.assertEqual(f.read(), '<h1>game</h1>')

    def test_game_zip_does_not_require_root_index_but_requires_manifest_entry(self):
        payload = self.archive(self.wasm_manifest(), {'game.wasm': b'wasm'})
        self.assertEqual(self.post('/_deploy/game', payload)[0], 200)
        invalid = self.archive(self.vue_manifest('missing-entry'), {'readme.txt': 'no entry'})
        self.assertEqual(self.post('/_deploy/game', invalid)[0], 400)

    def test_invalid_manifest_and_unsafe_paths_are_rejected(self):
        invalid_id = self.vue_manifest('../escape')
        payload = self.archive(invalid_id, {'index.html': 'x'})
        self.assertEqual(self.post('/_deploy/game', payload)[0], 400)
        invalid_version = self.vue_manifest('bad-version', 'not-semver')
        payload = self.archive(invalid_version, {'index.html': 'x'})
        self.assertEqual(self.post('/_deploy/game', payload)[0], 400)
        traversal = self.archive(self.vue_manifest('traversal'), {
            'index.html': 'x', '../outside.txt': 'blocked'
        })
        self.assertEqual(self.post('/_deploy/game', traversal)[0], 400)

    def test_site_deployment_and_rollback_do_not_touch_game_library(self):
        self.assertEqual(self.publish_vue()[0], 200)
        first = os.path.join(webhook.ROOT, 'releases', 'first')
        second = os.path.join(webhook.ROOT, 'releases', 'second')
        os.mkdir(first)
        os.mkdir(second)
        current = os.path.join(webhook.ROOT, 'current')
        os.symlink(first, current)
        site_zip = io.BytesIO()
        with zipfile.ZipFile(site_zip, 'w') as z:
            z.writestr('index.html', 'new site')
        status, _ctype, _body = self.post('/_deploy', site_zip.getvalue())
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isdir(os.path.join(webhook.ROOT, 'games', 'moonlight-courier', '1.0.0')))
        os.symlink(second, os.path.join(webhook.ROOT, 'rollback-link'))
        os.replace(os.path.join(webhook.ROOT, 'rollback-link'), current)
        self.assertEqual(os.readlink(current), second)
        self.assertTrue(os.path.isfile(os.path.join(webhook.ROOT, 'games', 'registry.json')))

    def test_concurrent_distinct_publications_do_not_lose_registry_entries(self):
        def publish(game_id):
            return self.publish_vue(game_id)[0]
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(publish, ['alpha-game', 'beta-game', 'gamma-game', 'delta-game']))
        self.assertEqual(statuses, [200, 200, 200, 200])
        _status, _ctype, registry = self.request('GET', '/_games/registry.json')
        self.assertEqual({g['id'] for g in registry['games']},
                         {'alpha-game', 'beta-game', 'gamma-game', 'delta-game'})

    def test_concurrent_same_version_has_one_success_and_one_conflict(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(lambda _n: self.publish_vue()[0], range(2)))
        self.assertEqual(sorted(statuses), [200, 409])
        _status, _ctype, registry = self.request('GET', '/_games/registry.json')
        self.assertEqual(len(registry['games']), 1)
        self.assertEqual(len(registry['games'][0]['versions']), 1)


    def test_missing_or_malformed_manifest_and_unsupported_contract_are_rejected(self):
        missing = self.archive(None, {'index.html': 'not a package'})
        self.assertEqual(self.post('/_deploy/game', missing)[0], 400)

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            z.writestr('manifest.json', '{broken json')
            z.writestr('index.html', 'x')
        self.assertEqual(self.post('/_deploy/game', buffer.getvalue())[0], 400)

        unsupported = self.vue_manifest('future-game')
        unsupported['manifestVersion'] = 2
        self.assertEqual(self.post('/_deploy/game', self.archive(unsupported, {'index.html': 'x'}))[0], 400)

        unsupported = self.vue_manifest('future-runtime')
        unsupported['pluginType'] = 'native'
        self.assertEqual(self.post('/_deploy/game', self.archive(unsupported, {'index.html': 'x'}))[0], 400)

    def test_absolute_and_symlink_zip_entries_are_rejected(self):
        absolute = self.archive(self.vue_manifest('absolute-path'), {
            'index.html': 'x', '/outside.txt': 'blocked'
        })
        self.assertEqual(self.post('/_deploy/game', absolute)[0], 400)

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            z.writestr('manifest.json', json.dumps(self.vue_manifest('symlink-game')))
            z.writestr('index.html', 'x')
            info = zipfile.ZipInfo('link')
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, 'index.html')
        self.assertEqual(self.post('/_deploy/game', buffer.getvalue())[0], 400)

    def test_archive_entry_expansion_and_upload_limits_are_enforced(self):
        payload = self.archive(self.vue_manifest('many-files'), {'index.html': 'x', 'extra.txt': 'y'})
        with mock.patch.object(webhook, 'MAX_ARCHIVE_FILES', 2):
            self.assertEqual(self.post('/_deploy/game', payload)[0], 400)

        payload = self.archive(self.vue_manifest('expanded'), {'index.html': 'larger'})
        with mock.patch.object(webhook, 'MAX_UNCOMPRESSED_BYTES', 2):
            self.assertEqual(self.post('/_deploy/game', payload)[0], 400)

        status, _ctype, body = self.request('POST', '/_deploy/game', b'', {
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/zip',
            'Content-Length': str(webhook.MAX_UPLOAD_BYTES + 1)
        })
        self.assertEqual((status, body), (413, {'error': 'invalid_size'}))

    def test_registry_never_references_package_when_registry_commit_fails(self):
        payload = self.archive(self.vue_manifest('orphan-game'), {'index.html': 'x'})
        with mock.patch.object(webhook, '_write_registry', side_effect=OSError('simulated disk failure')):
            status, _ctype, body = self.post('/_deploy/game', payload)
        self.assertEqual((status, body), (500, {'error': 'internal_error'}))
        self.assertTrue(os.path.isfile(os.path.join(
            webhook.ROOT, 'games', 'orphan-game', '1.0.0', 'index.html')))
        _status, _ctype, registry = self.request('GET', '/_games/registry.json')
        self.assertEqual(registry['games'], [])



if __name__ == '__main__':
    unittest.main()
