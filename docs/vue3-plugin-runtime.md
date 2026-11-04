# Vue 3 plugin runtime (v1 prototype)

This repository now contains a first runnable host + Vue 3 plugin prototype.

## Layout

- `src/runtime/manifest.ts`: validates manifest v1 and resolves package-relative entry URLs.
- `src/runtime/protocol.ts`: shared protocol envelope and version checks.
- `src/runtime/player.ts`: iframe player, instance binding, lifecycle, timeout and score handling.
- `src/sdk/vue.ts`: `useGameRuntime()` API contract.
- `src/sdk/bridge.ts`: iframe-side bridge and request/response handling.
- `examples/hello-vue3/`: minimal Vue 3 game package.
- `scripts/validate-plugin.mjs`: package entry validation.

## Run

Use Node.js 22 and npm:

```sh
npm install
npm run dev
npm test
npm run build
```

The build emits the platform shell to `dist/` and the example package to
`dist/games/hello-vue3/`. The ZIP deployed to the existing webhook must include
the entire `dist/` directory at its root.

## Runtime API

A game imports `useGameRuntime` from the SDK and receives:

- `assets.url(relativePath)`
- `audio.play(soundId, options?)`
- `storage.get(key)` / `storage.set(key, value)`
- `game.setScore(score)`, `game.pause()`, `game.resume()`, `game.end(result?)`
- `input.subscribe(listener)`
- `viewport.subscribe(listener)`

The package declares requested capabilities in its manifest. The host applies an
allowlist; declarations are not grants. Storage and audio are deliberately fail-closed
until a host provider is configured. No raw storage object or arbitrary host function
is exposed to game code.

## Security notes and known prototype boundaries

The default iframe sandbox is `allow-scripts` only, producing an opaque origin.
Because opaque origins cannot be addressed with a stable `targetOrigin`, the bridge
uses `*` only for that explicit mode and validates `event.source`, protocol version,
instance ID, message shape, and a message-size bound. For production, configure a
dedicated game origin via the player options; it must differ from the host origin.
Do not add `allow-same-origin` for a same-origin game.

This is a prototype, not a security certification. Before enabling untrusted third-party
games, add a host-managed audio provider, quota-limited namespaced storage provider,
strict schema validation for every message family, CSP/origin deployment policy,
request correlation and cancellation tests, and an end-to-end test under the actual
Caddy origin arrangement. The sample bridge is intended to be initialized by a framework
bootstrap; production games should call `provideGameRuntime` from their root component
using the bridge runtime.
