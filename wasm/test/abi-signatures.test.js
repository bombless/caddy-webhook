import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const workerSource = await readFile(new URL("../runtime/worker.js", import.meta.url), "utf8");
const fixture = (await readFile(new URL("./fixtures/minimal-valid.wasm.b64", import.meta.url), "utf8")).trim();
const validModule = Uint8Array.from(Buffer.from(fixture, "base64"));

const requiredExports = [
  "game_abi_version", "game_init", "game_update", "game_input", "game_render",
  "game_shutdown", "game_get_width", "game_get_height",
  "game_get_render_buffer_ptr", "game_get_render_buffer_len",
  "game_get_config_buffer_ptr", "game_get_config_buffer_capacity",
  "game_get_input_buffer_ptr", "game_get_input_buffer_capacity"
];

function readU32(bytes, state) {
  let value = 0, shift = 0, byte;
  do {
    assert.ok(state.offset < bytes.length, "truncated LEB128");
    byte = bytes[state.offset++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return value >>> 0;
}

function wrongExportSignature(moduleBytes, target) {
  const bytes = new Uint8Array(moduleBytes);
  let functionTypeOffsets = [];
  const exports = new Map();
  const readName = state => {
    const length = readU32(bytes, state);
    const end = state.offset + length;
    assert.ok(end <= bytes.length, "truncated export name");
    const value = new TextDecoder().decode(bytes.subarray(state.offset, end));
    state.offset = end;
    return value;
  };

  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const state = { offset };
    const size = readU32(bytes, state);
    const end = state.offset + size;
    assert.ok(end <= bytes.length, "truncated section");
    if (id === 3) {
      const count = readU32(bytes, state);
      functionTypeOffsets = [];
      for (let i = 0; i < count; i++) {
        functionTypeOffsets.push(state.offset);
        readU32(bytes, state);
      }
    } else if (id === 7) {
      const count = readU32(bytes, state);
      for (let i = 0; i < count; i++) {
        const name = readName(state);
        const kind = bytes[state.offset++];
        const index = readU32(bytes, state);
        exports.set(name, { kind, index });
      }
    }
    offset = end;
  }

  const item = exports.get(target);
  assert.ok(item, `fixture must export ${target}`);
  assert.equal(item.kind, 0, `${target} must be a function export`);
  const typeOffset = functionTypeOffsets[item.index];
  assert.notEqual(typeOffset, undefined, `${target} must reference a defined function`);
  // A one-byte out-of-range type index is caught by the runtime's ABI
  // signature preflight before WebAssembly.compile/instantiate is reached.
  assert.ok(bytes[typeOffset] < 0x80, "fixture type index must use one-byte LEB128");
  bytes[typeOffset] = 0x7f;
  return bytes.buffer;
}

async function initialize(bytes) {
  const messages = [];
  const scope = {
    WebAssembly, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
    JSON, Number, Math, Set, Error,
    postMessage: message => messages.push(message),
    close() {}
  };
  runInNewContext(workerSource, scope);
  await scope.onmessage({ data: {
    type: "INIT",
    bytes,
    config: { runtime: { display: { width: 1, height: 1 } } },
    limits: { maxMemoryPages: 2, maxOutputBytes: 4096 }
  } });
  return messages;
}

test("ABI preflight rejects a wrong signature for every required function export", async () => {
  for (const name of requiredExports) {
    const messages = await initialize(wrongExportSignature(validModule, name));
    assert.equal(messages.at(-1).type, "ERROR", name);
    assert.match(messages.at(-1).message, new RegExp(`invalid ABI signature: ${name}`), name);
  }
});

test("ABI preflight accepts the complete valid ABI v1 fixture", async () => {
  const messages = await initialize(validModule.buffer);
  assert.equal(messages[0].type, "READY");
});
