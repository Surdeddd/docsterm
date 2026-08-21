import type { Locale } from 'docsterm'

export interface PageStrings {
  documentTitle: string
  documentDescription: string
  navDocs: string
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
  terminalLabelMock: string
  terminalLabelPython: string
  heroTryLabel: string
  heroTryItems: string[]
  whyNumber: string
  whyTitle: string
  whyItems: Array<{ title: string; body: string }>
  aiNumber: string
  aiTitle: string
  aiLead: string
  aiProviderLabel: string
  aiProviderCustom: string
  aiModelLabel: string
  aiBaseUrlLabel: string
  aiKeyLabel: string
  aiKeyPlaceholder: string
  aiEndpointCustom: string
  aiSave: string
  aiClear: string
  aiStatusSet: string
  aiStatusEmpty: string
  aiMockNote: string
  jsNumber: string
  jsTitle: string
  jsLead: string
  jsTry: string
  terminalLabelJs: string
  pythonNumber: string
  pythonTitle: string
  pythonLead: string
  pythonBoot: string
  pythonBooting: string
  pythonTry: string
  rustNumber: string
  rustTitle: string
  rustLead: string
  rustTry: string
  terminalLabelRust: string
  embedNumber: string
  embedTitle: string
  embedLead: string
  embedReact: string
  embedVanilla: string
  embedDocs: string
  packagesNumber: string
  packagesTitle: string
  packagesLead: string
  packages: Array<{ name: string; body: string }>
  footerTagline: string
  footerBy: string
  footerLicense: string
}

const en: PageStrings = {
  documentTitle: 'docsterm - an embeddable AI terminal for documentation',
  documentDescription:
    'docsterm puts a live terminal inside your documentation. Commands run in the reader browser, and an AI assistant turns plain language into the right command and explains failures.',
  navDocs: 'docs',
  navNpm: 'npm',
  navGithub: 'github',
  langLabel: 'lang',
  themeLabel: 'theme',
  themeLight: 'light',
  themeDark: 'dark',
  heroEyebrow: 'open source · MIT · v0.1',
  heroTitleLead: 'Documentation',
  heroTitleAccent: 'your readers',
  heroTitleTail: 'can run.',
  heroLead:
    'docsterm drops a live console into any docs page. Commands execute in the reader browser - no servers, no VMs. The AI layer turns a plain-language request into the right command, and explains the error when something breaks.',
  heroInstallLabel: 'install',
  heroCopy: 'copy',
  heroCopied: 'copied',
  terminalLabelMock: 'shell - files, pipes, tab completion, less, Ctrl+C',
  terminalLabelPython: 'python 3 - pyodide, in your browser',
  heroTryLabel: 'try',
  heroTryItems: ['ls', 'less README.md', 'build', 'cat regions.csv | grep eu | wc -l', 'Tab completes', 'Ctrl+C cancels'],
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
  aiNumber: '02',
  aiTitle: 'Any provider, your key',
  aiLead:
    'Pick Anthropic, any OpenAI-compatible endpoint - OpenAI, OpenRouter, Groq, Gemini, DeepSeek, Mistral, xAI, your own gateway - or a model running locally in Ollama or LM Studio. The request goes straight from the browser to that endpoint; the key lives in this browser localStorage and nowhere else. Add ?ai=mock to the URL to try the whole flow offline, with no key at all.',
  aiProviderLabel: 'provider',
  aiProviderCustom: 'Custom endpoint',
  aiModelLabel: 'model',
  aiBaseUrlLabel: 'base URL',
  aiKeyLabel: 'api key',
  aiKeyPlaceholder: 'stored only in this browser',
  aiEndpointCustom: 'any OpenAI-compatible /chat/completions endpoint',
  aiSave: 'save',
  aiClear: 'clear',
  aiStatusSet: 'configured in this browser. Reload the page to use it.',
  aiStatusEmpty: 'not configured - AI is off unless the page is opened with ?ai=mock.',
  aiMockNote: 'open the mock flow',
  jsNumber: '03',
  jsTitle: 'JavaScript, instantly',
  jsLead:
    'The terminal below is a real JavaScript runtime in a Web Worker: persistent variables, async/await, console output, and a hard timeout that kills an infinite loop instead of freezing the page. Nothing to download - it starts with the page.',
  jsTry: 'try: const users = [1, 2, 3] · users.map(n => n * 2) · await fetch("/").then(r => r.status)',
  terminalLabelJs: 'javascript - web worker, isolated',
  pythonNumber: '04',
  pythonTitle: 'Real Python, client-side',
  pythonLead:
    'The terminal below is a full CPython build compiled to WebAssembly (Pyodide), fetched lazily on first use. Nothing runs on a server; the reader machine does the work.',
  pythonBoot: 'start the python environment',
  pythonBooting: 'loading python...',
  pythonTry: 'try: print("sum:", 6 * 7) · import sys; sys.version · 1 / 0',
  rustNumber: '05',
  rustTitle: 'Rust, C, Go - anything that compiles',
  rustLead:
    'The binary below is a real Rust program compiled to wasm32-wasip1 and served as a 55 KB file. docsterm implements the WASI syscalls it needs - argv, stdout, stderr, exit codes - so the same trick works for C, C++, Zig, TinyGo or any language with a WebAssembly target.',
  rustTry: 'try: greet world · greet Maxim from Rust · greet (with no arguments - it exits with code 2)',
  terminalLabelRust: 'rust - compiled to wasm32-wasip1',
  embedNumber: '06',
  embedTitle: 'Five minutes to embed',
  embedLead:
    'One React component, or a few lines of vanilla JS. Docusaurus, Vite and plain-HTML recipes live in the repository.',
  embedReact: 'React (Docusaurus, Next, Vite)',
  embedVanilla: 'Vanilla',
  embedDocs: 'read the embedding guide',
  packagesNumber: '07',
  packagesTitle: 'One package, nine doors',
  packagesLead:
    'Install docsterm once and import only what you use. Pyodide, the Anthropic SDK and React are optional peers - skip an entry point and its dependency never lands in your bundle.',
  packages: [
    { name: 'docsterm', body: 'The widget: terminal UI, session logic, i18n, themes, page context.' },
    { name: 'docsterm/shell', body: 'A real shell: virtual filesystem, pipes, redirects, your own commands.' },
    { name: 'docsterm/mock', body: 'Scripted commands with zero compute - for tutorials and tests.' },
    { name: 'docsterm/javascript', body: 'A JavaScript runtime in an isolated Web Worker, with timeouts.' },
    { name: 'docsterm/pyodide', body: 'Real Python 3 in the browser, loaded on demand.' },
    { name: 'docsterm/wasi', body: 'Rust, C, C++, Zig, Go - any binary compiled to wasm32-wasi.' },
    { name: 'docsterm/websocket', body: 'Your own server: docker, git, kubectl - anything a real shell runs.' },
    { name: 'docsterm/anthropic', body: 'Command suggestions and error explanations, BYOK.' },
    { name: 'docsterm/react', body: 'The React component wrapper.' },
  ],
  footerTagline: 'An embeddable AI terminal for documentation.',
  footerBy: 'built by',
  footerLicense: 'MIT · open source',
}

const ru: PageStrings = {
  documentTitle: 'docsterm - встраиваемый AI-терминал для документации',
  documentDescription:
    'docsterm ставит живой терминал прямо в документацию. Команды выполняются в браузере читателя, а AI превращает обычную формулировку в нужную команду и объясняет ошибки.',
  navDocs: 'доки',
  navNpm: 'npm',
  navGithub: 'github',
  langLabel: 'язык',
  themeLabel: 'тема',
  themeLight: 'светлая',
  themeDark: 'тёмная',
  heroEyebrow: 'open source · MIT · v0.1',
  heroTitleLead: 'Документация,',
  heroTitleAccent: 'которую читатель',
  heroTitleTail: 'запускает.',
  heroLead:
    'docsterm встраивает живую консоль в любую страницу доков. Команды выполняются в браузере читателя - без серверов и виртуалок. AI превращает запрос обычными словами в нужную команду и объясняет ошибку, когда что-то падает.',
  heroInstallLabel: 'установка',
  heroCopy: 'копировать',
  heroCopied: 'скопировано',
  terminalLabelMock: 'shell - файлы, конвейеры, автодополнение, less, Ctrl+C',
  terminalLabelPython: 'python 3 - pyodide, прямо в браузере',
  heroTryLabel: 'попробуй',
  heroTryItems: ['ls', 'less README.md', 'build', 'cat regions.csv | grep eu | wc -l', 'Tab дополняет', 'Ctrl+C отменяет'],
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
  aiNumber: '02',
  aiTitle: 'Любой провайдер, свой ключ',
  aiLead:
    'Выбирай Anthropic, любой OpenAI-совместимый эндпоинт - OpenAI, OpenRouter, Groq, Gemini, DeepSeek, Mistral, xAI, собственный шлюз - или модель, поднятую локально в Ollama либо LM Studio. Запрос уходит из браузера прямо туда; ключ лежит в localStorage этого браузера и больше нигде. Добавь ?ai=mock к адресу - и весь сценарий можно попробовать офлайн, вообще без ключа.',
  aiProviderLabel: 'провайдер',
  aiProviderCustom: 'Свой эндпоинт',
  aiModelLabel: 'модель',
  aiBaseUrlLabel: 'базовый URL',
  aiKeyLabel: 'api-ключ',
  aiKeyPlaceholder: 'хранится только в этом браузере',
  aiEndpointCustom: 'любой OpenAI-совместимый /chat/completions',
  aiSave: 'сохранить',
  aiClear: 'очистить',
  aiStatusSet: 'настроено в этом браузере. Перезагрузи страницу, чтобы применилось.',
  aiStatusEmpty: 'не настроено - AI выключен, пока страница не открыта с ?ai=mock.',
  aiMockNote: 'открыть mock-режим',
  jsNumber: '03',
  jsTitle: 'JavaScript сразу',
  jsLead:
    'Терминал ниже - настоящий рантайм JavaScript в Web Worker: переменные живут между командами, работает async/await и console, а жёсткий таймаут убивает бесконечный цикл вместо того, чтобы повесить страницу. Качать нечего - он готов вместе со страницей.',
  jsTry: 'попробуй: const users = [1, 2, 3] · users.map(n => n * 2) · await fetch("/").then(r => r.status)',
  terminalLabelJs: 'javascript - web worker, изолированно',
  pythonNumber: '04',
  pythonTitle: 'Настоящий Python на клиенте',
  pythonLead:
    'Терминал ниже - полноценный CPython, собранный в WebAssembly (Pyodide) и подгружаемый лениво при первом запуске. На сервере не выполняется ничего: работает машина читателя.',
  pythonBoot: 'запустить python-окружение',
  pythonBooting: 'загружаю python...',
  pythonTry: 'попробуй: print("сумма:", 6 * 7) · import sys; sys.version · 1 / 0',
  rustNumber: '05',
  rustTitle: 'Rust, C, Go - всё, что компилируется',
  rustLead:
    'Бинарник ниже - настоящая программа на Rust, собранная в wasm32-wasip1 и лежащая рядом файлом на 55 КБ. docsterm реализует нужные ей системные вызовы WASI - argv, stdout, stderr, коды возврата, - поэтому тот же приём работает для C, C++, Zig, TinyGo и любого языка с целью WebAssembly.',
  rustTry: 'попробуй: greet world · greet Максим из Rust · greet (без аргументов - выйдет с кодом 2)',
  terminalLabelRust: 'rust - собран в wasm32-wasip1',
  embedNumber: '06',
  embedTitle: 'Пять минут на встраивание',
  embedLead:
    'Один React-компонент или несколько строк на чистом JS. Рецепты для Docusaurus, Vite и обычного HTML лежат в репозитории.',
  embedReact: 'React (Docusaurus, Next, Vite)',
  embedVanilla: 'Чистый JS',
  embedDocs: 'открыть гайд по встраиванию',
  packagesNumber: '07',
  packagesTitle: 'Один пакет, девять входов',
  packagesLead:
    'Ставится docsterm один раз, импортируется только то, что нужно. Pyodide, Anthropic SDK и React - опциональные peer-зависимости: не импортируешь вход - его зависимость не попадает ни в бандл, ни в node_modules.',
  packages: [
    { name: 'docsterm', body: 'Виджет: интерфейс терминала, логика сессии, i18n, темы, контекст страницы.' },
    { name: 'docsterm/shell', body: 'Настоящая оболочка: виртуальная ФС, конвейеры, перенаправления, свои команды.' },
    { name: 'docsterm/mock', body: 'Скриптованные команды без вычислений - для туториалов и тестов.' },
    { name: 'docsterm/javascript', body: 'Рантайм JavaScript в изолированном Web Worker, с таймаутами.' },
    { name: 'docsterm/pyodide', body: 'Настоящий Python 3 в браузере, подгружается по требованию.' },
    { name: 'docsterm/wasi', body: 'Rust, C, C++, Zig, Go - любой бинарник, собранный в wasm32-wasi.' },
    { name: 'docsterm/websocket', body: 'Свой сервер: docker, git, kubectl - всё, что умеет настоящий шелл.' },
    { name: 'docsterm/anthropic', body: 'Подсказки команд и объяснение ошибок, ключ читателя.' },
    { name: 'docsterm/react', body: 'Обёртка-компонент для React.' },
  ],
  footerTagline: 'Встраиваемый AI-терминал для документации.',
  footerBy: 'сделал',
  footerLicense: 'MIT · открытый код',
}

const catalogs: Record<Locale, PageStrings> = { en, ru }

export function getPageStrings(locale: Locale): PageStrings {
  return catalogs[locale]
}
