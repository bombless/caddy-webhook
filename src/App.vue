<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { GamePlayerRuntime, type PlayerState } from './runtime/player'
import { WasmGamePlayer } from '../wasm/runtime/player.js'

interface GameVersion { version: string; manifestUrl: string }
interface RegistryGame {
  id: string
  name: string
  pluginType: 'vue3' | 'wasm'
  latestVersion: string
  manifestUrl: string
  versions: GameVersion[]
}
interface GameRegistry { registryVersion: number; games: RegistryGame[] }

const registry = ref<GameRegistry | null>(null)
const selectedId = ref('')
const frame = ref<HTMLIFrameElement>()
const canvas = ref<HTMLCanvasElement>()
const state = ref<PlayerState | 'loading' | 'ready' | 'running' | 'paused' | 'error'>('loading')
const score = ref(0)
const wasmGrantedCapabilities = ref<string[]>([])
const error = ref('')
const loadingRegistry = ref(true)
let vueRuntime: GamePlayerRuntime | undefined
let wasmRuntime: WasmGamePlayer | undefined
let resize: (() => void) | undefined

const selectedGame = () => registry.value?.games.find(game => game.id === selectedId.value)
const packageUrl = (manifestUrl: string) => new URL('.', new URL(manifestUrl, window.location.href)).href

function disposePlayer() {
  vueRuntime?.dispose()
  vueRuntime = undefined
  wasmRuntime?.dispose()
  wasmRuntime = undefined
}

async function launchSelected() {
  const game = selectedGame()
  if (!game) return
  disposePlayer()
  await nextTick()
  state.value = 'loading'
  error.value = ''
  score.value = 0
  try {
    if (game.pluginType === 'vue3') {
      if (!frame.value) throw new Error('Vue3 player frame is unavailable')
      vueRuntime = new GamePlayerRuntime(frame.value, {
        timeoutMs: 15000,
        onState: value => {
          state.value = value
          if (value === 'ready') vueRuntime?.start()
        },
        onScore: value => { score.value = value },
        onError: value => { error.value = value.message },
      })
      await vueRuntime.load(packageUrl(game.manifestUrl))
    } else if (game.pluginType === 'wasm') {
      if (!canvas.value) throw new Error('WASM canvas is unavailable')
      wasmRuntime = new WasmGamePlayer(canvas.value, {
        grantedCapabilities: wasmGrantedCapabilities.value,
        onError: (value: Error) => { error.value = value.message; state.value = 'error' },
      })
      await wasmRuntime.load(new URL('.', new URL(game.manifestUrl, window.location.href)))
      state.value = 'running'
    } else {
      throw new Error('Unsupported game runtime')
    }
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
    state.value = 'error'
  }
}

function selectGame(id: string) {
  wasmGrantedCapabilities.value = []
  selectedId.value = id
  void launchSelected()
}
function grantWasmControls() {
  wasmGrantedCapabilities.value = ['input.keyboard', 'input.pointer']
  void launchSelected()
}

async function loadRegistry() {
  loadingRegistry.value = true
  try {
    const response = await fetch('/_games/registry.json', { cache: 'no-store', credentials: 'omit' })
    if (!response.ok) throw new Error(`Game registry request failed (${response.status})`)
    const value = await response.json() as GameRegistry
    if (value?.registryVersion !== 1 || !Array.isArray(value.games)) throw new Error('Unsupported or invalid game registry schema')
    const validGames = value.games.filter(game => {
      if (!game || typeof game.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(game.id) ||
          typeof game.name !== 'string' || (game.pluginType !== 'vue3' && game.pluginType !== 'wasm') ||
          typeof game.latestVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(game.latestVersion) ||
          typeof game.manifestUrl !== 'string' || !Array.isArray(game.versions)) return false
      try {
        const latest = new URL(game.manifestUrl, window.location.href)
        if (latest.origin !== window.location.origin || latest.pathname !== `/games/${game.id}/${game.latestVersion}/manifest.json`) return false
        return game.versions.every(version => {
          if (!version || typeof version.version !== 'string' || typeof version.manifestUrl !== 'string') return false
          const url = new URL(version.manifestUrl, window.location.href)
          return url.origin === window.location.origin && url.pathname === `/games/${game.id}/${version.version}/manifest.json`
        })
      } catch { return false }
    })
    registry.value = { registryVersion: 1, games: validGames }
    const requested = new URLSearchParams(location.search).get('game')
    selectedId.value = validGames.some(game => game.id === requested) ? requested! : validGames[0]?.id ?? ''
    if (selectedId.value) await launchSelected()
    else state.value = 'ready'
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
    state.value = 'error'
  } finally { loadingRegistry.value = false }
}

function pause() {
  vueRuntime?.pause()
  wasmRuntime?.pause()
  state.value = 'paused'
}
function resume() {
  vueRuntime?.resume()
  wasmRuntime?.resume()
  state.value = 'running'
}

onMounted(() => {
  void loadRegistry()
  resize = () => { vueRuntime?.resize() }
  window.addEventListener('resize', resize)
})
onBeforeUnmount(() => {
  if (resize) window.removeEventListener('resize', resize)
  disposePlayer()
})
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div><strong>Bombless Arcade</strong><span class="sub">Persistent game library</span></div>
      <div class="stats"><span>Score</span><strong>{{ score }}</strong><span class="state">{{ state }}</span></div>
    </header>
    <nav class="library" aria-label="Game library">
      <span class="library-title">Games</span>
      <span v-if="loadingRegistry" class="sub">Loading library…</span>
      <span v-else-if="!registry?.games.length" class="sub">No games have been published yet.</span>
      <button v-for="game in registry?.games ?? []" :key="game.id" type="button"
        :aria-pressed="selectedId === game.id" :class="{ selected: selectedId === game.id }"
        @click="selectGame(game.id)">{{ game.name }} <small>{{ game.pluginType }} · {{ game.latestVersion }}</small></button>
    </nav>
    <section class="stage">
      <iframe v-if="selectedGame()?.pluginType === 'vue3'" ref="frame" class="game-frame"
        title="Vue 3 game" sandbox="allow-scripts" referrerpolicy="no-referrer" />
      <canvas v-else-if="selectedGame()?.pluginType === 'wasm'" ref="canvas" class="game-canvas"
        aria-label="WASM game" tabindex="0" />
      <div v-if="selectedGame()?.pluginType === 'wasm'" class="permission-row">
        <span v-if="wasmGrantedCapabilities.length">Keyboard and pointer input allowed for this session.</span>
        <span v-else>Keyboard and pointer input are blocked by default.</span>
        <button v-if="!wasmGrantedCapabilities.length" type="button" @click="grantWasmControls">Allow game controls</button>
      </div>
      <div v-if="state === 'error'" class="error" role="alert"><strong>Unable to load game</strong><p>{{ error }}</p></div>
      <div v-else-if="state === 'loading' || loadingRegistry" class="loading">Loading game…</div>
      <div v-else-if="!selectedGame() && !loadingRegistry" class="loading">Publish a game package to populate the library.</div>
    </section>
    <footer>
      <span>Games run in their runtime-specific sandbox.</span>
      <button type="button" @click="pause" :disabled="!selectedGame()">Pause</button>
      <button type="button" @click="resume" :disabled="!selectedGame()">Resume</button>
      <button type="button" @click="loadRegistry">Refresh library</button>
    </footer>
  </main>
</template>
