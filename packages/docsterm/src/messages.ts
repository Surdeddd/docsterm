import type { Locale } from './types.js'

export interface Messages {
  welcome: string
  welcomeNoAi: string
  aiNotConfigured: string
  aiThinking: string
  suggestionLabel: string
  confirmRun: string
  cancelled: string
  errorHint: string
  explainHeader: string
  nothingToExplain: string
  aiError: string
  aiRefused: string
  aiTruncated: string
  aiEmpty: string
  aiInvalid: string
  aiNetwork: string
  backendError: string
  backendFailed: string
  reloadHint: string
  helpText: string
  helpTextNoAi: string
  keysHelp: string
  keyMissing: string
  interrupted: string
  backendLoading: string
  notReady: string
  runtimeRestarted: string
  timedOut: string
  cspBlocked: string
  connectionClosed: string
  notConnected: string
  reconnecting: string
  connectFailed: string
  connectTimedOut: string
  aiServiceError: string
  pagerHint: string
  commandNotFoundIn: string
  noShellSyntax: string
  inputUnsupported: string
  ariaLabel: string
  exitStatus: string
  wasiUnmatchedQuote: string
  wasiFetchFailed: string
  wasiNotModule: string
  wasiNotCommand: string
  wasiOutputLimit: string
  wasiDescribe: string
  wasiUsage: string
  wasiNoModule: string
  wasiFetchNetworkError: string
  wasiWorkerTimedOut: string
  wasiCompileFailed: string
  wasiNoWorker: string
  wasiWorkerFailed: string
  shellBuiltins: string
  shellPageCommands: string
  shellDescription: string
  shellDescriptionPage: string
  jsTimeoutNote: string
  jsGlobals: string
  jsGlobalNotCloneable: string
  jsInitTimedOut: string
  jsReplDescription: string
  jsParserFailed: string
  aiDoesNotFit: string
  noOutputTimeout: string
  shellNotPipeable: string
  shellUnsupported: string
  shellSyntaxBackground: string
  shellSyntaxHereString: string
  shellSyntaxHereDocument: string
  shellSyntaxInputDuplication: string
  shellSyntaxReadWrite: string
  shellSyntaxProcessSubstitution: string
  shellSyntaxSubshell: string
  shellSyntaxConditional: string
  shellSyntaxLoop: string
  shellSyntaxCase: string
  shellSyntaxFunction: string
  shellSyntaxGroup: string
  shellSyntaxArithmetic: string
  shellSyntaxAnsiC: string
  shellSyntaxParameter: string
  shellSyntaxTime: string
  shellBraceLimit: string
  shellNeedsTerminal: string
  wsServerSilent: string
  wsReconnectAttempt: string
  wsReconnectFailed: string
  wsNewSession: string
  wsPtyDescription: string
  runButton: string
  runButtonLabel: string
  elementNeedsUrl: string
  elementUnknownBackend: string
  runIncomplete: string
  pyodideRuntime: string
  pyodideRuntimeUnknown: string
  pyodideDescription: string
}

const en: Messages = {
  welcome: 'docsterm ready. Type a command, or start with # to ask AI. Builtins: help, clear, history, explain.',
  welcomeNoAi: 'docsterm ready. Type a command. Builtins: help, clear, history.',
  aiNotConfigured: 'AI is not configured for this terminal.',
  aiThinking: 'thinking...',
  suggestionLabel: 'suggested command',
  confirmRun: 'run it? [y/N] ',
  cancelled: 'cancelled.',
  errorHint: "command failed. Type 'explain' to get an AI explanation.",
  explainHeader: 'explanation',
  nothingToExplain: 'nothing to explain yet - no failed command recorded.',
  aiError: 'AI request failed',
  aiRefused: 'the AI declined this request.',
  aiTruncated: 'the AI answer was cut off by the token limit.',
  aiEmpty: 'the AI returned an empty answer.',
  aiInvalid: 'the AI answer is not a usable command.',
  aiNetwork: 'cannot reach the AI service.',
  backendError: 'backend error',
  backendFailed: 'environment failed to start',
  reloadHint: 'reload the page to try again.',
  helpText:
    'builtins: help - this text; clear - clear screen; history - previous commands; explain - explain the last error; #<request> - ask AI for a command.',
  helpTextNoAi: 'builtins: help - this text; clear - clear screen; history - previous commands.',
  keysHelp:
    'keys: Tab completes, Up/Down walk history, Ctrl+C cancels, Ctrl+L clears the screen, Shift+Tab or Esc then Tab leaves the terminal.',
  keyMissing: 'no API key configured. Open AI settings to add one.',
  interrupted: '^C',
  backendLoading: 'loading environment...',
  notReady: 'environment is not ready yet',
  runtimeRestarted: 'runtime restarted, variables were reset',
  timedOut: 'timed out after {seconds} s',
  cspBlocked: 'blocked by the page Content-Security-Policy (needs {directive})',
  connectionClosed: 'connection closed by the server',
  notConnected: 'not connected to the server',
  reconnecting: 'reconnecting...',
  connectFailed: 'cannot connect to {url}',
  connectTimedOut: 'connection to {url} timed out',
  aiServiceError: 'the AI service reported an error',
  pagerHint: 'space/b/j/k/g/G, q to quit',
  commandNotFoundIn: '{name}: command not found (this terminal runs {program})',
  noShellSyntax: 'pipes, redirects and variables are not supported in this terminal',
  inputUnsupported: 'reading input is not supported in this terminal',
  ariaLabel: 'Terminal',
  exitStatus: 'exit {code}',
  wasiUnmatchedQuote: 'syntax error: unmatched {quote}',
  wasiFetchFailed: 'cannot download {url}: HTTP {status}',
  wasiNotModule: 'not a WebAssembly module: {source}',
  wasiNotCommand: 'not a WASI command: the module has no _start function or no memory export',
  wasiOutputLimit: 'output limit reached ({limit} characters), the rest is dropped',
  wasiDescribe:
    'This terminal runs one WebAssembly program, {program} (wasm32-wasi). Type {program} followed by its arguments. Quotes, backslash escapes and # comments work; pipes, redirects, variables, several commands and other programs do not. The program cannot read what you type: its standard input is fixed by the page.',
  wasiUsage: 'usage: {usage}',
  wasiNoModule: 'createWasiBackend needs url, bytes or instantiate',
  wasiFetchNetworkError: 'cannot download {url}: network error',
  wasiWorkerTimedOut: 'the WebAssembly worker did not start within {seconds} s',
  wasiCompileFailed: 'cannot compile {source}: {detail}',
  wasiNoWorker: 'WebAssembly programs need a Web Worker, and this environment has none',
  wasiWorkerFailed: 'the WebAssembly worker could not start',
  shellBuiltins: 'shell builtins: {names}',
  shellPageCommands: 'page commands: {names}',
  shellDescription:
    'POSIX-like shell over a virtual file system. Builtins: {builtins}. Syntax: | && || ! ; and newlines, redirects > >> < 2> 2>&1 &> /dev/null, quotes, $VAR ${VAR:-default} ${VAR%pattern} $? $(cmd), globs * ? [abc] [[:alpha:]], braces {a,b} {1..3}, ~, # comments. Not supported: background jobs &, here-documents, subshells ( ), loops, if/case, functions, time, $(( )).',
  shellDescriptionPage: 'Page commands: {names}.',
  jsTimeoutNote: 'A command that runs longer than {seconds} s is stopped and the runtime restarts, losing all variables.',
  jsGlobals: 'Predefined globals: {names}.',
  jsGlobalNotCloneable:
    'the global "{name}" cannot be passed to the worker: only cloneable data is allowed (no functions or DOM objects)',
  jsInitTimedOut: 'the JavaScript worker did not start within {seconds} s',
  jsReplDescription:
    'JavaScript REPL in a browser Web Worker, like the Node.js REPL: the value of the last expression is printed, top-level await works, and variables, functions and classes persist between commands. console.log, table, dir, count, time and group print to the terminal. There is no DOM (no document or window). Relative URLs (/, ./, ../) resolve against the page only in fetch, Request, XMLHttpRequest, importScripts and new URL; import() needs an absolute URL.',
  jsParserFailed: 'cannot load the JavaScript parser',
  aiDoesNotFit: 'the suggested command does not fit on the screen; ask for a shorter one.',
  noOutputTimeout: 'no output for {seconds} s, command cancelled',
  shellNotPipeable: '{name}: interactive commands cannot be piped',
  shellUnsupported: 'unsupported syntax: {construct}',
  shellSyntaxBackground: 'background jobs ({token})',
  shellSyntaxHereString: 'here-strings ({token})',
  shellSyntaxHereDocument: 'here-documents ({token})',
  shellSyntaxInputDuplication: 'input duplication ({token})',
  shellSyntaxReadWrite: 'read-write redirection ({token})',
  shellSyntaxProcessSubstitution: 'process substitution {token}',
  shellSyntaxSubshell: 'subshells {token}',
  shellSyntaxConditional: 'conditionals ({token})',
  shellSyntaxLoop: 'loops ({token})',
  shellSyntaxCase: 'case statements ({token})',
  shellSyntaxFunction: 'functions',
  shellSyntaxGroup: 'command groups {token}',
  shellSyntaxArithmetic: 'arithmetic {token}',
  shellSyntaxAnsiC: 'ANSI-C quoting {token}',
  shellSyntaxParameter: 'parameter expansion {token}',
  shellSyntaxTime: 'command timing ({token})',
  shellBraceLimit: 'brace expansion: too many words',
  shellNeedsTerminal: '{name}: needs an interactive terminal',
  wsServerSilent: 'the server stopped answering, connection dropped',
  wsReconnectAttempt: 'reconnecting, attempt {attempt} of {attempts}...',
  wsReconnectFailed: 'could not reconnect after {attempts} attempts; the next command will try again',
  wsNewSession: 'reconnected to a new session: the working directory and variables start over',
  wsPtyDescription:
    'Commands run in a real terminal (pty) on the server: full-screen programs and input prompts work.',
  runButton: 'run',
  runButtonLabel: 'run in the terminal: {command}',
  elementNeedsUrl: 'the websocket backend needs a url attribute',
  elementUnknownBackend: 'unknown backend "{name}": use shell, javascript, pyodide or websocket',
  runIncomplete: 'incomplete command: it needs more lines, so it did not run',
  pyodideRuntime: 'Python {python} on Pyodide {pyodide}',
  pyodideRuntimeUnknown: 'Python on Pyodide',
  pyodideDescription:
    "{runtime}: CPython compiled to WebAssembly, running in a web worker. Type Python statements; expression results print with repr(). Blocks continue on '... ' lines and end with an empty line. Top-level await works. Imports of Pyodide packages load automatically; pip install <package> (or %pip install) installs pure-Python wheels through micropip. input() and shell commands are not available; files live in an in-memory filesystem.",
}

const ru: Messages = {
  welcome: 'docsterm готов. Введи команду или начни с #, чтобы спросить AI. Встроенные: help, clear, history, explain.',
  welcomeNoAi: 'docsterm готов. Введи команду. Встроенные: help, clear, history.',
  aiNotConfigured: 'AI для этого терминала не настроен.',
  aiThinking: 'думаю...',
  suggestionLabel: 'предложенная команда',
  confirmRun: 'выполнить? [y/N] ',
  cancelled: 'отменено.',
  errorHint: "команда завершилась с ошибкой. Введи 'explain' для объяснения от AI.",
  explainHeader: 'объяснение',
  nothingToExplain: 'объяснять нечего - ошибок пока не было.',
  aiError: 'запрос к AI не удался',
  aiRefused: 'AI отказался выполнять этот запрос.',
  aiTruncated: 'ответ AI оборвался на лимите токенов.',
  aiEmpty: 'AI вернул пустой ответ.',
  aiInvalid: 'из ответа AI не получилось команды.',
  aiNetwork: 'не удаётся связаться с сервисом AI.',
  backendError: 'ошибка окружения',
  backendFailed: 'окружение не запустилось',
  reloadHint: 'перезагрузи страницу, чтобы попробовать ещё раз.',
  helpText:
    'встроенные: help - эта справка; clear - очистить экран; history - прошлые команды; explain - объяснить последнюю ошибку; #<запрос> - попросить AI составить команду.',
  helpTextNoAi: 'встроенные: help - эта справка; clear - очистить экран; history - прошлые команды.',
  keysHelp:
    'клавиши: Tab дополняет, вверх/вниз листают историю, Ctrl+C отменяет, Ctrl+L очищает экран, Shift+Tab или Esc, а затем Tab выводят из терминала.',
  keyMissing: 'API-ключ не задан. Добавь его в настройках AI.',
  interrupted: '^C',
  backendLoading: 'загружаю окружение...',
  notReady: 'окружение ещё не готово',
  runtimeRestarted: 'среда перезапущена, переменные сброшены',
  timedOut: 'превышено время ожидания: {seconds} с',
  cspBlocked: 'заблокировано политикой Content-Security-Policy страницы (нужно {directive})',
  connectionClosed: 'сервер закрыл соединение',
  notConnected: 'нет соединения с сервером',
  reconnecting: 'переподключаюсь...',
  connectFailed: 'не удаётся подключиться к {url}',
  connectTimedOut: 'истекло время ожидания подключения к {url}',
  aiServiceError: 'сервис AI сообщил об ошибке',
  pagerHint: 'пробел/b/j/k/g/G, q - выход',
  commandNotFoundIn: '{name}: команда не найдена (этот терминал запускает {program})',
  noShellSyntax: 'конвейеры, перенаправления и переменные в этом терминале не поддерживаются',
  inputUnsupported: 'чтение ввода в этом терминале не поддерживается',
  ariaLabel: 'Терминал',
  exitStatus: 'код выхода {code}',
  wasiUnmatchedQuote: 'синтаксическая ошибка: непарная кавычка {quote}',
  wasiFetchFailed: 'не удалось скачать {url}: HTTP {status}',
  wasiNotModule: 'это не модуль WebAssembly: {source}',
  wasiNotCommand: 'это не WASI-команда: в модуле нет функции _start или экспорта memory',
  wasiOutputLimit: 'достигнут предел вывода ({limit} символов), остальное отброшено',
  wasiDescribe:
    'Этот терминал запускает одну программу WebAssembly - {program} (wasm32-wasi). Введи {program} и аргументы. Кавычки, экранирование обратной косой чертой и комментарии # работают; конвейеры, перенаправления, переменные, несколько команд и другие программы - нет. Набранный текст программа не читает: её стандартный ввод задаёт страница.',
  wasiUsage: 'использование: {usage}',
  wasiNoModule: 'для createWasiBackend нужен url, bytes или instantiate',
  wasiFetchNetworkError: 'не удалось скачать {url}: ошибка сети',
  wasiWorkerTimedOut: 'WebAssembly-воркер не запустился за {seconds} с',
  wasiCompileFailed: 'не удалось скомпилировать {source}: {detail}',
  wasiNoWorker: 'программам WebAssembly нужен Web Worker, а в этой среде его нет',
  wasiWorkerFailed: 'WebAssembly-воркер не смог запуститься',
  shellBuiltins: 'встроенные команды оболочки: {names}',
  shellPageCommands: 'команды страницы: {names}',
  shellDescription:
    'POSIX-подобная оболочка поверх виртуальной файловой системы. Встроенные команды: {builtins}. Синтаксис: | && || ! ; и переводы строк, перенаправления > >> < 2> 2>&1 &> /dev/null, кавычки, $VAR ${VAR:-default} ${VAR%шаблон} $? $(cmd), шаблоны * ? [abc] [[:alpha:]], фигурные скобки {a,b} {1..3}, ~, комментарии #. Не поддерживается: фоновые задачи &, here-документы, подоболочки ( ), циклы, if/case, функции, time, $(( )).',
  shellDescriptionPage: 'Команды страницы: {names}.',
  jsTimeoutNote: 'Команда дольше {seconds} с останавливается, среда перезапускается, и все переменные теряются.',
  jsGlobals: 'Заранее заданные глобальные переменные: {names}.',
  jsGlobalNotCloneable:
    'глобальную переменную "{name}" нельзя передать в воркер: допустимы только клонируемые данные (без функций и DOM-объектов)',
  jsInitTimedOut: 'JavaScript-воркер не запустился за {seconds} с',
  jsReplDescription:
    'REPL JavaScript в Web Worker браузера, как REPL Node.js: печатается значение последнего выражения, await работает на верхнем уровне, а переменные, функции и классы сохраняются между командами. console.log, table, dir, count, time и group выводят в терминал. DOM нет (нет document и window). Относительные URL (/, ./, ../) отсчитываются от страницы только в fetch, Request, XMLHttpRequest, importScripts и new URL; для import() нужен абсолютный URL.',
  jsParserFailed: 'не удалось загрузить парсер JavaScript',
  aiDoesNotFit: 'предложенная команда не помещается на экране; попроси команду покороче.',
  noOutputTimeout: 'нет вывода {seconds} с, команда отменена',
  shellNotPipeable: '{name}: интерактивные команды нельзя использовать в конвейере',
  shellUnsupported: 'неподдерживаемый синтаксис: {construct}',
  shellSyntaxBackground: 'фоновые задачи ({token})',
  shellSyntaxHereString: 'here-строки ({token})',
  shellSyntaxHereDocument: 'here-документы ({token})',
  shellSyntaxInputDuplication: 'дублирование ввода ({token})',
  shellSyntaxReadWrite: 'перенаправление на чтение и запись ({token})',
  shellSyntaxProcessSubstitution: 'подстановка процессов {token}',
  shellSyntaxSubshell: 'подоболочки {token}',
  shellSyntaxConditional: 'условные конструкции ({token})',
  shellSyntaxLoop: 'циклы ({token})',
  shellSyntaxCase: 'конструкции case ({token})',
  shellSyntaxFunction: 'функции',
  shellSyntaxGroup: 'группы команд {token}',
  shellSyntaxArithmetic: 'арифметические выражения {token}',
  shellSyntaxAnsiC: 'кавычки ANSI-C {token}',
  shellSyntaxParameter: 'подстановка параметров {token}',
  shellSyntaxTime: 'замер времени команд ({token})',
  shellBraceLimit: 'раскрытие фигурных скобок: слишком много слов',
  shellNeedsTerminal: '{name}: нужен интерактивный терминал',
  wsServerSilent: 'сервер перестал отвечать, соединение разорвано',
  wsReconnectAttempt: 'переподключаюсь, попытка {attempt} из {attempts}...',
  wsReconnectFailed: 'не удалось переподключиться за {attempts} попыток; следующая команда попробует снова',
  wsNewSession: 'подключён новый сеанс: рабочий каталог и переменные начинаются заново',
  wsPtyDescription:
    'Команды выполняются на сервере в настоящем терминале (pty): полноэкранные программы и запросы ввода работают.',
  runButton: 'запустить',
  runButtonLabel: 'запустить в терминале: {command}',
  elementNeedsUrl: 'бэкенду websocket нужен атрибут url',
  elementUnknownBackend: 'неизвестный бэкенд "{name}": используй shell, javascript, pyodide или websocket',
  runIncomplete: 'незавершённая команда: ей нужны ещё строки, поэтому она не выполнена',
  pyodideRuntime: 'Python {python} на Pyodide {pyodide}',
  pyodideRuntimeUnknown: 'Python на Pyodide',
  pyodideDescription:
    "{runtime}: CPython, скомпилированный в WebAssembly, работает в Web Worker. Вводи инструкции Python; результаты выражений печатаются через repr(). Блоки продолжаются на строках '... ' и заканчиваются пустой строкой. await работает на верхнем уровне. Пакеты Pyodide загружаются автоматически при импорте; pip install <пакет> (или %pip install) ставит wheel-пакеты на чистом Python через micropip. input() и команды оболочки недоступны; файлы хранятся в файловой системе в памяти.",
}

const catalogs: Record<Locale, Messages> = { en, ru }

export function resolveLocale(input?: string): Locale {
  const raw = input ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)
  return raw.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

export function getMessages(locale: Locale): Messages {
  return catalogs[locale]
}

export function formatMessage(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}
