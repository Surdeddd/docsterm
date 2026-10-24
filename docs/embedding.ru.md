# Встраивание docsterm

Рецепты, как поставить терминал на сайт документации. Сам API описан в [справочнике](./reference.ru.md).

English version: [embedding.md](./embedding.md)

## Содержание

- [Общие правила](#общие-правила)
- [Чистый JavaScript и Vite](#чистый-javascript-и-vite)
- [React](#react)
- [Next.js App Router](#nextjs-app-router)
- [Docusaurus](#docusaurus)
- [Элемент `<docs-terminal>`](#элемент-docs-terminal)
- [Vue и VitePress](#vue-и-vitepress)
- [Astro и Starlight](#astro-и-starlight)
- [Обычный HTML с import map](#обычный-html-с-import-map)
- [Форма настроек AI](#форма-настроек-ai)
- [Сборщики и тесты](#сборщики-и-тесты)

## Общие правила

- **Таблица стилей.** Импортируйте `@xterm/xterm/css/xterm.css` один раз, в своём приложении. docsterm сам её не подключает.
- **Высота.** Задайте высоту контейнеру (или элементу `<docs-terminal>`). Терминал заполняет его и подстраивается при изменении размера и после загрузки веб-шрифтов.
- **Один бэкенд на терминал.** Объект бэкенда хранит сеанс (файлы, переменные, среду Python). Создайте его один раз на терминал и не пересоздавайте: новый объект — новый сеанс. После `dispose()` бэкенд можно запустить снова, это и нужно StrictMode в React и перемонтированию.
- **Серверный рендеринг.** Любой вход импортируется в Node без DOM, поэтому сборки Docusaurus, Next.js, VitePress и Astro работают. Сам терминал монтируется только в браузере: React-компонент рисует на сервере пустой `<div>`, а `defineDocsTerminal()` в Node ничего не делает.
- **Content-Security-Policy.** См. [таблицу в справочнике](./reference.ru.md#content-security-policy); коротко: xterm.js нужен `style-src 'unsafe-inline'`, а бэкендам JavaScript, Python и WASI — воркеры и WebAssembly или eval.

## Чистый JavaScript и Vite

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

`mount()` отклоняется, если бэкенд не запустился (причину терминал тоже покажет), и с `AbortError`, если раньше вызван `dispose()`. Vite ни для одного входа настраивать не нужно.

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

- **Постоянный бэкенд.** `useState(() => createXBackend())` создаёт его один раз на компонент; подойдёт и уровень модуля. Компонент перемонтирует терминал, как только проп `backend` становится другим объектом, так что `backend={createPyodideBackend()}` прямо в разметке перезапускал бы Python при каждой перерисовке.
- **StrictMode** в режиме разработки монтирует, размонтирует и монтирует снова. В итоге остаётся один рабочий терминал; бэкенд при необходимости освобождается и запускается заново.
- **Пропсы на лету.** `theme`, `locale`, `ai`, `pageContext`, `fontFamily`, `fontSize`, `ariaLabel`, `screenReaderMode` и `onEvent` меняют работающий терминал. Объекты `theme` и `pageContext` сравниваются по значению, так что встроенные объекты допустимы; встроенная стрелочная функция в `onEvent` стоит одного дешёвого обновления на каждую перерисовку. `welcome` читается только при монтировании.
- **Ref-хэндл.** У `DocsTerminalHandle` есть `run`, `insert`, `focus` и `clear`. `run()` отклоняется с `AbortError`, пока терминал не смонтирован.
- **Колбэки.** `onReady(terminal)` получает `DocsTerminal`, когда показано первое приглашение; `onError(error)` получает ошибки монтирования (без него они уходят в `console.error`).
- **Атрибуты контейнера.** `id`, `title`, `role`, `className`, `style`, `aria-*` и `data-*` достаются `<div>`-контейнеру. `aria-label` подписывает сам терминал, если не задан `ariaLabel`.

## Next.js App Router

`docsterm/react` начинается с `'use client'`, так что серверный компонент может его отрисовать, но не может передать бэкенд: бэкенд содержит функции, а они не переходят с сервера на клиент. Создавайте бэкенд в клиентском компоненте:

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

Сохраните его как `components/docs-shell.tsx` и рисуйте с любой страницы:

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

`docsterm/react` работает в MDX-страницах без `<BrowserOnly>`. Компонент `src/components/ShellTerminal.tsx`, который следует цветовому режиму сайта и добавляет на страницу кнопки запуска:

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

На странице:

```mdx
import ShellTerminal from '@site/src/components/ShellTerminal'

# Getting started

<pre data-docsterm-run><code>{`$ orbit init
Project initialized.`}</code></pre>

<ShellTerminal />
```

- `theme={colorMode}` следует за переключателем в шапке; `theme="auto"` следил бы только за операционной системой.
- Эффект подключает кнопки, когда терминал готов, и возвращает функцию очистки: при уходе со страницы кнопки исчезают, а следующая страница подключает свои.
- Обычные блоки кода в тройных обратных кавычках тоже получат кнопки с `selector: 'pre.prism-code code'`: их строки `.token-line` читаются по одной, а приглашения `$` выделяют команды. Этот селектор находит все блоки кода, а блок без приглашений выполняется целиком, так что на страницах с несколькими языками оставайтесь на `data-docsterm-run`.
- Виджет берёт для AI заголовок, описание и подзаголовки страницы. Передайте `pageContext`, если они не описывают содержимое.

## Элемент `<docs-terminal>`

`docsterm/element` регистрирует пользовательский элемент для Vue, Svelte, Astro, VitePress, Starlight, Hugo или обычного HTML. Он живёт в light DOM, поэтому `xterm.css` и шрифты страницы к нему применяются.

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

`defineDocsTerminal(tagName = 'docs-terminal')` регистрирует элемент. Сам импорт модуля ничего не регистрирует; повторный вызов ничего не делает; в Node функция ничего не делает. Если имя уже занято другим элементом, она бросает ошибку — передайте другое имя.

| Атрибут | Значение |
| --- | --- |
| `backend` | Встроенный бэкенд с настройками по умолчанию, загружается по требованию: `shell`, `javascript`, `pyodide` или `websocket` |
| `url` | Адрес сервера для `backend="websocket"` (обязателен) |
| `locale` | `en`, `ru` или тег языка вроде `ru-RU` |
| `theme` | `light`, `dark` или `auto` |
| `font-size` | Размер шрифта в пикселях |
| `font-family` | Семейство шрифтов |
| `aria-label` | Доступное имя терминала |
| `welcome` | Приветствие, читается при монтировании |

| Свойство | Значение |
| --- | --- |
| `backend` | Любой `Backend`; важнее атрибута |
| `theme` | `'light'`, `'dark'`, `'auto'` или объект `TerminalTheme`; важнее атрибута |
| `ai` | `AIProvider` |
| `pageContext` | `Partial<PageContext>` для AI |
| `onEvent` | Вызывается для каждого [события](./reference.ru.md#управляющий-api) |
| `terminal` | Смонтированный `DocsTerminal` или `null` (только чтение) |

Методы: `run(text)`, `insert(text)`, `clear()` и `focus()`, как у [`DocsTerminal`](./reference.ru.md#управляющий-api). `run()`, `insert()` и `clear()`, вызванные до появления бэкенда, ждут его. Опции без атрибута, например `screenReaderMode`, задаются через `element.terminal.setOptions()` после события `docsterm-ready`.

События: `docsterm-event` для каждого события, а также `docsterm-ready` и `docsterm-error`. Это `CustomEvent` с событием в `detail`; они всплывают и проходят сквозь теневые корни. `docsterm-error` приходит для фаз `init`, `run` и `ai`, так что сбои запуска отбирайте по `detail.phase === 'init'`. Неверное имя в `backend` или websocket без `url` приходят как `docsterm-error` с фазой `init` на языке атрибута `locale`, а без него — на языке браузера.

Жизненный цикл:

- Элемент монтируется, когда он в документе и у него есть бэкенд. Новое свойство `backend` или смена атрибута `backend` или `url` перемонтирует его один раз; остальные атрибуты применяются к работающему терминалу.
- Удаление элемента освобождает терминал и отклоняет ждущие вызовы `run()` с `AbortError`. Освобождение ждёт микрозадачу, поэтому перенос элемента в пределах одной задачи сохраняет сеанс.
- После сбоя загрузки (неверное имя в `backend`, websocket без `url`, модуль бэкенда не загрузился) `run()` отклоняется, пока не изменится свойство `backend` или атрибут `backend` либо `url`. Если не запустился сам терминал, его ошибка остаётся видна внутри элемента, и `run()` отклоняется с ней.
- Элемент получает `display: block`, если ваш CSS не задал другое значение. Высота берётся из вашего CSS.
- Уже вложенные дочерние элементы остаются над терминалом; запасной текст для читателей без JavaScript кладите в `<noscript>`.
- Свойства можно задавать когда угодно, в том числе до вызова `defineDocsTerminal()`: они подхватятся при обновлении элемента.
- TypeScript: `document.querySelector('docs-terminal')` возвращает `DocsTerminalElement`, а `addEventListener` знает три события (`DocsTerminalElementEventMap`). Для своего имени тега нужна своя запись в `HTMLElementTagNameMap` или `querySelector<DocsTerminalElement>(…)`.

## Vue и VitePress

Сообщите Vue, что `docs-terminal` — пользовательский элемент, зарегистрируйте его до монтирования приложения и передайте бэкенд через `:backend`. Vue запишет его как свойство, потому что такое свойство у элемента есть.

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

VitePress сначала рисует страницы на сервере, где свойство задать нельзя. Зарегистрируйте элемент в теме, отметьте его как пользовательский в конфигурации и рисуйте внутри `<ClientOnly>`.

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

Страница:

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

`:theme` следует за переключателем оформления VitePress; простой `theme="auto"` следит только за операционной системой.

## Astro и Starlight

Компонент Astro `src/components/Terminal.astro`. Astro собирает `<script>` и выполняет его один раз на страницу, сколько бы терминалов на ней ни было.

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

Синхронизация темы следует за переключателем темы Starlight, который ставит `data-theme` на `<html>`; на сайте без него уберите синхронизацию и напишите `theme="auto"`. Компонент используется из MDX:

```mdx
import Terminal from '../../components/Terminal.astro'

<Terminal backend="javascript" height="260px" />
```

Для бэкенда со своими файлами или командами задайте свойство из скрипта:

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

С клиентским роутером Astro выполняйте этот код в обработчике `astro:page-load` и вызывайте очистку кнопок запуска перед сменой страницы.

## Обычный HTML с import map

Без сборки: import map сообщает браузеру, где лежат docsterm и его зависимости. Фиксируйте точные версии.

```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>Начало работы</title>
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

- Собственные модули docsterm импортируют друг друга по относительным путям, поэтому записи нужны только «голым» именам: всегда `@xterm/xterm`, `@xterm/addon-fit` и `@xterm/addon-unicode11`, а для бэкенда JavaScript ещё `acorn`. Встроенные бэкенды из атрибута `backend="…"` загружают свои модули относительно `dist/element/index.js` и записей не требуют.
- Бэкенд Python загружает среду с jsDelivr по URL, ему запись тоже не нужна.
- Для `docsterm/react` и `docsterm/anthropic` нужно сопоставить `react` и `@anthropic-ai/sdk` с их сборками в виде ES-модулей; для них лучше взять сборщик.

## Форма настроек AI

Ключи приносят читатели. Сохраните ключ туда, откуда его читает провайдер, и дайте терминалу новый провайдер — перезагружать страницу не нужно.

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

Панель настроек демо, `demo/src/ai-settings.ts`, — полный пример. Прежде чем выпускать свою, прочтите раздел [Ключи, ошибки и ответы](./reference.ru.md#ключи-ошибки-и-ответы): ключи в `localStorage` доступны любому скрипту с вашего источника.

## Сборщики и тесты

- Vite, webpack 5 (Docusaurus, Next.js), Rollup и esbuild не требуют настройки. С версии 0.8 бэкенд Python не использует npm-пакет `pyodide`, так что уберите `optimizeDeps.exclude: ['pyodide']` и обходные настройки webpack, добавленные для старых версий.
- Vite может предупредить, что директива `'use client'` в `docsterm/react` проигнорирована; предупреждение безвредно.
- Воркеры JavaScript и WASI собираются из исходного текста функций. Не пропускайте docsterm через `keepNames` в esbuild или инструментирование покрытия istanbul: вставленные ими вспомогательные функции внутри воркера не существуют.
- В тестах с jsdom (Vitest, Jest) подставьте заглушку `window.matchMedia`: без неё xterm.js не открывается. Виджет загружает xterm и через ES-сборку, и через CommonJS.
