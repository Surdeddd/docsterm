import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    exclude: ['pyodide'],
  },
  build: {
    target: 'es2022',
  },
})
