import test from "node:test";
import assert from "node:assert/strict";
import { WasmGamePlayer, safePath, readLimited } from "../runtime/player.js";

const player = Object.create(WasmGamePlayer.prototype);
const validManifest = () => ({
  manifestVersion: 1,
  id: "pixel-snake",
  name: "Pixel Snake",
  version: "1.0.0",
  pluginType: "wasm",
  entry: "game.wasm",
  runtime: {
    apiVersion: "1",
    display: { width: 320, height: 180, pixelScale: "integer", orientation: "landscape" },
    capabilities: ["input.keyboard"],
    wasm: {
      abi: "bombless-game-abi",
      abiVersion: 1,
      maxMemoryPages: 16,
      maxOutputBytes: 230400,
      renderMode: "rgba"
    }
  }
});

test("accepts safe package-relative WASM paths and rejects traversal/ambiguous paths", () => {
  for (const path of ["game.wasm", "build/game-v1.wasm", "assets/plugin_2.wasm"]) {
    assert.equal(safePath(path), true, path);
  }
  for (const path of ["", "/game.wasm", "../game.wasm", "a/../game.wasm", "./game.wasm",
    "a//game.wasm", "%2e%2e/game.wasm", "a%2f..%2fgame.wasm", "a\\game.wasm",
    "https://example.test/game.wasm", "game.wasm?x=1", "game.wasm\n"]) {
    assert.equal(safePath(path), false, path);
  }
});

test("validates a complete manifest and rejects invalid fields", () => {
  assert.doesNotThrow(() => player._validateManifest(validManifest()));

  const invalid = [
    m => { m.manifestVersion = 2; },
    m => { m.id = "Uppercase"; },
    m => { m.entry = "../game.wasm"; },
    m => { m.entry = "game.js"; },
    m => { m.runtime.display.width = 0; },
    m => { m.runtime.wasm.maxMemoryPages = 257; },
    m => { m.runtime.capabilities = ["audio", "audio"]; },
    m => { m.runtime.capabilities = ["network"]; },
    m => { m.runtime.display.extra = true; },
    m => { m.runtime.extra = true; },
    m => { m.extra = true; }
  ];
  for (const mutate of invalid) {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(() => player._validateManifest(manifest));
  }
});

test("manifest capabilities require explicit host grants and unsupported services stay disabled", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  const manifest = validManifest();
  manifest.runtime.capabilities = ["input.keyboard", "input.pointer", "audio", "storage", "score"];

  instance.options = { grantedCapabilities: [] };
  assert.deepEqual(instance._grantCapabilities(manifest).runtime.capabilities, []);

  instance.options = { grantedCapabilities: ["input.keyboard"] };
  const granted = instance._grantCapabilities(manifest);
  assert.deepEqual(granted.runtime.capabilities, ["input.keyboard"]);
  assert.deepEqual(manifest.runtime.capabilities, ["input.keyboard", "input.pointer", "audio", "storage", "score"],
    "granting capabilities must not mutate the parsed manifest");
});

test("readLimited accepts bodies within limit without Content-Length", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));
  const bytes = await readLimited(response, 3, "fixture");
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("readLimited rejects declared and streamed sizes over limit", async () => {
  const declared = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-length": "3" }
  });
  await assert.rejects(readLimited(declared, 2, "module"), /size limit exceeded/);

  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { cancelled = true; }
  });
  const streamed = new Response(stream);
  await assert.rejects(readLimited(streamed, 1, "module"), /size limit exceeded/);
  assert.equal(cancelled, true);
});

test("readLimited requires a streaming body", async () => {
  await assert.rejects(readLimited({ headers: { get: () => null }, body: null }, 10, "manifest"),
    /streaming response body required/);
});


test("watchdog timeout terminates the worker and reports a recoverable error", async () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  let terminated = 0;
  let reported;
  let posted;
  instance.options = { watchdogMs: 5 };
  instance.worker = { postMessage: message => { posted = message; }, terminate: () => { terminated++; } };
  instance.pendingInputs = 2;
  instance._busy = false;
  instance._watchdogTimer = null;
  instance.running = true;
  instance.pause = () => { instance.running = false; };
  instance._reportError = error => { reported = error; };

  instance._timedPost({ type: "TICK", dtMicros: 16667 });
  assert.deepEqual(posted, { type: "TICK", dtMicros: 16667 });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(terminated, 1);
  assert.equal(instance.worker, null);
  assert.equal(instance.pendingInputs, 0);
  assert.equal(instance._busy, false);
  assert.match(reported.message, /watchdog timeout/);
});

test("pause sends key-up events for every held key", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  const sent = [];
  instance.running = false;
  instance.held = new Set(["KeyW", "ArrowLeft"]);
  instance.worker = { postMessage: message => sent.push(message) };
  instance.pendingInputs = 0;
  instance.options = { maxQueue: 128 };
  instance.inputWindowStart = 0;
  instance.inputCount = 0;
  instance.startedAt = performance.now();

  instance.pause();

  assert.deepEqual(sent.map(message => message.event.type), ["KEY_UP", "KEY_UP"]);
  assert.deepEqual(sent.map(message => message.event.code), ["KeyW", "ArrowLeft"]);
  assert.equal(instance.held.size, 0);
});


test("dispose aborts an in-flight package fetch without surfacing a stale error", async () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  Object.assign(instance, {
    disposed: false, loading: false, worker: null, running: false, held: new Set(),
    pendingInputs: 0, _busy: false, _watchdogTimer: null, _inputAttached: false,
    _lastLoad: null, _loadController: null, errorElement: { remove() {} },
    options: {}, _reportError: () => assert.fail("disposed load must not report a UI error")
  });
  let observedSignal;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    observedSignal = options.signal;
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  try {
    const loading = instance.load("https://example.test/games/snake/");
    await Promise.resolve();
    assert.ok(observedSignal);
    await instance.dispose();
    await assert.rejects(loading, error => error.name === "AbortError");
    assert.equal(observedSignal.aborted, true);
    assert.equal(instance._loadController, null);
    assert.equal(instance.worker, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispose performs bounded worker shutdown and is idempotent", async () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  let terminated = 0;
  let shutdowns = 0;
  const listeners = new Set();
  const worker = {
    postMessage(message) {
      if (message.type === "SHUTDOWN") {
        shutdowns++;
        for (const listener of listeners) listener({ data: { type: "SHUTDOWN_ACK" } });
      }
    },
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    terminate() { terminated++; }
  };
  Object.assign(instance, {
    disposed: false, running: false, held: new Set(), worker, pendingInputs: 0,
    _busy: false, _watchdogTimer: null, _inputAttached: false,
    _loadController: null, errorElement: { remove() {} }, options: {}
  });
  await instance.dispose();
  await instance.dispose();
  assert.equal(shutdowns, 1);
  assert.equal(terminated, 1);
  assert.equal(instance.worker, null);
  assert.equal(instance.disposed, true);
});


test("maps pointer coordinates through CSS scaling and centered letterboxing", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  instance.width = 320;
  instance.height = 180;
  instance.canvas = { getBoundingClientRect: () => ({
    left: 10, top: 20, width: 640, height: 480
  }) };
  // The 16:9 logical canvas occupies 640x360 inside a 640x480 box.
  assert.deepEqual(instance._logicalPoint(10, 80), { x: 0, y: 0 });
  assert.deepEqual(instance._logicalPoint(330, 260), { x: 160, y: 90 });
  assert.deepEqual(instance._logicalPoint(650, 440), { x: 320, y: 180 });
  // Pointer positions in the letterbox bars clamp to the nearest game edge.
  assert.deepEqual(instance._logicalPoint(330, 20), { x: 160, y: 0 });
  assert.deepEqual(instance._logicalPoint(330, 500), { x: 160, y: 180 });
});

test("maps pointer coordinates for a vertically letterboxed logical canvas", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  instance.width = 320;
  instance.height = 180;
  instance.canvas = { getBoundingClientRect: () => ({
    left: 0, top: 0, width: 800, height: 360
  }) };
  // A 640x360 game viewport is centered in the wider CSS box.
  assert.deepEqual(instance._logicalPoint(80, 180), { x: 0, y: 90 });
  assert.deepEqual(instance._logicalPoint(400, 180), { x: 160, y: 90 });
  assert.deepEqual(instance._logicalPoint(720, 180), { x: 320, y: 90 });
});


test("keyboard input is captured only by the focused player and focus loss releases held keys", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  const sent = [];
  const canvas = { contains: element => element?.parent === canvas, focus: () => { focused = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) };
  let focused = false;
  Object.assign(instance, {
    canvas, width: 320, height: 180, running: true,
    manifest: { runtime: { capabilities: ["input.keyboard", "input.pointer"] } },
    held: new Set(), startedAt: performance.now(), _send: event => sent.push(event),
    _focusout: () => instance._clearInput()
  });
  const originalDocument = globalThis.document;
  let prevented = 0;
  const event = type => ({ type, code: "ArrowLeft", shiftKey: false, ctrlKey: false,
    altKey: false, metaKey: false, preventDefault: () => { prevented++; } });
  try {
    globalThis.document = { activeElement: {} };
    instance._keyEvent(event("keydown"));
    assert.equal(prevented, 0);
    assert.equal(sent.length, 0);

    globalThis.document.activeElement = canvas;
    instance._keyEvent(event("keydown"));
    assert.equal(prevented, 1);
    assert.deepEqual(sent.map(item => item.type), ["KEY_DOWN"]);
    assert.equal(instance.held.has("ArrowLeft"), true);

    instance._focusout();
    assert.deepEqual(sent.map(item => item.type), ["KEY_DOWN", "KEY_UP"]);
    assert.equal(instance.held.size, 0);

    instance._pointerEvent({ type: "pointerdown", clientX: 0, clientY: 0, button: 0,
      buttons: 1, shiftKey: false, ctrlKey: false, altKey: false });
    assert.equal(focused, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});

test("resume restarts the fixed-step loop after pause and resets accumulated time", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  let scheduled;
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { scheduled = callback; return 17; };
  try {
    Object.assign(instance, {
      disposed: false, worker: {}, running: false, last: 0, acc: 0.08, _raf: 0
    });
    instance.resume();
    assert.equal(instance.running, true);
    assert.ok(instance.last > 0);
    assert.equal(instance.acc, 0);
    assert.equal(instance._raf, 17);
    assert.equal(typeof scheduled, "function");
    instance.resume();
    assert.equal(instance._raf, 17);
    instance.disposed = true;
    instance.running = false;
    instance.resume();
    assert.equal(instance.running, false);
  } finally {
    if (original === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = original;
  }
});


test("input timestamps use the pause-aware simulation clock", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  Object.assign(instance, { simulationMicros: 50000, acc: 0.002 });
  assert.equal(instance._timestampMicros(), 52000);
});

test("pause commits fractional simulation time without advancing paused wall time", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  const original = globalThis.cancelAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  try {
    Object.assign(instance, {
      running: true, _raf: 1, simulationMicros: 50000, acc: 0.002,
      _clearInput: () => {}
    });
    instance.pause();
    assert.equal(instance.simulationMicros, 52000);
    assert.equal(instance.acc, 0);
    assert.equal(instance._timestampMicros(), 52000);
  } finally {
    if (original === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = original;
  }
});

test("simulation stays at 60 Hz while presentation is capped at 30 Hz", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  const posted = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  try {
    Object.assign(instance, {
      running: true, last: 0, lastRender: 0, acc: 0, step: 1 / 60,
      renderInterval: 1 / 30, maxCatchUpSteps: 6, simulationMicros: 0, _busy: false,
      _timedPost: message => { posted.push(message); instance._busy = true; }
    });
    instance._tick(34);
    assert.deepEqual(posted, [{ type: "TICK", dtMicros: 16667, steps: 2 }]);
    assert.equal(instance.simulationMicros, 33334);
    assert.ok(Math.abs(instance.acc - (34 / 1000 - 2 / 60)) < 1e-9, "retain the fractional remainder after fixed updates");
    instance._tick(50);
    assert.equal(posted.length, 1, "do not render again before the 30 Hz presentation interval");
    instance._busy = false;
    instance._tick(68);
    assert.deepEqual(posted[1], { type: "TICK", dtMicros: 16667, steps: 2 });
    assert.equal(instance.simulationMicros, 66668);
    assert.equal(posted.length, 2);
  } finally {
    if (original === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = original;
  }
});

test("malformed and unknown worker messages terminate the worker and report an error", () => {
  for (const message of [
    null,
    { type: "INPUT_ACK" },
    { type: "FRAME", width: 1, height: 1, frame: new ArrayBuffer(3) },
    { type: "UNEXPECTED" }
  ]) {
    const instance = Object.create(WasmGamePlayer.prototype);
    let terminated = 0;
    let reported;
    const worker = { onmessage: () => {}, onerror: () => {}, onmessageerror: () => {}, terminate: () => { terminated++; } };
    Object.assign(instance, {
      worker, width: 1, height: 1, held: new Set(), pendingInputs: 0, _busy: true,
      _watchdogTimer: null, running: false, _inputAttached: false,
      _reportError: error => { reported = error; }
    });
    instance._message(message);
    assert.equal(terminated, 1);
    assert.equal(instance.worker, null);
    assert.equal(instance.pendingInputs, 0);
    assert.equal(instance._busy, false);
    assert.ok(reported instanceof Error);
  }
});

test("worker protocol failure clears a pending watchdog and detaches worker handlers", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  let terminated = 0;
  let reported;
  const worker = { onmessage: 1, onerror: 1, onmessageerror: 1, terminate: () => { terminated++; } };
  Object.assign(instance, {
    worker, width: 1, height: 1, held: new Set(), pendingInputs: 1, _busy: true,
    _watchdogTimer: setTimeout(() => assert.fail("watchdog should be cleared"), 1000),
    running: false, _inputAttached: false, _reportError: error => { reported = error; }
  });
  instance._message({ type: "INPUT_ACK", extra: true });
  assert.equal(terminated, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
  assert.equal(instance._watchdogTimer, null);
  assert.match(reported.message, /acknowledgement/);
});


test("rejects an unsolicited otherwise-valid framebuffer", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  let terminated = 0;
  let reported;
  Object.assign(instance, {
    worker: { terminate: () => { terminated++; } }, width: 1, height: 1,
    held: new Set(), pendingInputs: 0, _busy: false, _watchdogTimer: null,
    running: false, _inputAttached: false, _reportError: error => { reported = error; }
  });
  instance._message({ type: "FRAME", width: 1, height: 1, frame: new ArrayBuffer(4) });
  assert.equal(terminated, 1);
  assert.match(reported.message, /invalid framebuffer/);
});


test("input postMessage failure rolls back queue accounting and terminates the worker", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  let terminated = 0;
  let reported;
  const worker = { onmessage: 1, onerror: 1, onmessageerror: 1,
    postMessage() { throw new Error("detached worker"); }, terminate() { terminated++; } };
  Object.assign(instance, {
    worker, pendingInputs: 0, options: { maxQueue: 128 }, inputWindowStart: 0,
    inputCount: 0, held: new Set(), running: false, _busy: false,
    _watchdogTimer: null, _inputAttached: false,
    _reportError: error => { reported = error; }
  });
  instance._send({ type: "KEY_DOWN", code: "KeyW", modifiers: 0, timestamp_micros: 1 });
  assert.equal(instance.pendingInputs, 0);
  assert.equal(instance.worker, null);
  assert.equal(terminated, 1);
  assert.match(reported.message, /input delivery failed/);
});

test("tick postMessage failure clears watchdog state and reports a recoverable error", () => {
  const instance = Object.create(WasmGamePlayer.prototype);
  let terminated = 0;
  let reported;
  const worker = { onmessage: 1, onerror: 1, onmessageerror: 1,
    postMessage() { throw new Error("worker unavailable"); }, terminate() { terminated++; } };
  Object.assign(instance, {
    worker, pendingInputs: 0, held: new Set(), running: false, _busy: false,
    _watchdogTimer: null, _inputAttached: false,
    options: { watchdogMs: 1000 }, _reportError: error => { reported = error; }
  });
  instance._timedPost({ type: "TICK", dtMicros: 16667, steps: 1 });
  assert.equal(instance._watchdogTimer, null);
  assert.equal(instance._busy, false);
  assert.equal(instance.worker, null);
  assert.equal(terminated, 1);
  assert.match(reported.message, /message delivery failed/);
});
