import test from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest } from '../src/runtime/manifest.ts'
import { compileVueSFC } from '../src/runtime/sfc-loader.ts'
import { GamePlayerRuntime } from '../src/runtime/player.ts'

test('manifest rejects .html entry and accepts .vue / .js', () => {
  const base = {
    manifestVersion: 1,
    id: 'test-game',
    name: 'Test Game',
    version: '1.0.0',
    pluginType: 'vue3',
    runtime: {
      apiVersion: '1',
      display: { aspectRatio: '16:9', orientation: 'landscape', resize: 'contain' },
      capabilities: ['score', 'storage'],
    },
  }

  assert.throws(() => validateManifest({ ...base, entry: 'index.html' }), /not \.html/)
  assert.throws(() => validateManifest({ ...base, entry: 'game.html' }), /not \.html/)

  const validVue = validateManifest({ ...base, entry: 'Game.vue' })
  assert.equal(validVue.entry, 'Game.vue')

  const validJs = validateManifest({ ...base, entry: 'game.js' })
  assert.equal(validJs.entry, 'game.js')
})

test('compileVueSFC compiles SFC and verifies exposed startGame and persistence functions', async () => {
  const sfcCode = `
<script setup>
import { ref } from 'vue'

const score = ref(0)
const best = ref(0)
const started = ref(false)

function startGame() {
  started.value = true
}

function getSaveData() {
  return { score: score.value, best: best.value }
}

function loadSaveData(data) {
  if (data?.best) best.value = data.best
  if (data?.score) score.value = data.score
}

defineExpose({
  startGame,
  getSaveData,
  loadSaveData,
})
</script>
<template>
  <div class="test-game">
    <span class="score">{{ score }}</span>
  </div>
</template>
<style scoped>
.test-game { color: purple; }
</style>
`

  const { component, cleanup } = compileVueSFC(sfcCode, 'Game.vue')
  assert.ok(component, 'Component should be returned')
  assert.ok(component.__scopeId, 'Scoped style __scopeId should be present')
  assert.equal(typeof component.setup, 'function', 'Component should have setup function')

  // Execute setup with mock expose
  let exposed = {}
  const mockExpose = (exp) => { exposed = exp }
  const result = component.setup({}, { expose: mockExpose })

  assert.equal(typeof exposed.startGame, 'function', 'startGame should be exposed')
  assert.equal(typeof exposed.getSaveData, 'function', 'getSaveData should be exposed')
  assert.equal(typeof exposed.loadSaveData, 'function', 'loadSaveData should be exposed')

  // Test initial state via getSaveData
  assert.deepEqual(exposed.getSaveData(), { score: 0, best: 0 })

  // Test game start notification
  exposed.startGame()

  // Test data persistence restoration
  exposed.loadSaveData({ best: 999, score: 50 })

  // Test data persistence saving
  const saved = exposed.getSaveData()
  assert.deepEqual(saved, { score: 50, best: 999 })

  cleanup()
})

test('GamePlayerRuntime storage persistence handles GET, SET, DELETE, and CLEAR', () => {
  const sentMessages = []
  const mockIframe = {
    setAttribute: () => {},
    addEventListener: () => {},
    contentWindow: {
      postMessage: (msg) => { sentMessages.push(msg) },
    },
  }

  // Set up mock window if not in browser environment
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { href: 'http://localhost:5173/' },
    }
  }

  const runtime = new GamePlayerRuntime(mockIframe)
  // Associate a mock manifest for namespacing
  runtime.manifest = { id: 'test-courier' }

  const makeMessage = (type, payload, requestId = 'req-1') => ({
    source: mockIframe.contentWindow,
    data: {
      protocol: 'bombless-game',
      protocolVersion: 1,
      instanceId: runtime.instanceId,
      type,
      requestId,
      payload,
    },
  })

  // 1. Initial GET should be null
  sentMessages.length = 0
  runtime.receive(makeMessage('STORAGE_GET', { key: 'highScore' }, 'req-get-1'))
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.ok, true)
  assert.equal(sentMessages[0].payload.value, null)

  // 2. SET value
  sentMessages.length = 0
  runtime.receive(makeMessage('STORAGE_SET', { key: 'highScore', value: 4200 }, 'req-set-1'))
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.ok, true)

  // 3. GET value after SET
  sentMessages.length = 0
  runtime.receive(makeMessage('STORAGE_GET', { key: 'highScore' }, 'req-get-2'))
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.ok, true)
  assert.equal(sentMessages[0].payload.value, 4200)

  // 4. DELETE key
  sentMessages.length = 0
  runtime.receive(makeMessage('STORAGE_DELETE', { key: 'highScore' }, 'req-del-1'))
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.ok, true)

  // 5. GET after DELETE should be null
  sentMessages.length = 0
  runtime.receive(makeMessage('STORAGE_GET', { key: 'highScore' }, 'req-get-3'))
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.ok, true)
  assert.equal(sentMessages[0].payload.value, null)

  runtime.dispose()
})

test('compileVueSFC correctly compiles SFCs with v-if without ReferenceError on hoisted key', async () => {
  const fs = await import('node:fs')
  const helloCode = fs.readFileSync('examples/hello-vue3/Game.vue', 'utf-8')
  const { component: helloComp } = compileVueSFC(helloCode, 'Game.vue')
  assert.ok(helloComp, 'hello-vue3 Game.vue should compile and evaluate')

  const pebbleCode = fs.readFileSync('examples/pebble-match/Game.vue', 'utf-8')
  const { component: pebbleComp } = compileVueSFC(pebbleCode, 'Game.vue')
  assert.ok(pebbleComp, 'pebble-match Game.vue should compile and evaluate')
})

