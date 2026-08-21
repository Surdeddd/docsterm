# Embedding docsterm

Three recipes for putting a live terminal into your docs. In every setup the app (not the library) imports the xterm stylesheet once: `import '@xterm/xterm/css/xterm.css'`.

## Docusaurus (MDX)

`docsterm/react` works directly inside MDX pages — no dedicated plugin needed, and no `<BrowserOnly>` wrapper either: since 0.7.0 the widget loads xterm lazily inside `mount()`, so importing it during a server-side build is safe and the component server-renders as an empty container.

```bash
npm install docsterm @xterm/xterm
```

```mdx
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm/react'
import { createMockBackend } from 'docsterm/mock'

# Getting started

<DocsTerminal
  backend={createMockBackend({
    script: {
      'orbit init': { output: 'Project initialized.' },
      'orbit deploy': { output: 'Deployed to https://demo.orbit.app' },
    },
  })}
  theme="auto"
  style={{ height: 280 }}
/>
```

On an older docsterm, or if your bundler resolves `@xterm/xterm` to its CommonJS build during SSR, keep the terminal behind `<BrowserOnly>` instead.

The widget picks up the page title, meta description and headings automatically and feeds them to the AI as context. Override via the `pageContext` prop when embedding into an SPA route.

## React (any app)

```tsx
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm/react'
import { createPyodideBackend } from 'docsterm/pyodide'
import { createAnthropicProvider } from 'docsterm/anthropic'

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
import { createPyodideBackend } from 'docsterm/pyodide'

const terminal = new DocsTerminal({ backend: createPyodideBackend(), theme: 'auto' })
await terminal.mount(document.querySelector('#terminal')!)
```

When `docsterm/pyodide` is bundled with Vite, exclude pyodide from dependency pre-bundling:

```ts
export default defineConfig({
  optimizeDeps: { exclude: ['pyodide'] },
})
```

Pyodide artifacts (~10 MB wasm + stdlib) load lazily from the jsDelivr CDN on first `mount`; pass `indexURL` to `createPyodideBackend` to self-host them.

## Sizing and keys

Give the container a height — the widget fills it and refits on resize. Readers get real line editing (cursor keys, `Home`/`End`, `Ctrl+W`/`Ctrl+U`/`Ctrl+K`, word jumps), history, `Tab` completion when the backend implements `complete`, and `Ctrl+C` to cancel a running command. Backends that stream (`RunContext.write`) or return an `InteractiveRun` — like the shell's `less` — work in any of the recipes above; see the README for the contract.

## AI notes

- `createAnthropicProvider()` reads the key from `localStorage` (`docsterm:anthropic-key`); give docs readers a small settings form that calls `keyStore.set(ANTHROPIC_KEY_NAME, value)` — see `demo/src/ai-settings.ts` for a reference implementation.
- Without an `ai` option the terminal is a plain interactive tutorial; `#` requests print a localized "AI is not configured" message.
- Content-Security-Policy: the page needs `connect-src https://api.anthropic.com https://cdn.jsdelivr.net` (plus your own origins) when AI and Pyodide are enabled.
