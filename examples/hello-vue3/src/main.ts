import { createApp } from 'vue'
import Game from './Game.vue'
import { createGameBridge } from '../../../src/sdk/bridge'
import { GAME_RUNTIME_KEY } from '../../../src/sdk/vue'

const bridge = createGameBridge()
const app = createApp(Game)
app.provide(GAME_RUNTIME_KEY, bridge.runtime)
app.mount('#game')
window.addEventListener('pagehide', () => bridge.dispose(), { once: true })
