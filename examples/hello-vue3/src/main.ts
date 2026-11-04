import { createApp } from 'vue'
import Game from './Game.vue'
import '../../../src/style.css'
import { createGameBridge } from '../../../src/sdk/bridge'

const bridge = createGameBridge()
const app = createApp(Game)
app.provide(Symbol.for('unused'), null)
app.mixin({ beforeCreate() { /* bridge is initialized before game components mount */ } })
app.mount('#game')
window.addEventListener('pagehide', () => bridge.dispose(), { once: true })
