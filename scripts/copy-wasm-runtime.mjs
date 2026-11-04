import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist/wasm', { recursive: true })
await cp('wasm/runtime', 'dist/wasm/runtime', { recursive: true })
