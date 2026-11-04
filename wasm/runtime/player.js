const DEFAULTS = { maxModuleBytes: 16*1024*1024, maxMemoryPages: 256, maxOutputBytes: 4*1024*1024, watchdogMs: 1000, maxQueue: 128, renderHz: 30 };
const IMPLEMENTED_CAPABILITIES = new Set(["input.keyboard", "input.pointer"]);
const KEY_CODES = new Set(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","KeyW","KeyA","KeyS","KeyD","Space","Enter","Escape"]);
const safePath = p => {
  if (typeof p !== "string" || !p.length || p.length > 240 || p.startsWith("/") || p.includes("\\") || /[%\u0000-\u001f\u007f]/.test(p) || !/^[A-Za-z0-9._/-]+$/.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p)) return false;
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
    this.canvas=canvas; this.options={...DEFAULTS,...options};
    if(!Array.isArray(this.options.grantedCapabilities) || this.options.grantedCapabilities.some(cap=>typeof cap!=="string"||!IMPLEMENTED_CAPABILITIES.has(cap)) || new Set(this.options.grantedCapabilities).size!==this.options.grantedCapabilities.length) throw new TypeError("grantedCapabilities must contain unique, implemented capability names");
    const renderHz=Number.isFinite(this.options.renderHz)?this.options.renderHz:DEFAULTS.renderHz;
    this.renderInterval=1/Math.min(60,Math.max(10,renderHz));
    this.maxCatchUpSteps=6;
    this.inputWindowStart=0; this.inputCount=0; this.lastPointerMove=0; this.pendingInputs=0; this._watchdogTimer=null; this.startedAt=0; this.simulationMicros=0; this.held=new Set(); this.running=false; this.disposed=false; this.last=0; this.lastRender=0; this.acc=0; this.step=1/60; this.worker=null; this.loading=false; this._inputAttached=false; this._lastLoad=null; this._busy=false; this._loadController=null;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    this.ctx=canvas.getContext("2d",{alpha:false}); if(!this.ctx) throw Error("2D canvas unavailable");
    this._key=e=>this._keyEvent(e); this._pointer=e=>this._pointerEvent(e);
    this._blur=()=>this.pause(); this._visibility=()=>{if(document.hidden)this.pause();};
    this._focusout=()=>this._clearInput();
    this.errorElement=document.createElement("div");
    this.errorElement.setAttribute("role","alert"); this.errorElement.setAttribute("aria-live","assertive");
    this.errorElement.hidden=true;
    this.errorMessage=document.createElement("span");
    this.retryButton=document.createElement("button"); this.retryButton.type="button"; this.retryButton.textContent="Retry";
    this.retryButton.addEventListener("click",()=>{if(this._lastLoad&&!this.disposed)this.load(this._lastLoad.packageUrl,this._lastLoad.config).catch(()=>{});});
    this.errorElement.append(this.errorMessage,this.retryButton);
    canvas.parentNode?.insertBefore(this.errorElement,canvas.nextSibling);
  }
  async load(packageUrl, config={}) {
    if(this.disposed) throw Error("player disposed");
    if(this.loading||this.worker) throw Error("player is already loading or running; dispose it before loading another package");
    this.loading=true; this._lastLoad={packageUrl,config};
    const controller=new AbortController(); this._loadController=controller;
    const assertActive=()=>{if(this.disposed||controller.signal.aborted) throw new DOMException("Load aborted","AbortError");};
    try {
    const base=new URL(".",packageUrl), manifestUrl=new URL("manifest.json",base);
    const mr=await fetch(manifestUrl,{credentials:"omit",redirect:"error",signal:controller.signal});
    if(!mr.ok) throw Error("manifest fetch failed: "+mr.status);
    const manifestBytes=await readLimited(mr,64*1024,"manifest"); assertActive();
    let manifest;
    try { manifest=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(manifestBytes)); }
    catch { throw Error("manifest is not valid UTF-8 JSON"); }
    this._validateManifest(manifest);
    manifest=this._grantCapabilities(manifest);
    const wasmUrl=new URL(manifest.entry,base);
    if(wasmUrl.origin!==base.origin || !wasmUrl.pathname.startsWith(base.pathname)) throw Error("entry escapes package root");
    const response=await fetch(wasmUrl,{credentials:"omit",redirect:"error",signal:controller.signal});
    if(!response.ok) throw Error("WASM fetch failed: "+response.status);
    const caps=manifest.runtime.wasm;
    const bytes=await readLimited(response,this.options.maxModuleBytes,"WASM module"); assertActive();
    if(!bytes.byteLength) throw Error("empty WASM module");
    this.manifest=manifest; this.width=manifest.runtime.display.width; this.height=manifest.runtime.display.height;
    this.canvas.width=this.width; this.canvas.height=this.height;
    assertActive(); this.worker=new Worker(new URL("./worker.js",import.meta.url),{type:"module",name:"bombless-wasm-game"});
    await new Promise((resolve,reject)=>{
      const worker=this.worker; let settled=false;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);controller.signal.removeEventListener("abort",onAbort);
        if(error){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();if(this.worker===worker)this.worker=null;reject(error);}
        else resolve();
      };
      const onAbort=()=>finish(new DOMException("Load aborted","AbortError"));
      const timer=setTimeout(()=>finish(Error("WASM initialization timeout")),this.options.watchdogMs);
      controller.signal.addEventListener("abort",onAbort,{once:true});
      worker.onmessage=({data})=>{
        if(data?.type==="READY")finish();
        else if(data?.type==="ERROR")finish(Error(data.message));
      };
      worker.onerror=()=>finish(Error("WASM worker failed"));
      worker.onmessageerror=()=>finish(Error("WASM worker message could not be decoded"));
      try { worker.postMessage({type:"INIT",bytes:bytes.buffer,config:{...config,runtime:manifest.runtime},limits:{
        maxMemoryPages:Math.min(caps.maxMemoryPages,this.options.maxMemoryPages),
        maxOutputBytes:Math.min(caps.maxOutputBytes,this.options.maxOutputBytes)
      }},[bytes]); } catch(error) { finish(error); }
    });
    this.worker.onmessage=({data})=>this._message(data);
    this.worker.onerror=()=>{
      clearTimeout(this._watchdogTimer); this._watchdogTimer=null;
      this.pause(); this.worker?.terminate(); this.worker=null; this.pendingInputs=0; this._busy=false;
      this._reportError(Error("WASM worker failed"));
    };
    this.worker.onmessageerror=()=>this._failWorker(Error("WASM worker message could not be decoded"));
    this.startedAt=performance.now();
    this._attachInput(); this.errorElement.hidden=true; this.resume(); return manifest;
    } catch(error) {
      this._cleanupFailedLoad();
      if(!this.disposed && error?.name!=="AbortError") this._reportError(error);
      throw error;
    } finally { this.loading=false; if(this._loadController===controller)this._loadController=null; }
  }
  _reportError(error) {
    if(this.disposed)return;
    this.pause(); this._detachInput();
    const message=error instanceof Error?error.message:String(error);
    this.errorMessage.textContent="Game unavailable: "+message;
    this.retryButton.hidden=!this._lastLoad||this.disposed;
    this.errorElement.hidden=false;
    this.options.onError?.(error instanceof Error?error:new Error(message));
  }
  _cleanupFailedLoad() {
    clearTimeout(this._watchdogTimer); this._watchdogTimer=null;
    if(this.running){this.running=false;cancelAnimationFrame(this._raf);}
    this.held.clear(); this.pendingInputs=0; this._busy=false;
    this._detachInput();
    if(this.worker){this.worker.onmessage=null;this.worker.onerror=null;this.worker.onmessageerror=null;this.worker.terminate();}
    this.worker=null;
  }
  _grantCapabilities(manifest) {
    const granted=new Set(this.options.grantedCapabilities);
    return {...manifest,runtime:{...manifest.runtime,capabilities:manifest.runtime.capabilities.filter(cap=>granted.has(cap))}};
  }
  _validateManifest(m) {
    if(!m||typeof m!=="object"||Array.isArray(m)||m.manifestVersion!==1||m.pluginType!=="wasm"||!m.runtime||m.runtime.apiVersion!=="1") throw Error("invalid plugin manifest");
    if(typeof m.name!=="string"||!m.name.trim()||m.name.length>120||typeof m.version!=="string"||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(m.version)) throw Error("invalid plugin metadata");
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
  _failWorker(error) {
    clearTimeout(this._watchdogTimer); this._watchdogTimer=null;
    const worker=this.worker; this.worker=null;
    if(worker) { worker.onmessage=null; worker.onerror=null; worker.onmessageerror=null; worker.terminate(); }
    this.pendingInputs=0; this._busy=false;
    this.pause(); this._reportError(error);
  }
  _message(data) {
    if(!data||typeof data!=="object"||Array.isArray(data)||typeof data.type!=="string") {
      this._failWorker(Error("malformed worker message")); return;
    }
    if(data.type==="INPUT_ACK") {
      if(Object.keys(data).length!==1||this.pendingInputs<1) {
        this._failWorker(Error("invalid worker input acknowledgement")); return;
      }
      this.pendingInputs--; return;
    }
    if(data.type==="ERROR") {
      if(Object.keys(data).some(key=>!["type","message"].includes(key))||typeof data.message!=="string"||!data.message.length||data.message.length>240) {
        this._failWorker(Error("malformed worker error message")); return;
      }
      this._failWorker(Error(data.message)); return;
    }
    if(data.type==="FRAME") {
      if(!this._busy||Object.keys(data).length!==4||data.width!==this.width||data.height!==this.height||
        !(data.frame instanceof ArrayBuffer)||data.frame.byteLength!==this.width*this.height*4) {
        this._failWorker(Error("invalid framebuffer message from worker")); return;
      }
      clearTimeout(this._watchdogTimer); this._watchdogTimer=null; this._busy=false;
      try {
        this.ctx.putImageData(new ImageData(new Uint8ClampedArray(data.frame),this.width,this.height),0,0);
      } catch(error) { this._failWorker(error); }
      return;
    }
    this._failWorker(Error("unknown worker message type"));
  }
  _attachInput() {
    if(this._inputAttached)return; this._inputAttached=true;
    window.addEventListener("keydown",this._key); window.addEventListener("keyup",this._key);
    this.canvas.addEventListener("pointerdown",this._pointer); this.canvas.addEventListener("pointerup",this._pointer);
    this.canvas.addEventListener("pointermove",this._pointer); this.canvas.addEventListener("pointercancel",this._pointer);
    window.addEventListener("blur",this._blur); document.addEventListener("visibilitychange",this._visibility);
    this.canvas.addEventListener("focusout",this._focusout);
  }
  _detachInput() {
    if(!this._inputAttached)return; this._inputAttached=false;
    window.removeEventListener("keydown",this._key);window.removeEventListener("keyup",this._key);
    this.canvas.removeEventListener("pointerdown",this._pointer);this.canvas.removeEventListener("pointerup",this._pointer);this.canvas.removeEventListener("pointermove",this._pointer);this.canvas.removeEventListener("pointercancel",this._pointer);
    window.removeEventListener("blur",this._blur);document.removeEventListener("visibilitychange",this._visibility);
    this.canvas.removeEventListener("focusout",this._focusout);
  }
  _keyEvent(e) {
    if(!this.running||!this.manifest.runtime.capabilities.includes("input.keyboard")||!KEY_CODES.has(e.code)) return;
    // Keyboard input belongs only to the player the user has focused. Without
    // this guard every mounted game would consume page-level shortcuts.
    const active=document.activeElement;
    if(active!==this.canvas && !this.canvas.contains?.(active)) return;
    if(e.type==="keydown"){if(this.held.has(e.code))return;this.held.add(e.code);} else this.held.delete(e.code);
    e.preventDefault(); this._send({type:e.type==="keydown"?"KEY_DOWN":"KEY_UP",code:e.code,modifiers:(e.shiftKey?1:0)|(e.ctrlKey?2:0)|(e.altKey?4:0)|(e.metaKey?8:0),timestamp_micros:this._timestampMicros()});
  }
  _pointerEvent(e) {
    if(!this.running||!this.manifest.runtime.capabilities.includes("input.pointer")) return;
    if(e.type==="pointerdown") this.canvas.focus?.({preventScroll:true});
    const now=performance.now(); if(e.type==="pointermove" && now-this.lastPointerMove<16)return; if(e.type==="pointermove")this.lastPointerMove=now;
    const {x,y}=this._logicalPoint(e.clientX,e.clientY);
    const type={pointerdown:"POINTER_DOWN",pointerup:"POINTER_UP",pointermove:"POINTER_MOVE",pointercancel:"POINTER_CANCEL"}[e.type];
    if(type!=="POINTER_MOVE" && this.canvas.setPointerCapture && e.type==="pointerdown") this.canvas.setPointerCapture(e.pointerId);
    this._send({type,x:Math.max(0,Math.min(this.width,x)),y:Math.max(0,Math.min(this.height,y)),code:e.button,buttons:e.buttons,modifiers:(e.shiftKey?1:0)|(e.ctrlKey?2:0)|(e.altKey?4:0),timestamp_micros:this._timestampMicros()});
  }
  _logicalPoint(clientX,clientY) {
    const r=this.canvas.getBoundingClientRect();
    if(!Number.isFinite(r.width)||!Number.isFinite(r.height)||r.width<=0||r.height<=0) return {x:0,y:0};
    // Treat the CSS box as a letterboxed viewport for the logical game aspect ratio.
    const scale=Math.min(r.width/this.width,r.height/this.height);
    const contentWidth=this.width*scale,contentHeight=this.height*scale;
    const left=r.left+(r.width-contentWidth)/2,top=r.top+(r.height-contentHeight)/2;
    return {
      x:Math.max(0,Math.min(this.width,(clientX-left)/scale)),
      y:Math.max(0,Math.min(this.height,(clientY-top)/scale))
    };
  }
  _timestampMicros() { return this.simulationMicros+Math.max(0,Math.round(this.acc*1000000)); }
  _send(event) {
    if(!this.worker || this.pendingInputs>=this.options.maxQueue+(event.type==="KEY_UP"?32:0))return;
    const now=performance.now(); if(now-this.inputWindowStart>=1000){this.inputWindowStart=now;this.inputCount=0;}
    if(this.inputCount>=128 && event.type!=="KEY_UP")return; this.inputCount++; this.pendingInputs++;
    this.worker.postMessage({type:"INPUT",event});
  }
  _clearInput() { for(const code of this.held)this._send({type:"KEY_UP",code,modifiers:0,timestamp_micros:this._timestampMicros()});this.held.clear(); }
  resume() { if(this.disposed||!this.worker||this.running)return;this.running=true;this.last=performance.now();this.lastRender=0;this.acc=0;this._raf=requestAnimationFrame(t=>this._tick(t)); }
  pause() { if(this.running){this.running=false;cancelAnimationFrame(this._raf);this.simulationMicros+=Math.max(0,Math.round(this.acc*1000000));this.acc=0;} this._clearInput(); }
  _tick(now) {
    if(!this.running)return;
    const elapsed=Math.min((now-this.last)/1000,0.1);this.last=now;this.acc=Math.min(this.acc+elapsed,0.1);
    const availableSteps=Math.floor((this.acc+1e-9)/this.step);
    if(availableSteps>0&&now-this.lastRender>=this.renderInterval&&!this._busy){
      const steps=Math.min(availableSteps,this.maxCatchUpSteps);
      this.acc=Math.max(0,this.acc-steps*this.step);this.lastRender=now;
      this.simulationMicros+=steps*16667;
      this._timedPost({type:"TICK",dtMicros:16667,steps});
    }
    this._raf=requestAnimationFrame(t=>this._tick(t));
  }
  _timedPost(message) {
    if(this._busy)return;this._busy=true;
    clearTimeout(this._watchdogTimer);
    this._watchdogTimer=setTimeout(()=>{
      this._watchdogTimer=null; this.pause(); this.worker?.terminate(); this.worker=null;
      this.pendingInputs=0; this._busy=false;
      this._reportError(Error("WASM watchdog timeout"));
    },this.options.watchdogMs);
    this.worker.postMessage(message);
  }
  async dispose() {
    if(this.disposed)return;
    this.disposed=true; this._loadController?.abort();
    this.pause(); this._clearInput(); clearTimeout(this._watchdogTimer); this._watchdogTimer=null;
    this._detachInput(); this.errorElement.remove();
    if(this.worker){
      const worker=this.worker; this.worker=null; clearTimeout(this._watchdogTimer); this._watchdogTimer=null;
      await new Promise(resolve=>{
        let finished=false;
        const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);worker.terminate();resolve();};
        const timer=setTimeout(finish,100);
        worker.addEventListener("message",({data})=>{if(data?.type==="SHUTDOWN_ACK")finish();});
        try { worker.postMessage({type:"SHUTDOWN"}); } catch { finish(); }
      });
    }
  }
}

export { safePath, readLimited };
