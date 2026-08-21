# DocsTerm MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **This run:** executed inline by the goal-driven session (approval = `/goal` command, 2026-08-20).

**Goal:** Ship docsterm v0.1 — an embeddable AI terminal widget for documentation: pnpm monorepo with `docsterm`, `docsterm-backend-mock`, `docsterm-backend-pyodide`, `docsterm-ai-anthropic`, `docsterm-react`, a Vite demo site, verified by vitest + tsc + Playwright.

**Architecture:** xterm.js renders the terminal; a pure `SessionController` owns all line/AI/confirm state and talks to a `Backend` (command→result contract) and an `AIProvider` (NL→command suggestion, error explanation). xterm glue is a thin adapter so logic is unit-testable without DOM. Pyodide runs Python fully client-side; mock backend scripts tutorials with zero compute. AI is BYOK via the official Anthropic SDK in browser mode.

**Tech Stack:** TypeScript 5, pnpm workspaces, tsc builds (ESM), vitest 3, @testing-library/react, Playwright, Vite 7 (demo), @xterm/xterm 6.0.0 + @xterm/addon-fit 0.11.0, pyodide 314.x (npm loader + jsdelivr CDN), @anthropic-ai/sdk (latest).

## Global Constraints

- Идентификаторы/код — английский. Пользовательские строки виджета — через каталог сообщений `en`/`ru` (`locale` option, default from `navigator.language`). Никаких склеек "en / ru" в одном литерале.
- Документация: `README.md` (EN) + `README.ru.md` (RU) в корне репо.
- Без пояснительных комментариев в коде. Знание — в `MEMORY_BANK/` (в `.gitignore`).
- git: НЕ коммитить (feedback_no_autocommit) — шаги commit в этом плане отсутствуют намеренно.
- AI model default: `claude-opus-5` (mandated by claude-api skill), configurable. Никаких sampling-параметров. Structured outputs через `output_config.format`. Guard `stop_reason === "refusal"` до чтения `content`.
- Версии: node 24, pnpm 11.22, @xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, pyodide npm 314.0.5.
- nodepod/browserpod: НЕ включать (nodepod отсутствует в npm, browserpod проприетарный) — зафиксировано в GOAL.md.
- Publish в npm НЕ делать.

---

## Contracts (single source of truth — `packages/core/src/types.ts`)

```ts
export type Locale = 'en' | 'ru'

export interface BackendRunResult {
  output: string
  exitCode: number
}

export interface BackendHost {
  write(text: string): void
}

export interface Backend {
  readonly id: string
  readonly prompt: string
  init(host: BackendHost): Promise<void>
  run(command: string): Promise<BackendRunResult>
  dispose(): void
}

export interface PageContext {
  title: string
  url: string
  description: string
  headings: string[]
}

export interface HistoryEntry {
  command: string
  output: string
  exitCode: number
}

export interface CommandSuggestion {
  command: string
  explanation: string
}

export interface SuggestInput {
  request: string
  backendId: string
  context: PageContext
  history: HistoryEntry[]
}

export interface ExplainInput {
  command: string
  output: string
  exitCode: number
  backendId: string
  context: PageContext
  history: HistoryEntry[]
}

export interface AIProvider {
  readonly id: string
  suggestCommand(input: SuggestInput): Promise<CommandSuggestion>
  explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string>
}

export interface DocsTerminalOptions {
  backend: Backend
  ai?: AIProvider
  locale?: Locale
  theme?: 'light' | 'dark' | 'auto'
  pageContext?: Partial<PageContext>
  welcome?: string
}
```

## Behavior spec — SessionController (10 rules)

1. `handleInput(line)` при пустой строке → новый prompt.
2. `#<text>` → AI-режим: `ai.suggestCommand`; без `ai` → локализованное `aiNotConfigured`.
3. Обычная строка → `backend.run`; на время run ввод блокирован (`busy`).
4. Вывод нормализуется `\n` → `\r\n`; после вывода — prompt.
5. `exitCode !== 0` и есть `ai` → печатается hint `errorHint` («type `explain`…»), последняя ошибка запоминается.
6. Builtin `explain` → `ai.explainError` стримом (чанки через onChunk); нет сохранённой ошибки → `nothingToExplain`.
7. AI suggestion → печать `suggestion` + `confirmRun` (`run? [y/N]`); состояние confirm: `y`/`Y` → run, всё остальное → `cancelled`.
8. Builtin `clear` → очистка экрана; `help` → список builtin-команд.
9. История: массив HistoryEntry (cap 50); в AI уходят последние 5. ArrowUp/Down — навигация по введённым командам (в LineEditor).
10. Любая ошибка AI/backend → локализованное сообщение `aiError`/`backendError` + детали, исключение наружу не летит.

## Message catalog keys (en + ru обязательны)

`welcomeDefault, aiNotConfigured, aiThinking, suggestion, confirmRun, cancelled, running, errorHint, explainHeader, nothingToExplain, aiError, backendError, helpText, keyMissing, byePlaceholder` — точный состав финализируется в Task 2, оба языка заполняются одновременно.

---

### Task 0: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `vitest.workspace.ts`
- Create: `MEMORY_BANK/{projectbrief,productContext,systemPatterns,techContext,activeContext,progress}.md`

**Steps:**
- [ ] pnpm-workspace: `packages/*`, `demo`. Root scripts: `build` (`pnpm -r --filter './packages/*' run build`), `typecheck`, `test`, `e2e`.
- [ ] tsconfig.base: `strict`, `module: esnext`, `moduleResolution: bundler`, `target: es2022`, `declaration: true`, `skipLibCheck: true`.
- [ ] `.gitignore`: `node_modules`, `dist`, `MEMORY_BANK/`, `test-results`, `playwright-report`, `.DS_Store`.
- [ ] MEMORY_BANK 6 файлов по Cline-структуре, заполнить из GOAL/README.
- [ ] Verify: `pnpm install` проходит.

### Task 1: `docsterm` — types, i18n, LineEditor

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/{types,messages,line-editor,index}.ts`
- Test: `packages/core/test/{messages,line-editor}.test.ts`

**Interfaces:**
- Produces: contracts выше + `getMessages(locale): Messages`, `resolveLocale(input?: string): Locale`, `class LineEditor`.

**LineEditor contract:**
```ts
export interface LineEditorEvents {
  onRender(buffer: string, cursor: number): void
  onSubmit(line: string): void
}
export class LineEditor {
  constructor(events: LineEditorEvents)
  handleKey(data: string): void
  pushHistory(line: string): void
  reset(): void
}
```
Обрабатывает: printable append, `\x7f` backspace, `\r` submit (буфер → onSubmit, буфер очищен), `\x1b[A`/`\x1b[B` history up/down, `\x03` Ctrl+C → onSubmit('') семантика cancel (буфер сброшен без сабмита), стрелки влево/вправо игнор (MVP: курсор всегда в конце).

**Steps:**
- [ ] Тесты: resolveLocale('ru-RU')==='ru', default 'en'; messages: все ключи есть в en и ru, нет пустых. LineEditor: набор+submit, backspace, история up/down, ctrl+c очищает буфер.
- [ ] Verify fail → implement → verify pass (`pnpm --filter docsterm test`).
- [ ] `pnpm --filter docsterm build` + typecheck зелёные.

### Task 2: `docsterm` — SessionController + DocsTerminal (xterm glue)

**Files:**
- Create: `packages/core/src/{session-controller,docs-terminal,page-context,key-store,theme}.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/session-controller.test.ts`, `packages/core/test/page-context.test.ts`

**Interfaces:**
- Consumes: Task 1 (LineEditor, messages, types).
- Produces:
```ts
export interface SessionIO {
  print(text: string): void
  printPrompt(): void
  clearScreen(): void
  setBusy(busy: boolean): void
}
export class SessionController {
  constructor(opts: { backend: Backend; ai?: AIProvider; messages: Messages; io: SessionIO; pageContext: PageContext })
  submit(line: string): Promise<void>
  get busy(): boolean
}
export class DocsTerminal {
  constructor(options: DocsTerminalOptions)
  mount(element: HTMLElement): Promise<void>
  dispose(): void
}
export function collectPageContext(overrides?: Partial<PageContext>): PageContext
export const keyStore: { get(name: string): string | null; set(name: string, v: string): void; clear(name: string): void }
```
- `collectPageContext`: document.title, location.href, meta[name=description], тексты h1/h2/h3 (первые 30).
- DocsTerminal: создаёт `Terminal` (xterm) + FitAddon, тема из css-переменных/пресетов light+dark, `terminal.onData` → LineEditor → SessionController.submit; повторный mount → throw.

**Steps:**
- [ ] Тесты SessionController с fake io/backend/ai (все 10 правил спеки поведения: run ok, run error + hint, explain стрим, `#` suggest + y/N оба исхода, ai отсутствует, clear/help, busy-блокировка, ai throws → aiError).
- [ ] Verify fail → implement → pass.
- [ ] page-context тест на jsdom (среда vitest jsdom для этого файла).
- [ ] build + typecheck зелёные.

### Task 3: `docsterm-backend-mock`

**Files:**
- Create: `packages/backend-mock/{package.json,tsconfig.json,src/index.ts}`
- Test: `packages/backend-mock/test/mock.test.ts`

**Interfaces:**
```ts
export interface MockScriptEntry {
  output: string
  exitCode?: number
  delayMs?: number
}
export interface MockBackendOptions {
  script: Record<string, MockScriptEntry>
  fallback?: MockScriptEntry
  prompt?: string
}
export function createMockBackend(options: MockBackendOptions): Backend
```
Default fallback: `{ output: 'command not found: <cmd>', exitCode: 127 }`.

**Steps:**
- [ ] Тесты: scripted команда, fallback 127, delayMs, trim входной строки.
- [ ] Implement → pass → build.

### Task 4: `docsterm-backend-pyodide`

**Files:**
- Create: `packages/backend-pyodide/{package.json,tsconfig.json,src/index.ts}`

**Interfaces:**
```ts
export interface PyodideBackendOptions {
  indexURL?: string
  banner?: boolean
}
export function createPyodideBackend(options?: PyodideBackendOptions): Backend
```
- Ленивая загрузка в `init` через `loadPyodide` из npm `pyodide` (indexURL default = jsdelivr CDN версии пакета); stdout/stderr через `setStdout/setStderr` batched → host.write при init и в буфер при run; run: `runPythonAsync`, результат-объект не-None допечатывается repr; исключение → output=short traceback, exitCode=1; иначе 0. prompt `>>> `.
- Проверка — в e2e (Task 8); юнит только на нормализацию traceback (чистая функция `formatPythonError`).

**Steps:**
- [ ] `formatPythonError` тест (обрезка внутренних pyodide-фреймов).
- [ ] Implement → build + typecheck.

### Task 5: `docsterm-ai-anthropic`

**Files:**
- Create: `packages/ai-anthropic/{package.json,tsconfig.json,src/index.ts,src/prompts.ts}`
- Test: `packages/ai-anthropic/test/provider.test.ts`

**Interfaces:**
```ts
export interface AnthropicProviderOptions {
  apiKey?: string
  model?: string
  maxTokens?: number
}
export function createAnthropicProvider(options?: AnthropicProviderOptions): AIProvider
export const ANTHROPIC_KEY_NAME = 'docsterm:anthropic-key'
```
- apiKey: options → keyStore → throw `KeyMissingError`.
- Клиент: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`.
- `suggestCommand`: `client.messages.create` c `output_config: { format: { type: 'json_schema', schema: { type:'object', properties: { command:{type:'string'}, explanation:{type:'string'} }, required:['command','explanation'], additionalProperties:false } } }`; system из `buildSuggestSystem(context, backendId)`; `stop_reason === 'refusal'` → throw; парс JSON первого text-блока.
- `explainError`: `client.messages.stream`, text_delta чанки → onChunk, вернуть полный текст; system из `buildExplainSystem(context, backendId)`.
- prompts.ts: system-промпты включают title/description/headings страницы + правило «single command for the <backendId> environment, JSON only».
- Тест: инжект фейкового client (интерфейс `{ messages: { create, stream } }` в опции `clientFactory` для тестов) — suggest парсится, refusal бросает, explain собирает чанки.

**Steps:**
- [ ] Тесты (fake client) → fail → implement → pass → build.

### Task 6: `docsterm-react`

**Files:**
- Create: `packages/react/{package.json,tsconfig.json,src/index.tsx}`
- Test: `packages/react/test/component.test.tsx`

**Interfaces:**
```ts
export interface DocsTerminalProps extends DocsTerminalOptions {
  className?: string
  style?: React.CSSProperties
}
export function DocsTerminal(props: DocsTerminalProps): JSX.Element
```
useRef div + useEffect(mount/dispose, deps: [backend]); react 18+ peer.

**Steps:**
- [ ] Тест (jsdom + testing-library): рендер div, mount вызван (мок core через vi.mock), unmount → dispose.
- [ ] Implement → pass → build.

### Task 7: Demo site (`demo/`)

**Files:**
- Create: `demo/{package.json,tsconfig.json,vite.config.ts,index.html}`
- Create: `demo/src/{main.ts,style.css,pages.ts,ai-settings.ts}`

**Content:**
- Одна страница-доки вымышленного CLI `orbit` (заголовки, текст, разделы) + 3 виджета: mock-туториал `orbit` (script: `orbit init`, `orbit deploy`, `orbit status`, ошибка `orbit destroy` → exitCode 1), python-туториал (pyodide), секция AI (`#` подсказки).
- AI settings: input для ключа → keyStore, кнопка clear; `?ai=mock` → MockAIProvider из core (детерминированные ответы) — для e2e без ключа и оффлайн-демо.
- RU/EN переключатель языка виджета (locale prop) — демонстрация двуязычности.
- Тёмная/светлая тема через `prefers-color-scheme` + toggle.

**Steps:**
- [ ] Vite dev/build работает, все пакеты подключены через workspace deps.
- [ ] `pnpm --filter demo build` зелёный.

### Task 8: Playwright e2e + визуальная верификация

**Files:**
- Create: `playwright.config.ts`, `e2e/demo.spec.ts`

**Scenarios (все против `vite preview`):**
- [ ] терминал отрисован, welcome виден.
- [ ] mock: ввод `orbit init` → ожидаемый вывод; `orbit destroy` → hint про explain.
- [ ] `?ai=mock`: `#deploy the app` → suggestion → `y` → команда выполнена; `explain` после ошибки → стрим-текст появился.
- [ ] pyodide: `print(2+2)` → `4` (таймаут 120s на загрузку CDN).
- [ ] скриншоты light/dark в `e2e/screenshots/` (verify-before-done артефакт).

**Steps:**
- [ ] Config (webServer: vite preview, chromium) → тесты → все зелёные, скриншоты сняты и просмотрены.

### Task 9: Docs + финализация

**Files:**
- Create: `README.md` (EN, перезапись текущего ru-драфта — старый контент уже пересказан в GOAL/MEMORY_BANK), `README.ru.md`, `docs/embedding.md` (docusaurus/vite/react инструкция с кодом)
- Modify: `GOAL.md`, `MEMORY_BANK/{activeContext,progress}.md`, `TODO.md`

**Steps:**
- [ ] README EN: what/why/quickstart/packages/api/byok security note/roadmap; README.ru.md — перевод.
- [ ] embedding.md: react-компонент в docusaurus MDX (код), vanilla `<script type=module>`, vite.
- [ ] Финальный verify: `pnpm -r typecheck && pnpm -r test && pnpm -r build && pnpm e2e` — всё зелёное, лог в отчёт.
- [ ] GOAL.md: чекбоксы критерия готовности, финальный отчёт было→стало.
- [ ] `~/scripts/notify-maxim.sh` — финальный пинг.

## Self-Review

- Spec coverage: все пункты критерия готовности GOAL замаплены: build/typecheck/test (T0-6,9), pyodide screenshot (T8), mock tutorial (T7/8), AI-флоу оба (T2/5/7/8), page context (T2/5), react (T6), docusaurus-док (T9), README EN+RU (T9), MEMORY_BANK (T0). Deferred и честно записано в GOAL: nodepod/ws-бекенды, vue/svelte, docusaurus-плагин-пакет, step-engine туториалов, npm publish.
- Placeholders: нет TBD; каталог сообщений финализируется в T2 с полным списком ключей — состав перечислен выше.
- Types: контракты определены единожды, задачи ссылаются на них.
