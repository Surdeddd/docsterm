# docsterm

Встраиваемый AI-терминал для документации. Живая консоль прямо на docs-странице: читатель выполняет команды в браузере, просит AI обычным языком (`#задеплой приложение`) и получает AI-объяснение, когда команда падает — без серверов и песочниц на вашей стороне.

English version: [README.md](./README.md)

**Живое демо:** [docsterm.vercel.app](https://docsterm.vercel.app) (добавь `?ai=mock` для офлайн AI-флоу) · **npm:** [docsterm](https://www.npmjs.com/package/docsterm)

```bash
npm install docsterm @xterm/xterm
```

## Зачем

- Доки CLI/SDK — статичный текст. Читатель копирует команды к себе в терминал, теряет контекст, опечатывается и бросает туториал.
- Платформы интерактивных туториалов (Killercoda, Instruqt, KodeKloud) гоняют серверные VM — дорого, тяжело в эксплуатации, и это отдельные платформы, а не виджет для собственных доков.
- AI-терминалы стали нормой в нативных приложениях (Warp, Wave, IDE-плагины). docsterm приносит это в веб, прямо на страницу, с самой страницей в роли контекста.

Всё выполняется на клиенте: Python через [Pyodide](https://pyodide.org), скриптованные туториалы через mock-бекенд, AI — по собственному ключу читателя (BYOK, Anthropic).

## Один пакет, пять входов

Ставится `docsterm` один раз, импортируется только нужное. Pyodide, Anthropic SDK и React — **опциональные peer-зависимости**: не импортируешь вход, и его зависимость не попадает ни в бандл, ни в `node_modules`.

| Импорт | Что это |
|---|---|
| `docsterm` | Виджет: xterm.js UI, строчный редактор, логика сессии, i18n (en/ru), темы, сбор контекста страницы, mock-AI |
| `docsterm/shell` | Настоящая оболочка: виртуальная ФС, конвейеры, перенаправления, `&&`/`\|\|`, globs, переменные, ~25 встроенных команд и своя CLI как команда |
| `docsterm/mock` | Скриптованные команды без вычислений — для туториалов и тестов |
| `docsterm/pyodide` | Настоящий Python 3 в браузере (Pyodide, лениво с CDN) |
| `docsterm/anthropic` | AI-провайдер на официальном Anthropic SDK, браузерный режим, BYOK |
| `docsterm/openai` | AI-провайдер для **любого OpenAI-совместимого эндпоинта** — OpenAI, OpenRouter, Groq, Gemini, DeepSeek, Mistral, xAI, свой шлюз или локальные Ollama / LM Studio. Без зависимостей (чистый `fetch`) |
| `docsterm/react` | React-компонент `<DocsTerminal>` |

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
import { createMockBackend } from 'docsterm/mock'
import { createAnthropicProvider } from 'docsterm/anthropic'

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
import { DocsTerminal } from 'docsterm/react'
import { createPyodideBackend } from 'docsterm/pyodide'

export const PythonTutorial = () => (
  <DocsTerminal backend={createPyodideBackend()} theme="auto" />
)
```

Рецепты для Docusaurus, Vite и чистого HTML: [docs/embedding.md](./docs/embedding.md).

## Бекенды

Бекенд отвечает на один вопрос: что вывела командная строка и с каким кодом завершилась. В пакете их три, а написать четвёртый — строк двадцать.

**`docsterm/shell` — настоящая оболочка в браузере.** Засеваешь дерево файлов, регистрируешь свою CLI как команду — и у читателя рабочее окружение:

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

Читатель после этого может `ls`, `cd src`, `cat regions.csv | grep eu | wc -l`, `echo hi > notes.txt && cat notes.txt`, `find / -name *.ts`, `orbit deploy` — с настоящими кодами возврата, которые уходят в AI-объяснение.

Встроенные: `pwd cd ls cat echo touch mkdir rm cp mv head tail wc grep sort uniq find env export which sleep true false`. Синтаксис: конвейеры, `>`/`>>`/`<`, `&&`/`||`/`;`, кавычки, подстановка `$VAR`, globs `*`/`?`.

Свои команды получают `argv`, `stdin`, `cwd`, `env` и файловую систему, могут быть асинхронными и возвращают либо строку, либо `{ stdout, stderr, exitCode }`.

**`docsterm/pyodide`** запускает настоящий CPython. **`docsterm/mock`** проигрывает заранее заданный сценарий. Всё остальное — WebSocket до своего контейнера, другой WASM-рантайм — это реализация интерфейса `Backend`: `init`, `run`, `dispose`.

## Терминал

- Строчный REPL: команда → вывод, exit-коды отслеживаются.
- `#<запрос>` — AI превращает запрос в одну команду, показывает её с объяснением и спрашивает `выполнить? [y/N]`. Без подтверждения ничего не запускается.
- `explain` — стримит AI-объяснение последней упавшей команды.
- Встроенные команды: `help`, `clear`, `explain`. История стрелками, Ctrl+C отменяет строку.
- AI видит контекст страницы (title, description, заголовки) и последние команды — лёгкий RAG без инфраструктуры.

## AI-провайдеры

Интерфейс `AIProvider` не привязан к вендору — в нём всего два метода (`suggestCommand`, `explainError`), — и в пакете лежат три реализации:

```ts
// Anthropic через официальный SDK
import { createAnthropicProvider } from 'docsterm/anthropic'
const ai = createAnthropicProvider({ model: 'claude-opus-5' })

// Любой OpenAI-совместимый эндпоинт через пресет
import { createOpenAIProvider } from 'docsterm/openai'
const ai = createOpenAIProvider({ preset: 'openrouter', model: 'openai/gpt-4.1-mini' })

// Модель на машине самого читателя - вообще без ключа
const ai = createOpenAIProvider({ preset: 'ollama', model: 'llama3.1' })

// Свой шлюз или что угодно, что понимает /chat/completions
const ai = createOpenAIProvider({ baseURL: 'https://gateway.acme.dev/v1', model: 'internal-fast' })
```

Пресеты: `openai`, `openrouter`, `groq`, `gemini`, `deepseek`, `mistral`, `together`, `xai`, `ollama`, `lmstudio`. У OpenAI-провайдера **нет зависимостей** — это чистый `fetch` плюс разбор SSE, поэтому в бандл ничего лишнего не приезжает.

Свой провайдер — это два метода: реализуй `AIProvider` и передай его в `ai`.

Ключи всегда читательские: лежат в его `localStorage` и уходят только на тот эндпоинт, который ты настроил. Подсказки запрашиваются строгим JSON (схема там, где поддерживается, и терпимый разбор везде), объяснения приходят стримом.

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

MIT © [Surdeddd](https://github.com/Surdeddd)
