/* Runs inside a dedicated Worker. No WASI, network, DOM, or ambient imports. */
const ABI = "bombless-game-abi";
let instance, memory, ex, limits, config, stopped = false;
const required = ["game_abi_version","game_init","game_update","game_input","game_render","game_shutdown",
  "game_get_width","game_get_height","game_get_render_buffer_ptr","game_get_render_buffer_len",
  "game_get_config_buffer_ptr","game_get_config_buffer_capacity","game_get_input_buffer_ptr","game_get_input_buffer_capacity"];
const fail = (message) => { postMessage({type:"ERROR", message:String(message).slice(0,240)}); stopped=true; };
function range(ptr,len,capacity) {
  if (!Number.isInteger(ptr)||!Number.isInteger(len)||ptr<0||len<0||ptr+len>capacity||ptr+len>memory.buffer.byteLength) throw Error("guest memory range invalid");
  return ptr;
}
function u32(fn) { const n=fn(); if(!Number.isInteger(n)||n<0||n>0xffffffff) throw Error("invalid guest dimension/pointer"); return n; }
function call(code,name) { if(code!==0) throw Error(name+" failed ("+code+")"); }
onmessage = async ({data}) => {
  try {
    if(data.type==="INIT") {
      limits=data.limits; config=data.config;
      const module=await WebAssembly.compile(data.bytes);
      const imports=WebAssembly.Module.imports(module);
      if(imports.length) throw Error("WASM imports are not permitted");
      instance=await WebAssembly.instantiate(module,{});
      ex=instance.exports;
      for(const name of required) if(typeof ex[name]!=="function") throw Error("missing export: "+name);
      if(!(ex.memory instanceof WebAssembly.Memory)) throw Error("missing exported memory");
      memory=ex.memory;
      if(memory.buffer.byteLength>limits.maxMemoryPages*65536) throw Error("initial memory limit exceeded");
      if(ex.game_abi_version()!==1) throw Error("unsupported game ABI version");
      const bytes=new TextEncoder().encode(JSON.stringify(config));
      const cp=u32(ex.game_get_config_buffer_ptr()), cc=u32(ex.game_get_config_buffer_capacity());
      if(bytes.length>cc) throw Error("config exceeds guest buffer");
      new Uint8Array(memory.buffer,range(cp,bytes.length,memory.buffer.byteLength),bytes.length).set(bytes);
      call(ex.game_init(cp,bytes.length),"game_init");
      const width=u32(ex.game_get_width()), height=u32(ex.game_get_height());
      if(!width||!height||width>1024||height>1024||width!==config.runtime.display.width||height!==config.runtime.display.height) throw Error("invalid framebuffer dimensions");
      const expected=width*height*4;
      if(!Number.isSafeInteger(expected)||expected>limits.maxOutputBytes) throw Error("framebuffer exceeds output limit");
      const rp=u32(ex.game_get_render_buffer_ptr()), rl=u32(ex.game_get_render_buffer_len());
      if(rl<expected) throw Error("render buffer too small");
      range(rp,expected,memory.buffer.byteLength);
      postMessage({type:"READY",width,height});
    } else if(data.type==="INPUT" && !stopped) {
      const bytes=new TextEncoder().encode(JSON.stringify(data.event));
      const p=u32(ex.game_get_input_buffer_ptr()), cap=u32(ex.game_get_input_buffer_capacity());
      if(bytes.length>cap) throw Error("input event exceeds guest buffer");
      new Uint8Array(memory.buffer,range(p,bytes.length,memory.buffer.byteLength),bytes.length).set(bytes);
      call(ex.game_input(p,bytes.length),"game_input");
    } else if(data.type==="TICK" && !stopped) {
      call(ex.game_update(data.dtMicros),"game_update");
      const width=u32(ex.game_get_width()),height=u32(ex.game_get_height()),need=width*height*4;
      if(need>limits.maxOutputBytes) throw Error("frame exceeds output limit");
      const ptr=u32(ex.game_get_render_buffer_ptr()),len=u32(ex.game_get_render_buffer_len());
      if(len<need) throw Error("render buffer too small");
      range(ptr,need,memory.buffer.byteLength);
      call(ex.game_render(ptr,need),"game_render");
      const frame=new Uint8Array(need); frame.set(new Uint8Array(memory.buffer,ptr,need));
      postMessage({type:"FRAME",width,height,frame:frame.buffer},[frame.buffer]);
    } else if(data.type==="SHUTDOWN" && !stopped) {
      stopped=true; try { ex.game_shutdown(); } finally { close(); }
    }
  } catch(e) { fail(e && e.message || e); }
};
