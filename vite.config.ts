import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@engine': resolve(__dirname, './src/engine'),
      '@components': resolve(__dirname, './src/components'),
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@met4citizen/headtts'],
  },
  build: {
    target: 'esnext',
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer (used by some WASM modules)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
