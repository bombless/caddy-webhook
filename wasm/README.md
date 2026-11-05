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
  grantedCapabilities: ["input.keyboard", "input.pointer"],
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
cleanup events. Simulation advances in fixed 1/60 s steps while presentation
is capped independently (30 FPS by default; configure `renderHz` from 10 to 60).
The player batches up to six fixed updates into each rendered frame to catch up
after scheduling delays. Elapsed time is clamped after suspension. The runtime requires a dedicated Worker, Canvas
2D, and module-capable browser.
Manifest capabilities are requests, not grants. The host must explicitly pass
implemented capabilities through `grantedCapabilities`; the default is deny-all.
Only `input.keyboard` and `input.pointer` are currently grantable. Audio,
persistence, score, and asset capabilities remain disabled even when declared
in a manifest. Unknown or not-yet-implemented host grants are rejected.

## Game help manifest v1

WASM packages may include an optional top-level `help` object in
`manifest.json`. The host reads this metadata and renders a consistent,
accessible help panel outside the game Canvas; the guest does not need to draw
menus or explanatory text into its framebuffer.

The object is versioned independently from the package and ABI:

```json
{
  "help": {
    "schemaVersion": 1,
    "locale": "en",
    "description": "Guide the character through the level.",
    "objective": "Reach the exit without losing all your lives.",
    "controls": [
      { "action": "move_left", "label": "Move left", "inputs": ["ArrowLeft", "KeyA"] },
      { "action": "jump", "label": "Jump", "inputs": ["Space"] }
    ],
    "instructions": ["Avoid hazards.", "Collect keys to unlock the exit."],
    "tips": ["Look for safe paths before moving."]
  }
}
```

Fields are optional except `schemaVersion` when `help` is present.
`description` and `objective` are plain text; `instructions` and `tips`
are bounded lists of plain-text items. Each control has a unique semantic
`action`, a human-readable `label`, and one or more input identifiers.
Use browser `KeyboardEvent.code` values (for example `ArrowLeft`, `KeyA`,
`Space`, `Enter`, `KeyP`) so the host can show consistent keycaps.
Input identifiers describe controls; they do not grant input capabilities.
The host still applies the normal explicit capability grant policy.

The dependency-free runtime validator and both checked-in JSON schemas enforce
the same bounded shape and reject unknown properties. Old manifests without
`help` remain valid. The first implementation is static: the host reads help
once during manifest loading. Dynamic, level-specific hints and guest/host
request-response negotiation are deliberately deferred to a separately
versioned protocol; ABI v1 has no guest-to-host help message channel.

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

The Worker accepts a bounded `steps` count on each `TICK` (1–6), applies that
many identical 16,667-microsecond updates in order, and renders exactly once.
This keeps simulation cadence independent of presentation cadence without
introducing variable-delta game updates. The headless replay test supplies
explicit input timestamps and fixed update batches, then compares state-derived
frame output across identical runs. Input messages are queued (up to 256) and
delivered immediately before the first simulation update at or after each
event timestamp, preserving short key transitions inside a multi-step batch.
Timestamps use the simulation clock, so paused wall time is excluded.

Run the repository's normal static deployment after copying these files into
the frontend's `dist/wasm/` output.


## Browser demo

A small Snake game demonstrates the browser runtime end to end. Its guest is
implemented in `demo/game.c`; the manifest lives in
`demo/games/snake/manifest.json`. The guest receives keyboard events through
ABI v1 and draws an RGBA framebuffer; the page hosts the Canvas, Worker
lifecycle controls, and event stream.

Open `demo/index.html` through a static server (not `file://`) after building
the guest module to `demo/games/snake/game.wasm`. The
`.github/workflows/pages-demo.yml` workflow builds the WASM module with
Clang/LLD, assembles the static site, and deploys it to GitHub Pages on pushes
to any branch. The repository's Pages site is shared: a deployment from one
branch replaces the currently published site rather than creating a permanent
per-branch URL.
