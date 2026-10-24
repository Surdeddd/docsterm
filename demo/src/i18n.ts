import type { Locale } from 'docsterm'

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }

export interface PageStrings {
  documentTitle: string
  documentDescription: string
  navNpm: string
  navGithub: string
  langLabel: string
  themeLabel: string
  themeLight: string
  themeDark: string
  heroEyebrow: string
  heroTitleLead: string
  heroTitleAccent: string
  heroTitleTail: string
  heroLead: string
  heroInstallLabel: string
  heroCopy: string
  heroCopied: string
  heroCopyFallback: string
  terminalLabelMock: string
  heroTryLabel: string
  heroTryCommands: string[]
  heroTryHints: string[]
  heroTryButtonLabel: string
  shellBanner: string
  whyNumber: string
  whyTitle: string
  whyItems: Array<{ title: string; body: string }>
  runNumber: string
  runTitle: string
  runLead: string
  runSteps: Array<{ title: string; body: string }>
  terminalLabelRun: string
  eventsTitle: string
  eventsEmpty: string
  eventReady: string
  eventCommand: string
  eventInterrupt: string
  eventInterruptAi: string
  eventSuggest: string
  eventSuggestAccepted: string
  eventSuggestDeclined: string
  eventSuggestFailed: string
  eventExplain: string
  eventError: string
  eventSources: Record<'typed' | 'paste' | 'api' | 'ai', string>
  eventPhases: Record<'init' | 'run' | 'ai', string>
  aiNumber: string
  aiTitle: string
  aiLead: string
  aiMockLink: string
  aiProviderLabel: string
  aiProviderCustom: string
  aiProviderLocal: string
  aiModelLabel: string
  aiBaseUrlLabel: string
  aiKeyLabel: string
  aiKeyPlaceholder: string
  aiKeyStored: string
  aiEndpointCustom: string
  aiSave: string
  aiClear: string
  aiStatusActive: string
  aiStatusOff: string
  aiStatusNeedsKey: string
  aiStatusNeedsBaseUrl: string
  aiStatusNeedsModel: string
  aiStatusUnsaved: string
  aiStatusCleared: string
  aiStatusMock: string
  jsNumber: string
  jsTitle: string
  jsLead: string
  jsTry: string
  jsBanner: string
  terminalLabelJs: string
  pythonNumber: string
  pythonTitle: string
  pythonLead: string
  pythonBoot: string
  pythonBooting: string
  pythonRetry: string
  pythonTry: string
  terminalLabelPython: string
  rustNumber: string
  rustTitle: string
  rustLead: string
  rustTry: string
  rustBanner: string
  terminalLabelRust: string
  elementNumber: string
  elementTitle: string
  elementLead: string
  elementTry: string
  terminalLabelElement: string
  mountFailed: string
  reloadHint: string
  reloadButton: string
  embedNumber: string
  embedTitle: string
  embedLead: string
  embedReact: string
  embedVanilla: string
  embedDocs: string
  embedDocsHref: string
  packagesNumber: string
  packagesTitle: string
  packagesUnit: PluralForms
  packagesLead: string
  packagesHref: string
  packageBodies: Record<string, string>
  footerTagline: string
  footerBy: string
  footerLicense: string
  reactDocumentTitle: string
  reactTitle: string
  reactLead: string
  reactThemeToggle: string
  reactRerender: string
  reactRenders: string
  reactRunStatus: string
  reactEvents: string
  reactLastEvent: string
  reactBack: string
  terminalLabelReact: string
}

const en: PageStrings = {
  documentTitle: 'docsterm - an embeddable AI terminal for documentation',
  documentDescription:
    'docsterm puts a live terminal inside your documentation. Commands run in the reader browser, and an AI assistant turns plain language into the right command and explains failures.',
  navNpm: 'npm',
  navGithub: 'github',
  langLabel: 'lang',
  themeLabel: 'theme',
  themeLight: 'light',
  themeDark: 'dark',
  heroEyebrow: 'open source · MIT · v{version}',
  heroTitleLead: 'Documentation',
  heroTitleAccent: 'your readers',
  heroTitleTail: 'can run.',
  heroLead:
    'docsterm drops a live console into any docs page. Commands execute in the reader browser - no servers, no VMs. The AI layer turns a plain-language request into the right command, and explains the error when something breaks.',
  heroInstallLabel: 'install',
  heroCopy: 'copy',
  heroCopied: 'copied',
  heroCopyFallback: 'selected - press Ctrl+C or ⌘C to copy',
  terminalLabelMock: 'shell - files, pipes, tab completion, less, Ctrl+C',
  heroTryLabel: 'try',
  heroTryCommands: ['ls', 'build', 'cat regions.csv | grep eu | wc -l', 'less README.md'],
  heroTryHints: ['Tab completes', 'Ctrl+C cancels'],
  heroTryButtonLabel: 'run in the terminal above: {command}',
  shellBanner: 'orbit 1.4.2 - fictional deploys for tiny apps. Try: ls, cat README.md, orbit help',
  whyNumber: '01',
  whyTitle: 'Why a terminal in the docs',
  whyItems: [
    {
      title: 'Copy-paste loses readers',
      body:
        'A reader leaves the page for their own shell, mistypes a flag, and never comes back to step four. Every context switch is a drop-off you never see.',
    },
    {
      title: 'Hosted sandboxes are heavy',
      body:
        'Killercoda, Instruqt and friends boot server VMs: thousands a month, an ops burden, and a separate platform your docs have to link away to.',
    },
    {
      title: 'The page is the context',
      body:
        'docsterm runs client-side and reads the page it sits on - title, description, headings. The assistant already knows which tutorial the reader is in.',
    },
  ],
  runNumber: '02',
  runTitle: 'Code blocks that run',
  runLead:
    'Mark a code block and docsterm adds a run button to it. Lines that start with $ are the commands; everything else is shown output. The click goes through the same input path as typing, so history, Ctrl+C and the prompt behave exactly as for a reader. Every step reports an event your page can listen to.',
  runSteps: [
    { title: 'Create the project', body: 'Writes orbit.toml into the current folder.' },
    { title: 'Ship it', body: 'Uploads the bundle and prints the address.' },
    { title: 'Check on it', body: 'Shows the state of the deployment.' },
  ],
  terminalLabelRun: 'shell - driven by the buttons above',
  eventsTitle: 'events from this terminal',
  eventsEmpty: 'nothing yet - press a run button or type a command',
  eventReady: 'the terminal is ready',
  eventCommand: '{command} · {source} · exit {exitCode} · {duration} ms',
  eventInterrupt: 'interrupted: {command}',
  eventInterruptAi: 'interrupted the AI request',
  eventSuggest: 'AI suggested {command} for "{request}"',
  eventSuggestAccepted: 'accepted',
  eventSuggestDeclined: 'declined',
  eventSuggestFailed: 'AI could not answer "{request}"',
  eventExplain: 'AI explained {command}',
  eventError: '{phase} error: {message}',
  eventSources: { typed: 'typed', paste: 'pasted', api: 'api', ai: 'ai' },
  eventPhases: { init: 'start', run: 'run', ai: 'AI' },
  aiNumber: '03',
  aiTitle: 'Any provider, your key',
  aiLead:
    'Pick Anthropic, any OpenAI-compatible endpoint - OpenAI, OpenRouter, Groq, Gemini, DeepSeek, Mistral, xAI, your own gateway - or a model running locally in Ollama or LM Studio. The request goes straight from the browser to that endpoint; the key lives in this browser localStorage and nowhere else. Saving applies to every terminal on the page at once.',
  aiMockLink: 'or try the whole flow offline with the mock AI, no key at all',
  aiProviderLabel: 'provider',
  aiProviderCustom: 'Custom endpoint',
  aiProviderLocal: '{name} (local)',
  aiModelLabel: 'model',
  aiBaseUrlLabel: 'base URL',
  aiKeyLabel: 'api key',
  aiKeyPlaceholder: 'stored only in this browser',
  aiKeyStored: 'a key is saved - leave empty to keep it',
  aiEndpointCustom: 'any OpenAI-compatible /chat/completions endpoint',
  aiSave: 'save',
  aiClear: 'clear',
  aiStatusActive: 'on: {provider} · {model} answers in every terminal on this page.',
  aiStatusOff: 'off: nothing is configured in this browser yet.',
  aiStatusNeedsKey: 'off: add an API key for {provider} to turn AI on.',
  aiStatusNeedsBaseUrl: 'off: a custom endpoint needs a base URL.',
  aiStatusNeedsModel: 'off: choose a model for {provider}.',
  aiStatusUnsaved: 'The form has changes that are not saved yet.',
  aiStatusCleared: 'Every saved key, model and endpoint was removed from this browser.',
  aiStatusMock:
    'mock mode: every terminal uses the offline mock AI. Open the page without ?ai=mock to use these settings.',
  jsNumber: '04',
  jsTitle: 'JavaScript, instantly',
  jsLead:
    'The terminal below is a real JavaScript runtime in a Web Worker: persistent variables, async/await, console output. Ctrl+C or a timeout stops a runaway loop by restarting the worker instead of freezing the page. Nothing to download - it starts with the page.',
  jsTry: 'try: const users = [1, 2, 3] · users.map(n => n * 2) · await fetch("/").then(r => r.status)',
  jsBanner: 'javascript - variables persist between commands, top-level await works',
  terminalLabelJs: 'javascript - web worker, off the main thread',
  pythonNumber: '05',
  pythonTitle: 'Real Python, client-side',
  pythonLead:
    'The terminal below is a full CPython build compiled to WebAssembly (Pyodide), fetched lazily on first use and run in a Web Worker. Imports of bundled packages load on their own, and pip install fetches pure-Python wheels. Nothing runs on a server; the reader machine does the work.',
  pythonBoot: 'start the python environment',
  pythonBooting: 'loading python...',
  pythonRetry: 'try again',
  pythonTry: 'try: print("sum:", 6 * 7) · import sys; sys.version · 1 / 0',
  terminalLabelPython: 'python 3 - pyodide, in your browser',
  rustNumber: '06',
  rustTitle: 'Rust, C, Go - anything that compiles',
  rustLead:
    'The binary below is a real Rust program compiled to wasm32-wasip1 and served as a 54 KB file. docsterm implements the WASI syscalls it needs - argv, stdout, stderr, exit codes - so the same trick works for C, C++, Zig, TinyGo or any language with a WebAssembly target.',
  rustTry: 'try: greet world · greet Maxim from Rust · greet (with no arguments - it exits with code 2)',
  rustBanner: 'greet - Rust compiled to wasm32-wasip1 (54 KB)',
  terminalLabelRust: 'rust - compiled to wasm32-wasip1',
  elementNumber: '07',
  elementTitle: 'Any framework: one HTML tag',
  elementLead:
    'Vue, Svelte, Astro, VitePress or a plain HTML page: call defineDocsTerminal() once and write the tag. The terminal below is exactly that - a <docs-terminal backend="javascript"> element with no framework around it. It sends DOM events and has the same run, insert, focus and clear methods.',
  elementTry: 'try: [1, 2, 3].map(n => n * n) · typeof document · new Date().getFullYear()',
  terminalLabelElement: 'javascript - <docs-terminal> web component',
  mountFailed: 'This terminal could not start: {reason}',
  reloadHint: 'Reload the page to try again.',
  reloadButton: 'reload the page',
  embedNumber: '08',
  embedTitle: 'Five minutes to embed',
  embedLead:
    'One React component, or a few lines of vanilla JS. Recipes for Docusaurus, Next.js, Vite and plain HTML are in the embedding guide.',
  embedReact: 'React (Docusaurus, Next, Vite)',
  embedVanilla: 'Vanilla',
  embedDocs: 'read the embedding guide',
  embedDocsHref: 'https://github.com/Surdeddd/docsterm/blob/main/docs/embedding.md',
  packagesNumber: '09',
  packagesTitle: 'One package, {count} {unit}',
  packagesUnit: { one: 'entry point', other: 'entry points' },
  packagesLead:
    'Install docsterm once and import only what you use. The Anthropic SDK and React are optional peers, and Python loads from a CDN only when a reader starts it - skip an entry point and its dependency never lands in your bundle.',
  packagesHref: 'https://github.com/Surdeddd/docsterm/blob/main/docs/reference.md',
  packageBodies: {
    docsterm: 'The widget: terminal UI, session logic, i18n, themes, page context, run buttons.',
    'docsterm/shell': 'A real shell: virtual filesystem, pipes, redirects, your own commands.',
    'docsterm/javascript': 'A JavaScript runtime in a Web Worker, off the main thread, with timeouts.',
    'docsterm/pyodide': 'Real Python 3 in a Web Worker, loaded on demand.',
    'docsterm/wasi': 'Rust, C, C++, Zig, Go - any binary compiled to wasm32-wasi.',
    'docsterm/websocket': 'Your own server: docker, git, kubectl - anything a real shell runs.',
    'docsterm/mock': 'Scripted commands with zero compute - for tutorials and tests.',
    'docsterm/anthropic': 'Command suggestions and error explanations through Claude, with the reader key.',
    'docsterm/openai': 'The same AI layer for any OpenAI-compatible endpoint, local models included.',
    'docsterm/react': 'The React component wrapper with a ref handle and events.',
    'docsterm/element': 'A <docs-terminal> web component for Vue, Svelte, Astro and plain HTML.',
  },
  footerTagline: 'An embeddable AI terminal for documentation.',
  footerBy: 'built by',
  footerLicense: 'MIT · open source',
  reactDocumentTitle: 'docsterm - React StrictMode check',
  reactTitle: 'React, under StrictMode',
  reactLead:
    'This page renders docsterm/react inside StrictMode with a stable backend. Re-rendering the page or switching the theme must keep one terminal and everything typed into it.',
  reactThemeToggle: 'switch theme',
  reactRerender: 're-render the page',
  reactRenders: 'renders: {count}',
  reactRunStatus: 'run orbit status through the ref',
  reactEvents: 'events received: {count}',
  reactLastEvent: 'last event: {event}',
  reactBack: 'back to the demo',
  terminalLabelReact: 'shell - docsterm/react',
}

const ru: PageStrings = {
  documentTitle: 'docsterm - встраиваемый AI-терминал для документации',
  documentDescription:
    'docsterm ставит живой терминал прямо в документацию. Команды выполняются в браузере читателя, а AI превращает обычную формулировку в нужную команду и объясняет ошибки.',
  navNpm: 'npm',
  navGithub: 'github',
  langLabel: 'язык',
  themeLabel: 'тема',
  themeLight: 'светлая',
  themeDark: 'тёмная',
  heroEyebrow: 'открытый код · MIT · v{version}',
  heroTitleLead: 'Документация,',
  heroTitleAccent: 'которую читатель',
  heroTitleTail: 'запускает.',
  heroLead:
    'docsterm встраивает живую консоль в любую страницу доков. Команды выполняются в браузере читателя - без серверов и виртуалок. AI превращает запрос обычными словами в нужную команду и объясняет ошибку, когда что-то падает.',
  heroInstallLabel: 'установка',
  heroCopy: 'копировать',
  heroCopied: 'скопировано',
  heroCopyFallback: 'выделено - нажми Ctrl+C или ⌘C, чтобы скопировать',
  terminalLabelMock: 'shell - файлы, конвейеры, автодополнение, less, Ctrl+C',
  heroTryLabel: 'попробуй',
  heroTryCommands: ['ls', 'build', 'cat regions.csv | grep eu | wc -l', 'less README.md'],
  heroTryHints: ['Tab дополняет', 'Ctrl+C отменяет'],
  heroTryButtonLabel: 'запустить в терминале выше: {command}',
  shellBanner: 'orbit 1.4.2 - вымышленные деплои для маленьких приложений. Попробуй: ls, cat README.md, orbit help',
  whyNumber: '01',
  whyTitle: 'Зачем терминал в доках',
  whyItems: [
    {
      title: 'Копипаст теряет читателей',
      body:
        'Читатель уходит со страницы в свой шелл, ошибается во флаге и до четвёртого шага уже не возвращается. Каждое переключение контекста - отвал, которого вы не видите.',
    },
    {
      title: 'Хостед-песочницы тяжёлые',
      body:
        'Killercoda, Instruqt и подобные поднимают серверные VM: тысячи долларов в месяц, отдельный ops и чужая платформа, куда доки вынуждены уводить читателя.',
    },
    {
      title: 'Контекст - сама страница',
      body:
        'docsterm работает на клиенте и читает страницу, на которой стоит: заголовок, описание, подзаголовки. Ассистент уже знает, в каком туториале находится читатель.',
    },
  ],
  runNumber: '02',
  runTitle: 'Блоки кода, которые запускаются',
  runLead:
    'Помечаешь блок кода - docsterm добавляет к нему кнопку запуска. Строки с $ в начале - это команды, остальное - показанный вывод. Клик идёт тем же путём, что и набор с клавиатуры, поэтому история, Ctrl+C и приглашение ведут себя так же, как у читателя. Каждый шаг присылает событие, которое страница может слушать.',
  runSteps: [
    { title: 'Создай проект', body: 'Записывает orbit.toml в текущую папку.' },
    { title: 'Задеплой', body: 'Загружает бандл и печатает адрес.' },
    { title: 'Проверь', body: 'Показывает состояние деплоя.' },
  ],
  terminalLabelRun: 'shell - управляется кнопками выше',
  eventsTitle: 'события этого терминала',
  eventsEmpty: 'пока пусто - нажми кнопку запуска или набери команду',
  eventReady: 'терминал готов',
  eventCommand: '{command} · {source} · код {exitCode} · {duration} мс',
  eventInterrupt: 'прервано: {command}',
  eventInterruptAi: 'запрос к AI прерван',
  eventSuggest: 'AI предложил {command} на запрос «{request}»',
  eventSuggestAccepted: 'принято',
  eventSuggestDeclined: 'отклонено',
  eventSuggestFailed: 'AI не смог ответить на «{request}»',
  eventExplain: 'AI объяснил {command}',
  eventError: 'ошибка ({phase}): {message}',
  eventSources: { typed: 'набрано', paste: 'вставлено', api: 'api', ai: 'ai' },
  eventPhases: { init: 'запуск', run: 'выполнение', ai: 'AI' },
  aiNumber: '03',
  aiTitle: 'Любой провайдер, свой ключ',
  aiLead:
    'Выбирай Anthropic, любой OpenAI-совместимый эндпоинт - OpenAI, OpenRouter, Groq, Gemini, DeepSeek, Mistral, xAI, собственный шлюз - или модель, поднятую локально в Ollama либо LM Studio. Запрос уходит из браузера прямо туда; ключ лежит в localStorage этого браузера и больше нигде. Сохранение сразу применяется ко всем терминалам на странице.',
  aiMockLink: 'или попробуй весь сценарий офлайн с mock-AI, вообще без ключа',
  aiProviderLabel: 'провайдер',
  aiProviderCustom: 'Свой эндпоинт',
  aiProviderLocal: '{name} (локально)',
  aiModelLabel: 'модель',
  aiBaseUrlLabel: 'базовый URL',
  aiKeyLabel: 'api-ключ',
  aiKeyPlaceholder: 'хранится только в этом браузере',
  aiKeyStored: 'ключ сохранён - оставь поле пустым, чтобы его не менять',
  aiEndpointCustom: 'любой OpenAI-совместимый /chat/completions',
  aiSave: 'сохранить',
  aiClear: 'очистить',
  aiStatusActive: 'включено: {provider} · {model} отвечает во всех терминалах на странице.',
  aiStatusOff: 'выключено: в этом браузере ещё ничего не настроено.',
  aiStatusNeedsKey: 'выключено: добавь API-ключ для {provider}, чтобы включить AI.',
  aiStatusNeedsBaseUrl: 'выключено: своему эндпоинту нужен базовый URL.',
  aiStatusNeedsModel: 'выключено: выбери модель для {provider}.',
  aiStatusUnsaved: 'В форме есть несохранённые изменения.',
  aiStatusCleared: 'Все сохранённые ключи, модели и эндпоинты удалены из этого браузера.',
  aiStatusMock:
    'mock-режим: все терминалы используют офлайн mock-AI. Открой страницу без ?ai=mock, чтобы работали эти настройки.',
  jsNumber: '04',
  jsTitle: 'JavaScript сразу',
  jsLead:
    'Терминал ниже - настоящий рантайм JavaScript в Web Worker: переменные живут между командами, работают async/await и console. Ctrl+C или таймаут останавливают зациклившийся код перезапуском воркера, а не вешают страницу. Качать нечего - он готов вместе со страницей.',
  jsTry: 'попробуй: const users = [1, 2, 3] · users.map(n => n * 2) · await fetch("/").then(r => r.status)',
  jsBanner: 'javascript - переменные живут между командами, работает await на верхнем уровне',
  terminalLabelJs: 'javascript - web worker, вне основного потока',
  pythonNumber: '05',
  pythonTitle: 'Настоящий Python на клиенте',
  pythonLead:
    'Терминал ниже - полноценный CPython, собранный в WebAssembly (Pyodide): подгружается лениво при первом запуске и работает в Web Worker. Встроенные пакеты подтягиваются сами при импорте, а pip install ставит чистые Python-колёса. На сервере не выполняется ничего: работает машина читателя.',
  pythonBoot: 'запустить python-окружение',
  pythonBooting: 'загружаю python...',
  pythonRetry: 'попробовать ещё раз',
  pythonTry: 'попробуй: print("сумма:", 6 * 7) · import sys; sys.version · 1 / 0',
  terminalLabelPython: 'python 3 - pyodide, прямо в браузере',
  rustNumber: '06',
  rustTitle: 'Rust, C, Go - всё, что компилируется',
  rustLead:
    'Бинарник ниже - настоящая программа на Rust, собранная в wasm32-wasip1 и лежащая рядом файлом на 54 КБ. docsterm реализует нужные ей системные вызовы WASI - argv, stdout, stderr, коды возврата, - поэтому тот же приём работает для C, C++, Zig, TinyGo и любого языка с целью WebAssembly.',
  rustTry: 'попробуй: greet world · greet Максим из Rust · greet (без аргументов - выйдет с кодом 2)',
  rustBanner: 'greet - Rust, собранный в wasm32-wasip1 (54 КБ)',
  terminalLabelRust: 'rust - собран в wasm32-wasip1',
  elementNumber: '07',
  elementTitle: 'Любой фреймворк: один HTML-тег',
  elementLead:
    'Vue, Svelte, Astro, VitePress или обычная HTML-страница: один раз вызываешь defineDocsTerminal() и пишешь тег. Терминал ниже - ровно это: элемент <docs-terminal backend="javascript"> без всякого фреймворка вокруг. Он шлёт DOM-события и умеет те же run, insert, focus и clear.',
  elementTry: 'попробуй: [1, 2, 3].map(n => n * n) · typeof document · new Date().getFullYear()',
  terminalLabelElement: 'javascript - веб-компонент <docs-terminal>',
  mountFailed: 'Терминал не запустился: {reason}',
  reloadHint: 'Перезагрузи страницу, чтобы попробовать ещё раз.',
  reloadButton: 'перезагрузить страницу',
  embedNumber: '08',
  embedTitle: 'Пять минут на встраивание',
  embedLead:
    'Один React-компонент или несколько строк на чистом JS. Рецепты для Docusaurus, Next.js, Vite и обычного HTML - в гайде по встраиванию.',
  embedReact: 'React (Docusaurus, Next, Vite)',
  embedVanilla: 'Чистый JS',
  embedDocs: 'открыть гайд по встраиванию',
  embedDocsHref: 'https://github.com/Surdeddd/docsterm/blob/main/docs/embedding.ru.md',
  packagesNumber: '09',
  packagesTitle: 'Один пакет, {count} {unit}',
  packagesUnit: { one: 'вход', few: 'входа', many: 'входов', other: 'входа' },
  packagesLead:
    'Ставится docsterm один раз, импортируется только то, что нужно. Anthropic SDK и React - опциональные peer-зависимости, а Python грузится с CDN, только когда читатель его запускает: не импортируешь вход - его зависимость не попадает в бандл.',
  packagesHref: 'https://github.com/Surdeddd/docsterm/blob/main/docs/reference.ru.md',
  packageBodies: {
    docsterm: 'Виджет: интерфейс терминала, логика сессии, i18n, темы, контекст страницы, кнопки запуска.',
    'docsterm/shell': 'Настоящая оболочка: виртуальная ФС, конвейеры, перенаправления, свои команды.',
    'docsterm/javascript': 'Рантайм JavaScript в Web Worker, вне основного потока, с таймаутами.',
    'docsterm/pyodide': 'Настоящий Python 3 в Web Worker, подгружается по требованию.',
    'docsterm/wasi': 'Rust, C, C++, Zig, Go - любой бинарник, собранный в wasm32-wasi.',
    'docsterm/websocket': 'Свой сервер: docker, git, kubectl - всё, что умеет настоящий шелл.',
    'docsterm/mock': 'Скриптованные команды без вычислений - для туториалов и тестов.',
    'docsterm/anthropic': 'Подсказки команд и объяснение ошибок через Claude, ключ читателя.',
    'docsterm/openai': 'Тот же AI-слой для любого OpenAI-совместимого эндпоинта, включая локальные модели.',
    'docsterm/react': 'Обёртка-компонент для React с ref-методами и событиями.',
    'docsterm/element': 'Веб-компонент <docs-terminal> для Vue, Svelte, Astro и обычного HTML.',
  },
  footerTagline: 'Встраиваемый AI-терминал для документации.',
  footerBy: 'сделал',
  footerLicense: 'MIT · открытый код',
  reactDocumentTitle: 'docsterm - проверка React StrictMode',
  reactTitle: 'React в StrictMode',
  reactLead:
    'Эта страница рендерит docsterm/react внутри StrictMode со стабильным бекендом. Перерисовка страницы и смена темы должны оставлять один терминал и всё, что в нём набрано.',
  reactThemeToggle: 'сменить тему',
  reactRerender: 'перерисовать страницу',
  reactRenders: 'рендеров: {count}',
  reactRunStatus: 'запустить orbit status через ref',
  reactEvents: 'получено событий: {count}',
  reactLastEvent: 'последнее событие: {event}',
  reactBack: 'назад к демо',
  terminalLabelReact: 'shell - docsterm/react',
}

const catalogs: Record<Locale, PageStrings> = { en, ru }

export function getPageStrings(locale: Locale): PageStrings {
  return catalogs[locale]
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}

export function plural(locale: Locale, count: number, forms: PluralForms): string {
  return forms[new Intl.PluralRules(locale).select(count)] ?? forms.other
}
