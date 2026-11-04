import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  root: 'examples/hello-vue3',
  base: './',
  plugins: [vue()],
  build: { outDir: '../../dist/games/hello-vue3', emptyOutDir: true, sourcemap: false },
})
