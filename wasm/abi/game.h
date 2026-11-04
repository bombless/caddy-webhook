#ifndef BOMBLESS_GAME_ABI_H
#define BOMBLESS_GAME_ABI_H
#include <stdint.h>

/* bombless-game-abi v1.
 *
 * Every pointer is an unsigned byte offset into the module's exported
 * WebAssembly.Memory named "memory". Every accessor and lifecycle export
 * below is REQUIRED and has the exact wasm32 signature shown by its C type.
 * Modules MUST NOT import host functions, WASI, or any other imports in v1.
 *
 * Return codes for int32_t functions:
 *   GAME_OK                 success
 *   GAME_ERR_INVALID_ARGUMENT malformed pointer/length/value
 *   GAME_ERR_UNSUPPORTED    unsupported ABI/configuration
 *   GAME_ERR_CAPACITY       supplied scratch/output capacity insufficient
 *   GAME_ERR_STATE          call invalid for current lifecycle state
 *   GAME_ERR_INTERNAL       unrecoverable guest-side game error
 * Any other return value is a protocol violation; the host terminates the game.
 *
 * Lifecycle: game_abi_version is callable before initialization.
 * game_init is called exactly once; on success the module enters READY.
 * game_input and game_update are legal only in READY. game_render is legal
 * only in READY and writes the complete framebuffer into the guest-owned
 * buffer returned by game_get_render_buffer_ptr. game_shutdown is called at
 * most once after successful initialization. No calls are made after shutdown.
 *
 * The host writes UTF-8 JSON bytes (without a trailing NUL) into the
 * guest-owned config/input scratch buffers before calling game_init/input.
 * The guest owns all buffers; the host must validate their ranges and copy
 * rendered bytes before making another guest call. Memory may grow during
 * any guest call, so the host must reacquire memory.buffer and recreate views.
 */
#define GAME_ABI_VERSION 1u
#define GAME_OK 0
#define GAME_ERR_INVALID_ARGUMENT -1
#define GAME_ERR_UNSUPPORTED -2
#define GAME_ERR_CAPACITY -3
#define GAME_ERR_STATE -4
#define GAME_ERR_INTERNAL -5

uint32_t game_abi_version(void);
int32_t game_init(uint32_t config_ptr, uint32_t config_len);
int32_t game_update(uint32_t dt_micros);
int32_t game_input(uint32_t event_ptr, uint32_t event_len);
/* Required: writes exactly width*height*4 bytes to the guest-owned render
 * buffer. output_ptr MUST equal game_get_render_buffer_ptr(); capacity MUST
 * be at least game_get_render_buffer_len(). Returns the exact byte count or
 * one of the negative GAME_ERR_* values. */
int32_t game_render(uint32_t output_ptr, uint32_t output_capacity);
void game_shutdown(void);

/* Required accessors; width/height are 1..1024. Framebuffer is tightly
 * packed RGBA8, top-left origin, row_stride=width*4, straight (not
 * premultiplied) alpha. Length is at least width*height*4. */
uint32_t game_get_width(void);
uint32_t game_get_height(void);
uint32_t game_get_render_buffer_ptr(void);
uint32_t game_get_render_buffer_len(void);

/* Required guest-owned scratch regions. Config is one UTF-8 JSON manifest
 * configuration object. Each input is one UTF-8 JSON event object:
 *   KEY_DOWN/KEY_UP: {type,code,modifiers,timestamp_micros}
 *   POINTER_DOWN/UP/MOVE/CANCEL: {type,x,y,code,buttons,modifiers,timestamp_micros}
 * Coordinates are finite logical-canvas pixels. timestamp_micros is a
 * monotonic microsecond timestamp relative to game start. All JSON is
 * length-delimited, has no trailing NUL, and must fit the reported capacity.
 * These regions MUST NOT overlap the framebuffer or mutable game state.
 */
uint32_t game_get_config_buffer_ptr(void);
uint32_t game_get_config_buffer_capacity(void);
uint32_t game_get_input_buffer_ptr(void);
uint32_t game_get_input_buffer_capacity(void);
#endif
