# WASM game plugin runtime (prototype)

This directory implements the browser-side ABI v1 runtime described in
`docs/design/wasm-plugin.md`. It is deliberately independent of the Python
deployment webhook: deploy these static files with the normal `dist/` ZIP.

## Package

A game package contains `manifest.json` and the declared `.wasm` entry.
Validate authoring packages against `schema/manifest.schema.json` before
publishing. The player resolves the entry relative to the manifest URL; game
code must not know the public origin or `/app/` mount.

## Host integration

Serve `runtime/player.js` and `runtime/worker.js` as same-origin static ES
modules. Create a canvas and instantiate:

```js
import { WasmGamePlayer } from "./wasm/runtime/player.js";
const player = new WasmGamePlayer(document.querySelector("canvas"), {
  onError: error => showRecoverableError(error)
});
await player.load(new URL("./games/pixel-snake/", location.href));
```

Call `pause()`, `resume()`, and `dispose()` with the owning player lifecycle.
The runtime requires a dedicated Worker, Canvas 2D, and module-capable browser.
It does not provide audio, persistence, score, or asset capabilities yet;
manifest capability declarations are requests and do not grant those services.

## ABI v1 implementation contract

See `abi/game.h`. In addition to the six lifecycle exports, the module must
export `memory` and the dimension/framebuffer accessors. It must also export
config/input scratch-buffer accessors. These reserved regions must not overlap
the framebuffer or live game state. Config and input are UTF-8 JSON records.
The framebuffer is RGBA8, top-left origin, tightly packed rows, straight alpha.

The Worker rejects every import (including WASI), validates exports and guest
memory ranges, and caps dimensions, memory pages, frame size, config and input
buffers. The main thread owns input and Canvas; the Worker owns the instance.
The main thread terminates the Worker on a missed watchdog deadline because a
synchronous WASM call cannot be preempted from inside that Worker.

## Limitations before production

This is an initial runtime slice, not a security certification. Browser worker
termination is the CPU watchdog boundary. A module can still consume its
worker's CPU until termination. Capability events (audio/storage/score), formal
JSON-schema validation in the player, cross-toolchain ABI conformance tests,
and a full deterministic headless game harness remain follow-up work. Keep
capabilities disabled until host-side handlers and policy are implemented.

Run the repository's normal static deployment after copying these files into
the frontend's `dist/wasm/` output.
