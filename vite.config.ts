import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    port: 4742,
    host: '0.0.0.0',
    strictPort: true,
  },
  preview: {
    port: 4742,
    host: '0.0.0.0',
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
})
