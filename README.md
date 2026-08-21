# docsterm

An embeddable AI terminal for documentation. Drop a live console into any docs page: readers run commands right in the browser, ask the AI in plain language (`#deploy the app`), and get AI explanations when a command fails — no servers, no sandboxes to operate.

Русская версия: [README.ru.md](./README.ru.md)

**Live demo:** [docsterm.vercel.app](https://docsterm.vercel.app) (add `?ai=mock` for the offline AI flow) · **npm:** [docsterm](https://www.npmjs.com/package/docsterm)

```bash
npm install docsterm @xterm/xterm
```

## Why

- CLI/SDK docs are static text. Readers copy commands into their own terminal, lose context, make typos, and abandon tutorials.
- Interactive-tutorial platforms (Killercoda, Instruqt, KodeKloud) run server-side VMs — expensive, ops-heavy, and they are separate platforms, not a widget for your own docs.
- AI-assisted terminals are the norm in native apps (Warp, Wave, IDE plugins). docsterm brings that to the web, embedded in the page, with the page itself as context.

Everything runs client-side: Python via [Pyodide](https://pyodide.org), scripted tutorials via the mock backend, AI via the reader's own Anthropic API key (BYOK).

## One package, five entry points

Install `docsterm` once and import only the parts you use. Pyodide, the Anthropic SDK and React are **optional peer dependencies** — skip an entry point and its dependency never reaches your bundle or your `node_modules`.

| Import | What it is |
|---|---|
| `docsterm` | The widget: xterm.js UI, line editor, session logic, i18n (en/ru), themes, page-context collector, mock AI provider |
| `docsterm/shell` | A real shell: virtual filesystem, pipes, redirects, `&&`/`\|\|`, globs, env vars, ~25 builtins, and your own CLI as a command |
| `docsterm/mock` | Scripted commands with zero compute — for tutorials and tests |
| `docsterm/javascript` | A JavaScript runtime in an isolated Web Worker, with timeouts and persistent state |
| `docsterm/pyodide` | Real Python 3 in the browser (Pyodide, loaded lazily from CDN) |
| `docsterm/websocket` | Commands executed on your own server — docker, git, kubectl, anything a real shell runs |
| `docsterm/anthropic` | AI provider on the official Anthropic SDK, browser mode, BYOK |
| `docsterm/openai` | AI provider for **any OpenAI-compatible endpoint** — OpenAI, OpenRouter, Groq, Gemini, DeepSeek, Mistral, xAI, your own gateway, or a local Ollama / LM Studio model. Zero dependencies (plain `fetch`) |
| `docsterm/react` | `<DocsTerminal>` React component |

## Quick start

```bash
pnpm install
pnpm --filter docsterm-demo dev
```

Open the printed URL. Append `?ai=mock` to try the AI flow offline, `?locale=ru` for Russian widget messages, `?theme=dark` to force the dark theme.

## Usage

Vanilla:

```ts
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm'
import { createMockBackend } from 'docsterm/mock'
import { createAnthropicProvider } from 'docsterm/anthropic'

const terminal = new DocsTerminal({
  backend: createMockBackend({
    script: { 'orbit init': { output: 'Project initialized.' } },
  }),
  ai: createAnthropicProvider(),
  locale: 'en',
  theme: 'auto',
})
await terminal.mount(document.querySelector('#terminal')!)
```

React:

```tsx
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal } from 'docsterm/react'
import { createPyodideBackend } from 'docsterm/pyodide'

export const PythonTutorial = () => (
  <DocsTerminal backend={createPyodideBackend()} theme="auto" />
)
```

Docusaurus, Vite and plain-HTML recipes: [docs/embedding.md](./docs/embedding.md).

## What can actually run in a terminal on a docs page

A browser tab is not a Linux machine, so be honest about the line: **anything that compiles to WebAssembly or is written in JS runs on the reader's machine; anything that needs a kernel — Docker, systemd, real processes — needs a machine.** docsterm covers both sides.

| You want to document | Runs where | How |
|---|---|---|
| Your own CLI (`orbit`, `stripe`, `supabase`…) | Reader's browser | `docsterm/shell` — register the CLI as a command |
| Shell basics (`ls`, `grep`, pipes, redirects) | Reader's browser | `docsterm/shell` — ~25 builtins |
| JavaScript / TypeScript SDK | Reader's browser | `docsterm/javascript` — Web Worker, persistent variables, `await` |
| Python library | Reader's browser | `docsterm/pyodide` — real CPython on WASM, `pip install` works |
| Ruby, PHP, Lua, SQLite, C | Reader's browser | A ~20-line `Backend` around `ruby.wasm`, `php-wasm`, `wasmoon`, `sql.js`, … |
| **Docker, git, kubectl, ssh, npm, real Linux** | **Your server** | `docsterm/websocket` — one socket to a container you control |
| Node.js, client-side | — | Not yet: no mature MIT browser sandbox exists (WebContainers and BrowserPod are commercial, nodepod was never published) |

So: **Docker and git are supported — through `docsterm/websocket`.** There is no way to run a container runtime inside a browser tab, and any product claiming otherwise is either shipping an x86 emulator or calling a server. docsterm calls a server, and you decide which one.

### Real commands over a WebSocket

```ts
import { createWebSocketBackend } from 'docsterm/websocket'

const backend = createWebSocketBackend({
  url: 'wss://sandbox.acme.dev/shell',
  prompt: 'demo@sandbox:~$ ',
})
```

The protocol is three JSON messages, so the server side is small — here it is complete, in Node:

```js
import { WebSocketServer } from 'ws'
import { exec } from 'node:child_process'

new WebSocketServer({ port: 8080 }).on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'ready', banner: 'ubuntu sandbox' }))
  socket.on('message', (raw) => {
    const { id, command } = JSON.parse(raw)
    // Run it inside a throwaway container, never on the host:
    const child = exec(`docker exec docs-sandbox sh -lc ${JSON.stringify(command)}`)
    child.stdout.on('data', (chunk) => socket.send(JSON.stringify({ type: 'output', id, chunk })))
    child.stderr.on('data', (chunk) => socket.send(JSON.stringify({ type: 'output', id, chunk })))
    child.on('close', (code) => socket.send(JSON.stringify({ type: 'exit', id, code: code ?? 0 })))
  })
})
```

Exit codes come back to the widget, so `explain` works on a failed `git push` exactly as it does on a failed Python line. **Security is yours:** run every session in a disposable container with no credentials, a CPU/memory cap and no host network — the reader is typing arbitrary commands.

## Backends

A backend answers one question: given a command line, what is the output and the exit code. Five ship with the package, and writing a sixth is ~20 lines.

**`docsterm/shell` — a real shell, in the browser.** Seed it with a file tree, register your own CLI as a command, and readers get a working environment:

```ts
import { createShellBackend } from 'docsterm/shell'

const backend = createShellBackend({
  cwd: '/project',
  files: {
    project: {
      'README.md': '# demo app\n',
      'regions.csv': 'name,region\nalpha,eu\nbeta,us\n',
      src: { 'index.ts': 'export const answer = 42\n' },
    },
  },
  commands: {
    orbit: (ctx) => {
      if (ctx.argv[1] === 'deploy') return 'Deployed to https://demo.orbit.app\n'
      return { stderr: `orbit: unknown command\n`, exitCode: 2 }
    },
  },
})
```

The reader can then run `ls`, `cd src`, `cat regions.csv | grep eu | wc -l`, `echo hi > notes.txt && cat notes.txt`, `find / -name *.ts`, `orbit deploy` — with real exit codes feeding the AI's `explain`.

Builtins: `pwd cd ls cat echo touch mkdir rm cp mv head tail wc grep sort uniq find env export which sleep true false`. Syntax: pipes, `>`/`>>`/`<`, `&&`/`||`/`;`, quoting, `$VAR` expansion, `*`/`?` globs.

Custom commands get `argv`, `stdin`, `cwd`, `env` and the filesystem, may be async, and return either a string or `{ stdout, stderr, exitCode }`.

**`docsterm/javascript`** evaluates JavaScript in a Web Worker: variables persist between commands, top-level `await` works, `console.log` is captured, and a configurable timeout terminates a runaway loop and restarts the runtime instead of freezing the page.

**`docsterm/pyodide`** runs real CPython. **`docsterm/websocket`** forwards commands to your own machine. **`docsterm/mock`** replays a fixed script. Anything else — another WASM runtime, a REPL of your own — is a `Backend` implementation: `init`, `run`, `dispose`.

## The terminal

- Line-oriented REPL: type a command, get output, exit codes tracked.
- `#<request>` — the AI turns the request into one command, shows it with an explanation, and asks `run it? [y/N]` before executing. Nothing runs without confirmation.
- `explain` — streams an AI explanation of the last failed command.
- Builtins: `help`, `clear`, `explain`. History with arrow keys, Ctrl+C cancels the line.
- The AI sees the page context (title, description, headings) and the last few commands — a lightweight RAG with zero infrastructure.

## AI providers

The `AIProvider` interface is provider-agnostic — two sentences (`suggestCommand`, `explainError`) — and three implementations ship with the package:

```ts
// Anthropic, via the official SDK
import { createAnthropicProvider } from 'docsterm/anthropic'
const ai = createAnthropicProvider({ model: 'claude-opus-5' })

// Any OpenAI-compatible endpoint, via a preset
import { createOpenAIProvider } from 'docsterm/openai'
const ai = createOpenAIProvider({ preset: 'openrouter', model: 'openai/gpt-4.1-mini' })

// A model running on the reader's own machine - no key at all
const ai = createOpenAIProvider({ preset: 'ollama', model: 'llama3.1' })

// Your own gateway, or anything else that speaks /chat/completions
const ai = createOpenAIProvider({ baseURL: 'https://gateway.acme.dev/v1', model: 'internal-fast' })
```

Presets: `openai`, `openrouter`, `groq`, `gemini`, `deepseek`, `mistral`, `together`, `xai`, `ollama`, `lmstudio`. The OpenAI provider has **no dependencies** — it is plain `fetch` plus SSE parsing — so nothing extra reaches your bundle.

Writing your own takes two methods; implement `AIProvider` and pass it as `ai`.

Keys are bring-your-own: they live in the reader's `localStorage` and go only to the endpoint you configured. Suggestions ask for structured JSON (schema mode where supported, tolerant parsing everywhere else), explanations stream token by token.

For docs without AI, skip the `ai` option — the terminal works as a plain interactive tutorial. For offline demos and tests use `createMockAIProvider` from `docsterm`.

## Languages and themes

Widget messages ship in English and Russian (`locale: 'en' | 'ru'`, defaults to `navigator.language`). Themes: `light`, `dark`, or `auto` (follows `prefers-color-scheme`).

## Development

```bash
pnpm install
pnpm typecheck   # tsc across all packages
pnpm test        # builds packages, then runs vitest (unit)
pnpm e2e         # Playwright against the built demo (incl. real Pyodide)
```

## Roadmap

- Node.js backend (blocked on a mature MIT browser sandbox; WebContainers/BrowserPod are commercial, nodepod is not published)
- Step-by-step tutorial engine with output validation
- Docusaurus plugin package, Vue/Svelte wrappers
- WebSocket backend for server-side scenarios (docker/k8s)
- Stuck-point analytics for docs teams

## License

MIT © [Surdeddd](https://github.com/Surdeddd)
