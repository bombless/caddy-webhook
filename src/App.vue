<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { GamePlayerRuntime, type PlayerState } from './runtime/player'

const frame = ref<HTMLIFrameElement>()
const state = ref<PlayerState>('loading')
const score = ref(0)
const error = ref('')
const gameUrl = new URLSearchParams(location.search).get('game') ?? './games/hello-vue3/'
const runtime = ref<GamePlayerRuntime>()

onMounted(() => {
  if (!frame.value) return
  const player = new GamePlayerRuntime(frame.value, {
    timeoutMs: 15000,
    onState: (value) => { state.value = value },
    onScore: (value) => { score.value = value },
    onError: (value) => { error.value = value.message },
  })
  runtime.value = player
  void player.load(gameUrl)
  const resize = () => player.resize()
  window.addEventListener('resize', resize)
  onBeforeUnmount(() => window.removeEventListener('resize', resize))
})
onBeforeUnmount(() => runtime.value?.dispose())
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div><strong>Bombless Arcade</strong><span class="sub">Vue 3 game runtime</span></div>
      <div class="stats"><span>Score</span><strong>{{ score }}</strong><span class="state">{{ state }}</span></div>
    </header>
    <section class="stage">
      <iframe ref="frame" class="game-frame" title="Game" sandbox="allow-scripts" referrerpolicy="no-referrer" />
      <div v-if="state === 'error'" class="error" role="alert">
        <strong>Unable to load game</strong><p>{{ error }}</p>
      </div>
      <div v-else-if="state === 'loading'" class="loading">Loading game…</div>
    </section>
    <footer><span>Game code runs in a sandboxed iframe.</span><button @click="runtime?.pause()">Pause</button><button @click="runtime?.resume()">Resume</button></footer>
  </main>
</template>
