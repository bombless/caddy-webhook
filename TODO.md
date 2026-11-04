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
- [ ] Define watchdog semantics and test that an unresponsive guest can be terminated without blocking the main thread.
- [ ] Handle worker errors, traps, malformed messages, fetch failures, aborts, and disposal without leaking workers, listeners, object URLs, or animation callbacks.
- [x] Ensure pause, blur, visibility changes, and disposal clear held input and stop simulation.
- [ ] Add a user-visible recoverable error state; do not silently leave a blank or frozen player.
- [ ] Document the security boundary accurately: worker isolation and capability restriction are fault containment, not a guarantee that arbitrary WASM is harmless.

## P0 — Automated ABI and runtime tests

- [ ] Add a minimal valid WASM fixture exporting the required ABI.
- [ ] Add invalid fixtures: missing exports, wrong ABI version, unexpected imports, malformed memory, invalid pointers, oversized output, invalid dimensions, and trap-on-call.
- [ ] Add tests for manifest validation and unsafe entry paths.
- [ ] Add tests for module/package size limits, memory limits, and output bounds.
- [ ] Add tests for worker message validation and malformed payloads.
- [ ] Add tests for watchdog timeout and worker termination.
- [ ] Add tests for pause/resume/dispose and held-key cleanup.
- [ ] Add browser tests that instantiate a real module and verify Canvas output.
- [ ] Add a deterministic headless harness that supplies exact input events and fixed update ticks, then asserts known state/render results.
- [ ] Run the tests in CI and document supported browsers and required test tooling.

## P1 — Complete input and timing semantics

- [ ] Normalize keyboard, pointer, touch, and cancellation events into the documented ABI record.
- [ ] Implement logical-canvas coordinate mapping that accounts for scaling and letterboxing.
- [ ] Include key-up events and clear input on blur, pause, visibility loss, and disposal.
- [ ] Define bounded input queue capacity and an explicit overflow policy.
- [ ] Prevent browser defaults only for keys captured by the active player.
- [ ] Add an accumulator-based fixed timestep; clamp elapsed time after tab suspension.
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

## Suggested execution order

1. Finalize ABI and memory ownership (P0).
2. Harden manifest/package loading and worker boundaries (P0).
3. Add valid/invalid WASM fixtures and automated browser/headless tests (P0).
4. Implement deterministic input/timing and capability events (P1).
5. Build C and Rust Snake packages and prove cross-toolchain compatibility (P1).
6. Integrate the Player into the actual frontend and deployment flow (P1).
7. Profile rendering, consider optional extensions, and complete release documentation (P2).
