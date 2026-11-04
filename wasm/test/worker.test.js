import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const workerSource = await readFile(new URL("../runtime/worker.js", import.meta.url), "utf8");
const validModule = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
const realModuleBase64 = (await readFile(new URL("./fixtures/minimal-valid.wasm.b64", import.meta.url), "utf8")).trim();
const realModule = Uint8Array.from(Buffer.from(realModuleBase64, "base64")).buffer;
const invalidFixtures = JSON.parse(await readFile(new URL("./fixtures/invalid-fixtures.json", import.meta.url), "utf8"));
const fixtureBytes = name => Uint8Array.from(Buffer.from(invalidFixtures[name], "base64")).buffer;\n
function wrongGameInitSignature(moduleBytes) {
  const bytes = new Uint8Array(moduleBytes.slice(0));
  const read = state => {
    let value = 0, shift = 0, byte;
    do { byte = bytes[state.offset++]; value |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return value >>> 0;
  };
  const name = state => {
    const length = read(state);
    const value = new TextDecoder().decode(bytes.subarray(state.offset, state.offset + length));
    state.offset += length;
    return value;
  };
  let functionSection = null, gameInitIndex = -1, section = 8;
  while (section < bytes.length) {
    const id = bytes[section++];
    const state = { offset: section };
    const size = read(state), end = state.offset + size;
    if (id === 3) {
      const count = read(state), entries = [];
      for (let i = 0; i < count; i++) entries.push(state.offset), read(state);
      functionSection = { entries };
    } else if (id === 7) {
      const count = read(state);
      for (let i = 0; i < count; i++) {
        const exportName = name(state), kind = bytes[state.offset++], index = read(state);
        if (exportName === "game_init" && kind === 0) gameInitIndex = index;
      }
    }
    section = end;
  }
  assert.ok(functionSection);
  assert.ok(gameInitIndex >= 0);
  // A valid ABI module has at least one alternate function type. Point
  // game_init at type zero while retaining the original section encoding.
  const typeEntryOffset = functionSection.entries[gameInitIndex];
  assert.notEqual(bytes[typeEntryOffset], 0);
  bytes[typeEntryOffset] = 0;
  return bytes.buffer;
}


function realHarness() {
  const messages = [];
  const scope = {
    WebAssembly, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, JSON, Number, Math, Set, Error,
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
    init: async (bytes = realModule) => scope.onmessage({ data: {
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


test("real invalid WASM fixtures are rejected at the ABI boundary", async () => {
  const imported = realHarness();
  await imported.init(fixtureBytes("invalid-import"));
  assert.match(imported.messages.at(-1).message, /imports/);

  const missing = realHarness();
  await missing.init(fixtureBytes("missing-render"));
  assert.match(missing.messages.at(-1).message, /missing export: game_render/);

  const abi = realHarness();
  await abi.init(fixtureBytes("invalid-version"));
  assert.match(abi.messages.at(-1).message, /ABI version/);

  const dimensions = realHarness();
  await dimensions.init(fixtureBytes("invalid-dimensions"));
  assert.match(dimensions.messages.at(-1).message, /dimensions/);

  const pointer = realHarness();
  await pointer.init(fixtureBytes("invalid-pointer"));
  assert.match(pointer.messages.at(-1).message, /pointer/);

  const output = realHarness();
  await output.init(fixtureBytes("invalid-output"));
  assert.match(output.messages.at(-1).message, /range/);

  const memory = realHarness();
  await memory.init(fixtureBytes("invalid-memory"));
  assert.match(memory.messages.at(-1).message, /memory limit/);

  const trap = realHarness();
  await trap.init(fixtureBytes("invalid-trap"));
  assert.equal(trap.messages.at(-1).type, "READY");
  await trap.send({ type: "TICK", dtMicros: 16667 });
  assert.equal(trap.messages.at(-1).type, "ERROR");
});


test("rejects unknown message types and unexpected top-level fields", async () => {
  const unknown = harness();
  await unknown.send({ type: "EXECUTE" });
  assert.match(unknown.messages.at(-1).message, /unknown worker message type/);

  const extraInit = harness();
  await extraInit.send({ type: "INIT", bytes: realModule, config: {}, limits: { maxMemoryPages: 2, maxOutputBytes: 4096 }, host: true });
  assert.match(extraInit.messages.at(-1).message, /malformed INIT/);

  const extraInput = harness();
  await extraInput.init();
  await extraInput.send({ type: "INPUT", event: { type: "KEY_DOWN", code: "KeyW", modifiers: 0, timestamp_micros: 1 }, host: true });
  assert.match(extraInput.messages.at(-1).message, /malformed INPUT/);
});

test("rejects malformed tick payloads and shutdown before initialization", async () => {
  const tick = harness();
  await tick.init();
  await tick.send({ type: "TICK", dtMicros: 16667, elapsed: 1 });
  assert.match(tick.messages.at(-1).message, /malformed TICK/);

  const shutdown = harness();
  await shutdown.send({ type: "SHUTDOWN" });
  assert.match(shutdown.messages.at(-1).message, /shutdown before initialization/);
});

test("rejects a real module whose game_init export has the wrong WASM signature", async () => {
  const h = realHarness();
  await h.init(wrongGameInitSignature(realModule));
  assert.equal(h.messages.at(-1).type, "ERROR");
  assert.match(h.messages.at(-1).message, /invalid ABI signature: game_init/);
});
