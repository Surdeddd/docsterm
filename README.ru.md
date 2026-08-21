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

## Один пакет, девять входов

Ставится `docsterm` один раз, импортируется только нужное. Pyodide, Anthropic SDK и React — **опциональные peer-зависимости**: не импортируешь вход, и его зависимость не попадает ни в бандл, ни в `node_modules`.

| Импорт | Что это |
|---|---|
| `docsterm` | Виджет: xterm.js UI, строчный редактор, логика сессии, i18n (en/ru), темы, сбор контекста страницы, mock-AI |
| `docsterm/shell` | Настоящая оболочка: виртуальная ФС, конвейеры, перенаправления, `&&`/`\|\|`, globs, переменные, ~25 встроенных команд и своя CLI как команда |
| `docsterm/mock` | Скриптованные команды без вычислений — для туториалов и тестов |
| `docsterm/javascript` | Рантайм JavaScript в изолированном Web Worker, с таймаутами и живым состоянием |
| `docsterm/pyodide` | Настоящий Python 3 в браузере (Pyodide, лениво с CDN) |
| `docsterm/wasi` | Rust, C, C++, Zig, TinyGo — любой бинарник, собранный в wasm32-wasi, прямо в браузере читателя |
| `docsterm/websocket` | Команды выполняются на твоём сервере — docker, git, kubectl, всё что умеет настоящий шелл |
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

## Что реально может работать в терминале на странице доков

Вкладка браузера — не машина с Linux, поэтому граница проходит честно: **всё, что компилируется в WebAssembly или написано на JS, работает у читателя; всё, чему нужно ядро — Docker, systemd, настоящие процессы — требует машины.** docsterm закрывает обе стороны.

| Что документируешь | Где выполняется | Чем |
|---|---|---|
| Свою CLI (`orbit`, `stripe`, `supabase`…) | Браузер читателя | `docsterm/shell` — регистрируешь CLI как команду |
| Базовый шелл (`ls`, `grep`, конвейеры, перенаправления) | Браузер читателя | `docsterm/shell` — ~25 встроенных команд |
| JavaScript / TypeScript SDK | Браузер читателя | `docsterm/javascript` — Web Worker, живые переменные, `await` |
| Библиотеку на Python | Браузер читателя | `docsterm/pyodide` — настоящий CPython на WASM, `pip install` работает |
| **Rust, C, C++, Zig, TinyGo** | Браузер читателя | `docsterm/wasi` — собираешь в `wasm32-wasip1` и кладёшь `.wasm` рядом с доками |
| Ruby, PHP, Lua, SQLite | Браузер читателя | `Backend` на ~20 строк вокруг `ruby.wasm`, `php-wasm`, `wasmoon`, `sql.js`, … |
| **Docker, git, kubectl, ssh, npm, настоящий Linux** | **Твой сервер** | `docsterm/websocket` — один сокет до контейнера, которым ты управляешь |
| Node.js на клиенте | — | Пока нет: зрелой MIT-песочницы не существует (WebContainers и BrowserPod коммерческие, nodepod так и не вышел) |

То есть: **Docker и git поддерживаются — через `docsterm/websocket`.** Запустить рантайм контейнеров внутри вкладки нельзя в принципе, и любой продукт, который утверждает обратное, либо тащит эмулятор x86, либо ходит на сервер. docsterm ходит на сервер, и какой это сервер — решаешь ты.

### Настоящие команды через WebSocket

```ts
import { createWebSocketBackend } from 'docsterm/websocket'

const backend = createWebSocketBackend({
  url: 'wss://sandbox.acme.dev/shell',
  prompt: 'demo@sandbox:~$ ',
})
```

Протокол — три JSON-сообщения, поэтому серверная часть крошечная. Вот она целиком, на Node:

```js
import { WebSocketServer } from 'ws'
import { exec } from 'node:child_process'

new WebSocketServer({ port: 8080 }).on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'ready', banner: 'ubuntu sandbox' }))
  socket.on('message', (raw) => {
    const { id, command } = JSON.parse(raw)
    // Только внутри одноразового контейнера, никогда на хосте:
    const child = exec(`docker exec docs-sandbox sh -lc ${JSON.stringify(command)}`)
    child.stdout.on('data', (chunk) => socket.send(JSON.stringify({ type: 'output', id, chunk })))
    child.stderr.on('data', (chunk) => socket.send(JSON.stringify({ type: 'output', id, chunk })))
    child.on('close', (code) => socket.send(JSON.stringify({ type: 'exit', id, code: code ?? 0 })))
  })
})
```

Коды возврата приходят обратно в виджет, поэтому `explain` работает на упавшем `git push` ровно так же, как на упавшей строке Python. **Безопасность на тебе:** каждая сессия — одноразовый контейнер без доступов, с лимитом CPU и памяти и без сети хоста: читатель набирает произвольные команды.

## Бекенды

Бекенд отвечает на один вопрос: что вывела командная строка и с каким кодом завершилась. В пакете их шесть, а написать седьмой — строк двадцать.

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

**`docsterm/wasi` — Rust, C, C++, Zig, TinyGo.** Собираешь программу в `wasm32-wasip1`, кладёшь файл рядом с доками — docsterm реализует нужные ей вызовы WASI (argv, окружение, stdin, stdout, stderr, коды возврата), и бинарник работает у читателя без изменений:

```bash
cargo build --release --target wasm32-wasip1   # или: zig build-exe -target wasm32-wasi
```

```ts
import { createWasiBackend } from 'docsterm/wasi'

const backend = createWasiBackend({
  url: '/greet.wasm',
  program: 'greet',
  env: { RUST_LOG: 'info' },
})
```

Каждая команда получает **свежий экземпляр**, поэтому один запуск не может испортить следующий, а ловушка или ненулевой `exit` доходят до виджета кодом возврата, который AI умеет объяснять. На демо крутится ровно это: Rust-бинарник на 55 КБ, без всякого сервера.

**`docsterm/javascript`** исполняет JavaScript в Web Worker: переменные живут между командами, работает `await` верхнего уровня, `console.log` перехватывается, а таймаут убивает зациклившийся код и перезапускает рантайм вместо того, чтобы повесить страницу.

**`docsterm/pyodide`** запускает настоящий CPython. **`docsterm/websocket`** отправляет команды на твою машину. **`docsterm/mock`** проигрывает заранее заданный сценарий. Всё остальное — другой WASM-рантайм, свой REPL — это реализация интерфейса `Backend`: `init`, `run`, `dispose`.

## Терминал

Это не поле ввода, притворяющееся консолью: xterm.js с настоящим строчным редактором, потоковым выводом, отменой и программами, которые читают клавиши напрямую.

| Клавиши | Что делают |
| --- | --- |
| `←` `→`, `Alt+←` `Alt+→` | двигают курсор по символам и по словам |
| `Home` `End`, `Ctrl+A` `Ctrl+E` | в начало и в конец строки |
| `Backspace`, `Delete` | удаляют слева и справа от курсора |
| `Ctrl+U` `Ctrl+K` `Ctrl+W` | вырезают до начала, до конца и предыдущее слово |
| `↑` `↓` | история, до 200 строк |
| `Tab` | дополняет команды и пути: единственное совпадение подставляется, общий префикс дописывается, несколько вариантов выводятся списком |
| `Ctrl+C` | отменяет запущенную команду или очищает набираемую строку |

- **Редактирование настоящее.** Курсор ходит внутри строки, а команда шире виджета переносится и остаётся редактируемой — редактор перерисовывает весь перенесённый блок, а не последнюю строку экрана.
- **Вывод идёт потоком по ходу работы**, а не появляется целиком в конце.
- **`Ctrl+C` бросает запуск сразу.** Приглашение возвращается немедленно, команде срабатывает `AbortSignal`, а всё, что брошенная команда напечатает позже, отбрасывается и не ложится поверх новой строки.
- **Интерактивные программы получают клавиши как есть.** Во встроенном шелле `less`/`more` — настоящий пейджер (`space`, `b`, `j`, `k`, `g`, `G`, `q`), и любой бекенд может вернуть такую сессию.
- **ANSI-цвета**: `ls` красит каталоги; `colors: false` выключает раскраску.
- Встроенные команды виджета поверх бекенда: `help`, `clear`, `explain`, `history` и `#<запрос>` для AI.
- `#<запрос>` — AI превращает запрос в одну команду, показывает её с объяснением и спрашивает `выполнить? [y/N]`. Без подтверждения ничего не запускается.
- `explain` — стримит AI-объяснение последней упавшей команды.
- AI видит контекст страницы (title, description, заголовки) и последние команды — лёгкий RAG без инфраструктуры.

### Бекенды, которые используют весь терминал

`run` получает `RunContext` и может вернуть либо обычный результат, либо интерактивную сессию; необязательный `complete` отвечает за `Tab`:

```ts
import type { Backend, RunContext } from 'docsterm'

const backend: Backend = {
  id: 'demo',
  prompt: '$ ',
  async init() {},

  async run(command: string, ctx?: RunContext) {
    ctx?.write('working...\n')                  // уходит на экран сразу
    if (ctx?.signal.aborted) return { output: '', exitCode: 130 }

    if (command === 'watch') {
      return {                                   // интерактивная сессия
        onKey: (data) => { if (data === 'q') finish({ output: '', exitCode: 0 }) },
        done,                                    // Promise<BackendRunResult>
      }
    }
    return { output: 'done\n', exitCode: 0 }
  },

  complete({ line, cursor }) {
    return { from: 0, to: cursor, candidates: ['watch', 'wait'] }
  },

  dispose() {},
}
```

В `ctx` лежат ещё `columns` и `rows` — полноэкранная программа знает, в какой размер рисует. Бекенды, которым не нужны ни поток, ни интерактив, могут оставить прежний `run` с одним аргументом: второй необязателен, а тип возврата только расширился, так что старые бекенды продолжают работать.

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
- Полноэкранные TUI (альтернативный буфер экрана, отчёты о мыши)
- Аналитика застреваний для docs-команд

## Лицензия

MIT © [Surdeddd](https://github.com/Surdeddd)
