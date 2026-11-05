<script setup lang="ts">
import { ref } from 'vue'
import { useGameRuntime } from '../../../src/sdk/vue'

const runtime = useGameRuntime()
const score = ref(0)
const best = ref(0)
const started = ref(false)
const paused = ref(false)
const ended = ref(false)
void runtime.storage.get('bestScore').then((value) => { if (typeof value === 'number') best.value = value }).catch(() => {})

function onGameStart() {
  started.value = true
  paused.value = false
  ended.value = false
}
function onGamePause() { paused.value = true }
function onGameResume() { paused.value = false; started.value = true }
function onGameEnd() { ended.value = true; paused.value = false }

async function collect() {
  if (!started.value || paused.value || ended.value) return
  score.value += 1
  runtime.game.setScore(score.value)
  if (score.value > best.value) {
    best.value = score.value
    await runtime.storage.set('bestScore', best.value).catch(() => {})
  }
}
defineExpose({ onGameStart, onGamePause, onGameResume, onGameEnd })
</script>

<template>
  <main class="game">
    <div class="orb">✦</div>
    <h1>Moonlight Courier</h1>
    <p v-if="!started">Waiting for the host to start the game…</p>
    <p v-else-if="paused">Game paused</p>
    <p v-else-if="ended">Game ended</p>
    <p v-else>Collect parcels and make the night brighter.</p>
    <div class="scores"><span>Score <b>{{ score }}</b></span><span>Best <b>{{ best }}</b></span></div>
    <button :disabled="!started || paused || ended" @click="collect">Collect parcel</button>
  </main>
</template>

<style scoped>
.game { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; color: #f5edff; background: radial-gradient(circle at 50% 25%, #34336b, #101329 65%); }
.orb { width: 72px; height: 72px; display: grid; place-items: center; border-radius: 50%; background: #f4c96a; color: #46315d; font-size: 38px; box-shadow: 0 0 48px #f4c96a88; }
h1 { margin: 20px 0 4px; font-size: clamp(26px, 5vw, 42px) } p { color: #c5bfdc }
.scores { display: flex; gap: 28px; margin: 18px 0 26px } .scores span { color: #c5bfdc } .scores b { display: block; color: white; font-size: 28px }
button { padding: 12px 24px; border: 0; border-radius: 10px; color: #282044; background: #f4c96a; font-weight: 700; cursor: pointer }
button:disabled { opacity: .45; cursor: not-allowed }
</style>
