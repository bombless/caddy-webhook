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
