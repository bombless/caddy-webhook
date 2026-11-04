/* Runs inside a dedicated Worker. No WASI, network, DOM, or ambient imports. */
const required = ["game_abi_version","game_init","game_update","game_input","game_render","game_shutdown",
  "game_get_width","game_get_height","game_get_render_buffer_ptr","game_get_render_buffer_len",
  "game_get_config_buffer_ptr","game_get_config_buffer_capacity","game_get_input_buffer_ptr","game_get_input_buffer_capacity"];
let instance, memory, ex, limits, config, stopped = false;
const fail = message => { postMessage({type:"ERROR",message:String(message).slice(0,240)}); stopped=true; };
function checkMemory() {
  if(!(memory instanceof WebAssembly.Memory) || memory.buffer.byteLength > limits.maxMemoryPages*65536) throw Error("WASM memory limit exceeded");
}
function range(ptr,len) {
  checkMemory();
  if(!Number.isInteger(ptr)||!Number.isInteger(len)||ptr<0||len<0||ptr+len>memory.buffer.byteLength) throw Error("guest memory range invalid");
  return ptr;
}
function u32(fn) { const n=fn(); if(!Number.isInteger(n)||n<0||n>0xffffffff) throw Error("invalid guest dimension/pointer"); return n; }
function status(code,name) { checkMemory(); if(code!==0) throw Error(name+" failed ("+code+")"); }
function dimensions() {
  const width=u32(ex.game_get_width()),height=u32(ex.game_get_height()),bytes=width*height*4;
  if(!width||!height||width>1024||height>1024||!Number.isSafeInteger(bytes)||bytes>limits.maxOutputBytes) throw Error("invalid framebuffer dimensions/size");
  return {width,height,bytes};
}
onmessage = async ({data}) => {
  try {
    if(!data || typeof data!=="object" || typeof data.type!=="string") throw Error("malformed worker message");
    if(data.type==="INIT") {
      if(instance || !data.limits || !data.config || !(data.bytes instanceof ArrayBuffer)) throw Error("malformed INIT message");
      limits=data.limits; config=data.config;
      if(!Number.isInteger(limits.maxMemoryPages)||limits.maxMemoryPages<1||limits.maxMemoryPages>256||
         !Number.isInteger(limits.maxOutputBytes)||limits.maxOutputBytes<4||limits.maxOutputBytes>4*1024*1024||
         data.bytes.byteLength<8||data.bytes.byteLength>16*1024*1024) throw Error("invalid runtime limits or module size");
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
      new Uint8Array(memory.buffer,range(cp,bytes.length),bytes.length).set(bytes);
      status(ex.game_init(cp,bytes.length),"game_init");
      const d=dimensions();
      if(d.width!==config.runtime.display.width||d.height!==config.runtime.display.height) throw Error("manifest/framebuffer dimensions differ");
      const rp=u32(ex.game_get_render_buffer_ptr()),rl=u32(ex.game_get_render_buffer_len());
      if(rl<d.bytes) throw Error("render buffer too small");
      range(rp,d.bytes);
      postMessage({type:"READY",width:d.width,height:d.height});
    } else if(data.type==="INPUT" && !stopped) {
      if(!data.event || typeof data.event!=="object" || Array.isArray(data.event)) throw Error("malformed input event");
      const bytes=new TextEncoder().encode(JSON.stringify(data.event));
      const p=u32(ex.game_get_input_buffer_ptr()),cap=u32(ex.game_get_input_buffer_capacity());
      if(cap>4096 || bytes.length>cap) throw Error("input event exceeds guest buffer/limit");
      new Uint8Array(memory.buffer,range(p,bytes.length),bytes.length).set(bytes);
      status(ex.game_input(p,bytes.length),"game_input");
      postMessage({type:"INPUT_ACK"});
    } else if(data.type==="TICK" && !stopped) {
      if(data.dtMicros!==16667) throw Error("invalid fixed timestep");
      status(ex.game_update(data.dtMicros),"game_update");
      const d=dimensions(),ptr=u32(ex.game_get_render_buffer_ptr()),len=u32(ex.game_get_render_buffer_len());
      if(len<d.bytes) throw Error("render buffer too small");
      range(ptr,d.bytes);
      const rendered=ex.game_render(ptr,d.bytes); checkMemory();
      if(rendered!==d.bytes) throw Error("game_render returned unexpected byte count");
      const frame=new Uint8Array(d.bytes); frame.set(new Uint8Array(memory.buffer,ptr,d.bytes));
      postMessage({type:"FRAME",width:d.width,height:d.height,frame:frame.buffer},[frame.buffer]);
    } else if(data.type==="SHUTDOWN" && !stopped) {
      stopped=true; try { ex.game_shutdown(); } finally { close(); }
    } else if(data.type!=="INIT" && data.type!=="SHUTDOWN") {
      throw Error("unknown worker message type");
    }
  } catch(e) { fail(e && e.message || e); }
};
