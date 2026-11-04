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
