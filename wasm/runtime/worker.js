/* Runs inside a dedicated Worker. No WASI, network, DOM, or ambient imports. */
const required = ["game_abi_version","game_init","game_update","game_input","game_render","game_shutdown",
  "game_get_width","game_get_height","game_get_render_buffer_ptr","game_get_render_buffer_len",
  "game_get_config_buffer_ptr","game_get_config_buffer_capacity","game_get_input_buffer_ptr","game_get_input_buffer_capacity"];
let instance, memory, ex, limits, config, stopped = false;
let inputQueue = [], simulationTimeMicros = 0, lastInputTimestampMicros = -1;
const MAX_PENDING_INPUTS = 256;
const fail = message => { postMessage({type:"ERROR",message:String(message).slice(0,240)}); stopped=true; };

/* WebAssembly.Module does not expose function types. Parse the standard
 * type/function/export sections so a same-named export with the wrong ABI
 * signature is rejected before the first guest call. Imports are rejected
 * separately below, so function indices map directly to the function section. */
function validateAbiSignatures(bytes) {
  const view = new DataView(bytes);
  let offset = 8;
  const readU32 = end => {
    let value = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      if (offset >= end) throw Error("truncated WASM section");
      const byte = view.getUint8(offset++);
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value >>> 0;
      shift += 7;
    }
    throw Error("invalid WASM LEB128 integer");
  };
  const readName = end => {
    const length = readU32(end);
    if (offset + length > end) throw Error("truncated WASM name");
    const value = new TextDecoder().decode(new Uint8Array(bytes, offset, length));
    offset += length;
    return value;
  };
  const types = [], functions = [], exports = new Map();
  while (offset < bytes.byteLength) {
    const id = view.getUint8(offset++);
    const size = readU32(bytes.byteLength);
    const end = offset + size;
    if (end > bytes.byteLength) throw Error("truncated WASM section");
    if (id === 1) {
      const count = readU32(end);
      for (let i = 0; i < count; i++) {
        if (view.getUint8(offset++) !== 0x60) throw Error("unsupported WASM function type");
        const paramCount = readU32(end), params = [];
        for (let p = 0; p < paramCount; p++) params.push(view.getUint8(offset++));
        const resultCount = readU32(end), results = [];
        for (let r = 0; r < resultCount; r++) results.push(view.getUint8(offset++));
        if (offset > end || params.some(x => ![0x7f, 0x7e, 0x7d].includes(x)) || results.some(x => ![0x7f, 0x7e, 0x7d].includes(x))) throw Error("unsupported WASM value type (supported: i32, i64, f32)");
        types.push({ params, results });
      }
    } else if (id === 2) {
      const count = readU32(end);
      if (count !== 0) throw Error("WASM imports are not permitted");
    } else if (id === 3) {
      const count = readU32(end);
      for (let i = 0; i < count; i++) functions.push(readU32(end));
    } else if (id === 7) {
      const count = readU32(end);
      for (let i = 0; i < count; i++) {
        const name = readName(end), kind = view.getUint8(offset++), index = readU32(end);
        exports.set(name, { kind, index });
      }
    }
    if (offset > end) throw Error("malformed WASM section");
    offset = end;
  }
  const expected = {
    game_abi_version: [0, 1], game_init: [2, 1], game_update: [1, 1],
    game_input: [2, 1], game_render: [2, 1], game_shutdown: [0, 0],
    game_get_width: [0, 1], game_get_height: [0, 1],
    game_get_render_buffer_ptr: [0, 1], game_get_render_buffer_len: [0, 1],
    game_get_config_buffer_ptr: [0, 1], game_get_config_buffer_capacity: [0, 1],
    game_get_input_buffer_ptr: [0, 1], game_get_input_buffer_capacity: [0, 1]
  };
  for (const [name, signature] of Object.entries(expected)) {
    const item = exports.get(name);
    if (!item || item.kind !== 0) throw Error("missing export: " + name);
    const typeIndex = functions[item.index];
    const type = types[typeIndex];
    if (!type || type.params.length !== signature[0] || type.results.length !== signature[1] ||
        type.params.some(x => x !== 0x7f) || type.results.some(x => x !== 0x7f)) {
      throw Error("invalid ABI signature: " + name);
    }
  }
  const memoryExport = exports.get("memory");
  if (!memoryExport || memoryExport.kind !== 2) throw Error("missing exported memory");
}

function checkMemory() {
  if(!(memory instanceof WebAssembly.Memory) || memory.buffer.byteLength > limits.maxMemoryPages*65536) throw Error("WASM memory limit exceeded");
}
function range(ptr,len) {
  checkMemory();
  if(!Number.isInteger(ptr)||!Number.isInteger(len)||ptr<0||len<0||ptr+len>memory.buffer.byteLength) throw Error("guest memory range invalid");
  return ptr;
}
function u32(value) { const n=value; if(!Number.isInteger(n)||n<0||n>0xffffffff) throw Error("invalid guest dimension/pointer"); return n; }
function status(code,name) { checkMemory(); if(code!==0) throw Error(name+" failed ("+code+")"); }
function exactKeys(value,allowed,name) {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key))) throw Error("malformed "+name+" message");
}
function dimensions() {
  const width=u32(ex.game_get_width()),height=u32(ex.game_get_height()),bytes=width*height*4;
  if(!width||!height||width>1024||height>1024||!Number.isSafeInteger(bytes)||bytes>limits.maxOutputBytes) throw Error("invalid framebuffer dimensions/size");
  return {width,height,bytes};
}
function validateEvent(e) {
  const keyTypes=new Set(["KEY_DOWN","KEY_UP"]), pointerTypes=new Set(["POINTER_DOWN","POINTER_UP","POINTER_MOVE","POINTER_CANCEL"]);
  const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
  if(typeof e.type!=="string" || !integer(e.timestamp_micros,0,Number.MAX_SAFE_INTEGER) || !integer(e.modifiers,0,15)) throw Error("invalid input event metadata");
  if(keyTypes.has(e.type)) {
    if(Object.keys(e).some(k=>!["type","code","modifiers","timestamp_micros"].includes(k)) ||
       !["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","KeyW","KeyA","KeyS","KeyD","Space","Enter","Escape"].includes(e.code)) throw Error("invalid keyboard event");
  } else if(pointerTypes.has(e.type)) {
    if(Object.keys(e).some(k=>!["type","x","y","code","buttons","modifiers","timestamp_micros"].includes(k)) ||
       !Number.isFinite(e.x)||!Number.isFinite(e.y)||e.x<0||e.y<0||e.x>1024||e.y>1024||
       !integer(e.code,-1,31)||!integer(e.buttons,0,31)) throw Error("invalid pointer event");
  } else throw Error("unknown input event type");
}
function deliverInput(event) {
  const bytes=new TextEncoder().encode(JSON.stringify(event));
  const p=u32(ex.game_get_input_buffer_ptr()),cap=u32(ex.game_get_input_buffer_capacity());
  if(cap>4096 || bytes.length>cap) throw Error("input event exceeds guest buffer/limit");
  range(p,cap);
  new Uint8Array(memory.buffer,range(p,bytes.length),bytes.length).set(bytes);
  status(ex.game_input(p,bytes.length),"game_input");
}
onmessage = async ({data}) => {
  try {
    if(!data || typeof data!=="object" || typeof data.type!=="string") throw Error("malformed worker message");
    if(data.type==="INIT") {
      exactKeys(data,["type","bytes","config","limits"],"INIT");
      if(stopped || instance || !data.limits || !data.config || typeof data.config!=="object" || Array.isArray(data.config) || !(data.bytes instanceof ArrayBuffer)) throw Error("malformed INIT message");
      exactKeys(data.limits,["maxMemoryPages","maxOutputBytes"],"INIT limits");
      limits=data.limits; config=data.config;
      if(!Number.isInteger(limits.maxMemoryPages)||limits.maxMemoryPages<1||limits.maxMemoryPages>256||
         !Number.isInteger(limits.maxOutputBytes)||limits.maxOutputBytes<4||limits.maxOutputBytes>4*1024*1024||
         data.bytes.byteLength<8||data.bytes.byteLength>16*1024*1024) throw Error("invalid runtime limits or module size");
      validateAbiSignatures(data.bytes);
      const module=await WebAssembly.compile(data.bytes);
      if(WebAssembly.Module.imports(module).length) throw Error("WASM imports are not permitted");
      instance=await WebAssembly.instantiate(module,{});
      ex=instance.exports;
      for(const name of required) if(typeof ex[name]!=="function") throw Error("missing export: "+name);
      if(!(ex.memory instanceof WebAssembly.Memory)) throw Error("missing exported memory");
      memory=ex.memory; checkMemory();
      if(ex.game_abi_version()!==1) throw Error("unsupported game ABI version");
      const bytes=new TextEncoder().encode(JSON.stringify(config));
      if(bytes.length>64*1024) throw Error("config exceeds host limit");
      const cp=u32(ex.game_get_config_buffer_ptr()),cc=u32(ex.game_get_config_buffer_capacity());
      if(cc>64*1024 || bytes.length>cc) throw Error("config exceeds guest buffer/limit");
      range(cp,cc);
      new Uint8Array(memory.buffer,range(cp,bytes.length),bytes.length).set(bytes);
      status(ex.game_init(cp,bytes.length),"game_init");
      inputQueue=[]; simulationTimeMicros=0; lastInputTimestampMicros=-1;
      const d=dimensions();
      if(d.width!==config.runtime.display.width||d.height!==config.runtime.display.height) throw Error("manifest/framebuffer dimensions differ");
      const rp=u32(ex.game_get_render_buffer_ptr()),rl=u32(ex.game_get_render_buffer_len());
      if(rl<d.bytes) throw Error("render buffer too small");
      range(rp,rl);
      postMessage({type:"READY",width:d.width,height:d.height});
    } else if(data.type==="INPUT" && !stopped) {
      exactKeys(data,["type","event"],"INPUT");
      if(!instance || !ex || !data.event || typeof data.event!=="object" || Array.isArray(data.event)) throw Error("malformed input event");
      validateEvent(data.event);
      if(inputQueue.length>=MAX_PENDING_INPUTS) throw Error("input event queue limit exceeded");
      if(data.event.timestamp_micros<lastInputTimestampMicros) throw Error("input timestamps must be monotonic");
      lastInputTimestampMicros=data.event.timestamp_micros;
      inputQueue.push(data.event);
      postMessage({type:"INPUT_ACK"});
    } else if(data.type==="TICK" && !stopped) {
      exactKeys(data,["type","dtMicros","steps"],"TICK");
      const steps=data.steps===undefined?1:data.steps;
      if(!instance || !ex || data.dtMicros!==16667 || !Number.isInteger(steps) || steps<1 || steps>6) throw Error("invalid fixed timestep/batch size");
      for(let i=0;i<steps;i++) {
        simulationTimeMicros+=data.dtMicros;
        if(!Number.isSafeInteger(simulationTimeMicros)) throw Error("simulation clock overflow");
        while(inputQueue.length && inputQueue[0].timestamp_micros<=simulationTimeMicros) deliverInput(inputQueue.shift());
        status(ex.game_update(data.dtMicros),"game_update");
      }
      const d=dimensions(),ptr=u32(ex.game_get_render_buffer_ptr()),len=u32(ex.game_get_render_buffer_len());
      if(len<d.bytes) throw Error("render buffer too small");
      range(ptr,len);
      const rendered=ex.game_render(ptr,d.bytes); checkMemory();
      if(rendered!==d.bytes) throw Error("game_render returned unexpected byte count");
      const frame=new Uint8Array(d.bytes); frame.set(new Uint8Array(memory.buffer,ptr,d.bytes));
      postMessage({type:"FRAME",width:d.width,height:d.height,frame:frame.buffer},[frame.buffer]);
    } else if(data.type==="SHUTDOWN") {
      exactKeys(data,["type"],"SHUTDOWN");
      if(stopped) throw Error("shutdown after worker stopped");
      if(!instance || !ex) throw Error("shutdown before initialization");
      stopped=true; inputQueue=[]; try { ex.game_shutdown(); } finally { postMessage({type:"SHUTDOWN_ACK"}); close(); }
    } else {
      throw Error("unknown worker message type or invalid lifecycle state");
    }
  } catch(e) { fail(e && e.message || e); }
};
