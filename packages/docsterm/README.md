<!-- Generated from README.md at the repository root by scripts/sync-readme.mjs. Edit that file instead. -->

# docsterm

An embeddable terminal for documentation pages, built on xterm.js 6. Readers run commands right on the page — in a shell emulated in the browser, a JavaScript or Python REPL, a WebAssembly program or a real shell on your server — ask an AI to turn a request into a command (`#deploy the app`), and get an explanation when a command fails.

Русская версия: [README.ru.md](https://github.com/Surdeddd/docsterm/blob/main/README.ru.md) · Framework recipes: [docs/embedding.md](https://github.com/Surdeddd/docsterm/blob/main/docs/embedding.md) · Changes: [CHANGELOG.md](https://github.com/Surdeddd/docsterm/blob/main/CHANGELOG.md)

**Live demo:** [docsterm.vercel.app](https://docsterm.vercel.app) (add `?ai=mock` for the offline AI flow) · **npm:** [docsterm](https://www.npmjs.com/package/docsterm)

![docsterm demo: a shell command, an AI-suggested command accepted with y](https://raw.githubusercontent.com/Surdeddd/docsterm/main/docs/demo.gif)

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [What runs where](#what-runs-where)
- [Reference](#reference)
- [Security and limits](#security-and-limits)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

## Install

```bash
npm install docsterm @xterm/xterm
```

`docsterm` depends on `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-unicode11` and `acorn`. Add `@xterm/xterm` to your own dependencies as well, because your app imports its stylesheet: the widget does not inject `@xterm/xterm/css/xterm.css` for you.

One package, eleven entry points. Import only what you use; an optional peer is needed only for the entry that uses it.

| Import | What it is | Also install |
| --- | --- | --- |
| `docsterm` | The widget (`DocsTerminal`), Run buttons, mock AI provider, themes, en/ru messages, types | — |
| `docsterm/shell` | A POSIX-like shell over a virtual file system; your CLI becomes a command | — |
| `docsterm/javascript` | A JavaScript REPL in a Web Worker | — |
| `docsterm/pyodide` | A Python REPL (CPython on Pyodide) in a Web Worker | — (the runtime downloads from jsDelivr, or from your `indexURL`) |
| `docsterm/wasi` | Runs one `wasm32-wasi` program (Rust, C, C++, Zig, Go) | your `.wasm` file |
| `docsterm/websocket` | Commands run on your server over a WebSocket | a server, see [examples/websocket-server](https://github.com/Surdeddd/docsterm/blob/main/examples/websocket-server/README.md) |
| `docsterm/mock` | Scripted outputs with no compute, for tutorials and tests | — |
| `docsterm/anthropic` | AI provider on the Anthropic SDK, bring-your-own-key | `@anthropic-ai/sdk` (>= 0.50.1) |
| `docsterm/openai` | AI provider for any OpenAI-compatible endpoint, plain `fetch` | — |
| `docsterm/react` | The `<DocsTerminal>` React component | `react` (>= 18) |
| `docsterm/element` | The `<docs-terminal>` custom element for any framework or plain HTML | — |

Every entry imports cleanly in Node without a DOM (server-side builds of Docusaurus, Next.js, VitePress and Astro), and the package has `"sideEffects": false`. Types resolve under the `bundler`, `nodenext` and `node10` module resolutions; the React types need TypeScript 4.4 or newer.

## Quick start

Give the container a height; the terminal fills it and refits when it resizes.

```ts
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm'
import { createShellBackend } from 'docsterm/shell'

const terminal = new DocsTerminal({
  backend: createShellBackend({
    cwd: '/project',
    files: { project: { 'README.md': '# demo app\n', src: { 'index.ts': 'export const answer = 42\n' } } },
  }),
  theme: 'auto',
})

const container = document.querySelector<HTMLElement>('#terminal')
if (container) await terminal.mount(container)
```

React (keep the backend stable, see [React](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#react)):

```tsx
import '@xterm/xterm/css/xterm.css'
import { useState } from 'react'
import { DocsTerminal } from 'docsterm/react'
import { createPyodideBackend } from 'docsterm/pyodide'

export function PythonTutorial() {
  const [backend] = useState(() => createPyodideBackend())
  return <DocsTerminal backend={backend} theme="auto" style={{ height: 320 }} />
}
```

Any other framework, or plain HTML, uses the custom element:

```html
<docs-terminal backend="shell" theme="auto" style="height: 280px"></docs-terminal>
```

```ts
import '@xterm/xterm/css/xterm.css'
import { defineDocsTerminal } from 'docsterm/element'

defineDocsTerminal()
```

Recipes for Docusaurus, Next.js, Vue/VitePress, Astro/Starlight, plain HTML with an import map and Vite: [docs/embedding.md](https://github.com/Surdeddd/docsterm/blob/main/docs/embedding.md).

## What runs where

A browser tab is not a Linux machine. Anything written in JavaScript or compiled to WebAssembly runs on the reader's machine; anything that needs a kernel (Docker, systemd, real processes) needs a machine you run.

| You want to document | Runs where | How |
| --- | --- | --- |
| Your own CLI (`orbit`, `stripe`, `supabase`…) | reader's browser | `docsterm/shell`, with the CLI registered as a command |
| Shell basics (`ls`, `grep`, pipes, redirects) | reader's browser | `docsterm/shell`, 33 builtins |
| A JavaScript or TypeScript SDK | reader's browser | `docsterm/javascript` |
| A Python library | reader's browser | `docsterm/pyodide`, `pip install` for pure-Python wheels |
| A Rust, C, C++, Zig or Go program | reader's browser | `docsterm/wasi`, compiled to `wasm32-wasip1` |
| Ruby, PHP, Lua, SQLite | reader's browser | your own `Backend` around `ruby.wasm`, `php-wasm`, `wasmoon`, `sql.js`… |
| Docker, git, kubectl, npm, a real Linux shell | your server | `docsterm/websocket` and the [reference server](https://github.com/Surdeddd/docsterm/blob/main/examples/websocket-server/README.md) |
| Node.js in the browser | — | not supported |

## Reference

- [Backends](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#backends) — Six backends, the capability matrix and the options of each
- [The terminal](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#the-terminal) — Keys, history, completion, the less pager, Ctrl+C
- [AI providers](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#ai-providers) — Anthropic, OpenAI-compatible endpoints, local models, keys and errors
- [Control API](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#control-api) — Methods, events and run reports of a terminal
- [Run buttons](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#run-buttons) — Turn code blocks of a page into Run buttons
- [React](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#react) — The `<DocsTerminal>` component and keeping the backend stable
- [The `<docs-terminal>` element](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#the-docs-terminal-element) — The custom element for any framework or plain HTML
- [Widget options](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#widget-options) — Every option of the widget
- [Writing a backend](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#writing-a-backend) — The `Backend` contract, with interactive programs
- [Content-Security-Policy](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#content-security-policy) — What each backend needs from the page policy
- [Languages and themes](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#languages-and-themes) — Messages in English and Russian, themes

## Security and limits

- **Workers share your origin.** The JavaScript and Python workers run with the authority of the documentation's origin: code a reader types can call same-origin URLs with the site's cookies and read and write its IndexedDB and Cache Storage. If your docs share an origin with an application that relies on cookies, serve the JavaScript and Python terminals from an origin without those cookies.
- **Shell regular expressions.** `grep -E` and `grep -P` run on the page's main thread without a time limit; a pattern with catastrophic backtracking freezes the tab.
- **Pyodide from the CDN** loads without an integrity check. For production, self-host it and set `indexURL`.
- **WASI on the page.** `worker: false` or a custom `instantiate` blocks the page while a program runs, and a compute loop cannot be stopped.
- **AI keys** live in the reader's `localStorage`, where every script on your origin can read them; see [Keys, errors and answers](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#keys-errors-and-answers).
- **AI suggestions** never run without `y`; they are stripped of escape sequences, refused when they contain invisible characters or do not fit the screen, and keys typed before the question appears are discarded. Pasted `#` lines never reach the AI.
- **Servers.** A WebSocket backend lets strangers type commands on your machine. Start from the [reference server](https://github.com/Surdeddd/docsterm/blob/main/examples/websocket-server/README.md), which runs every session as a non-root user in a Docker container without network and with CPU, memory and process limits, and read its security section: for a public deployment it recommends gVisor or user-namespace remapping.
- **Analytics.** Events and run reports can carry secrets the reader typed; see the privacy note in [Control API](https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md#control-api).

## Development

```bash
pnpm install
pnpm build                          # builds packages/docsterm/dist (into .dist-next, swapped in on success)
pnpm --filter docsterm-demo dev     # the demo, which reads dist
pnpm typecheck
pnpm lint
pnpm test                           # vitest unit tests
pnpm test:scripts                   # node:test for scripts/
pnpm coverage
pnpm exec playwright install chromium   # once
pnpm e2e                            # builds the library and the demo, then runs Playwright on port 4179
pnpm probe                          # packs the library and checks it in clean projects (needs the npm registry)
node scripts/sync-readme.mjs        # regenerates packages/docsterm/README.md from this file
```

The demo understands `?ai=mock` (the AI flow offline), `?locale=en` or `?locale=ru`, `?theme=light` or `?theme=dark`, and `?isolated`, which makes the dev and preview servers send the cross-origin isolation headers so Python keeps its variables on Ctrl+C; `/react.html` is the React check page. The e2e suite runs Python offline from `node_modules/pyodide`; only the `pip install` test needs the network (`cdn.jsdelivr.net`, `pypi.org`).

The repository needs Node.js 22.22.2+, 24.15+ or 26 and pnpm 11.22. The reference WebSocket server has its own [README](https://github.com/Surdeddd/docsterm/blob/main/examples/websocket-server/README.md).

## Roadmap

- Node.js backend (no mature open-source browser sandbox for Node.js exists yet)
- Step-by-step tutorial mode with output checks
- Reading typed input in Pyodide and WASI programs (needs cross-origin isolation)
- Stuck-point analytics for docs teams

## License

MIT © [Surdeddd](https://github.com/Surdeddd)
