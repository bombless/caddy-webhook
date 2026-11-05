<script setup>
import { ref } from 'vue'
import { useGameRuntime } from '@bombless/game-sdk/vue'

const runtime = useGameRuntime()
const score = ref(0)
const best = ref(0)
const isStarted = ref(false)

// Function exposed for the runtime to call and notify game start
async function startGame() {
  isStarted.value = true
  try {
    const savedBest = await runtime.storage.get('bestScore')
    if (typeof savedBest === 'number' && savedBest > best.value) {
      best.value = savedBest
    }
  } catch {
    // Fail-open if initial storage read is unavailable
  }
}

// Data persistence scheme functions exposed for runtime container
function getSaveData() {
  return {
    score: score.value,
    best: best.value,
  }
}

function loadSaveData(data) {
  if (data && typeof data === 'object') {
    if (typeof data.best === 'number') best.value = data.best
    if (typeof data.score === 'number') score.value = data.score
  }
}

async function collect() {
  score.value += 1
  runtime.game.setScore(score.value)
  if (score.value > best.value) {
    best.value = score.value
    await runtime.storage.set('bestScore', best.value).catch(() => {})
  }
}

defineExpose({
  startGame,
  start: startGame,
  getSaveData,
  saveState: getSaveData,
  loadSaveData,
  restoreState: loadSaveData,
})
</script>

<template>
  <main class="game">
    <div class="orb">✦</div>
    <h1>Moonlight Courier</h1>
    <p>Collect parcels and make the night brighter.</p>
    <p v-if="isStarted" class="status-badge">Game Running</p>
    <div class="scores">
      <span>Score <b>{{ score }}</b></span>
      <span>Best <b>{{ best }}</b></span>
    </div>
    <button @click="collect" :disabled="!isStarted">Collect parcel</button>
  </main>
</template>

<style scoped>
.game { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; color: #f5edff; background: radial-gradient(circle at 50% 25%, #34336b, #101329 65%); box-sizing: border-box; }
.orb { width: 72px; height: 72px; display: grid; place-items: center; border-radius: 50%; background: #f4c96a; color: #46315d; font-size: 38px; box-shadow: 0 0 48px #f4c96a88; }
h1 { margin: 20px 0 4px; font-size: clamp(26px, 5vw, 42px); }
p { color: #c5bfdc; }
.status-badge { display: inline-block; padding: 4px 12px; background: rgba(244, 201, 106, 0.2); border: 1px solid #f4c96a; border-radius: 999px; font-size: 13px; color: #f4c96a; }
.scores { display: flex; gap: 28px; margin: 18px 0 26px; }
.scores span { color: #c5bfdc; }
.scores b { display: block; color: white; font-size: 28px; }
button { padding: 12px 24px; border: 0; border-radius: 10px; color: #282044; background: #f4c96a; font-weight: 700; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
