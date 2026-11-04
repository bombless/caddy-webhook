# WASM Game Plugin — Implementation TODO

This checklist tracks the work required to take the initial runtime skeleton in PR #1 to a tested, integrated implementation of [`docs/design/wasm-plugin.md`](docs/design/wasm-plugin.md).

## Current baseline

- [x] Add a versioned C ABI header (`wasm/abi/game.h`).
- [x] Add an initial manifest JSON Schema (`wasm/schema/manifest.schema.json`).
- [x] Add a Dedicated Worker runtime skeleton (`wasm/runtime/worker.js`).
- [x] Add a Canvas player/runtime loader (`wasm/runtime/player.js`).
- [x] Document the initial runtime layout and deployment assumptions (`wasm/README.md`).

> The current code is a starting point, not a production-ready implementation. Browser execution, ABI conformance, and integration tests have not yet been demonstrated.

## P0 — Make ABI v1 precise and internally consistent

- [x] Review the current header and runtime against the design proposal; resolve signature and ownership mismatches before treating ABI v1 as stable.
- [x] Specify every export's exact WASM signature, required/optional status, lifecycle state, and return-code behavior.
- [x] Specify the framebuffer contract: width, height, RGBA byte order, top-left origin, row stride, straight/premultiplied alpha, and buffer ownership.
- [x] Specify how the guest exposes framebuffer pointer, capacity, and dimensions; validate all values and integer arithmetic before creating memory views.
- [x] Specify config and input wire formats, including UTF-8 handling, record layout, enum values, timestamp units, and maximum lengths.
- [x] Define behavior when guest memory grows; recreate all views after calls that may grow memory and copy frame data before guest mutation.
- [x] Define whether render writes into a host-provided buffer or a guest-owned framebuffer; make header, worker, and sample modules use the same contract.
- [x] Define ABI error codes and host behavior for every failure path.
- [x] Add ABI version negotiation and reject unsupported versions cleanly.

## P0 — Security and runtime hardening

- [x] Enforce package and manifest size limits before parsing or instantiating.
- [x] Enforce WASM byte limits while streaming downloads; also enforce the limit when the response has no trustworthy `Content-Length`.
- [x] Validate manifest fields against the schema in the actual browser runtime (or document and implement the chosen validator strategy).
- [x] Validate package-relative paths: reject absolute paths, schemes, traversal segments, backslashes where unsafe, and malformed/encoded traversal.
- [x] Resolve `entry` and assets relative to the package base URL without assuming the site's hostname or `/app/` mount path.
- [x] Keep imports explicitly allowlisted; verify that WASI, network, filesystem, DOM, and other ambient capabilities cannot be imported.
- [x] Verify memory limits against the actual instantiated memory, including modules that declare or grow memory unexpectedly.
- [x] Bound every message, input queue, event queue, render payload, and host capability request.
- [x] Validate pointers, lengths, dimensions, multiplication/addition overflow, enum values, numeric finiteness, and guest return values at every boundary.
- [x] Define tick-scoped watchdog semantics; worker termination is implemented. (Automated timeout/termination coverage remains in the test section.)
- [ ] Finish auditing and testing cleanup/error paths for worker errors, traps, malformed messages, fetch failures, aborts, and disposal; verify no workers, listeners, object URLs, or animation callbacks leak. (Fetch cancellation and disposal are now covered; continue auditing remaining failure paths.)
- [x] Ensure pause, blur, visibility changes, and disposal clear held input and stop simulation.
- [x] Add a user-visible recoverable error state; do not silently leave a blank or frozen player.
- [x] Document the security boundary accurately: worker isolation and capability restriction are fault containment, not a guarantee that arbitrary WASM is harmless.

## P0 — Automated ABI and runtime tests

- [x] Add a minimal valid WASM fixture exporting the required ABI; the test harness instantiates it with the real WebAssembly engine and verifies input, RGBA output, and shutdown.
- [x] Add invalid fixtures for missing exports, wrong ABI version, unexpected imports, over-limit memory, invalid pointers, oversized framebuffer, invalid dimensions, and trap-on-call.
- [x] Add tests for manifest validation and unsafe entry paths.
- [x] Add tests for module/package size limits, memory limits, and output bounds (streaming reader and manifest/runtime bounds; worker memory/output fixtures already cover the guest boundary).
- [x] Add tests for worker message validation and malformed payloads.
- [x] Add tests for watchdog timeout and worker termination.
- [ ] Add browser tests for end-to-end held-key cleanup. (Unit coverage now includes resume, pause/key-up, graceful dispose, and in-flight fetch cancellation.)
- [ ] Add browser tests that instantiate a real module and verify Canvas output.
- [ ] Add a deterministic headless harness that supplies exact input events and fixed update ticks, then asserts known state/render results.
- [ ] Run the tests in CI and document supported browsers and required test tooling.

## P1 — Complete input and timing semantics

- [x] Normalize keyboard, pointer, touch (through Pointer Events), and cancellation events into the documented ABI record.
- [x] Implement logical-canvas coordinate mapping that accounts for scaling and letterboxing; pointer coordinates now map through a centered aspect-ratio viewport and clamp letterbox-bar input to the nearest edge.
- [x] Include key-up events and clear input on blur, focus loss, pause, visibility loss, and disposal.
- [x] Define bounded input queue capacity and an explicit overflow policy: drop new non-release input at capacity while reserving 32 slots for key-release events.
- [x] Prevent browser defaults only for keys captured by the active player; the canvas is focusable and pointer interaction focuses it.
- [x] Add an accumulator-based fixed timestep; clamp elapsed time after tab suspension.
- [ ] Separate simulation tick rate from render/presentation rate and cap both.
- [ ] Make deterministic replay possible without relying on wall-clock timing.

## P1 — Host capability/event protocol

- [ ] Define a versioned, bounded guest-to-host event buffer or message protocol.
- [ ] Implement event parsing and validation without allowing guest-controlled arbitrary host calls.
- [ ] Implement `GAME_OVER` and `SCORE_UPDATE` events with validation and rate limits.
- [ ] Implement audio requests using only host-approved, manifest-declared sound IDs.
- [ ] Implement namespaced, quota-limited storage with explicit asynchronous request/response semantics.
- [ ] Define asset IDs/handles and resolve only manifest-declared package-relative resources.
- [ ] Treat manifest capabilities as requests; require host policy to grant each capability.
- [ ] Add tests for unknown event types, malformed payloads, undeclared IDs, quota exhaustion, and event flooding.

## P1 — Cross-toolchain sample game

- [ ] Build a minimal Snake game using the finalized ABI and fixed logical RGBA framebuffer.
- [ ] Compile the same sample from C and Rust (or another second independent toolchain).
- [ ] Verify identical ABI behavior and deterministic replay for both builds.
- [ ] Implement keyboard controls (arrows/WASD), score updates, and game-over events.
- [ ] Include reproducible build instructions and checked-in source; avoid checking in toolchain-specific build artifacts unless the project requires them.
- [ ] Add a sample package with `manifest.json`, `game.wasm`, and any declared assets.
- [ ] Add an end-to-end smoke test that loads the sample through the actual Player.

## P1 — Frontend and deployment integration

- [ ] Inspect the real frontend/application architecture and identify the intended plugin discovery and player entry points.
- [ ] Integrate the Player into the frontend shell; the current repository baseline did not expose an existing Vue game-player integration.
- [ ] Decide where plugin packages are stored and how package base URLs are obtained.
- [ ] Ensure normal deployment and ZIP/static hosting publish the runtime assets and plugin packages at the expected paths.
- [ ] Verify operation under a non-root mount path and a different hostname.
- [ ] Add loading, pause, resume, restart, and error UI states.
- [ ] Verify responsive Canvas sizing, high-DPI behavior, focus handling, and accessibility.
- [ ] Document the supported plugin author workflow from source to package.

## P2 — Rendering and performance

- [ ] Specify and test RGBA color/alpha semantics and row stride.
- [ ] Profile framebuffer copy/upload costs at target resolutions and frame rates.
- [ ] Avoid per-pixel JavaScript/WASM calls; retain bulk buffer transfer.
- [ ] Add nearest-neighbor scaling where appropriate for pixel-art games.
- [ ] Consider OffscreenCanvas only after profiling; keep it optional and preserve the main-thread Canvas fallback.
- [ ] Design draw-command rendering as a separately versioned future ABI extension; do not expand ABI v1 prematurely.

## P2 — Documentation and release readiness

- [ ] Publish the finalized ABI specification and compatibility policy.
- [ ] Document manifest fields, capability grant policy, package layout, and path resolution.
- [ ] Document resource limits and default runtime quotas.
- [ ] Add troubleshooting guidance for compile, load, validation, runtime, and watchdog failures.
- [ ] Add a threat model and explicitly list non-goals/limitations.
- [ ] Complete the design document's validation checklist with links to corresponding tests.
- [ ] Review the implementation against every requirement in `docs/design/wasm-plugin.md`.
- [ ] Obtain maintainer review and resolve all review comments before declaring ABI v1 stable.

## Implementation progress (2026-11-04)

- Added a Node.js built-in test harness that executes the actual `wasm/runtime/worker.js` in an isolated VM context.
- Added initial coverage for initialization, malformed messages/module bytes, import rejection, missing exports, ABI version rejection, framebuffer bounds, and malformed keyboard input.
- Added `package.json` scripts (`npm run check:wasm`, `npm run test:wasm`) and a GitHub Actions workflow for syntax checks and worker tests.
- Test limitation: the fixture is a minimal valid WASM container and the harness supplies mocked exports; this exercises worker-side validation and message handling, but does not yet prove real module export/signature conformance. Real valid/invalid ABI fixtures, manifest schema tests, resource-limit tests, watchdog/lifecycle coverage, and browser tests remain outstanding.
- Fixed the worker's `u32` helper: call sites pass already-evaluated ABI values, so the helper validates a number rather than invoking it as a function. This was the common cause of all three initial CI failures.
- Added an accessible player error surface (`role=alert`) with a retry action; load/fetch/manifest/worker failures now surface instead of leaving a blank canvas. Runtime failure cleanup detaches input listeners, clears watchdog state, stops animation, and terminates the worker. Malformed worker messages and invalid frame payloads are rejected.
- Added a real ABI v1 WASM smoke fixture (C source plus base64 module) and real invalid-module fixtures. The worker tests now instantiate actual modules, verify input/RGBA frame/shutdown, and reject invalid imports, missing exports, wrong ABI version, bad dimensions/pointers, oversized framebuffer, over-limit memory, and traps. Mock-based boundary tests remain as additional coverage.
- Added `wasm/test/player.test.js` for manifest validation, safe/unsafe package entry paths, and streamed package/module size-limit behavior. Exported the small `safePath` and `readLimited` helpers for direct tests; the player’s existing `_validateManifest()` is exercised without constructing DOM state.
- CI run [41843753939](https://github.com/bombless/caddy-webhook/actions/runs/41843753939) passed on commit `b3518eb76102dbb720c782aee6e0b5a953ca4ab6` (syntax checks and all worker + player tests).
- GitHub Actions passes on the current branch (7 test groups, including the real fixture corpus). Remaining P0 gaps include exact WASM export-signature conformance, watchdog/lifecycle tests, browser Canvas tests, and the deterministic headless harness. Manifest/path and streaming-size helper tests are now covered; full JSON Schema conformance and end-to-end fetch integration are not yet proven.

## Implementation progress (2026-11-04, continued)

- Made package loading cancellable with an `AbortController`: manifest and WASM fetches receive the abort signal, and disposed/aborted loads cannot continue into Worker creation or surface stale UI errors.
- Made Worker initialization cancellable and idempotently cleaned up its handlers/timer on timeout, initialization error, worker error, message decode error, or disposal.
- Disposal now aborts an in-flight load, clears watchdog state, detaches input, requests bounded graceful Worker shutdown, and terminates the Worker after ACK or a 100 ms fallback.
- Added regression tests for aborting a pending package fetch and for graceful/idempotent disposal.
- CI run [41844848083](https://github.com/bombless/caddy-webhook/actions/runs/41844848083) passed (JavaScript syntax checks and all worker/player tests).

## Implementation progress (2026-11-04, continued)

- Hardened the Worker message protocol: INIT, INPUT, TICK, and SHUTDOWN now reject unexpected top-level fields; INIT limits reject unexpected keys; config must be a non-array object; input/tick/shutdown require the appropriate initialized lifecycle state.
- Added regression coverage for unknown message types, extra INIT/INPUT/TICK fields, and shutdown-before-initialization.
- CI run [41844085548](https://github.com/bombless/caddy-webhook/actions/runs/41844085548) passed on commit `f11de5b3437b2d164b51eb2f59f9a6eaa79b5b92` (JavaScript syntax checks and worker ABI tests).

## Implementation progress (2026-11-04, continued)

- Added player-level regression tests proving a missed tick watchdog terminates the Worker, clears pending/busy state, and reports a recoverable timeout; added coverage that pause emits KEY_UP for every held key.
- CI run [41844184415](https://github.com/bombless/caddy-webhook/actions/runs/41844184415) passed on commit `d8421747006c7ff7614a1db1d16e422cd6aca208` (syntax checks and all worker/player tests).
- Lifecycle unit coverage includes pause/held-key cleanup, resume, graceful/idempotent dispose, in-flight fetch cancellation, and watchdog termination; browser-level held-key and Canvas tests remain outstanding.

## Handoff / next session

Current working branch: `feat/wasm-plugin-runtime`.

Latest branch HEAD: `dca382505e40b72dcd4946faca7f18d6ba76787d`. Relevant implementation commits: `d9c4a986` fixes numeric ABI value validation; `2dff6cf` adds recoverable error UI and failed-load cleanup; `e3dfbbc` hardens listener cleanup and worker-message validation; `ff4bbc9` adds a real valid ABI fixture and smoke test; `7eda64f` adds real invalid fixtures and rejection tests; `1c0e23f` corrects the invalid-pointer assertion to match the earlier numeric guard.

The ABI v1 contract, worker hardening, first recoverable error UI, and a real worker smoke/invalid-fixture suite are now implemented. CI passes, but **complete ABI conformance and browser rendering have not been validated**. Do not describe the runtime as production-ready. Next session should:

1. Add explicit export-signature conformance checks/fixtures; current JS boundary checks validate return values and behavior but do not introspect every WASM function signature.
2. Add manifest/schema validation tests, package/module size-limit tests, watchdog timeout coverage, pause/resume/dispose and held-input cleanup tests, and a deterministic headless game harness.
3. Run `node --check wasm/runtime/player.js`, `node --check wasm/runtime/worker.js`, and `node --test wasm/test/*.test.js`; keep CI green and record exact results.
4. Continue the lifecycle audit, including fetch abort/cancellation and disposal edge cases. Browser tests for real Canvas output remain outstanding.
5. Keep frontend integration explicitly blocked until the actual frontend source/repository and deployment workflow are identified; this repository currently provides the webhook/static deployment side rather than the frontend shell.

CI validation (2026-11-04): initial runs [41841293121](https://github.com/bombless/caddy-webhook/actions/runs/41841293121) and [41841284566](https://github.com/bombless/caddy-webhook/actions/runs/41841284566) failed (2/5 tests passed). After fixing `u32`, run [41841916248](https://github.com/bombless/caddy-webhook/actions/runs/41841916248) passed. After player error UI and cleanup changes, push/PR runs [41842164730](https://github.com/bombless/caddy-webhook/actions/runs/41842164730) and [41842174871](https://github.com/bombless/caddy-webhook/actions/runs/41842174871) passed. The real valid-fixture suite passed in [41842645652](https://github.com/bombless/caddy-webhook/actions/runs/41842645652) and [41842658198](https://github.com/bombless/caddy-webhook/actions/runs/41842658198). The expanded invalid-fixture suite initially exposed and corrected an assertion expecting range rejection when the numeric pointer guard rejects first; current push/PR runs [41843258750](https://github.com/bombless/caddy-webhook/actions/runs/41843258750) and [41843273233](https://github.com/bombless/caddy-webhook/actions/runs/41843273233) pass syntax checks and all 7 worker test groups. No browser validation has been run.

## Suggested execution order

1. Finalize ABI and memory ownership (P0).
2. Harden manifest/package loading and worker boundaries (P0).
3. Add valid/invalid WASM fixtures and automated browser/headless tests (P0).
4. Implement deterministic input/timing and capability events (P1).
5. Build C and Rust Snake packages and prove cross-toolchain compatibility (P1).
6. Integrate the Player into the actual frontend and deployment flow (P1).
7. Profile rendering, consider optional extensions, and complete release documentation (P2).


## Implementation progress (2026-11-04, ABI signature conformance)

- Added a bounded parser for the standard WASM type/function/export sections in the Worker. Because the WebAssembly JavaScript API does not expose function signatures, the runtime now verifies all 14 required ABI v1 exports' i32 parameter/result arity before instantiation and requires an exported linear memory.
- The runtime rejects imported functions during the same preflight parse (and continues to reject imports through the WebAssembly module API) before any guest code is called.
- Added a regression test that mutates the real valid WASM fixture's game_init type index while preserving the binary structure; the Worker must reject it with an ABI signature error.
- Validation is pending the GitHub Actions run triggered by these commits. Browser Canvas tests, explicit resume coverage, and deterministic game-state replay remain outstanding.


## Implementation progress (2026-11-04, player lifecycle)

- Added a focused regression test proving resume restarts the fixed-step animation loop after pause, resets the accumulator, remains idempotent while running, and does not restart after disposal.
- Existing unit coverage already exercises pause-generated KEY_UP events, bounded graceful disposal, idempotency, fetch cancellation, and watchdog termination. Real-browser focus/blur and held-key integration remain unverified.


## Implementation progress (2026-11-04, ABI preflight enforcement)

- Wired the ABI v1 type/function/export-section parser into the Worker INIT path, so all 14 required function signatures and the exported linear memory are checked before WebAssembly compilation/instantiation and before any guest code runs.
- Kept the existing missing-export error contract consistent with the worker tests.
- Fixed a stray literal \\n in the worker test source that made the entire worker test module fail to parse (the syntax-check step did not cover test files).
- GitHub Actions run [41855643294](https://github.com/bombless/caddy-webhook/actions/runs/41855643294) passed JavaScript syntax checks and the full player + worker test suite on commit `6366afb0784b523076897db81ca0d078607fde64`.
- Real-browser Canvas/focus/held-key integration and deterministic game-state replay remain outstanding; this change does not establish production readiness.


## Implementation progress (2026-11-04, complete ABI export signature regression coverage)

- Added `wasm/test/abi-signatures.test.js`, which mutates the real ABI fixture's function type index one export at a time and verifies the Worker preflight rejects a signature mismatch for each of the 14 required ABI v1 function exports.
- Added a positive control proving the unmodified real WASM fixture still initializes successfully.
- This closes the unit-test gap for per-export signature rejection; it does not replace browser Canvas/focus/held-key tests or deterministic game-state replay.
- GitHub Actions runs [41856808074](https://github.com/bombless/caddy-webhook/actions/runs/41856808074) and [41856998908](https://github.com/bombless/caddy-webhook/actions/runs/41856998908) passed. The follow-up test uses a different *valid* function type with incompatible arity for each export (rather than an out-of-range type index), proving the preflight catches genuine signature mismatches before instantiation. Latest test commit: `7f03bdcb06915ec832c19a359897634ba651736a`.

## Implementation progress (2026-11-04, focused-player input)

- Made the player canvas keyboard-focusable and focus it on pointer-down.
- Only the focused canvas (or one of its descendants) receives supported keyboard input and browser-default suppression; multiple mounted players no longer all capture the same page-level keys.
- Focus loss sends `KEY_UP` for held keys; the focusout listener is detached during player cleanup.
- Documented Pointer Events as the unified pointer/touch path, the bounded input overflow policy, and fixed-step timing behavior.
- Added a regression test for unfocused-key passthrough, focused-key capture, focus-loss release, and pointer-to-focus behavior.
- Local validation: `npm run check:wasm` and `npm run test:wasm` pass (25 tests). Browser-level focus/Canvas validation and deterministic game-state replay remain outstanding.


## Implementation progress (2026-11-04, main-thread worker protocol audit)

- Closed a lifecycle/error-path gap found during review: malformed, unknown, extra-field, and unsolicited worker messages now terminate the worker, clear watchdog/busy/input state, detach host input through the recoverable error path, and surface an error instead of leaving a worker running behind a blank/frozen player.
- INPUT_ACK is accepted only when an input is outstanding; FRAME is accepted only as the response to an in-flight tick and only with the exact dimensions, byte length, and message shape. Canvas upload exceptions also enter the same cleanup path.
- Added player regression tests for malformed messages, invalid acknowledgements, malformed frame buffers, unknown message types, unsolicited valid-looking frames, and cleanup of worker handlers/watchdog state.
- Changes are committed on feat/wasm-plugin-runtime; CI validation for this batch is pending. This is a targeted audit improvement, not completion of the broader lifecycle audit or browser-level validation.
