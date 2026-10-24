# Embedding docsterm

Recipes for putting a terminal into a documentation site. The API itself is described in the [reference](./reference.md).

Русская версия: [embedding.ru.md](./embedding.ru.md)

## Contents

- [Rules for every setup](#rules-for-every-setup)
- [Vanilla JavaScript and Vite](#vanilla-javascript-and-vite)
- [React](#react)
- [Next.js App Router](#nextjs-app-router)
- [Docusaurus](#docusaurus)
- [The `<docs-terminal>` element](#the-docs-terminal-element)
- [Vue and VitePress](#vue-and-vitepress)
- [Astro and Starlight](#astro-and-starlight)
- [Plain HTML with an import map](#plain-html-with-an-import-map)
- [An AI settings form](#an-ai-settings-form)
- [Bundlers and tests](#bundlers-and-tests)

## Rules for every setup

- **Stylesheet.** Import `@xterm/xterm/css/xterm.css` once, in your app. docsterm never injects it.
- **Height.** Give the container (or the `<docs-terminal>` element) a height. The terminal fills it and refits when it resizes or when web fonts finish loading.
- **One backend per terminal.** A backend object holds the session (files, variables, the Python runtime). Create it once per terminal and keep it; a new object means a new session. Backends can start again after `dispose()`, which is what React StrictMode and remounts need.
- **Server-side rendering.** Every entry imports in Node without a DOM, so Docusaurus, Next.js, VitePress and Astro builds work. The terminal itself mounts only in the browser: the React component renders an empty `<div>` on the server, and `defineDocsTerminal()` does nothing in Node.
- **Content-Security-Policy.** See the [table in the reference](./reference.md#content-security-policy); in short, xterm.js needs `style-src 'unsafe-inline'`, and the JavaScript, Python and WASI backends need workers and WebAssembly or eval.

## Vanilla JavaScript and Vite

```ts
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm'
import { createJavaScriptBackend } from 'docsterm/javascript'

const terminal = new DocsTerminal({
  backend: createJavaScriptBackend({ globals: { apiBase: 'https://api.example.com' } }),
  theme: 'auto',
  welcome: 'Try: await fetch(apiBase).then((r) => r.status)',
})

const container = document.querySelector<HTMLElement>('#terminal')
if (container) {
  terminal.mount(container).catch((error: unknown) => console.error(error))
  window.addEventListener('pagehide', () => terminal.dispose(), { once: true })
}
```

`mount()` rejects when the backend cannot start (the terminal also shows the reason) and with an `AbortError` when `dispose()` runs first. Vite needs no configuration for any entry.

## React

```tsx
import '@xterm/xterm/css/xterm.css'
import { useRef, useState } from 'react'
import { DocsTerminal, type DocsTerminalHandle } from 'docsterm/react'
import { createPyodideBackend } from 'docsterm/pyodide'

export function PythonPlayground({ locale }: { locale: 'en' | 'ru' }) {
  const [backend] = useState(() => createPyodideBackend({ packages: ['micropip', 'numpy'] }))
  const terminal = useRef<DocsTerminalHandle>(null)
  return (
    <section>
      <button type="button" onClick={() => terminal.current?.insert('import numpy as np')}>
        prefill an import
      </button>
      <DocsTerminal
        ref={terminal}
        backend={backend}
        locale={locale}
        theme="auto"
        aria-label="Python playground"
        onReady={(widget) => widget.focus()}
        onError={(error) => console.error(error)}
        style={{ height: 320 }}
      />
    </section>
  )
}
```

- **Keep the backend stable.** `useState(() => createXBackend())` creates it once per component; module scope also works. The component remounts the terminal whenever the `backend` prop is a different object, so `backend={createPyodideBackend()}` inline would restart Python on every re-render.
- **StrictMode** mounts, unmounts and mounts again in development. The result is one working terminal; the backend is disposed and started again when needed.
- **Live props.** `theme`, `locale`, `ai`, `pageContext`, `fontFamily`, `fontSize`, `ariaLabel`, `screenReaderMode` and `onEvent` update the running terminal. `theme` and `pageContext` objects are compared by value, so inline objects are fine; an inline `onEvent` arrow costs one cheap update per render. `welcome` is read only at mount.
- **Ref handle.** `DocsTerminalHandle` has `run`, `insert`, `focus` and `clear`. `run()` rejects with an `AbortError` while no terminal is mounted.
- **Callbacks.** `onReady(terminal)` receives the `DocsTerminal` once the first prompt is shown; `onError(error)` receives mount failures (without it they go to `console.error`).
- **Container attributes.** `id`, `title`, `role`, `className`, `style`, `aria-*` and `data-*` go to the container `<div>`. `aria-label` labels the terminal itself unless `ariaLabel` is set.

## Next.js App Router

`docsterm/react` starts with `'use client'`, so a server component can render it, but it cannot pass a backend: a backend holds functions, which cannot cross from the server to the client. Create the backend in a client component:

```tsx
'use client'

import '@xterm/xterm/css/xterm.css'
import { useState } from 'react'
import { DocsTerminal } from 'docsterm/react'
import { createShellBackend } from 'docsterm/shell'

export function DocsShell() {
  const [backend] = useState(() =>
    createShellBackend({ cwd: '/app', files: { app: { 'package.json': '{ "name": "demo" }\n' } } }),
  )
  return <DocsTerminal backend={backend} theme="auto" style={{ height: 300 }} />
}
```

Save it as `components/docs-shell.tsx` and render it from any page:

```tsx
import { DocsShell } from '@/components/docs-shell'

export default function Page() {
  return (
    <main>
      <h1>Getting started</h1>
      <DocsShell />
    </main>
  )
}
```

## Docusaurus

`docsterm/react` works in MDX pages without `<BrowserOnly>`. A component in `src/components/ShellTerminal.tsx` that follows the site's colour mode and adds Run buttons to the page:

```tsx
import '@xterm/xterm/css/xterm.css'
import { useEffect, useState } from 'react'
import { useColorMode } from '@docusaurus/theme-common'
import { attachRunButtons, type DocsTerminal as Widget } from 'docsterm'
import { DocsTerminal } from 'docsterm/react'
import { createShellBackend } from 'docsterm/shell'

export default function ShellTerminal() {
  const { colorMode } = useColorMode()
  const [backend] = useState(() =>
    createShellBackend({
      cwd: '/project',
      files: { project: { 'README.md': '# orbit\n' } },
      commands: { orbit: (ctx) => (ctx.argv[1] === 'init' ? 'Project initialized.\n' : 'usage: orbit init\n') },
    }),
  )
  const [terminal, setTerminal] = useState<Widget | null>(null)

  useEffect(() => {
    if (!terminal) return
    return attachRunButtons(document.querySelector('article') ?? document.body, terminal)
  }, [terminal])

  return <DocsTerminal backend={backend} theme={colorMode} onReady={setTerminal} style={{ height: 320 }} />
}
```

In a page:

```mdx
import ShellTerminal from '@site/src/components/ShellTerminal'

# Getting started

<pre data-docsterm-run><code>{`$ orbit init
Project initialized.`}</code></pre>

<ShellTerminal />
```

- `theme={colorMode}` follows the navbar toggle; `theme="auto"` would follow only the operating system.
- The effect attaches Run buttons after the terminal is ready and returns the cleanup, so leaving the page removes them and the next page attaches its own.
- Ordinary fenced code blocks get buttons too with `selector: 'pre.prism-code code'`: their `.token-line` rows are read line by line, and `$` prompts pick out the commands. That selector matches every code block, and a block without prompts runs whole, so keep `data-docsterm-run` on pages that mix languages.
- The widget reads the page title, description and headings for the AI. Pass `pageContext` when they do not describe the content.

## The `<docs-terminal>` element

`docsterm/element` defines a custom element for Vue, Svelte, Astro, VitePress, Starlight, Hugo or plain HTML. It uses light DOM, so the page's `xterm.css` and fonts apply.

```ts
import '@xterm/xterm/css/xterm.css'
import { defineDocsTerminal, type DocsTerminalElement } from 'docsterm/element'
import { createShellBackend } from 'docsterm/shell'

defineDocsTerminal()

const element = document.querySelector<DocsTerminalElement>('docs-terminal#cli')
if (element) {
  element.backend = createShellBackend({ cwd: '/project' })
  element.theme = { background: '#1e1e2e', foreground: '#cdd6f4' }
  element.addEventListener('docsterm-error', (event) => {
    if (event.detail.phase === 'init') console.warn(event.detail.message)
  })
  element.addEventListener('docsterm-ready', () => element.terminal?.setOptions({ screenReaderMode: true }))
  void element.run('ls').then((report) => console.info(report.exitCode))
}
```

`defineDocsTerminal(tagName = 'docs-terminal')` registers the element. Importing the module defines nothing; calling it twice is a no-op; in Node it does nothing. If another element already owns the name, it throws: pass another name.

| Attribute | Meaning |
| --- | --- |
| `backend` | A built-in backend with default options, loaded on demand: `shell`, `javascript`, `pyodide` or `websocket` |
| `url` | Server URL for `backend="websocket"` (required) |
| `locale` | `en`, `ru` or a language tag such as `ru-RU` |
| `theme` | `light`, `dark` or `auto` |
| `font-size` | Font size in pixels |
| `font-family` | Font family |
| `aria-label` | Accessible name of the terminal |
| `welcome` | Welcome line, read at mount |

| Property | Meaning |
| --- | --- |
| `backend` | Any `Backend`; wins over the attribute |
| `theme` | `'light'`, `'dark'`, `'auto'` or a `TerminalTheme` object; wins over the attribute |
| `ai` | An `AIProvider` |
| `pageContext` | `Partial<PageContext>` for the AI |
| `onEvent` | Called with every [event](./reference.md#control-api) |
| `terminal` | The mounted `DocsTerminal`, or `null` (read-only) |

Methods: `run(text)`, `insert(text)`, `clear()` and `focus()`, as on [`DocsTerminal`](./reference.md#control-api). `run()`, `insert()` and `clear()` called before a backend exists wait for it. Options without an attribute, such as `screenReaderMode`, go through `element.terminal.setOptions()` once `docsterm-ready` has fired.

Events: `docsterm-event` for every event, plus `docsterm-ready` and `docsterm-error`. They are `CustomEvent`s with the event as `detail`, bubble, and cross shadow roots. `docsterm-error` fires for the `init`, `run` and `ai` phases, so check `detail.phase === 'init'` for start-up failures. A wrong `backend` name or a websocket without `url` is reported as a `docsterm-error` with phase `init`, in the language of the `locale` attribute or else the browser.

Lifecycle:

- The element mounts when it is in the document and has a backend. A new `backend` property, or a change of the `backend` or `url` attribute, remounts it once; other attribute changes apply to the running terminal.
- Removing the element disposes the terminal and rejects pending `run()` calls with an `AbortError`. Disposal waits for a microtask, so moving the element within the same task keeps the session.
- After a load failure (a wrong `backend` name, a websocket without `url`, a backend module that fails to load), `run()` rejects until the `backend` property or the `backend` or `url` attribute changes. If the terminal fails to start, its error stays visible inside the element and `run()` rejects with it.
- The element shows itself as `display: block` unless your CSS sets a display. Its height comes from your CSS.
- Existing children stay above the terminal; put a fallback for readers without JavaScript into `<noscript>`.
- Properties can be set at any time, also before `defineDocsTerminal()` runs: they are picked up when the element upgrades.
- TypeScript: `document.querySelector('docs-terminal')` returns a `DocsTerminalElement`, and `addEventListener` knows the three events (`DocsTerminalElementEventMap`). A custom tag name needs its own `HTMLElementTagNameMap` entry, or `querySelector<DocsTerminalElement>(…)`.

## Vue and VitePress

Tell Vue that `docs-terminal` is a custom element, define it before the app mounts, and bind the backend with `:backend`. Vue sets it as a property because the element has one.

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'docs-terminal' } } })],
})
```

```ts
import '@xterm/xterm/css/xterm.css'
import { createApp } from 'vue'
import { defineDocsTerminal } from 'docsterm/element'
import App from './App.vue'

defineDocsTerminal()
createApp(App).mount('#app')
```

```vue
<script setup lang="ts">
import { createShellBackend } from 'docsterm/shell'

const backend = createShellBackend({ cwd: '/project', files: { project: { 'README.md': '# demo\n' } } })
</script>

<template>
  <docs-terminal :backend="backend" theme="auto" style="height: 300px" />
</template>
```

VitePress renders pages on the server first, where no property can be set. Register the element in the theme, mark it as a custom element in the config, and render it inside `<ClientOnly>`.

`.vitepress/config.ts`:

```ts
import { defineConfig } from 'vitepress'

export default defineConfig({
  vue: { template: { compilerOptions: { isCustomElement: (tag) => tag === 'docs-terminal' } } },
})
```

`.vitepress/theme/index.ts`:

```ts
import '@xterm/xterm/css/xterm.css'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { defineDocsTerminal } from 'docsterm/element'

export default {
  extends: DefaultTheme,
  enhanceApp() {
    defineDocsTerminal()
  },
} satisfies Theme
```

A page:

```md
<script setup lang="ts">
import { useData } from 'vitepress'
import { createShellBackend } from 'docsterm/shell'

const { isDark } = useData()
const backend = createShellBackend({ cwd: '/project' })
</script>

# Getting started

<ClientOnly>
  <docs-terminal :backend="backend" :theme="isDark ? 'dark' : 'light'" style="height: 300px" />
</ClientOnly>
```

`:theme` follows VitePress's appearance toggle; a plain `theme="auto"` follows only the operating system.

## Astro and Starlight

An Astro component, `src/components/Terminal.astro`. Astro bundles the `<script>` and runs it once per page, however many terminals the page has.

```astro
---
interface Props {
  backend?: 'shell' | 'javascript' | 'pyodide'
  height?: string
}
const { backend = 'shell', height = '300px' } = Astro.props
---

<docs-terminal backend={backend} style={`height: ${height}`}></docs-terminal>

<script>
  import '@xterm/xterm/css/xterm.css'
  import { defineDocsTerminal } from 'docsterm/element'

  defineDocsTerminal()

  const syncTheme = () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    for (const element of document.querySelectorAll('docs-terminal')) element.setAttribute('theme', theme)
  }
  new MutationObserver(syncTheme).observe(document.documentElement, { attributeFilter: ['data-theme'] })
  syncTheme()
</script>
```

The theme sync follows Starlight's theme picker, which sets `data-theme` on `<html>`; on a site without it, drop the sync and write `theme="auto"`. Use the component from MDX:

```mdx
import Terminal from '../../components/Terminal.astro'

<Terminal backend="javascript" height="260px" />
```

For a backend with your own files or commands, set the property from a script:

```astro
<docs-terminal id="orbit-terminal" theme="auto" style="height: 320px"></docs-terminal>

<script>
  import '@xterm/xterm/css/xterm.css'
  import { attachRunButtons } from 'docsterm'
  import { defineDocsTerminal, type DocsTerminalElement } from 'docsterm/element'
  import { createShellBackend } from 'docsterm/shell'

  defineDocsTerminal()
  const element = document.querySelector<DocsTerminalElement>('#orbit-terminal')
  if (element) {
    element.backend = createShellBackend({ cwd: '/project', files: { project: { 'README.md': '# orbit\n' } } })
    attachRunButtons(document.querySelector('main') ?? document.body, element)
  }
</script>
```

With Astro's client-side router, run this code in an `astro:page-load` listener and call the Run buttons cleanup before the page changes.

## Plain HTML with an import map

No build step: an import map tells the browser where docsterm and its dependencies live. Pin exact versions.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Getting started</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css" />
    <script type="importmap">
      {
        "imports": {
          "docsterm": "https://cdn.jsdelivr.net/npm/docsterm@0.8.0/dist/index.js",
          "docsterm/element": "https://cdn.jsdelivr.net/npm/docsterm@0.8.0/dist/element/index.js",
          "docsterm/shell": "https://cdn.jsdelivr.net/npm/docsterm@0.8.0/dist/shell/index.js",
          "@xterm/xterm": "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs",
          "@xterm/addon-fit": "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs",
          "@xterm/addon-unicode11": "https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.9.0/lib/addon-unicode11.mjs",
          "acorn": "https://cdn.jsdelivr.net/npm/acorn@8.18.0/dist/acorn.mjs"
        }
      }
    </script>
  </head>
  <body>
    <pre data-docsterm-run><code>$ ls /project</code></pre>
    <docs-terminal id="cli" theme="auto" style="height: 320px"></docs-terminal>
    <script type="module">
      import { attachRunButtons } from 'docsterm'
      import { defineDocsTerminal } from 'docsterm/element'
      import { createShellBackend } from 'docsterm/shell'

      defineDocsTerminal()
      /** @type {import('docsterm/element').DocsTerminalElement | null} */
      const element = document.querySelector('#cli')
      if (element) {
        element.backend = createShellBackend({ cwd: '/project', files: { project: { 'notes.txt': 'hello\n' } } })
        attachRunButtons(document.body, element)
      }
    </script>
  </body>
</html>
```

- docsterm's own modules import each other by relative paths, so only the bare names need entries: `@xterm/xterm`, `@xterm/addon-fit` and `@xterm/addon-unicode11` always, `acorn` for the JavaScript backend. The built-in `backend="…"` attributes load their modules relative to `dist/element/index.js` and need no entry.
- The Python backend loads its runtime from jsDelivr by URL, so it needs no entry either.
- `docsterm/react` and `docsterm/anthropic` need `react` and `@anthropic-ai/sdk` mapped to ES module builds; prefer a bundler for those.

## An AI settings form

Readers bring their own keys. Store a key where the provider reads it, then give the terminal a new provider; no reload is needed.

```ts
import { keyStore, type DocsTerminal } from 'docsterm'
import { ANTHROPIC_KEY_NAME, createAnthropicProvider } from 'docsterm/anthropic'
import { createOpenAIProvider, defaultKeyName } from 'docsterm/openai'

export function useAnthropic(terminal: DocsTerminal, key: string) {
  keyStore.set(ANTHROPIC_KEY_NAME, key)
  terminal.setAI(createAnthropicProvider())
}

export function useOpenRouter(terminal: DocsTerminal, key: string, model: string) {
  keyStore.set(defaultKeyName({ preset: 'openrouter' }), key)
  terminal.setAI(createOpenAIProvider({ preset: 'openrouter', model }))
}

export function forgetKeys() {
  keyStore.clear(ANTHROPIC_KEY_NAME)
  keyStore.clear(defaultKeyName({ preset: 'openrouter' }))
}
```

The demo's settings panel, `demo/src/ai-settings.ts`, is a complete example. Read [Keys, errors and answers](./reference.md#keys-errors-and-answers) before you ship one: keys in `localStorage` are readable by every script on your origin.

## Bundlers and tests

- Vite, webpack 5 (Docusaurus, Next.js), Rollup and esbuild need no configuration. Since 0.8 the Python backend does not use the `pyodide` npm package, so drop any `optimizeDeps.exclude: ['pyodide']` or webpack fallbacks added for older versions.
- Vite may warn that the `'use client'` directive of `docsterm/react` was ignored; the warning is harmless.
- The JavaScript and WASI workers are built from the source text of functions. Do not run docsterm through esbuild's `keepNames` or istanbul coverage instrumentation: the helpers they inject do not exist inside the worker.
- In jsdom tests (Vitest, Jest), stub `window.matchMedia`; xterm.js needs it to open. The widget loads xterm through either its ES or its CommonJS build.
