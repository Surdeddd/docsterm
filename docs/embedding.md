# Embedding docsterm

Three recipes for putting a live terminal into your docs. In every setup the app (not the library) imports the xterm stylesheet once: `import '@xterm/xterm/css/xterm.css'`.

## Docusaurus (MDX)

`docsterm-react` works directly inside MDX pages — no dedicated plugin needed. Docusaurus renders MDX with React, so wrap the terminal in `<BrowserOnly>` (xterm needs a real DOM):

```bash
npm install docsterm docsterm-react docsterm-backend-mock @xterm/xterm
```

```mdx
import BrowserOnly from '@docusaurus/BrowserOnly'

# Getting started

<BrowserOnly>
  {() => {
    require('@xterm/xterm/css/xterm.css')
    const { DocsTerminal } = require('docsterm-react')
    const { createMockBackend } = require('docsterm-backend-mock')
    const backend = createMockBackend({
      script: {
        'orbit init': { output: 'Project initialized.' },
        'orbit deploy': { output: 'Deployed to https://demo.orbit.app' },
      },
    })
    return <DocsTerminal backend={backend} theme="auto" style={{ height: 280 }} />
  }}
</BrowserOnly>
```

The widget picks up the page title, meta description and headings automatically and feeds them to the AI as context. Override via the `pageContext` prop when embedding into an SPA route.

## React (any app)

```tsx
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm-react'
import { createPyodideBackend } from 'docsterm-backend-pyodide'
import { createAnthropicProvider } from 'docsterm-ai-anthropic'

export function PythonPlayground() {
  return (
    <DocsTerminal
      backend={createPyodideBackend()}
      ai={createAnthropicProvider()}
      locale="en"
      theme="auto"
      style={{ height: 300 }}
    />
  )
}
```

The component mounts the widget on mount and disposes it on unmount; a new `backend` instance remounts the terminal.

## Vanilla + Vite

```ts
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm'
import { createPyodideBackend } from 'docsterm-backend-pyodide'

const terminal = new DocsTerminal({ backend: createPyodideBackend(), theme: 'auto' })
await terminal.mount(document.querySelector('#terminal')!)
```

When `docsterm-backend-pyodide` is bundled with Vite, exclude pyodide from dependency pre-bundling:

```ts
export default defineConfig({
  optimizeDeps: { exclude: ['pyodide'] },
})
```

Pyodide artifacts (~10 MB wasm + stdlib) load lazily from the jsDelivr CDN on first `mount`; pass `indexURL` to `createPyodideBackend` to self-host them.

## AI notes

- `createAnthropicProvider()` reads the key from `localStorage` (`docsterm:anthropic-key`); give docs readers a small settings form that calls `keyStore.set(ANTHROPIC_KEY_NAME, value)` — see `demo/src/ai-settings.ts` for a reference implementation.
- Without an `ai` option the terminal is a plain interactive tutorial; `#` requests print a localized "AI is not configured" message.
- Content-Security-Policy: the page needs `connect-src https://api.anthropic.com https://cdn.jsdelivr.net` (plus your own origins) when AI and Pyodide are enabled.
