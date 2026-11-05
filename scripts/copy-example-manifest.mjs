import { copyFile, mkdir } from 'node:fs/promises'

const destination = 'dist/_build/hello-vue3'
await mkdir(destination, { recursive: true })
await copyFile('examples/hello-vue3/manifest.json', `${destination}/manifest.json`)
