import { WasmGamePlayer } from "./wasm/runtime/player.js";

const canvas = document.querySelector("#game");
const status = document.querySelector("#status");
const loading = document.querySelector("#loading");
const pauseButton = document.querySelector("#pause");
const events = document.querySelector("#events");
let player;
let startedAt = performance.now();

function log(message) {
  const elapsed = Math.floor((performance.now() - startedAt) / 1000);
  const row = document.createElement("li");
  const time = document.createElement("time");
  const text = document.createElement("span");
  time.textContent = `00:${String(elapsed).padStart(2, "0")}`;
  text.textContent = message;
  row.append(time, text);
  events.prepend(row);
  while (events.children.length > 6) events.lastElementChild.remove();
}
function setStatus(value) { status.textContent = value; }
async function boot() {
  startedAt = performance.now();
  setStatus("STARTING");
  pauseButton.disabled = true;
  loading.hidden = false;
  try {
    player = new WasmGamePlayer(canvas, {
      grantedCapabilities: ["input.keyboard", "input.pointer"],
      renderHz: 30,
      onError(error) { setStatus("ERROR"); log(`Runtime error: ${error.message}`); }
    });
    await player.load(new URL("./games/snake/", import.meta.url), { difficulty: "normal" });
    loading.hidden = true;
    setStatus("RUNNING");
    pauseButton.disabled = false;
    pauseButton.textContent = "Pause runtime";
    log("WASM module initialized");
    log("Worker handshake complete");
    log("Keyboard capability granted");
    canvas.focus({ preventScroll: true });
  } catch (error) {
    loading.textContent = "COULD NOT START";
    loading.querySelector("span").textContent = error.message;
    setStatus("ERROR");
    log(`Load failed: ${error.message}`);
  }
}
pauseButton.addEventListener("click", () => {
  if (!player) return;
  if (player.running) {
    player.pause();
    pauseButton.textContent = "Resume runtime";
    setStatus("PAUSED");
    log("Simulation paused · input released");
  } else {
    player.resume();
    pauseButton.textContent = "Pause runtime";
    setStatus("RUNNING");
    log("Simulation resumed");
    canvas.focus({ preventScroll: true });
  }
});
document.querySelector("#restart").addEventListener("click", () => location.reload());
window.addEventListener("pagehide", () => player?.dispose(), { once: true });
boot();
