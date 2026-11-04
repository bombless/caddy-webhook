# WASM worker fixtures

`minimal-valid.c` is the source for the real ABI v1 smoke-test module.
`minimal-valid.wasm.b64` is the checked-in binary encoded as text so it can be
reviewed and updated through text-only repository tooling. The Node test decodes
it and instantiates it with the real WebAssembly engine; it does not mock the
module exports.

Regenerate the fixture with a Clang toolchain that includes the wasm32 target:

```sh
clang --target=wasm32 -O1 -nostdlib \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--initial-memory=131072 -Wl,--max-memory=262144 \
  -Wl,--strip-all -o minimal-valid.wasm minimal-valid.c
base64 -w0 minimal-valid.wasm > minimal-valid.wasm.b64
```

The fixture exports every required ABI v1 function and a two-page linear
memory. It accepts a 1x1 RGBA framebuffer, acknowledges input, and renders one
opaque red pixel. It is a smoke fixture, not a game sample or a complete
conformance suite.

`variants.c` is the shared source for the invalid-module corpus in
`invalid-fixtures.json`. The fixtures are compiled with the same linker flags
as the valid fixture and one of these defines:

- `-DABI_VERSION=99` — unsupported ABI version
- `-DHOST_IMPORT` — imports an unapproved host function
- `-DINVALID_CONFIG_PTR` — returns an out-of-range config pointer
- `-DGAME_WIDTH=0` — invalid framebuffer dimensions
- `-DTRAP_ON_UPDATE` — traps during a simulation tick
- `-DOMIT_RENDER_EXPORT` — exports the render function under the wrong name

The oversized-memory fixture is built with
`-Wl,--initial-memory=196608` instead of `131072`; the runtime test config
allows only two pages. The invalid modules are base64-encoded in the JSON file
and exercised by the worker tests using the real WebAssembly engine.
