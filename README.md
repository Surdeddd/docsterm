# docsterm

An embeddable AI terminal for documentation. Drop a live console into any docs page: readers run commands right in the browser, ask the AI in plain language (`#deploy the app`), and get AI explanations when a command fails — no servers, no sandboxes to operate.

Русская версия: [README.ru.md](./README.ru.md)

## Why

- CLI/SDK docs are static text. Readers copy commands into their own terminal, lose context, make typos, and abandon tutorials.
- Interactive-tutorial platforms (Killercoda, Instruqt, KodeKloud) run server-side VMs — expensive, ops-heavy, and they are separate platforms, not a widget for your own docs.
- AI-assisted terminals are the norm in native apps (Warp, Wave, IDE plugins). docsterm brings that to the web, embedded in the page, with the page itself as context.

Everything runs client-side: Python via [Pyodide](https://pyodide.org), scripted tutorials via the mock backend, AI via the reader's own Anthropic API key (BYOK).

## Packages

| Package | What it is |
|---|---|
| `docsterm` | The widget: xterm.js UI, line editor, session logic, i18n (en/ru), themes, page-context collector, mock AI provider |
| `docsterm-backend-mock` | Scripted commands with zero compute — for tutorials and tests |
| `docsterm-backend-pyodide` | Real Python 3 in the browser (Pyodide, loaded lazily from CDN) |
| `docsterm-ai-anthropic` | AI provider on the official Anthropic SDK, browser mode, BYOK |
| `docsterm-react` | `<DocsTerminal>` React component |

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
import { createMockBackend } from 'docsterm-backend-mock'
import { createAnthropicProvider } from 'docsterm-ai-anthropic'

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
import { DocsTerminal } from 'docsterm-react'
import { createPyodideBackend } from 'docsterm-backend-pyodide'

export const PythonTutorial = () => (
  <DocsTerminal backend={createPyodideBackend()} theme="auto" />
)
```

Docusaurus, Vite and plain-HTML recipes: [docs/embedding.md](./docs/embedding.md).

## The terminal

- Line-oriented REPL: type a command, get output, exit codes tracked.
- `#<request>` — the AI turns the request into one command, shows it with an explanation, and asks `run it? [y/N]` before executing. Nothing runs without confirmation.
- `explain` — streams an AI explanation of the last failed command.
- Builtins: `help`, `clear`, `explain`. History with arrow keys, Ctrl+C cancels the line.
- The AI sees the page context (title, description, headings) and the last few commands — a lightweight RAG with zero infrastructure.

## AI and keys

`docsterm-ai-anthropic` calls the Anthropic API directly from the browser (official SDK, `dangerouslyAllowBrowser`). The key is bring-your-own: stored in `localStorage` under `docsterm:anthropic-key`, never sent anywhere except `api.anthropic.com`. Suggestions use structured outputs (guaranteed JSON), explanations stream. Default model: `claude-opus-5` (configurable).

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

MIT
