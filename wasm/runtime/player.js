const DEFAULTS = { maxModuleBytes: 16*1024*1024, maxMemoryPages: 256, maxOutputBytes: 4*1024*1024, watchdogMs: 1000, maxQueue: 128 };
const KEY_CODES = new Set(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","KeyW","KeyA","KeyS","KeyD","Space","Enter","Escape"]);
const safePath = p => {
  if (typeof p !== "string" || !p.length || p.length > 240 || p.startsWith("/") || p.includes("\\\\") || /[%\\u0000-\\u001f\\u007f]/.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p)) return false;
  let decoded; try { decoded = decodeURIComponent(p); } catch { return false; }
  return decoded === p && !p.split("/").some(x => !x || x === "." || x === "..");
};
async function readLimited(response, limit, label) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > limit) throw Error(label + " size limit exceeded");
  if (!response.body?.getReader) throw Error("streaming response body required");
  const reader = response.body.getReader(), chunks=[]; let total=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if(done) break;
      total += value.byteLength;
      if(total > limit) { await reader.cancel(); throw Error(label + " size limit exceeded"); }
      chunks.push(value);
    }
  } catch(e) { try { await reader.cancel(); } catch {} throw e; }
  const bytes=new Uint8Array(total); let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

export class WasmGamePlayer {
  constructor(canvas, options={}) {
    if(!(canvas instanceof HTMLCanvasElement)) throw new TypeError("canvas required");
    this.canvas=canvas; this.options={...DEFAULTS,...options}; this.inputWindowStart=0; this.inputCount=0; this.lastPointerMove=0; this.pendingInputs=0; this._watchdogTimer=null; this.startedAt=0; this.held=new Set(); this.running=false; this.disposed=false; this.last=0; this.acc=0; this.step=1/60; this.worker=null;
    this.ctx=canvas.getContext("2d",{alpha:false}); if(!this.ctx) throw Error("2D canvas unavailable");
    this._key=e=>this._keyEvent(e); this._pointer=e=>this._pointerEvent(e);
    this._blur=()=>this._clearInput(); this._visibility=()=>{if(document.hidden)this.pause();};
  }
  async load(packageUrl, config={}) {
    if(this.disposed) throw Error("player disposed");
    const base=new URL(".",packageUrl), manifestUrl=new URL("manifest.json",base);
    const mr=await fetch(manifestUrl,{credentials:"omit",redirect:"error"});
    if(!mr.ok) throw Error("manifest fetch failed: "+mr.status);
    const manifestBytes=await readLimited(mr,64*1024,"manifest");
    let manifest;
    try { manifest=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(manifestBytes)); }
    catch { throw Error("manifest is not valid UTF-8 JSON"); }
    this._validateManifest(manifest);
    const wasmUrl=new URL(manifest.entry,base);
    if(wasmUrl.origin!==base.origin || !wasmUrl.pathname.startsWith(base.pathname)) throw Error("entry escapes package root");
    const response=await fetch(wasmUrl,{credentials:"omit",redirect:"error"});
    if(!response.ok) throw Error("WASM fetch failed: "+response.status);
    const caps=manifest.runtime.wasm;
    const bytes=await readLimited(response,this.options.maxModuleBytes,"WASM module");
    if(!bytes.byteLength) throw Error("empty WASM module");
    this.manifest=manifest; this.width=manifest.runtime.display.width; this.height=manifest.runtime.display.height;
    this.canvas.width=this.width; this.canvas.height=this.height;
    this.worker=new Worker(new URL("./worker.js",import.meta.url),{type:"module",name:"bombless-wasm-game"});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.worker?.terminate();this.worker=null;reject(Error("WASM initialization timeout"));},this.options.watchdogMs);
      this.worker.onmessage=({data})=>{
        if(data.type==="READY"){clearTimeout(timer);resolve();}
        else if(data.type==="ERROR"){clearTimeout(timer);this.worker.terminate();this.worker=null;reject(Error(data.message));}
      };
      this.worker.onerror=()=>{clearTimeout(timer);this.worker?.terminate();this.worker=null;reject(Error("WASM worker failed"));};
      this.worker.postMessage({type:"INIT",bytes:bytes.buffer,config:{...config,runtime:manifest.runtime},limits:{
        maxMemoryPages:Math.min(caps.maxMemoryPages,this.options.maxMemoryPages),
        maxOutputBytes:Math.min(caps.maxOutputBytes,this.options.maxOutputBytes)
      }},[bytes]);
    });
    this.worker.onmessage=({data})=>this._message(data);
    this.startedAt=performance.now();
    this._attachInput(); this.resume(); return manifest;
  }
  _validateManifest(m) {
    if(!m||typeof m!=="object"||Array.isArray(m)||m.manifestVersion!==1||m.pluginType!=="wasm"||!m.runtime||m.runtime.apiVersion!=="1") throw Error("invalid plugin manifest");
    if(typeof m.name!=="string"||!m.name.trim()||m.name.length>120||typeof m.version!=="string"||!/^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(m.version)) throw Error("invalid plugin metadata");
    const allowedTop=new Set(["manifestVersion","id","name","version","pluginType","entry","runtime"]);
    if(Object.keys(m).some(k=>!allowedTop.has(k))) throw Error("unknown manifest field");
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.id||"")||!safePath(m.entry)||!m.entry.endsWith(".wasm")) throw Error("invalid plugin id or entry");
    const d=m.runtime.display,w=m.runtime.wasm;
    if(!d||!Number.isInteger(d.width)||!Number.isInteger(d.height)||d.width<1||d.height<1||d.width>1024||d.height>1024) throw Error("invalid display dimensions");
    if(!w||w.abi!=="bombless-game-abi"||w.abiVersion!==1||w.renderMode!=="rgba"||!Number.isInteger(w.maxMemoryPages)||w.maxMemoryPages<1||w.maxMemoryPages>256||!Number.isInteger(w.maxOutputBytes)||w.maxOutputBytes<4||w.maxOutputBytes>4*1024*1024) throw Error("invalid WASM limits/ABI");
    const allowedCaps=new Set(["input.keyboard","input.pointer","audio","storage","score"]);
    if(!Array.isArray(m.runtime.capabilities)||m.runtime.capabilities.length>16||new Set(m.runtime.capabilities).size!==m.runtime.capabilities.length||m.runtime.capabilities.some(x=>!allowedCaps.has(x))) throw Error("invalid capabilities");
    if(Object.keys(m.runtime).some(k=>!["apiVersion","display","capabilities","wasm"].includes(k))) throw Error("unknown runtime field");
    if(d.pixelScale!==undefined&&!["integer","fit"].includes(d.pixelScale)) throw Error("invalid pixelScale");
    if(d.orientation!==undefined&&!["landscape","portrait","any"].includes(d.orientation)) throw Error("invalid orientation");
    if(Object.keys(d).some(k=>!["width","height","pixelScale","orientation"].includes(k))) throw Error("unknown display field");
    if(Object.keys(w).some(k=>!["abi","abiVersion","maxMemoryPages","maxOutputBytes","renderMode"].includes(k))) throw Error("unknown WASM field");
  }
  _message(data) {
    if(data.type==="INPUT_ACK"){this.pendingInputs=Math.max(0,this.pendingInputs-1);return;}
    if(data.type==="ERROR"){
      clearTimeout(this._watchdogTimer); this._watchdogTimer=null; this._busy=false;
      this.pause();this.worker?.terminate();this.worker=null;this.pendingInputs=0;
      this.options.onError?.(new Error(data.message));return;
    }
    if(data.type==="FRAME" && data.width===this.width && data.height===this.height && data.frame instanceof ArrayBuffer && data.frame.byteLength===this.width*this.height*4) {
      clearTimeout(this._watchdogTimer); this._watchdogTimer=null; this._busy=false;
      this.ctx.putImageData(new ImageData(new Uint8ClampedArray(data.frame),this.width,this.height),0,0);
    }
  }
  _attachInput() {
    window.addEventListener("keydown",this._key); window.addEventListener("keyup",this._key);
    this.canvas.addEventListener("pointerdown",this._pointer); this.canvas.addEventListener("pointerup",this._pointer);
    this.canvas.addEventListener("pointermove",this._pointer); this.canvas.addEventListener("pointercancel",this._pointer);
    window.addEventListener("blur",this._blur); document.addEventListener("visibilitychange",this._visibility);
  }
  _keyEvent(e) {
    if(!this.manifest.runtime.capabilities.includes("input.keyboard")||!KEY_CODES.has(e.code)) return;
    if(e.type==="keydown"){if(this.held.has(e.code))return;this.held.add(e.code);} else this.held.delete(e.code);
    e.preventDefault(); this._send({type:e.type==="keydown"?"KEY_DOWN":"KEY_UP",code:e.code,modifiers:(e.shiftKey?1:0)|(e.ctrlKey?2:0)|(e.altKey?4:0)|(e.metaKey?8:0),timestamp_micros:this._timestampMicros()});
  }
  _pointerEvent(e) {
    if(!this.manifest.runtime.capabilities.includes("input.pointer")) return;
    const now=performance.now(); if(e.type==="pointermove" && now-this.lastPointerMove<16)return; if(e.type==="pointermove")this.lastPointerMove=now;
    const r=this.canvas.getBoundingClientRect(),x=(e.clientX-r.left)*this.width/r.width,y=(e.clientY-r.top)*this.height/r.height;
    const type={pointerdown:"POINTER_DOWN",pointerup:"POINTER_UP",pointermove:"POINTER_MOVE",pointercancel:"POINTER_CANCEL"}[e.type];
    if(type!=="POINTER_MOVE" && this.canvas.setPointerCapture && e.type==="pointerdown") this.canvas.setPointerCapture(e.pointerId);
    this._send({type,x:Math.max(0,Math.min(this.width,x)),y:Math.max(0,Math.min(this.height,y)),code:e.button,buttons:e.buttons,modifiers:(e.shiftKey?1:0)|(e.ctrlKey?2:0)|(e.altKey?4:0),timestamp_micros:this._timestampMicros()});
  }
  _timestampMicros() { return Math.max(0,Math.round((performance.now()-this.startedAt)*1000)); }
  _send(event) {
    if(!this.worker || this.pendingInputs>=this.options.maxQueue+(event.type==="KEY_UP"?32:0))return;
    const now=performance.now(); if(now-this.inputWindowStart>=1000){this.inputWindowStart=now;this.inputCount=0;}
    if(this.inputCount>=128)return; this.inputCount++; this.pendingInputs++;
    this.worker.postMessage({type:"INPUT",event});
  }
  _clearInput() { for(const code of this.held)this._send({type:"KEY_UP",code,modifiers:0,timestamp_micros:Math.round(performance.now()*1000)});this.held.clear(); }
  resume() { if(this.disposed||!this.worker||this.running)return;this.running=true;this.last=performance.now();this.acc=0;this._raf=requestAnimationFrame(t=>this._tick(t)); }
  pause() { if(!this.running)return;this.running=false;cancelAnimationFrame(this._raf);this._clearInput(); }
  _tick(now) {
    if(!this.running)return;
    const elapsed=Math.min((now-this.last)/1000,0.1);this.last=now;this.acc=Math.min(this.acc+elapsed,0.1);
    if(this.acc>=this.step&&!this._busy){this._timedPost({type:"TICK",dtMicros:16667});this.acc-=this.step;}
    this._raf=requestAnimationFrame(t=>this._tick(t));
  }
  _timedPost(message) {
    if(this._busy)return;this._busy=true;
    clearTimeout(this._watchdogTimer);
    this._watchdogTimer=setTimeout(()=>{
      this._watchdogTimer=null; this.pause(); this.worker?.terminate(); this.worker=null;
      this.pendingInputs=0; this._busy=false;
      this.options.onError?.(Error("WASM watchdog timeout"));
    },this.options.watchdogMs);
    this.worker.postMessage(message);
  }
  async dispose() {
    if(this.disposed)return;this.pause();this.disposed=true;this._clearInput();
    window.removeEventListener("keydown",this._key);window.removeEventListener("keyup",this._key);
    this.canvas.removeEventListener("pointerdown",this._pointer);this.canvas.removeEventListener("pointerup",this._pointer);this.canvas.removeEventListener("pointermove",this._pointer);this.canvas.removeEventListener("pointercancel",this._pointer);
    window.removeEventListener("blur",this._blur);document.removeEventListener("visibilitychange",this._visibility);
    if(this.worker){this.worker.postMessage({type:"SHUTDOWN"});this.worker.terminate();this.worker=null;}
  }
}
