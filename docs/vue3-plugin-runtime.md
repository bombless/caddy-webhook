# Vue 3 plugin runtime (v1 prototype)

This repository contains a first runnable host + Vue 3 plugin prototype.

## Layout

- `src/runtime/manifest.ts`: validates manifest v1 and resolves package-relative entry URLs.
- `src/runtime/protocol.ts`: shared protocol envelope and version checks.
- `src/runtime/player.ts`: iframe player, instance binding, lifecycle, timeout and score handling.
- `src/sdk/vue.ts`: `useGameRuntime()` API contract and injection key.
- `src/sdk/bridge.ts`: iframe-side bridge and request/response handling.
- `examples/hello-vue3/`: minimal Vue 3 game package.
- `schemas/game-plugin-manifest.schema.json`: interoperable manifest schema.
- `scripts/validate-plugin.mjs`: package entry validation.

## Run

Use Node.js 22 and npm:

```sh
npm install
npm test
npm run dev
npm run build
```

The build emits the platform shell to `dist/` and the example package to
`dist/games/hello-vue3/`. The ZIP deployed to the existing webhook must include
the entire `dist/` directory at its root.

## Runtime API

A game imports `useGameRuntime()` from the SDK and receives:

- `assets.url(relativePath)`
- `audio.play(soundId, options?)`
- `storage.get(key)` / `storage.set(key, value)`
- `game.setScore(score)`, `game.pause()`, `game.resume()`, `game.end(result?)`
- `input.subscribe(listener)` for normalized keyboard/pointer events
- `viewport.subscribe(listener)` for resize notifications

The package declares requested capabilities in its manifest. The host applies an
allowlist; declarations are not grants. Audio and persistence are fail-closed until
host providers are configured. No raw storage object or arbitrary host function is
exposed to game code.

## Security notes and prototype boundaries

The default iframe sandbox is `allow-scripts` only, producing an opaque origin.
Because opaque origins cannot be addressed with a stable `targetOrigin`, the bridge
uses `*` only for that explicit mode and validates `event.source`, protocol version,
instance ID, message shape, and a message-size bound. The Caddy example adds wildcard
CORS only to `/app/games/*`, which is needed for ES module loading from an opaque
origin. For production, configure a dedicated game origin via the player options;
it must differ from the host origin. Do not add `allow-same-origin` for a same-origin
game.

This is a prototype, not a security certification. Before enabling untrusted third-party
games, add a host-managed audio provider, quota-limited namespaced storage provider,
strict per-message payload schemas, CSP/origin deployment policy, request cancellation
tests, and end-to-end tests under the actual Caddy origin arrangement. Audio/storage
capabilities are not enabled by default.
