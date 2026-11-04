#ifndef BOMBLESS_GAME_ABI_H
#define BOMBLESS_GAME_ABI_H
#include <stdint.h>

/* bombless-game-abi v1. All pointers are byte offsets in exported memory.
 * Return codes: 0 success; -1 invalid argument; -2 unsupported ABI/config;
 * -3 insufficient capacity; -4 invalid state; -5 internal error.
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
/* Returns exactly width * height * 4 bytes written, or a negative error. */
int32_t game_render(uint32_t output_ptr, uint32_t output_capacity);
void game_shutdown(void);

uint32_t game_get_width(void);
uint32_t game_get_height(void);
uint32_t game_get_render_buffer_ptr(void);
uint32_t game_get_render_buffer_len(void);

/* ABI v1 host-memory contract. Reserve these writable guest-memory regions;
 * the host writes UTF-8 JSON config/input records into them before each call.
 * They must not overlap the framebuffer or module-owned live state.
 */
uint32_t game_get_config_buffer_ptr(void);
uint32_t game_get_config_buffer_capacity(void);
uint32_t game_get_input_buffer_ptr(void);
uint32_t game_get_input_buffer_capacity(void);
#endif
