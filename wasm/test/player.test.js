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
