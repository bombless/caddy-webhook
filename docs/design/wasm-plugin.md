# WASM Game Plugin — Design

**Status:** Proposal / design baseline  
**Audience:** Game-generation bots, runtime implementers, and maintainers  
**Target:** A language-neutral game module that runs inside a constrained browser host and renders through a host-owned Canvas.

## 1. Goals

A WASM plugin is the low-level, logic-oriented game format. The bot implements game rules and state transitions; the platform owns browser integration, input capture, rendering presentation, audio, persistence, and deployment.

The design should:

- Accept modules compiled from Rust, C, C++, AssemblyScript, or other WASM-targeting languages.
- Keep the game independent of the site's hostname and `/app/` mount path.
- Provide a small, versioned ABI with predictable memory ownership.
- Avoid one JavaScript↔WASM call per pixel.
- Run without DOM, direct network, filesystem, or ambient browser API access.
- Be testable with deterministic input sequences and a headless harness.

## 2. Security and execution model

Run each module in a dedicated Web Worker where practical. The worker owns the WASM instance and game loop; the main thread owns the visible Canvas and platform UI. Communicate with structured, bounded messages.

A WASM module does not automatically have access to DOM, cookies, localStorage, or fetch. It can still consume excessive CPU or memory, exploit unsafe host imports, or produce malformed output. Therefore:

- Provide no WASI filesystem or network capability by default.
- Keep the import table minimal and explicitly allowlisted.
- Enforce maximum linear memory and maximum module/package size.
- Bound input queue length, output buffer size, and message rate.
- Use a watchdog/worker termination policy for unresponsive modules.
- Do not rely on a synchronous WASM call being preemptible. A runaway call may block its worker until it returns; terminate the worker when a deadline is exceeded.
- Validate all pointers, lengths, dimensions, enum values, and numeric ranges before reading memory.
- Consider a separate Worker per game instance.

This is capability restriction and fault containment, not a proof that arbitrary code is harmless.

## 3. Plugin package format

A built WASM plugin is a static directory:

```text
pixel-snake/
├── manifest.json
├── game.wasm
└── assets/
    ├── palette.json
    └── ...
```

The package root contains `manifest.json` and the declared WASM binary. Optional assets are package-relative and accessed through host-mediated resource handles or a manifest URL map.

### Shared manifest proposal

```json
{
  "manifestVersion": 1,
  "id": "pixel-snake",
  "name": "Pixel Snake",
  "version": "1.0.0",
  "pluginType": "wasm",
  "entry": "game.wasm",
  "runtime": {
    "apiVersion": "1",
    "display": {
      "width": 320,
      "height": 180,
      "pixelScale": "integer",
      "orientation": "landscape"
    },
    "capabilities": ["input.keyboard", "input.pointer", "audio", "storage", "score"],
    "wasm": {
      "abi": "bombless-game-abi",
      "abiVersion": 1,
      "maxMemoryPages": 256,
      "maxOutputBytes": 1048576,
      "renderMode": "rgba"
    }
  }
}
```

The schema should be shared with the Vue plugin design. `pluginType` is `wasm` here; `entry` must be a safe package-relative path. Declared capabilities are requests, not automatic grants.

## 4. ABI v1: exported functions

Prefer a small C-compatible ABI with integer return codes and explicit pointers/lengths. Avoid passing language-specific strings, structs with unstable layout, or JavaScript objects across the boundary.

Proposed exports:

```c
// Required: return ABI version supported by this module.
uint32_t game_abi_version(void);

// Required: initialize once. config is UTF-8 JSON in guest memory.
int32_t game_init(uint32_t config_ptr, uint32_t config_len);

// Required: advance simulation by dt in seconds.
// Host should use a fixed simulation step (for example 1/60 s).
int32_t game_update(uint32_t dt_micros);

// Required: receive one normalized input event encoded as a compact record.
int32_t game_input(uint32_t event_ptr, uint32_t event_len);

// Required: write a frame into the module-owned output buffer.
// Returns bytes written, or a negative error code.
int32_t game_render(uint32_t output_ptr, uint32_t output_capacity);

// Required: release internal resources.
void game_shutdown(void);
```

The exact ABI must be specified in a header and tested across at least two toolchains before declaring v1 stable. The signatures above are illustrative; implementation may simplify them once buffer ownership is proven.

### Memory and buffer contract

Export linear memory as `memory`. Define explicit query exports for required buffer sizes and dimensions, for example:

```c
uint32_t game_get_width(void);
uint32_t game_get_height(void);
uint32_t game_get_render_buffer_ptr(void);
uint32_t game_get_render_buffer_len(void);
```

A simpler first implementation can let the module own a fixed RGBA framebuffer and expose its pointer and length. The host should:

1. Check dimensions against configured limits.
2. Check `width * height * 4` for integer overflow.
3. Check pointer + length stays inside current WASM memory.
4. Create a fresh typed-array view if memory has grown (old views become detached/stale after memory growth).
5. Copy or upload the frame before the next module call can mutate it.

Do not call `game_get_pixel(x, y)` once per pixel from JavaScript. That creates a huge number of JS/WASM boundary crossings. If pixel rendering is needed, write the entire RGBA buffer in WASM memory and upload it in one batch.

## 5. Rendering modes

### Mode A — RGBA framebuffer (recommended first prototype)

The module renders to a fixed logical resolution, such as 320×180 or 256×144. It writes RGBA8 bytes into a contiguous buffer. The host draws the frame to Canvas using `ImageData` / `putImageData`, then scales the Canvas to fit the player.

Advantages:

- Very simple contract.
- Language-neutral.
- Great for pixel art, board games, cellular simulations, and generated procedural visuals.
- No per-pixel function calls.

Trade-offs:

- Full-frame memory copy/upload each frame.
- Text and high-resolution vector UI are less convenient.
- Alpha, color format, row stride, and color-space semantics must be specified.

Specify RGBA byte order, top-left origin, row stride, alpha convention (recommend straight alpha initially), and whether the host may use nearest-neighbor scaling.

### Mode B — Draw-command buffer (future extension)

The module writes a compact binary command stream into guest memory. Example logical commands:

- CLEAR(color)
- RECT(x, y, width, height, color)
- CIRCLE(x, y, radius, color)
- LINE(x1, y1, x2, y2, width, color)
- SPRITE(assetId, x, y, width, height, frame)
- TEXT(fontId, x, y, textBytes, color)

The host validates and interprets commands using Canvas 2D. Use a binary format with an explicit version, command count, byte length, and bounded string/resource references; do not use free-form text commands as the production protocol.

This mode can reduce framebuffer traffic and improve vector/text rendering, but it expands the ABI and resource model. Defer it until the framebuffer prototype is working.

## 6. Input contract

The host captures browser keyboard, pointer, touch, and (optionally) gamepad events. It normalizes them into a compact event record and passes them to `game_input` or writes them into a bounded event queue. Input timestamps use the monotonic simulation clock; paused wall time is excluded. The Worker queues bounded input records and delivers each immediately before the first fixed update whose simulation time reaches its timestamp. This preserves short key transitions when multiple updates are batched into one presentation frame.

Proposed logical fields:

```text
type: KEY_DOWN | KEY_UP | POINTER_DOWN | POINTER_UP | POINTER_MOVE | POINTER_CANCEL
code: normalized key/button identifier
x, y: logical game coordinates (when applicable)
buttons: bit mask
modifiers: bit mask
timestamp_micros: monotonic timestamp relative to game start
```

Requirements:

- Use logical canvas coordinates, not page coordinates.
- Include key-up events to avoid stuck controls.
- Clear held input on blur, pause, and disposal.
- Bound event queue length and define overflow behavior.
- Prevent browser defaults only for keys captured by the active player.
- Keep pointer/touch mapping consistent with letterboxing and scaling.

## 7. Timing and deterministic updates

Use a fixed simulation timestep (16,667 microseconds for ABI v1) with an accumulator in the host. Simulation and presentation rates are independent: the host may batch multiple fixed `game_update` calls before one `game_render` call, and must cap both the update batch and presentation rate. The current runtime defaults to 60 Hz simulation, 30 FPS presentation, and at most six updates per rendered frame. Pass the same fixed `dt` value to every update; never replace catch-up with a large variable delta.

The host should clamp large elapsed times after tab suspension and should not pass an arbitrarily large delta to the module. For deterministic tests, allow the harness to supply an exact sequence of input events and fixed update ticks.

## 8. Host capabilities

Keep browser capabilities on the host side. The WASM module requests operations through a small set of explicit imports or, preferably for the first version, emits bounded events that the host consumes.

Suggested events/capabilities:

- `AUDIO_PLAY(sound_id, volume)`
- `STORAGE_GET(key)` / `STORAGE_SET(key, value)`
- `SCORE_UPDATE(score)`
- `GAME_OVER(result)`
- `ASSET_REQUEST(asset_id)` (only if an asset handle table is needed)

For the first prototype, prefer a guest-to-host event output buffer over complex synchronous imports. Storage and asset loading are asynchronous in browsers; a request/response event protocol avoids blocking the WASM simulation on browser promises.

Storage must be namespaced per game and quota-limited. Audio IDs and asset IDs must resolve only to entries declared by the package/host. Validate and rate-limit every event.

## 9. Worker and Canvas architecture

Recommended topology:

```text
Main thread
  ├── Platform UI and Canvas
  ├── Input capture
  ├── Audio and persistence services
  └── Worker messaging
          |
          v
Dedicated Worker
  ├── WASM instance
  ├── Fixed-step simulation loop
  ├── Input queue
  └── Render/event buffers
```

For the first version, transfer a copied RGBA frame or a bounded render buffer from the Worker to the main thread. Later, consider `OffscreenCanvas` transfer if supported and justified by profiling. Do not make OffscreenCanvas mandatory for ABI v1.

## 10. Resource and URL independence

The WASM module must not know the deployment URL. The host loads `game.wasm` using the manifest's package-relative `entry`, resolved against the package base URL. The module should not construct URLs.

If a game needs images or sounds, declare them in the manifest and refer to stable asset IDs. The host resolves those IDs to package-relative URLs and loads the resources. The WASM module receives numeric handles or emits asset IDs; it never receives a hard-coded `/app/` path.

## 11. Error handling and lifecycle

Define explicit return codes, for example:

- `0`: success
- `-1`: invalid argument
- `-2`: unsupported ABI/config
- `-3`: insufficient output capacity
- `-4`: invalid state
- `-5`: internal game error

Host lifecycle:

- Fetch and validate manifest.
- Fetch WASM binary and enforce byte limit.
- Instantiate with only approved imports.
- Verify ABI version and required exports.
- Initialize.
- Run fixed-step update and render loop.
- On pause, stop simulation and clear held inputs.
- On dispose/error/timeout, terminate Worker and release host resources.

Never trust guest pointers, dimensions, lengths, return values, or event payloads. On traps or watchdog timeout, stop the instance and show a recoverable error UI.

## 12. Validation checklist

- [ ] Manifest and ABI versions validate.
- [ ] WASM module imports only the allowlisted functions.
- [ ] Module memory stays within configured limits.
- [ ] All exports and signatures match the ABI.
- [ ] Invalid pointers, lengths, dimensions, and return codes are rejected.
- [ ] Rendering uses a bulk buffer, not per-pixel JS/WASM calls.
- [ ] Input coordinates map correctly to logical canvas coordinates.
- [ ] Key-up, blur, pause, and disposal cannot leave stuck controls.
- [ ] Fixed-step update is stable after tab suspension.
- [x] Simulation and presentation rates are independently capped; Worker tick batches are bounded and use fixed deltas.
- [ ] Worker timeout and termination recover cleanly.
- [ ] Storage/audio/score events are bounded and namespaced.
- [ ] The game runs without knowledge of the public host or `/app/` path.

## 13. Recommended first prototype

Implement a tiny pixel Snake game compiled to WASM, using:

- 320×180 or a smaller fixed logical framebuffer.
- Keyboard input (arrows/WASD).
- Fixed-step simulation.
- RGBA framebuffer output.
- One score event and one game-over event.
- No network, filesystem, WASI, or external imports.
- Dedicated Worker with a memory cap and watchdog.

Build a small ABI test harness that loads the same module, replays deterministic input sequences, and checks selected game-state/render outputs. Only after this works should the ABI add draw commands, asset handles, persistent storage, or more input devices.
