<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type Component } from 'vue'

type Bridge = ReturnType<typeof import('./sdk/bridge').createGameBridge>
const props = defineProps<{ gameComponent: Component; bridge: Bridge }>()
const gameRef = ref<Record<string, unknown> | null>(null)
const unsubscribe: Array<() => void> = []

function invoke(method: string, payload?: unknown) {
  const fn = gameRef.value?.[method]
  if (typeof fn === 'function') return (fn as (value?: unknown) => unknown)(payload)
}

onMounted(() => {
  const required = ['onGameStart', 'onGamePause', 'onGameResume', 'onGameEnd']
  const missing = required.filter(name => typeof gameRef.value?.[name] !== 'function')
  if (missing.length) {
    props.bridge.fail('Game component must expose: ' + required.join(', ') + '. Missing: ' + missing.join(', '))
    return
  }
  unsubscribe.push(
    props.bridge.on('LIFECYCLE_START', () => { void invoke('onGameStart') }),
    props.bridge.on('LIFECYCLE_PAUSE', () => { void invoke('onGamePause') }),
    props.bridge.on('LIFECYCLE_RESUME', () => { void invoke('onGameResume') }),
    props.bridge.on('LIFECYCLE_END', payload => { void invoke('onGameEnd', payload?.result) }),
  )
  props.bridge.ready()
})

onBeforeUnmount(() => {
  for (const off of unsubscribe) off()
  props.bridge.dispose()
})
</script>

<template>
  <div id="game-root" class="game-root">
    <component :is="gameComponent" ref="gameRef" />
  </div>
</template>

<style>
html, body, #game { width: 100%; min-width: 0; min-height: 100%; margin: 0; }
.game-root { width: 100%; min-height: 100vh; overflow: auto; }
</style>
