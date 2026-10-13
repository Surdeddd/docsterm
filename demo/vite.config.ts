import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

const require = createRequire(import.meta.url)
const manifest = require('docsterm/package.json') as { version: string; exports: Record<string, unknown> }

const entries = Object.keys(manifest.exports)
  .filter((key) => key !== './package.json')
  .map((key) => (key === '.' ? 'docsterm' : `docsterm/${key.slice(2)}`))

const isolate: Connect.NextHandleFunction = (request, response, next) => {
  const url = new URL(request.url ?? '/', 'http://demo.local')
  if (url.searchParams.has('isolated')) {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  next()
}

const crossOriginIsolation = (): Plugin => ({
  name: 'docsterm-demo-isolation',
  configureServer(server) {
    server.middlewares.use(isolate)
  },
  configurePreviewServer(server) {
    server.middlewares.use(isolate)
  },
})

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url))

export default defineConfig({
  plugins: [react(), crossOriginIsolation()],
  define: {
    __DOCSTERM_VERSION__: JSON.stringify(manifest.version),
    __DOCSTERM_ENTRIES__: JSON.stringify(entries),
  },
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: {
        main: page('index.html'),
        react: page('react.html'),
      },
    },
  },
})
