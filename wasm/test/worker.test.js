import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const workerSource = await readFile(new URL("../runtime/worker.js", import.meta.url), "utf8");
const validModule = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
const realModuleBase64 = (await readFile(new URL("./fixtures/minimal-valid.wasm.b64", import.meta.url), "utf8")).trim();
const realModule = Uint8Array.from(Buffer.from(realModuleBase64, "base64")).buffer;

function realHarness() {
  const messages = [];
  const scope = {
    WebAssembly, Uint8Array, ArrayBuffer, TextEncoder, JSON, Number, Math, Set, Error,
    postMessage: message => messages.push(message),
    close() {}
  };
  runInNewContext(workerSource, scope);
  return {
    messages,
    send: async data => { await scope.onmessage({ data }); },
    init: async (bytes = realModule) => scope.onmessage({ data: {
      type: "INIT", bytes, config: { runtime: { display: { width: 1, height: 1 } } },
      limits: { maxMemoryPages: 2, maxOutputBytes: 4096 }
    } })
  };
}

function harness(overrides = {}) {
  const messages = [];
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  const exports = {
    memory,
    game_abi_version: () => 1,
    game_init: () => 0,
    game_update: () => 0,
    game_input: () => 0,
    game_render: (_ptr, len) => len,
    game_shutdown: () => {},
    game_get_width: () => 1,
    game_get_height: () => 1,
    game_get_render_buffer_ptr: () => 1024,
    game_get_render_buffer_len: () => 4,
    game_get_config_buffer_ptr: () => 0,
    game_get_config_buffer_capacity: () => 128,
    game_get_input_buffer_ptr: () => 256,
    game_get_input_buffer_capacity: () => 128,
    ...overrides.exports
  };
  const wasm = {
    Memory: WebAssembly.Memory,
    Module: { imports: () => overrides.imports ?? [] },
    compile: async bytes => {
      await WebAssembly.compile(bytes);
      return {};
    },
    instantiate: async () => ({ exports })
  };
  const scope = {
    WebAssembly: wasm, Uint8Array, ArrayBuffer, TextEncoder, JSON, Number, Math, Set, Error,
    postMessage: message => messages.push(message),
    close() {}
  };
  runInNewContext(workerSource, scope);
  return {
    messages, memory,
    send: async data => { await scope.onmessage({ data }); },
    init: async (bytes = validModule) => scope.onmessage({ data: {
      type: "INIT", bytes, config: { runtime: { display: { width: 1, height: 1 } } },
      limits: { maxMemoryPages: 2, maxOutputBytes: 4096 }
    } })
  };
}

test("valid module initializes and produces a copied RGBA frame", async () => {
  const h = harness();
  await h.init();
  assert.equal(h.messages[0].type, "READY");
  assert.equal(h.messages[0].width, 1);
  assert.equal(h.messages[0].height, 1);
  await h.send({ type: "TICK", dtMicros: 16667 });
  assert.equal(h.messages[1].type, "FRAME");
  assert.equal(h.messages[1].frame.byteLength, 4);
});

test("rejects malformed messages and invalid initialization limits", async () => {
  const h = harness();
  await h.send(null);
  assert.equal(h.messages.at(-1).type, "ERROR");
  const h2 = harness();
  await h2.init(validModule.slice(0, 4));
  assert.equal(h2.messages.at(-1).type, "ERROR");
});

test("rejects modules with imports and missing required exports", async () => {
  const imported = harness({ imports: [{ module: "env", name: "host_call", kind: "function" }] });
  await imported.init();
  assert.match(imported.messages.at(-1).message, /imports/);
  const missing = harness({ exports: { game_render: undefined } });
  await missing.init();
  assert.match(missing.messages.at(-1).message, /missing export/);
});

test("rejects unsupported ABI versions and invalid framebuffer dimensions", async () => {
  const abi = harness({ exports: { game_abi_version: () => 99 } });
  await abi.init();
  assert.match(abi.messages.at(-1).message, /ABI version/);
  const dimensions = harness({ exports: { game_get_width: () => 0 } });
  await dimensions.init();
  assert.match(dimensions.messages.at(-1).message, /dimensions/);
});

test("rejects out-of-bounds guest buffers and malformed input events", async () => {
  const pointer = harness({ exports: { game_get_config_buffer_ptr: () => 65535 } });
  await pointer.init();
  assert.match(pointer.messages.at(-1).message, /range/);
  const h = harness();
  await h.init();
  await h.send({ type: "INPUT", event: { type: "KEY_DOWN", code: "NotAKey", modifiers: 0, timestamp_micros: 1 } });
  assert.match(h.messages.at(-1).message, /keyboard event/);
});


test("real ABI v1 WASM fixture initializes, accepts input, renders RGBA, and shuts down", async () => {
  const h = realHarness();
  await h.init();
  assert.equal(h.messages[0].type, "READY");
  assert.equal(h.messages[0].width, 1);
  assert.equal(h.messages[0].height, 1);
  await h.send({ type: "INPUT", event: {
    type: "KEY_DOWN", code: "KeyW", modifiers: 0, timestamp_micros: 1
  }});
  assert.equal(h.messages[1].type, "INPUT_ACK");
  await h.send({ type: "TICK", dtMicros: 16667 });
  assert.equal(h.messages[2].type, "FRAME");
  assert.deepEqual([...new Uint8Array(h.messages[2].frame)], [255, 0, 0, 255]);
  await h.send({ type: "SHUTDOWN" });
  assert.equal(h.messages[3].type, "SHUTDOWN_ACK");
});
