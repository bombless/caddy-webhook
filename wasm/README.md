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
The canvas is keyboard-focusable; pointer interaction focuses it, and only the
focused player captures supported keys or prevents their browser defaults.
When focus leaves the canvas, held keys receive `KEY_UP`. Blur, hidden-page,
pause, and disposal paths also clear held input. Pointer and touch input use
Pointer Events and are normalized to logical canvas coordinates after
letterboxing. Input is bounded by `maxQueue`; new non-release events are
dropped at capacity while up to 32 additional slots are reserved for key-up
cleanup events. Simulation uses a fixed 1/60 s step and clamps accumulated
elapsed time after suspension. The runtime requires a dedicated Worker, Canvas
2D, and module-capable browser.
It does not provide audio, persistence, score, or asset capabilities yet;
manifest capability declarations are requests and do not grant those services.

## ABI v1 implementation contract

See `abi/game.h`. In addition to the six lifecycle exports, the module must
export `memory` and the dimension/framebuffer accessors. It must also export
config/input scratch-buffer accessors. These reserved regions must not overlap
the framebuffer or live game state. Config and input are UTF-8 JSON records.
The framebuffer is RGBA8, top-left origin, tightly packed rows, straight alpha.

The Worker rejects every import (including WASI), validates required exports
and guest memory ranges, and caps dimensions, memory pages, frame size, config,
input buffers, and queued input messages. The main thread owns input and Canvas;
the Worker owns the instance. The main thread terminates the Worker on a missed
per-tick watchdog deadline because a synchronous WASM call cannot be preempted
from inside that Worker.

ABI v1 requires the six lifecycle exports, exported linear memory named
`memory`, and all dimension/framebuffer/config/input accessors declared in
`abi/game.h`. Every accessor and lifecycle export is required. The guest owns
its framebuffer and scratch buffers; the host writes length-delimited UTF-8
JSON (no trailing NUL) into config/input scratch buffers. Input records use the
documented KEY_* and POINTER_* JSON shapes. Rendering is tightly packed RGBA8,
top-left origin, row stride `width * 4`, straight alpha. `game_render(ptr, cap)`
must write exactly `width * height * 4` bytes and return that byte count.
Lifecycle calls are legal only in READY, except ABI negotiation before init
and shutdown after successful init. See the header for the complete return
code and state contract.

The player enforces a 64 KiB manifest limit and a 16 MiB module limit while
streaming (even without Content-Length). Its dependency-free runtime validator
implements the checked-in v1 schema constraints, including required fields,
types, enums, bounds, uniqueness, and rejection of unknown properties. Keep
the schema and `_validateManifest()` in sync when changing the manifest.
Package entry paths reject encoded paths and traversal, and are resolved
relative to the package base URL. Memory is checked against the configured
maximum after instantiation and after guest calls; all memory views are
recreated from the current memory buffer after calls that may grow it.

## Limitations before production

This is an initial runtime slice, not a security certification. Worker
isolation and capability restriction provide fault containment, not a guarantee
that arbitrary WASM is harmless. Browser worker termination is the CPU watchdog
boundary. A synchronous guest call cannot be preempted; the main thread
terminates the worker if initialization or a tick exceeds the configured
watchdog deadline. Guest shutdown is acknowledged with a bounded 100 ms wait
before forced termination. A module can still consume its worker's CPU until
termination. Capability events (audio/storage/score), formal
JSON-schema validation in the player, cross-toolchain ABI conformance tests, browser Canvas
tests, and a full deterministic headless game harness remain follow-up work. The
runtime also treats malformed or unsolicited Worker messages as fatal protocol
errors and terminates the affected Worker before presenting the recoverable error UI. Keep
capabilities disabled until host-side handlers and policy are implemented.

Run the repository's normal static deployment after copying these files into
the frontend's `dist/wasm/` output.
