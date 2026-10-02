import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5191 },
  base: './',
  // three.js 本体が大きいので警告の閾値を上げる
  build: { chunkSizeWarningLimit: 800 },
})
