# docsterm

Встраиваемый AI-терминал для документации. Живая консоль прямо на docs-странице: читатель выполняет команды в браузере, просит AI обычным языком (`#задеплой приложение`) и получает AI-объяснение, когда команда падает — без серверов и песочниц на вашей стороне.

English version: [README.md](./README.md)

**Живое демо:** [docsterm.vercel.app](https://docsterm.vercel.app) (добавь `?ai=mock` для офлайн AI-флоу) · **npm:** [docsterm](https://www.npmjs.com/package/docsterm)

```bash
npm install docsterm docsterm-backend-mock @xterm/xterm
```

## Зачем

- Доки CLI/SDK — статичный текст. Читатель копирует команды к себе в терминал, теряет контекст, опечатывается и бросает туториал.
- Платформы интерактивных туториалов (Killercoda, Instruqt, KodeKloud) гоняют серверные VM — дорого, тяжело в эксплуатации, и это отдельные платформы, а не виджет для собственных доков.
- AI-терминалы стали нормой в нативных приложениях (Warp, Wave, IDE-плагины). docsterm приносит это в веб, прямо на страницу, с самой страницей в роли контекста.

Всё выполняется на клиенте: Python через [Pyodide](https://pyodide.org), скриптованные туториалы через mock-бекенд, AI — по собственному ключу читателя (BYOK, Anthropic).

## Пакеты

| Пакет | Что это |
|---|---|
| `docsterm` | Виджет: xterm.js UI, строчный редактор, логика сессии, i18n (en/ru), темы, сбор контекста страницы, mock-AI |
| `docsterm-backend-mock` | Скриптованные команды без вычислений — для туториалов и тестов |
| `docsterm-backend-pyodide` | Настоящий Python 3 в браузере (Pyodide, лениво с CDN) |
| `docsterm-ai-anthropic` | AI-провайдер на официальном Anthropic SDK, браузерный режим, BYOK |
| `docsterm-react` | React-компонент `<DocsTerminal>` |

## Быстрый старт

```bash
pnpm install
pnpm --filter docsterm-demo dev
```

Открой напечатанный URL. Добавь `?ai=mock` чтобы попробовать AI-флоу офлайн, `?locale=ru` для русских сообщений виджета, `?theme=dark` для тёмной темы.

## Использование

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
  locale: 'ru',
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

Рецепты для Docusaurus, Vite и чистого HTML: [docs/embedding.md](./docs/embedding.md).

## Терминал

- Строчный REPL: команда → вывод, exit-коды отслеживаются.
- `#<запрос>` — AI превращает запрос в одну команду, показывает её с объяснением и спрашивает `выполнить? [y/N]`. Без подтверждения ничего не запускается.
- `explain` — стримит AI-объяснение последней упавшей команды.
- Встроенные команды: `help`, `clear`, `explain`. История стрелками, Ctrl+C отменяет строку.
- AI видит контекст страницы (title, description, заголовки) и последние команды — лёгкий RAG без инфраструктуры.

## AI и ключи

`docsterm-ai-anthropic` ходит в Anthropic API прямо из браузера (официальный SDK, `dangerouslyAllowBrowser`). Ключ — свой у читателя: хранится в `localStorage` под `docsterm:anthropic-key` и не уходит никуда, кроме `api.anthropic.com`. Подсказки — через structured outputs (гарантированный JSON), объяснения — стримом. Модель по умолчанию: `claude-opus-5` (настраивается).

Для доков без AI просто не передавай опцию `ai` — терминал работает как обычный интерактивный туториал. Для офлайн-демо и тестов есть `createMockAIProvider` в `docsterm`.

## Языки и темы

Сообщения виджета — на английском и русском (`locale: 'en' | 'ru'`, по умолчанию из `navigator.language`). Темы: `light`, `dark`, `auto` (следует `prefers-color-scheme`).

## Разработка

```bash
pnpm install
pnpm typecheck   # tsc по всем пакетам
pnpm test        # сборка пакетов + vitest (юнит)
pnpm e2e         # Playwright по собранному демо (включая живой Pyodide)
```

## Роадмап

- Node.js-бекенд (ждёт зрелой MIT-песочницы в браузере; WebContainers/BrowserPod коммерческие, nodepod не опубликован)
- Пошаговый движок туториалов с валидацией вывода
- Пакет-плагин для Docusaurus, обёртки Vue/Svelte
- WebSocket-бекенд для серверных сценариев (docker/k8s)
- Аналитика застреваний для docs-команд

## Лицензия

MIT
