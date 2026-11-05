import json
import unittest

import webhook


def valid_manifest():
    return {
        'manifestVersion': 1,
        'id': 'snake-arcade',
        'name': 'Snake Arcade',
        'version': '1.0.1',
        'pluginType': 'wasm',
        'entry': 'game.wasm',
        'runtime': {
            'apiVersion': '1',
            'display': {'width': 160, 'height': 120, 'pixelScale': 'fit'},
            'capabilities': ['input.keyboard'],
            'wasm': {
                'abi': 'bombless-game-abi',
                'abiVersion': 1,
                'maxMemoryPages': 16,
                'maxOutputBytes': 307200,
                'renderMode': 'rgba',
            },
        },
    }


class GameHelpManifestTests(unittest.TestCase):
    def validate(self, manifest):
        return webhook._validate_manifest(json.dumps(manifest).encode('utf-8'))

    def test_legacy_wasm_manifest_without_help_remains_valid(self):
        manifest = valid_manifest()
        self.assertNotIn('help', self.validate(manifest))

    def test_accepts_versioned_bounded_help_metadata(self):
        manifest = valid_manifest()
        manifest['help'] = {
            'schemaVersion': 1,
            'locale': 'en',
            'description': 'Collect food and avoid collisions.',
            'objective': 'Get the highest score.',
            'controls': [
                {'action': 'move_up', 'label': 'Move up', 'inputs': ['ArrowUp', 'KeyW']},
                {'action': 'pause', 'label': 'Pause', 'inputs': ['KeyP']},
            ],
            'instructions': ['Eat food to grow.', 'Avoid walls and your body.'],
            'tips': ['Plan ahead.'],
        }
        self.assertEqual(self.validate(manifest)['help'], manifest['help'])

    def test_rejects_invalid_help_contracts(self):
        mutations = (
            lambda help_data: help_data.update(schemaVersion=2),
            lambda help_data: help_data.update(unknown=True),
            lambda help_data: help_data.update(locale='../en'),
            lambda help_data: help_data.update(instructions=['']),
            lambda help_data: help_data.update(controls=[{'action': 'move', 'label': 'Move', 'inputs': []}]),
            lambda help_data: help_data.update(controls=[
                {'action': 'move', 'label': 'Move', 'inputs': ['KeyW']},
                {'action': 'move', 'label': 'Move again', 'inputs': ['ArrowUp']},
            ]),
            lambda help_data: help_data.update(tips=['x' * 241]),
        )
        for mutate in mutations:
            manifest = valid_manifest()
            manifest['help'] = {'schemaVersion': 1}
            mutate(manifest['help'])
            with self.subTest(help_data=manifest['help']):
                with self.assertRaises(webhook.InvalidArchiveError):
                    self.validate(manifest)

    def test_rejects_help_on_vue3_packages(self):
        manifest = valid_manifest()
        manifest['pluginType'] = 'vue3'
        manifest['entry'] = 'index.html'
        manifest['runtime'] = {
            'apiVersion': '1',
            'display': {},
            'capabilities': [],
        }
        manifest['help'] = {'schemaVersion': 1}
        with self.assertRaises(webhook.InvalidArchiveError):
            self.validate(manifest)


if __name__ == '__main__':
    unittest.main()
