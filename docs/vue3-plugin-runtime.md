# Vue 3 game component runtime (API v1)

Vue 3 game packages are loaded in a sandboxed iframe. The iframe document is the package entry, but the entry must mount the shared Vue runtime shell and pass the game component to it. The platform does not treat the package HTML as the game UI itself.

## Package layout

- `index.html`: minimal iframe document with a single mount point (`#game`).
- `src/main.ts`: creates the SDK bridge and mounts `RuntimeShell`, passing the game component.
- `src/Game.vue`: the game component. It owns game UI and game-specific state only.
- `src/runtime/RuntimeShell.vue`: shared Vue container; validates the component lifecycle contract and forwards host lifecycle messages.
- `src/sdk/vue.ts`: typed runtime API and `useGameRuntime()`.
- `src/sdk/bridge.ts`: iframe-side protocol bridge.

Example entry:

```ts
import { createApp } from 'vue'
import Game from './Game.vue'
import RuntimeShell from '../../../src/runtime/RuntimeShell.vue'
import { createGameBridge } from '../../../src/sdk/bridge'
import { GAME_RUNTIME_KEY } from '../../../src/sdk/vue'

const bridge = createGameBridge()
const app = createApp(RuntimeShell, { gameComponent: Game, bridge })
app.provide(GAME_RUNTIME_KEY, bridge.runtime)
app.mount('#game')
window.addEventListener('pagehide', () => bridge.dispose(), { once: true })
```

## Required game component contract

Every Vue game component must expose these four methods with `defineExpose`. The shell checks that all four exist before it reports `GAME_READY`.

- `onGameStart(): void | Promise<void>`
- `onGamePause(): void | Promise<void>`
- `onGameResume(): void | Promise<void>`
- `onGameEnd(result?: unknown): void | Promise<void>`

Example:

```vue
<script setup lang="ts">
function onGameStart() { /* initialize or continue the round */ }
function onGamePause() { /* stop timers and animation */ }
function onGameResume() { /* resume timers and animation */ }
function onGameEnd(result?: unknown) { /* persist final state and show results */ }

defineExpose({ onGameStart, onGamePause, onGameResume, onGameEnd })
</script>
```

The host sends `HOST_START`, `HOST_PAUSE`, `HOST_RESUME`, and `HOST_END`. The shell calls the matching exposed component method. A game should not start its main loop before `onGameStart` is called. The host runtime exposes `start()`, `pause()`, `resume()`, and `end(result?)`; the platform shell starts the game after the component reports ready.

## Runtime SDK

A game imports `useGameRuntime()` and receives:

- `assets.url(relativePath)`
- `audio.play(soundId, options?)`
- `storage.get(key)` / `storage.set(key, value)`
- `game.setScore(score)`, `game.pause()`, `game.resume()`, `game.end(result?)`
- `input.subscribe(listener)` for normalized keyboard/pointer events
- `viewport.subscribe(listener)` for resize notifications

Storage is host-mediated, scoped to the manifest game ID, and persists across iframe reloads and game versions on the same platform origin. Keys are limited to 64 safe characters, each serialized value to 8 KiB, and each game's namespace to 64 KiB. The `storage` manifest capability must be declared and granted. The host validates requests and never exposes `localStorage` directly to game code. Storage errors reject the SDK promise; games should handle unavailable/quota-exceeded storage gracefully.

Capabilities are requests, not grants. The host applies an allowlist. Audio remains unavailable until a host audio provider is implemented. No raw storage object or arbitrary host function is exposed to game code.

## Run and build

Use Node.js 22 and npm:

```sh
npm install
npm test
npm run dev
npm run build
```

The build emits the platform shell to `dist/` and the example game package to `dist/games/hello-vue3/`. The deployed ZIP must include the entire `dist/` directory at its root.

## Security notes

The default iframe sandbox is `allow-scripts` only, producing an opaque origin. The bridge uses `*` only for that opaque-origin mode and validates `event.source`, protocol version, instance ID, message shape, and message-size bounds. For production, configure a dedicated game origin via player options; it must differ from the host origin. Do not add `allow-same-origin` for a same-origin game.

This is not a security certification. Treat game code as untrusted, validate every message, keep storage quota-limited and namespaced, and test the actual Caddy origin/CORS arrangement before enabling third-party packages.
