import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const workerSource = await readFile(new URL("../runtime/worker.js", import.meta.url), "utf8");
const fixture = (await readFile(new URL("./fixtures/minimal-valid.wasm.b64", import.meta.url), "utf8")).trim();
const validModule = Uint8Array.from(Buffer.from(fixture, "base64"));

function createWorker() {
  const messages = [];
  const scope = {
    WebAssembly, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    JSON, Number, Math, Set, Error,
    postMessage: message => messages.push(message),
    close() {}
  };
  runInNewContext(workerSource, scope);
  const send = async data => scope.onmessage({ data });
  const init = () => send({
    type: "INIT",
    bytes: validModule.buffer.slice(0),
    config: { runtime: { display: { width: 1, height: 1 } } },
    limits: { maxMemoryPages: 2, maxOutputBytes: 4096 }
  });
  return { messages, send, init };
}

test("worker rejects a second shutdown instead of silently accepting it", async () => {
  const worker = createWorker();
  await worker.init();
  assert.equal(worker.messages[0].type, "READY");

  await worker.send({ type: "SHUTDOWN" });
  assert.equal(worker.messages.at(-1).type, "SHUTDOWN_ACK");

  await worker.send({ type: "SHUTDOWN" });
  assert.equal(worker.messages.at(-1).type, "ERROR");
  assert.match(worker.messages.at(-1).message, /shutdown after worker stopped/);
});

test("worker rejects input and ticks after shutdown", async () => {
  for (const message of [
    { type: "INPUT", event: { type: "KEY_DOWN", code: "KeyW", modifiers: 0, timestamp_micros: 1 } },
    { type: "TICK", dtMicros: 16667 }
  ]) {
    const worker = createWorker();
    await worker.init();
    await worker.send({ type: "SHUTDOWN" });
    await worker.send(message);
    assert.equal(worker.messages.at(-1).type, "ERROR", message.type);
    assert.match(worker.messages.at(-1).message, /invalid lifecycle state/, message.type);
  }
});
