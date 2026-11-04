# Vue 3 Game Plugin — Design

**Status:** Proposal / design baseline  
**Audience:** Game-generation bots, runtime implementers, and maintainers  
**Target:** A static game package that can be hosted under `/app/` without the game knowing its public URL.

## 1. Goals

A Vue 3 plugin is the high-level, UI-rich game format. It is intended for games where the generated implementation benefits from DOM layout, CSS, text, menus, forms, animation, or existing Vue libraries.

The plugin contract should:

- Let a bot implement a Vue 3 game view without owning the site shell.
- Keep deployment paths and public origins out of game source.
- Provide a small, versioned runtime API for input, audio, persistence, scoring, and lifecycle.
- Keep the platform shell independent from the game's internal component structure.
- Produce ordinary static build output that the existing ZIP → Caddy webhook deployment can serve.

## 2. Non-goals

- A Vue component is not a security sandbox.
- The runtime does not promise that arbitrary third-party JavaScript is safe.
- The first version does not require server-side APIs, accounts, leaderboards, or multiplayer.
- The plugin is not required to use a particular state-management library.

## 3. Recommended execution model

### Preferred trust model

Run the game application inside a sandboxed iframe. The platform owns the outer player UI; the game owns only its iframe document. A Web Component may be used as the platform-facing custom element (for example, `<game-player>`), and Shadow DOM may encapsulate the platform UI and styles, but neither Web Components nor Shadow DOM are security boundaries.

For meaningful isolation, serve untrusted game documents from a distinct origin from the host application. A separate origin such as `games.example.net` is preferable. Do not assume that a same-origin iframe with `allow-scripts allow-same-origin` is safely sandboxed: that combination can undermine the sandbox boundary. A sandboxed opaque-origin iframe also has practical implications for module scripts, CORS, storage, and asset loading; validate the chosen deployment arrangement before shipping it.

Suggested initial iframe policy (adjust only after threat-model review):

```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  title="Game"
/>
```

Do not add `allow-same-origin`, `allow-top-navigation`, `allow-popups`, downloads, or forms by default. If the runtime cannot provide the required Vue module loading and asset behavior under this policy, solve that at the hosting/origin layer rather than silently weakening the sandbox.

For trusted, first-party bot output, direct component mounting can be offered as a development mode, but it must be documented as trusted code with the same page privileges as the host.

## 4. Plugin package format

A built Vue plugin is a self-contained static directory:

```text
moonlight-courier/
├── manifest.json
├── index.html
├── assets/
│   ├── game-<hash>.js
│   ├── game-<hash>.css
│   └── player.png
└── audio/
    └── collect.ogg
```

The package root must contain `manifest.json` and `index.html`. All URLs inside the plugin must be relative to the plugin document or resolved through the SDK. Never hard-code `/`, `/app/`, the production hostname, or a CDN hostname.

### Shared manifest proposal

The same outer manifest shape should be usable by Vue and WASM plugins:

```json
{
  "manifestVersion": 1,
  "id": "moonlight-courier",
  "name": "Moonlight Courier",
  "version": "1.0.0",
  "pluginType": "vue3",
  "entry": "index.html",
  "runtime": {
    "apiVersion": "1",
    "display": {
      "aspectRatio": "16:9",
      "orientation": "landscape",
      "resize": "contain"
    },
    "capabilities": ["input.keyboard", "input.pointer", "audio", "storage", "score"]
  }
}
```

Manifest validation rules:

- `manifestVersion` is the manifest schema version, independent of the plugin's own `version`.
- `id` uses a conservative lowercase identifier format such as `[a-z0-9][a-z0-9-]{0,63}`.
- `pluginType` is exactly `vue3` for this format.
- `entry` is a relative path inside the package; reject absolute paths, `..` traversal, and URL schemes.
- `apiVersion` identifies the host SDK contract.
- Capabilities are declarations, not automatic grants. The host must apply an allowlist and user/platform policy.

## 5. Bot authoring contract

The bot creates a Vue 3 application with one designated game root component, conventionally `src/Game.vue`. The generated project may contain internal components and styles, but it must not implement the platform's outer navigation, deployment routing, or global player controls.

Example:

```vue
<script setup>
import { ref } from 'vue'
import { useGameRuntime } from '@bombless/game-sdk/vue'

const { assets, audio, storage, game } = useGameRuntime()
const score = ref(0)

function collect() {
  score.value += 1
  audio.play('collect')
  game.setScore(score.value)
  storage.set('bestScore', score.value)
}
</script>

<template>
  <main class="game">
    <h1>Moonlight Courier</h1>
    <p>Score: {{ score }}</p>
    <img :src="assets.url('images/courier.png')" alt="Courier" />
    <button @click="collect">Collect parcel</button>
  </main>
</template>
```

This is illustrative API design, not an existing published package. Names and signatures should be finalized with the SDK implementation and TypeScript declarations.

### Proposed SDK surface

Keep the first API small and asynchronous where host communication may be involved:

- `assets.url(relativePath): string` — resolve a package-local asset URL using the runtime-provided base URL.
- `audio.play(soundId, options?): Promise<void>` — request playback of a declared package sound.
- `storage.get(key): Promise<unknown>` and `storage.set(key, value): Promise<void>` — namespaced, quota-limited save data.
- `game.setScore(score): void` — publish current score.
- `game.pause()`, `game.resume()`, `game.end(result?)` — lifecycle requests.
- `input` — normalized keyboard, pointer, and touch state/events.
- `viewport` — current logical dimensions and resize notifications.

The game must remain playable if optional capabilities such as audio or persistence are unavailable. The host should validate payload sizes and types.

## 6. Host ↔ game messaging

For iframe mode, define a versioned message protocol over `postMessage`. Every message should include:

```json
{
  "protocol": "bombless-game",
  "protocolVersion": 1,
  "instanceId": "host-generated-random-id",
  "type": "GAME_READY",
  "requestId": "optional-request-id",
  "payload": {}
}
```

Rules:

- Generate a fresh, unguessable `instanceId` for each player instance.
- Validate `event.source` against the iframe's `contentWindow`.
- Validate origin according to the selected origin model; do not use `*` as a general target origin when a stable origin is available.
- Validate protocol version, message type, payload schema, string lengths, and numeric ranges.
- Use request IDs for request/response APIs; reject stale responses after teardown.
- Never expose arbitrary host functions or raw storage objects to the game.
- Rate-limit noisy messages such as score updates and resize events.
- Treat all game messages as untrusted input.

Suggested message families:

- Handshake: `HOST_INIT`, `GAME_READY`, `HOST_DISPOSE`
- Viewport: `VIEWPORT_RESIZE`
- Input: `INPUT_EVENT`, `INPUT_STATE`
- Capabilities: `AUDIO_PLAY`, `STORAGE_GET`, `STORAGE_SET`
- Game state: `SCORE_UPDATE`, `GAME_PAUSE`, `GAME_RESUME`, `GAME_OVER`

## 7. Build and publishing requirements

The bot's generated project should:

1. Pin a supported Node.js version and use the repository's supported package manager.
2. Commit its lockfile.
3. Provide a deterministic `build` script.
4. Build to a clean `dist/` directory.
5. Emit `manifest.json` and `index.html` at the plugin package root.
6. Use relative asset URLs (for Vite, configure a relative base such as `base: './'` for a self-contained plugin package).
7. Avoid runtime network dependencies unless explicitly declared and approved.
8. Run a package validation step before deployment.

The deployment artifact should contain the platform shell plus game packages, for example:

```text
dist/
├── index.html
├── runtime/
│   └── ...
└── games/
    └── moonlight-courier/
        ├── manifest.json
        ├── index.html
        └── assets/
```

The shell discovers or is configured with the game package path. The public mount path `/app/` is a deployment concern owned by the host and Caddy, not by the game. The host should derive the game package URL from its own runtime configuration and pass an absolute resolved URL to the iframe.

## 8. Lifecycle and failure handling

The host should support:

- Loading → ready → running → paused → ended → disposed states.
- A loading timeout and a clear error state.
- Cleanup of event listeners, timers, audio, and pending requests on dispose.
- Pause when the player is hidden or the page is backgrounded, subject to platform policy.
- A restart that creates a clean game instance rather than reusing stale state.
- A host-controlled timeout for unresponsive games.

## 9. Validation checklist

- [ ] Manifest schema and relative entry path validate.
- [ ] Built package contains the declared entry and all local assets.
- [ ] No required asset URL begins with `/`.
- [ ] Plugin runs under the selected iframe origin and sandbox policy.
- [ ] Host rejects messages from unexpected windows/origins/instances.
- [ ] Storage is namespaced, quota-limited, and schema-validated.
- [ ] Audio starts only after an appropriate user gesture where required by browsers.
- [ ] Resize, pause, resume, restart, and disposal work.
- [ ] A game cannot navigate the host top-level page or call undeclared capabilities.
- [ ] The final deployment works at the public `/app/` mount without game-source changes.

## 10. Open decisions for implementation

1. Whether games are served from a dedicated origin or whether a carefully tested opaque-origin iframe setup is sufficient.
2. Whether the host is Vue-based internally or framework-neutral.
3. Exact TypeScript types and message schemas for SDK API v1.
4. Whether game assets are bundled into each package or shared through a content-addressed asset store.
5. Per-game storage quota, audio policy, and input mapping defaults.

## 11. Recommended first prototype

Build one minimal Vue 3 game package (a small clicker or Snake UI) and a host player that loads it through the intended iframe policy. Verify relative assets, handshake, score updates, audio request, namespaced storage, resize, restart, and disposal before migrating a larger generated game.
