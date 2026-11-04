typedef unsigned int u32;
typedef unsigned char u8;

#ifndef ABI_VERSION
#define ABI_VERSION 1
#endif
#ifndef GAME_WIDTH
#define GAME_WIDTH 1
#endif
#ifndef GAME_HEIGHT
#define GAME_HEIGHT 1
#endif

static u8 config_buf[128];
static u8 input_buf[128];
static u8 framebuffer[4];

#if defined(HOST_IMPORT)
__attribute__((import_module("env"), import_name("host_call")))
extern int host_call(void);
#endif

__attribute__((export_name("game_abi_version")))
u32 game_abi_version(void) { return ABI_VERSION; }

__attribute__((export_name("game_init")))
int game_init(u32 ptr, u32 len) {
  (void)ptr; (void)len;
#if defined(HOST_IMPORT)
  return host_call();
#else
  return 0;
#endif
}

__attribute__((export_name("game_update")))
int game_update(u32 dt_micros) {
  (void)dt_micros;
#if defined(TRAP_ON_UPDATE)
  __builtin_trap();
#endif
  return 0;
}

__attribute__((export_name("game_input")))
int game_input(u32 ptr, u32 len) { (void)ptr; (void)len; return 0; }

#if defined(OMIT_RENDER_EXPORT)
__attribute__((export_name("not_game_render")))
#else
__attribute__((export_name("game_render")))
#endif
int game_render(u32 ptr, u32 capacity) {
  if (ptr != (u32)(unsigned long)framebuffer || capacity < 4) return -3;
  framebuffer[0]=255; framebuffer[1]=0; framebuffer[2]=0; framebuffer[3]=255;
  return 4;
}

__attribute__((export_name("game_shutdown")))
void game_shutdown(void) {}

__attribute__((export_name("game_get_width")))
u32 game_get_width(void) { return GAME_WIDTH; }

__attribute__((export_name("game_get_height")))
u32 game_get_height(void) { return GAME_HEIGHT; }

__attribute__((export_name("game_get_render_buffer_ptr")))
u32 game_get_render_buffer_ptr(void) { return (u32)(unsigned long)framebuffer; }

__attribute__((export_name("game_get_render_buffer_len")))
u32 game_get_render_buffer_len(void) { return 4; }

__attribute__((export_name("game_get_config_buffer_ptr")))
u32 game_get_config_buffer_ptr(void) {
#if defined(INVALID_CONFIG_PTR)
  return 0xffffffffu;
#else
  return (u32)(unsigned long)config_buf;
#endif
}

__attribute__((export_name("game_get_config_buffer_capacity")))
u32 game_get_config_buffer_capacity(void) { return 128; }

__attribute__((export_name("game_get_input_buffer_ptr")))
u32 game_get_input_buffer_ptr(void) { return (u32)(unsigned long)input_buf; }

__attribute__((export_name("game_get_input_buffer_capacity")))
u32 game_get_input_buffer_capacity(void) { return 128; }
