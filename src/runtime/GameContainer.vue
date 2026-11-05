<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef } from 'vue'
import { createGameBridge } from '../sdk/bridge'
import { provideGameRuntime } from '../sdk/vue'
import { loadGameComponent, type CleanUpFn } from './sfc-loader'

const bridge = createGameBridge()
provideGameRuntime(bridge.runtime)

const gameComponent = shallowRef<any>(null)
const gameRef = ref<any>(null)
const loading = ref(true)
const error = ref('')
let cleanupStyles: CleanUpFn | null = null

async function initGame(payload: Record<string, unknown>) {
  loading.value = true
  error.value = ''
  try {
    const entry = String(payload.entry ?? 'Game.vue')
    const packageUrl = String(payload.packageUrl ?? '')
    const resolvedUrl = new URL(entry, packageUrl).href

    if (cleanupStyles) {
      cleanupStyles()
      cleanupStyles = null
    }

    const { component, cleanup } = await loadGameComponent(resolvedUrl, bridge.runtime)
    cleanupStyles = cleanup
    gameComponent.value = component
    await nextTick()

    // 1. Data persistence: restore saved state if component exposes hook
    const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : []
    if (capabilities.includes('storage')) {
      try {
        const savedData = await bridge.runtime.storage.get('__game_save__')
        if (savedData !== null && savedData !== undefined) {
          if (typeof gameRef.value?.loadSaveData === 'function') {
            await gameRef.value.loadSaveData(savedData)
          } else if (typeof gameRef.value?.restoreState === 'function') {
            await gameRef.value.restoreState(savedData)
          }
        }
      } catch (err) {
        console.warn('Failed to restore persisted game state:', err)
      }
    }

    // 2. Lifecycle: notify the game component that the game starts
    if (typeof gameRef.value?.startGame === 'function') {
      await gameRef.value.startGame({ runtime: bridge.runtime })
    } else if (typeof gameRef.value?.start === 'function') {
      await gameRef.value.start({ runtime: bridge.runtime })
    } else if (typeof gameRef.value?.onGameStart === 'function') {
      await gameRef.value.onGameStart({ runtime: bridge.runtime })
    }

    loading.value = false
    bridge.emitReady()
  } catch (err) {
    loading.value = false
    error.value = err instanceof Error ? err.message : String(err)
    console.error('Failed to load or start game component:', err)
  }
}

async function saveComponentState() {
  try {
    if (typeof gameRef.value?.getSaveData === 'function') {
      const data = await gameRef.value.getSaveData()
      if (data !== undefined) {
        await bridge.runtime.storage.set('__game_save__', data)
      }
    } else if (typeof gameRef.value?.saveState === 'function') {
      const data = await gameRef.value.saveState()
      if (data !== undefined) {
        await bridge.runtime.storage.set('__game_save__', data)
      }
    }
  } catch (err) {
    console.warn('Failed to save game state:', err)
  }
}

bridge.on('HOST_INIT', (payload: any) => {
  void initGame(payload)
})

bridge.on('LIFECYCLE_PAUSE', () => {
  void saveComponentState()
  if (typeof gameRef.value?.pauseGame === 'function') {
    gameRef.value.pauseGame()
  } else if (typeof gameRef.value?.pause === 'function') {
    gameRef.value.pause()
  }
})

bridge.on('LIFECYCLE_RESUME', () => {
  if (typeof gameRef.value?.resumeGame === 'function') {
    gameRef.value.resumeGame()
  } else if (typeof gameRef.value?.resume === 'function') {
    gameRef.value.resume()
  }
})

bridge.on('LIFECYCLE_DISPOSE', () => {
  void saveComponentState()
  if (typeof gameRef.value?.stopGame === 'function') {
    gameRef.value.stopGame()
  } else if (typeof gameRef.value?.dispose === 'function') {
    gameRef.value.dispose()
  }
  if (cleanupStyles) {
    cleanupStyles()
    cleanupStyles = null
  }
})

onBeforeUnmount(() => {
  void saveComponentState()
  if (cleanupStyles) {
    cleanupStyles()
    cleanupStyles = null
  }
  bridge.dispose()
})
</script>

<template>
  <div class="runtime-container">
    <div v-if="error" class="container-error">
      <p>Container error: {{ error }}</p>
    </div>
    <component
      :is="gameComponent"
      v-else-if="gameComponent"
      ref="gameRef"
      :runtime="bridge.runtime"
    />
  </div>
</template>

<style scoped>
.runtime-container {
  width: 100%;
  height: 100%;
  min-height: 100vh;
  box-sizing: border-box;
}
.container-error {
  padding: 16px;
  color: #ff6b6b;
  background: rgba(255, 0, 0, 0.1);
  border-radius: 8px;
  font-family: sans-serif;
}
</style>
