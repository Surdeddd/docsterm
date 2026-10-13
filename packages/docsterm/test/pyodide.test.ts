import { spawn, spawnSync, type Serializable } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { Worker as NodeWorker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createPyodideBackend,
  DEFAULT_PYODIDE_VERSION,
  PYODIDE_VERSION,
  PYODIDE_WORKER_SOURCE,
  type PyodideBackendOptions,
  type PyodideWorker,
} from '../src/pyodide/index.js'
import type { BackendHost, Locale, SimpleBackend } from '../src/types.js'

const INDEX_URL = new URL('../node_modules/pyodide/', import.meta.url).href
const CDN = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/'
const MICROPIP_WHEEL = `${CDN}micropip-0.11.1-py3-none-any.whl`
const BANNER = 'Python 3.14.2 (pyodide 314.0.7)\n'
const RESTARTED = 'runtime restarted, variables were reset\n'
const DESCRIPTION_EN =
  "CPython compiled to WebAssembly, running in a web worker. Type Python statements; expression results print with repr(). Blocks continue on '... ' lines and end with an empty line. Top-level await works. Imports of Pyodide packages load automatically; pip install <package> (or %pip install) installs pure-Python wheels through micropip. input() and shell commands are not available; files live in an in-memory filesystem."
const DESCRIPTION_RU =
  "CPython, скомпилированный в WebAssembly, работает в Web Worker. Вводи инструкции Python; результаты выражений печатаются через repr(). Блоки продолжаются на строках '... ' и заканчиваются пустой строкой. await работает на верхнем уровне. Пакеты Pyodide загружаются автоматически при импорте; pip install <пакет> (или %pip install) ставит wheel-пакеты на чистом Python через micropip. input() и команды оболочки недоступны; файлы хранятся в файловой системе в памяти."
const DESCRIPTION_LIMIT = 600
const BOOT_TIMEOUT = 60_000
const RUN_TIMEOUT = 30_000

const THREAD_TRANSPORT = [
  "import { parentPort } from 'node:worker_threads'",
  'const send = (message) => parentPort.postMessage(message)',
  "const listen = (handler) => parentPort.on('message', handler)",
]

const PROCESS_TRANSPORT = [
  'const send = (message) => void (process.connected && process.send(message))',
  "const listen = (handler) => process.on('message', handler)",
  "process.on('disconnect', () => process.exit(0))",
]

const workerShim = (transport: readonly string[]): string =>
  [
    ...transport,
    'globalThis.self = globalThis',
    'const scope = new EventTarget()',
    'self.addEventListener = (type, listener) => scope.addEventListener(type, listener)',
    'self.postMessage = send',
    'listen((data) => self.onmessage?.({ data }))',
    'const unprevented = (type, init) => {',
    '  const event = Object.assign(new Event(type, { cancelable: true }), init)',
    '  scope.dispatchEvent(event)',
    '  return !event.defaultPrevented',
    '}',
    "process.on('uncaughtException', (error) => {",
    "  if (unprevented('error', { error, message: `Uncaught ${error}` })) send({ uncaught: String(error) })",
    '})',
    "process.on('unhandledRejection', (reason, promise) => {",
    "  if (unprevented('unhandledrejection', { reason, promise })) send({ unhandled: String(reason) })",
    '})',
    'globalThis.fetch = async (url) => {',
    '  send({ fetched: String(url) })',
    '  const delay = Number(globalThis.docstermFetchDelay ?? 0)',
    '  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))',
    "  return new Response('', { status: 404 })",
    '}',
  ].join('\n')

const JSPI_PROBE = "process.exit(typeof WebAssembly.Suspending === 'function' ? 0 : 1)"
const JSPI_ARGS = [[], ['--experimental-wasm-jspi']].find(
  (args) => spawnSync(process.execPath, [...args, '-e', JSPI_PROBE]).status === 0,
)
const JSPI_REQUIRED = Number(process.versions.node.split('.')[0]) >= 24
const JSPI_SUITE =
  JSPI_ARGS === undefined && !JSPI_REQUIRED
    ? `pyodide backend Ctrl+C with stack switching (skipped: Node ${process.versions.node} has no WebAssembly.Suspending, even with --experimental-wasm-jspi)`
    : 'pyodide backend Ctrl+C with stack switching and without cross-origin isolation'

interface Probe {
  workers: number
  terminated: number
  errors: unknown[]
  unhandled: string[]
  fetched: string[]
}

const newProbe = (): Probe => ({ workers: 0, terminated: 0, errors: [], unhandled: [], fetched: [] })

const report = (data: unknown, key: string): string | null => {
  if (typeof data !== 'object' || data === null || !(key in data)) return null
  return String((data as Record<string, unknown>)[key])
}

class WorkerErrorEvent extends Event {
  readonly colno = 0
  readonly filename = ''
  readonly lineno = 0

  constructor(
    readonly message: string,
    readonly error: unknown = undefined,
  ) {
    super('error', { cancelable: true })
  }
}

const deliver = (probe: Probe, adapter: PyodideWorker, data: unknown): void => {
  const fetched = report(data, 'fetched')
  const uncaught = report(data, 'uncaught')
  const unhandled = report(data, 'unhandled')
  if (fetched !== null) probe.fetched.push(fetched)
  else if (unhandled !== null) probe.unhandled.push(unhandled)
  else if (uncaught !== null) {
    probe.errors.push(uncaught)
    adapter.onerror?.(new WorkerErrorEvent(`Uncaught ${uncaught}`))
  } else adapter.onmessage?.(new MessageEvent('message', { data }))
}

const failed = (probe: Probe, adapter: PyodideWorker, error: Error): void => {
  probe.errors.push(error)
  adapter.onerror?.(new WorkerErrorEvent(error.message, error))
}

const nodeWorkers =
  (probe: Probe) =>
  (source: string): PyodideWorker => {
    const shimmed = `${workerShim(THREAD_TRANSPORT)}\n${source}`
    const worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(shimmed)}`))
    probe.workers += 1
    const adapter: PyodideWorker = {
      onmessage: null,
      onerror: null,
      postMessage: (message) => worker.postMessage(message),
      terminate: () => {
        probe.terminated += 1
        void worker.terminate()
      },
    }
    worker.on('message', (data: unknown) => deliver(probe, adapter, data))
    worker.on('error', (error: Error) => failed(probe, adapter, error))
    return adapter
  }

const jspiProcesses =
  (probe: Probe) =>
  (source: string): PyodideWorker => {
    const args = [...(JSPI_ARGS ?? []), '--input-type=module', '-e', `${workerShim(PROCESS_TRANSPORT)}\n${source}`]
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    probe.workers += 1
    const adapter: PyodideWorker = {
      onmessage: null,
      onerror: null,
      postMessage: (message) => {
        if (child.connected) child.send(message as Serializable)
      },
      terminate: () => {
        probe.terminated += 1
        child.kill()
      },
    }
    child.on('message', (data: unknown) => deliver(probe, adapter, data))
    child.on('error', (error: Error) => failed(probe, adapter, error))
    return adapter
  }

interface RecordingHost extends BackendHost {
  writes: string[]
}

const recordingHost = (locale?: Locale): RecordingHost => {
  const writes: string[] = []
  return { writes, write: (text) => void writes.push(text), locale }
}

interface Captured {
  text: string
  exitCode: number
}

const capture = async (
  backend: SimpleBackend,
  code: string,
  options: { locale?: Locale; signal?: AbortSignal } = {},
): Promise<Captured> => {
  const chunks: string[] = []
  const result = await backend.run(code, {
    write: (text) => void chunks.push(text),
    signal: options.signal ?? new AbortController().signal,
    columns: 80,
    rows: 24,
    locale: options.locale,
  })
  return { text: chunks.join('') + result.output, exitCode: result.exitCode }
}

const numberedText = (text: string): string => text.replace(/<python-input-\d+>/g, '<python-input-N>')

const numbered = (captured: Captured): Captured => ({ ...captured, text: numberedText(captured.text) })

const hostWritesAfter = async (host: RecordingHost, seen: number): Promise<string[]> => {
  await vi.waitFor(
    () => {
      if (host.writes.length === seen) throw new Error('no host output yet')
    },
    { timeout: 5000, interval: 20 },
  )
  return host.writes.slice(seen).map(numberedText)
}

const abortAfter = (backend: SimpleBackend, code: string, delay: number): Promise<Captured> => {
  const controller = new AbortController()
  const pending = capture(backend, code, { signal: controller.signal })
  setTimeout(() => controller.abort(), delay)
  return pending
}

const realBackend = (probe: Probe, options: PyodideBackendOptions = {}) =>
  createPyodideBackend({ indexURL: INDEX_URL, createWorker: nodeWorkers(probe), ...options })

const OFFLINE_MICROPIP = [
  'Loading micropip',
  `Didn't find package micropip-0.11.1-py3-none-any.whl locally, attempting to load from ${CDN}`,
  'Failed to load micropip',
  'The following error occurred while loading micropip:',
  `Failed to load '${MICROPIP_WHEEL}': request failed.`,
  '',
].join('\n')

describe('pyodide backend REPL', () => {
  const probe = newProbe()
  const host = recordingHost()
  const backend = realBackend(probe)
  let booted: { writes: string[]; fetched: string[] } | null = null

  beforeAll(async () => {
    await backend.init(host)
    booted = { writes: [...host.writes], fetched: [...probe.fetched] }
  }, BOOT_TIMEOUT)
  afterAll(() => {
    const escaped = [probe.errors, probe.unhandled]
    backend.dispose()
    expect(escaped).toEqual([[], []])
  })

  it('prints the loaded runtime version and preloads micropip from the package index', () => {
    expect(booted).toEqual({ writes: [BANNER], fetched: [MICROPIP_WHEEL] })
  })

  it('shows expression results with repr()', async () => {
    const cases: Array<[string, string]> = [
      ['True', 'True\n'],
      ['1.0', '1.0\n'],
      ["'abc'", "'abc'\n"],
      ["float('nan')", 'nan\n'],
      ['1e20', '1e+20\n'],
      ["'a\\nb'", "'a\\nb'\n"],
      ['[1, 2.5]', '[1, 2.5]\n'],
      ['None', ''],
    ]
    for (const [code, text] of cases) {
      expect(await capture(backend, code)).toEqual({ text, exitCode: 0 })
    }
  }, RUN_TIMEOUT)

  it('keeps the last shown value in _', async () => {
    expect(await capture(backend, '6 * 7')).toEqual({ text: '42\n', exitCode: 0 })
    expect(await capture(backend, 'x = 5')).toEqual({ text: '', exitCode: 0 })
    expect(await capture(backend, '_ + 1')).toEqual({ text: '43\n', exitCode: 0 })
  }, RUN_TIMEOUT)

  it('keeps output without a trailing newline in the same command', async () => {
    expect(await capture(backend, "print('a', end='')")).toEqual({ text: 'a', exitCode: 0 })
    expect(await capture(backend, "import sys; sys.stdout.write('no newline')")).toEqual({
      text: 'no newline10\n',
      exitCode: 0,
    })
  }, RUN_TIMEOUT)

  it('keeps sys.stdout a CPython-like text stream whose raw bytes stay in the command', async () => {
    expect(
      await capture(backend, 'import sys; sys.stdout, sys.stderr is sys.__stderr__, sys.stdout.isatty(), sys.stdout.buffer'),
    ).toEqual({
      text: "(<_io.TextIOWrapper name='<stdout>' mode='w' encoding='utf-8'>, True, False, <_io.BufferedWriter name='<stdout>'>)\n",
      exitCode: 0,
    })
    expect(await capture(backend, "import sys; sys.stdout.buffer.write(b'raw bytes\\n'); sys.stdout.flush()")).toEqual({
      text: 'raw bytes\n',
      exitCode: 0,
    })
    expect(await capture(backend, "sys.stdout.reconfigure(errors='replace'); print('after reconfigure')")).toEqual({
      text: 'after reconfigure\n',
      exitCode: 0,
    })
  }, RUN_TIMEOUT)

  it('streams lines while the command is still running', async () => {
    const chunks: Array<[string, number]> = []
    const result = await backend.run("import asyncio\nprint('start')\nawait asyncio.sleep(0.4)\nprint('end')", {
      write: (text) => void chunks.push([text, performance.now()]),
      signal: new AbortController().signal,
      columns: 80,
      rows: 24,
    })
    const finished = performance.now()
    expect([result, chunks.map(([text]) => text)]).toEqual([{ output: '', exitCode: 0 }, ['start\n', 'end\n']])
    expect(finished - (chunks[0]?.[1] ?? finished)).toBeGreaterThan(300)
  }, RUN_TIMEOUT)

  it('returns all output when the caller gives no run context', async () => {
    expect(await backend.run('print(1); 2')).toEqual({ output: '1\n2', exitCode: 0 })
  }, RUN_TIMEOUT)

  it('asks for more lines until a block is complete', async () => {
    expect(backend.prompt).toBe('>>> ')
    expect(backend.continuationPrompt).toBe('... ')
    const checks: Array<[string, boolean]> = [
      ['def f():', false],
      ['def f():\n  return 1', false],
      ['def f():\n  return 1\n', true],
      ['for i in range(2):\n    await asyncio.sleep(0)', false],
      ['1 +', true],
      ['pip install six', true],
      ['x = 1', true],
    ]
    for (const [source, complete] of checks) {
      expect([source, await backend.isComplete?.(source)]).toEqual([source, complete])
    }
    expect(await capture(backend, 'def f():\n  return 1\n')).toEqual({ text: '', exitCode: 0 })
    expect(await capture(backend, 'f()')).toEqual({ text: '1\n', exitCode: 0 })
  }, RUN_TIMEOUT)

  it('prints a compiler warning once, from the command and not from the completeness or import checks', async () => {
    const seen = host.writes.length
    expect(await backend.isComplete?.('"\\d"')).toBe(true)
    expect(numbered(await capture(backend, '"\\d"'))).toEqual({
      text: [
        '<python-input-N>:1: SyntaxWarning: "\\d" is an invalid escape sequence. Such sequences will not work in the future. Did you mean "\\\\d"? A raw string is also an option.',
        '  "\\d"',
        "'\\\\d'",
        '',
      ].join('\n'),
      exitCode: 0,
    })
    expect(host.writes.length).toBe(seen)
  }, RUN_TIMEOUT)

  it('ends exit(), quit() and sys.exit(n) with their code and no traceback', async () => {
    const cases: Array<[string, Captured]> = [
      ['exit()', { text: '', exitCode: 0 }],
      ['quit()', { text: '', exitCode: 0 }],
      ['import sys; sys.exit(3)', { text: '', exitCode: 3 }],
      ['sys.exit(0)', { text: '', exitCode: 0 }],
      ['sys.exit(False)', { text: '', exitCode: 0 }],
      ['sys.exit(True)', { text: '', exitCode: 1 }],
      ['sys.exit(256)', { text: '', exitCode: 0 }],
      ['sys.exit(-1)', { text: '', exitCode: 255 }],
      ['sys.exit(2**64)', { text: '', exitCode: 255 }],
      ["sys.exit('bye')", { text: 'bye\n', exitCode: 1 }],
      ['raise SystemExit', { text: '', exitCode: 0 }],
    ]
    for (const [code, expected] of cases) {
      const captured = await capture(backend, code)
      expect([code, captured, typeof captured.exitCode]).toEqual([code, expected, 'number'])
    }
    expect(await capture(backend, 'sys.stdin.closed, repr(exit)')).toEqual({
      text: "(False, 'Use exit() or Ctrl-D (i.e. EOF) to exit')\n",
      exitCode: 0,
    })
    expect(probe.errors).toEqual([])
  }, RUN_TIMEOUT)

  it('prints the traceback of a KeyboardInterrupt that user code raises and exits with 130', async () => {
    expect(numbered(await capture(backend, 'raise KeyboardInterrupt'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    raise KeyboardInterrupt',
        'KeyboardInterrupt',
        '',
      ].join('\n'),
      exitCode: 130,
    })
    await capture(backend, "def stop():\n    raise KeyboardInterrupt('stopped by the code')\n")
    expect(numbered(await capture(backend, 'stop()'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    stop()',
        '    ~~~~^^',
        '  File "<python-input-N>", line 2, in stop',
        "    raise KeyboardInterrupt('stopped by the code')",
        'KeyboardInterrupt: stopped by the code',
        '',
      ].join('\n'),
      exitCode: 130,
    })
  }, RUN_TIMEOUT)

  it('prints CPython tracebacks without runtime frames', async () => {
    expect(numbered(await capture(backend, '1/0'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    1/0',
        '    ~^~',
        'ZeroDivisionError: division by zero',
        '',
      ].join('\n'),
      exitCode: 1,
    })
    expect(numbered(await capture(backend, '1 +'))).toEqual({
      text: ['  File "<python-input-N>", line 1', '    1 +', '       ^', 'SyntaxError: invalid syntax', ''].join('\n'),
      exitCode: 1,
    })
    await capture(backend, 'def g():\n    return 1 / 0\n')
    expect(numbered(await capture(backend, 'g()'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    g()',
        '    ~^^',
        '  File "<python-input-N>", line 2, in g',
        '    return 1 / 0',
        '           ~~^~~',
        'ZeroDivisionError: division by zero',
        '',
      ].join('\n'),
      exitCode: 1,
    })
  }, RUN_TIMEOUT)

  it('shows a CancelledError from user code as a traceback, not as Ctrl+C', async () => {
    const awaited = 'import asyncio\nt = asyncio.ensure_future(asyncio.sleep(10))\nt.cancel()\nawait t'
    expect(numbered(await capture(backend, awaited))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 4, in <module>',
        '    await t',
        '  File "/lib/python314.zip/asyncio/tasks.py", line 687, in sleep',
        '    async def sleep(delay, result=None):',
        'asyncio.exceptions.CancelledError',
        '',
      ].join('\n'),
      exitCode: 1,
    })
    expect(numbered(await capture(backend, 'raise asyncio.CancelledError()'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    raise asyncio.CancelledError()',
        'asyncio.exceptions.CancelledError',
        '',
      ].join('\n'),
      exitCode: 1,
    })
  }, RUN_TIMEOUT)

  it('raises a clear localized error from input() instead of opening a dialog', async () => {
    expect(numbered(await capture(backend, "input('your name? ')"))).toEqual({
      text: [
        'your name? ',
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        "    input('your name? ')",
        '    ~~~~~^^^^^^^^^^^^^^^',
        'EOFError: reading input is not supported in this terminal',
        '',
      ].join('\n'),
      exitCode: 1,
    })
    expect(numbered(await capture(backend, 'input()', { locale: 'ru' }))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    input()',
        '    ~~~~~^^',
        'EOFError: чтение ввода в этом терминале не поддерживается',
        '',
      ].join('\n'),
      exitCode: 1,
    })
    expect(await capture(backend, 'import sys; sys.stdin.readline()')).toEqual({ text: "''\n", exitCode: 0 })
  }, RUN_TIMEOUT)

  it('installs requirements through micropip for pip install and %pip install', async () => {
    const fake = [
      'import sys, types',
      "fake = types.ModuleType('micropip')",
      'async def install(requirements, **options):',
      "    print('install', requirements, sorted(options.items()))",
      'fake.install = install',
      "sys.modules['micropip'] = fake",
      '',
    ].join('\n')
    expect(await capture(backend, fake)).toEqual({ text: '', exitCode: 0 })
    expect(await capture(backend, 'pip install six')).toEqual({
      text: "install ['six'] [('deps', True), ('pre', False), ('verbose', True)]\n",
      exitCode: 0,
    })
    expect(await capture(backend, '%pip install -q --pre --no-deps -U a "b>=1"')).toEqual({
      text: "install ['a', 'b>=1'] [('deps', False), ('pre', True), ('verbose', False)]\n",
      exitCode: 0,
    })
    expect(await capture(backend, 'pip install --bogus x')).toEqual({
      text: 'ERROR: no such option: --bogus\n',
      exitCode: 2,
    })
    expect(await capture(backend, 'pip install')).toEqual({
      text: 'ERROR: You must give at least one requirement to install (see "pip help install")\n',
      exitCode: 1,
    })
    const failing = [
      'async def install(requirements, **options):',
      "    raise ValueError(\"Can't find a pure Python 3 wheel for: 'nope'\\nSee: https://pyodide.org\\n\")",
      'fake.install = install',
      '',
    ].join('\n')
    expect(await capture(backend, failing)).toEqual({ text: '', exitCode: 0 })
    expect(await capture(backend, 'pip install nope')).toEqual({
      text: "ERROR: Can't find a pure Python 3 wheel for: 'nope'\nSee: https://pyodide.org\n",
      exitCode: 1,
    })
  }, RUN_TIMEOUT)

  it('loads micropip on demand for pip install and reports why it failed', async () => {
    expect(await capture(backend, "import sys; removed = sys.modules.pop('micropip', None)")).toEqual({
      text: '',
      exitCode: 0,
    })
    const before = probe.fetched.length
    expect(await capture(backend, 'pip install six')).toEqual({ text: OFFLINE_MICROPIP, exitCode: 1 })
    expect(probe.fetched.slice(before)).toEqual([MICROPIP_WHEEL])
  }, RUN_TIMEOUT)

  it('loads the Pyodide packages a command imports before running it', async () => {
    expect(await capture(backend, "import sys; removed = sys.modules.pop('micropip', None)")).toEqual({
      text: '',
      exitCode: 0,
    })
    expect(numbered(await capture(backend, 'import micropip'))).toEqual({
      text:
        OFFLINE_MICROPIP +
        [
          'Traceback (most recent call last):',
          '  File "<python-input-N>", line 1, in <module>',
          '    import micropip',
          "ModuleNotFoundError: No module named 'micropip'",
          '',
        ].join('\n'),
      exitCode: 1,
    })
  }, RUN_TIMEOUT)

  it('stays quiet about imported packages that are already loaded', async () => {
    expect(await capture(backend, "import pyodide_js; pyodide_js.loadedPackages.six = 'default channel'")).toEqual({
      text: '',
      exitCode: 0,
    })
    expect(numbered(await capture(backend, 'import six'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    import six',
        "ModuleNotFoundError: No module named 'six'",
        '',
      ].join('\n'),
      exitCode: 1,
    })
  }, RUN_TIMEOUT)

  it('runs in a worker realm that cannot reach page globals or the DOM', async () => {
    vi.stubGlobal('docstermPageSecret', 'sk-page-secret')
    try {
      expect(
        await capture(backend, "import js; getattr(js, 'docstermPageSecret', None), getattr(js, 'document', None)"),
      ).toEqual({ text: '(None, None)\n', exitCode: 0 })
    } finally {
      vi.unstubAllGlobals()
    }
  }, RUN_TIMEOUT)

  it('describes the environment for AI prompts', () => {
    expect(backend.describe?.()).toBe(`Python 3.14.2 on Pyodide 314.0.7: ${DESCRIPTION_EN}`)
  })

  it('sends output that arrives after a command ended to the host', async () => {
    const code = [
      'import asyncio',
      'async def later():',
      '    await asyncio.sleep(0.2)',
      "    print('late')",
      'background = asyncio.ensure_future(later())',
      '',
    ].join('\n')
    const seen = host.writes.length
    expect(await capture(backend, code)).toEqual({ text: '', exitCode: 0 })
    expect(await hostWritesAfter(host, seen)).toEqual(['late\n'])
  }, RUN_TIMEOUT)

  it('prints an exception raised in a JS callback and keeps every variable', async () => {
    expect(await capture(backend, "kept = 'v'")).toEqual({ text: '', exitCode: 0 })
    const seen = host.writes.length
    const code = [
      'from js import setTimeout',
      'from pyodide.ffi import create_once_callable',
      'timer = setTimeout(create_once_callable(lambda: 1/0), 50)',
    ].join('\n')
    expect(await capture(backend, code)).toEqual({ text: '', exitCode: 0 })
    expect(await hostWritesAfter(host, seen)).toEqual([
      [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 3, in <lambda>',
        '    timer = setTimeout(create_once_callable(lambda: 1/0), 50)',
        `${' '.repeat(52)}~^~`,
        'ZeroDivisionError: division by zero',
        '',
      ].join('\n'),
    ])
    expect(await capture(backend, 'kept')).toEqual({ text: "'v'\n", exitCode: 0 })
    expect([probe.workers, probe.errors]).toEqual([1, []])
  }, RUN_TIMEOUT)

  it('prints a failed coroutine that a JS callback started and nobody awaited', async () => {
    const seen = host.writes.length
    const code = [
      'from js import setTimeout',
      'from pyodide.ffi import create_once_callable',
      'async def later():',
      "    raise ValueError('later')",
      'timer = setTimeout(create_once_callable(later), 50)',
    ].join('\n')
    expect(await capture(backend, code)).toEqual({ text: '', exitCode: 0 })
    expect(await hostWritesAfter(host, seen)).toEqual([
      [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 4, in later',
        "    raise ValueError('later')",
        'ValueError: later',
        '',
      ].join('\n'),
    ])
    expect([probe.workers, probe.errors, probe.unhandled]).toEqual([1, [], []])
  }, RUN_TIMEOUT)
})

describe('pyodide backend Ctrl+C without cross-origin isolation', () => {
  const probe = newProbe()
  const host = recordingHost()
  const backend = realBackend(probe, { packages: [] })

  beforeAll(() => backend.init(host), BOOT_TIMEOUT)
  afterAll(() => backend.dispose())

  it('runs one command at a time so each gets only its own output', async () => {
    const first = capture(backend, "import asyncio\nawait asyncio.sleep(0.3)\nprint('first')")
    const second = capture(backend, "print('second'); 7 * 6")
    expect(await first).toEqual({ text: 'first\n', exitCode: 0 })
    expect(await second).toEqual({ text: 'second\n42\n', exitCode: 0 })
  }, RUN_TIMEOUT)

  it('answers an already aborted signal without running the command', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await capture(backend, 'ran = True', { signal: controller.signal })).toEqual({ text: '', exitCode: 130 })
    expect(numbered(await capture(backend, 'ran'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    ran',
        "NameError: name 'ran' is not defined",
        '',
      ].join('\n'),
      exitCode: 1,
    })
  }, RUN_TIMEOUT)

  it('cancels an awaiting command and keeps the session', async () => {
    const [seen, workers] = [host.writes.length, probe.workers]
    expect(await capture(backend, "kept = 'state'")).toEqual({ text: '', exitCode: 0 })
    const controller = new AbortController()
    const started = performance.now()
    const pending = capture(backend, "import asyncio\nawait asyncio.sleep(30)\nprint('old')", {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toEqual({ text: '', exitCode: 130 })
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(
      await capture(backend, "print('second starts'); await asyncio.sleep(0.2); print('second ends'); 7 * 6"),
    ).toEqual({ text: 'second starts\nsecond ends\n42\n', exitCode: 0 })
    expect(await capture(backend, 'kept')).toEqual({ text: "'state'\n", exitCode: 0 })
    expect([host.writes.slice(seen), probe.workers - workers]).toEqual([[], 0])
  }, RUN_TIMEOUT)

  it('restarts a busy runtime on Ctrl+C while the page stays responsive', async () => {
    const [seen, workers, terminated] = [host.writes.length, probe.workers, probe.terminated]
    expect(await capture(backend, 'restart_marker = 1')).toEqual({ text: '', exitCode: 0 })
    const controller = new AbortController()
    let settled = false
    const pending = capture(backend, 'while True: pass', { signal: controller.signal }).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(settled).toBe(false)
    controller.abort()
    expect(await pending).toEqual({ text: '', exitCode: 130 })
    expect(host.writes.slice(seen)).toEqual([RESTARTED])
    expect(numbered(await capture(backend, 'restart_marker'))).toEqual({
      text: [
        'Traceback (most recent call last):',
        '  File "<python-input-N>", line 1, in <module>',
        '    restart_marker',
        "NameError: name 'restart_marker' is not defined",
        '',
      ].join('\n'),
      exitCode: 1,
    })
    expect(await capture(backend, '1 + 1')).toEqual({ text: '2\n', exitCode: 0 })
    expect([probe.workers - workers, probe.terminated - terminated, probe.errors]).toEqual([1, 1, []])
  }, RUN_TIMEOUT)

  it('asks the restarted runtime whether a block typed right after Ctrl+C is complete', async () => {
    const workers = probe.workers
    const controller = new AbortController()
    const pending = capture(backend, 'while True: pass', { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    const verdicts = Promise.all([
      backend.isComplete?.('def f():'),
      backend.isComplete?.('def f():\n  return 1'),
      backend.isComplete?.('def f():\n  return 1\n'),
    ])
    expect(await pending).toEqual({ text: '', exitCode: 130 })
    expect(await verdicts).toEqual([false, false, true])
    expect(await capture(backend, 'def f():\n  return 1\n')).toEqual({ text: '', exitCode: 0 })
    expect(await capture(backend, 'f()')).toEqual({ text: '1\n', exitCode: 0 })
    expect([probe.workers - workers, probe.errors]).toEqual([1, []])
  }, RUN_TIMEOUT)
})

describe('pyodide backend Ctrl+C under cross-origin isolation', () => {
  const probe = newProbe()
  const host = recordingHost()
  let backend: SimpleBackend

  beforeAll(async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    backend = realBackend(probe, { packages: [] })
    await backend.init(host)
    expect(await capture(backend, 'state = 41')).toEqual({ text: '', exitCode: 0 })
  }, BOOT_TIMEOUT)
  afterAll(() => {
    backend.dispose()
    vi.unstubAllGlobals()
  })

  it('raises KeyboardInterrupt in a busy loop and keeps every variable', async () => {
    const controller = new AbortController()
    const pending = capture(backend, 'while True: pass', { signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    expect(await pending).toEqual({ text: '', exitCode: 130 })
    expect(await capture(backend, 'state + 1')).toEqual({ text: '42\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.terminated]).toEqual([[BANNER], 1, 0])
  }, RUN_TIMEOUT)

  it('cancels an awaiting command through the same Ctrl+C', async () => {
    const controller = new AbortController()
    const pending = capture(backend, 'import asyncio\nawait asyncio.sleep(5)', { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toEqual({ text: '', exitCode: 130 })
    expect(await capture(backend, 'state')).toEqual({ text: '41\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors]).toEqual([[BANNER], 1, []])
  }, RUN_TIMEOUT)

  const abortEach = async (code: string, delays: number[]): Promise<Captured[]> => {
    const results: Captured[] = []
    for (const delay of delays) {
      const controller = new AbortController()
      const pending = capture(backend, code, { signal: controller.signal })
      setTimeout(() => controller.abort(), delay)
      results.push(await pending)
    }
    return results
  }

  it('keeps the session when Ctrl+C lands while a loop awaits again and again', async () => {
    const delays = Array.from({ length: 24 }, (_, index) => 50 + index * 8)
    const code = 'import asyncio\nfor i in range(100000):\n    await asyncio.sleep(0.002)'
    expect(await abortEach(code, delays)).toEqual(delays.map(() => ({ text: '', exitCode: 130 })))
    expect(await capture(backend, 'state')).toEqual({ text: '41\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors, probe.unhandled]).toEqual([[BANNER], 1, [], []])
  }, 60_000)

  it('keeps the session when Ctrl+C comes right after a busy loop starts', async () => {
    const delays = Array.from({ length: 52 }, (_, index) => 5 + (index % 26))
    expect(await abortEach('while True: pass', delays)).toEqual(delays.map(() => ({ text: '', exitCode: 130 })))
    expect(await capture(backend, 'state')).toEqual({ text: '41\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors, probe.unhandled]).toEqual([[BANNER], 1, [], []])
  }, 60_000)

  it('interrupts a busy task that the command awaits', async () => {
    const code = [
      'import asyncio',
      'async def spin():',
      '    await asyncio.sleep(0)',
      '    while True: pass',
      'await asyncio.gather(spin())',
    ].join('\n')
    expect(await abortEach(code, [150])).toEqual([{ text: '', exitCode: 130 }])
    expect(await capture(backend, 'state')).toEqual({ text: '41\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors, probe.unhandled]).toEqual([[BANNER], 1, [], []])
  }, RUN_TIMEOUT)

  it('interrupts a busy JS callback that the command started', async () => {
    const code = [
      'import asyncio',
      'from js import setTimeout',
      'from pyodide.ffi import create_once_callable',
      'def spin():',
      '    while True: pass',
      'timer = setTimeout(create_once_callable(spin), 0)',
      'await asyncio.sleep(10)',
    ].join('\n')
    expect(await abortEach(code, [150])).toEqual([{ text: '', exitCode: 130 }])
    expect(await capture(backend, 'state')).toEqual({ text: '41\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors, probe.unhandled]).toEqual([[BANNER], 1, [], []])
  }, RUN_TIMEOUT)

  it('interrupts time.sleep in place and keeps every variable', async () => {
    const started = performance.now()
    expect(await abortEach('import time\ntime.sleep(30)', [150])).toEqual([{ text: '', exitCode: 130 }])
    expect(await abortEach('import time\nwhile True: time.sleep(0.01)', [150])).toEqual([{ text: '', exitCode: 130 }])
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(await capture(backend, "import time\ntime.sleep(0.12)\nprint('slept')")).toEqual({ text: 'slept\n', exitCode: 0 })
    expect(await capture(backend, 'state')).toEqual({ text: '41\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors, probe.unhandled]).toEqual([[BANNER], 1, [], []])
  }, RUN_TIMEOUT)

  it('never raises KeyboardInterrupt inside the asyncio or Pyodide event loop machinery', async () => {
    const code = [
      'import asyncio, signal, sys',
      'import pyodide.webloop',
      'handler = signal.getsignal(signal.SIGINT)',
      'def frame_in(filename):',
      "    scope = {'sys': sys}",
      "    exec(compile('def probe():\\n    return sys._getframe()\\n', filename, 'exec'), scope)",
      "    return scope['probe']()",
      'def verdict(filename):',
      '    try:',
      '        handler(signal.SIGINT, frame_in(filename))',
      '    except KeyboardInterrupt:',
      "        return 'raised'",
      "    return 'deferred'",
      "[verdict(name) for name in (asyncio.tasks.__file__, pyodide.webloop.__file__, '/lib/python3.14/json/decoder.py', '<python-input-0>')]",
    ].join('\n')
    expect(await capture(backend, code)).toEqual({ text: "['deferred', 'deferred', 'raised', 'raised']\n", exitCode: 0 })
  }, RUN_TIMEOUT)
})

it.runIf(JSPI_REQUIRED)('finds WebAssembly.Suspending on Node 24 and later, so the stack switching suite always runs there', () => {
  expect(JSPI_ARGS).toBeDefined()
})

describe.runIf(JSPI_ARGS !== undefined || JSPI_REQUIRED)(JSPI_SUITE, () => {
  const probe = newProbe()
  const host = recordingHost()
  const backend = createPyodideBackend({ indexURL: INDEX_URL, packages: [], createWorker: jspiProcesses(probe) })

  beforeAll(async () => {
    await backend.init(host)
    expect(await capture(backend, 'state = 41\nfrom pyodide.ffi import can_run_sync\ncan_run_sync()')).toEqual({
      text: 'True\n',
      exitCode: 0,
    })
  }, BOOT_TIMEOUT)
  afterAll(() => backend.dispose())

  it('interrupts time.sleep in place with a KeyboardInterrupt the code can catch', async () => {
    const code = ['import time', 'try:', '    time.sleep(30)', 'except KeyboardInterrupt:', '    caught = True'].join('\n')
    expect(await abortAfter(backend, code, 150)).toEqual({ text: '', exitCode: 130 })
    expect(await capture(backend, 'state, caught')).toEqual({ text: '(41, True)\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors, probe.unhandled]).toEqual([[BANNER], 1, [], []])
  }, RUN_TIMEOUT)

  it('interrupts asyncio.run in place and leaves the tasks of earlier commands running', async () => {
    const ticker = [
      'import asyncio',
      'ticks = 0',
      'async def tick():',
      '    global ticks',
      '    while True:',
      '        ticks += 1',
      '        await asyncio.sleep(0.01)',
      'ticker = asyncio.ensure_future(tick())',
    ].join('\n')
    expect(await capture(backend, ticker)).toEqual({ text: '', exitCode: 0 })
    const code = ['async def main():', '    while True:', '        await asyncio.sleep(0.01)', 'asyncio.run(main())'].join('\n')
    expect(await abortAfter(backend, code, 150)).toEqual({ text: '', exitCode: 130 })
    expect(await capture(backend, 'before = ticks\nawait asyncio.sleep(0.1)\nstate, ticks > before, ticker.done()')).toEqual({
      text: '(41, True, False)\n',
      exitCode: 0,
    })
    expect(await capture(backend, 'ticker.cancel()')).toEqual({ text: 'True\n', exitCode: 0 })
    expect([host.writes, probe.workers, probe.errors, probe.unhandled]).toEqual([[BANNER], 1, [], []])
  }, RUN_TIMEOUT)
})

describe('pyodide backend output ownership', () => {
  const probe = newProbe()
  const host = recordingHost()
  const backend = realBackend(probe, { packages: [] })

  beforeAll(() => backend.init(host), BOOT_TIMEOUT)
  afterAll(() => backend.dispose())

  it('shows late prints of an earlier command in the command that is running when they arrive', async () => {
    const code = [
      'import asyncio, sys',
      'async def later():',
      '    await asyncio.sleep(0.2)',
      "    print('late out')",
      "    print('late err', file=sys.stderr)",
      'background = asyncio.ensure_future(later())',
      '',
    ].join('\n')
    expect(await capture(backend, code)).toEqual({ text: '', exitCode: 0 })
    const seen = host.writes.length
    expect(await capture(backend, "import asyncio\nawait asyncio.sleep(0.5)\nprint('next')")).toEqual({
      text: 'late out\nlate err\nnext\n',
      exitCode: 0,
    })
    expect(host.writes.slice(seen)).toEqual([])
  }, RUN_TIMEOUT)

  it('keeps the output of the tasks a command awaits in that command', async () => {
    const code = [
      'import asyncio',
      'async def work(name):',
      '    await asyncio.sleep(0.05)',
      '    print(name)',
      "done = await asyncio.gather(work('a'), work('b'))",
    ].join('\n')
    const seen = host.writes.length
    expect(await capture(backend, code)).toEqual({ text: 'a\nb\n', exitCode: 0 })
    expect(host.writes.length).toBe(seen)
  }, RUN_TIMEOUT)

  it('sends package progress of a cancelled command to the host, never into the next command', async () => {
    expect(await capture(backend, 'import js; js.docstermFetchDelay = 400')).toEqual({ text: '', exitCode: 0 })
    const controller = new AbortController()
    const chunks: string[] = []
    const cancelled = backend.run('import six', {
      write: (text) => void chunks.push(text),
      signal: controller.signal,
      columns: 80,
      rows: 24,
    })
    await vi.waitFor(
      () => {
        if (!chunks.join('').includes("Didn't find package six")) throw new Error('six is not being fetched yet')
      },
      { timeout: 5000, interval: 10 },
    )
    controller.abort()
    expect(await cancelled).toEqual({ output: '', exitCode: 130 })
    const seen = host.writes.length
    expect(await capture(backend, "import asyncio\nawait asyncio.sleep(0.6)\nprint('next')")).toEqual({
      text: 'next\n',
      exitCode: 0,
    })
    expect(host.writes.slice(seen)).toEqual([
      'Failed to load six\n',
      'The following error occurred while loading six:\n',
      `Failed to load '${CDN}six-1.17.0-py2.py3-none-any.whl': request failed.\n`,
    ])
    expect([probe.errors, probe.unhandled]).toEqual([[], []])
  }, RUN_TIMEOUT)

  it('sends micropip loading progress of a cancelled pip install to the host, never into the next command', async () => {
    expect(await capture(backend, 'import js; js.docstermFetchDelay = 400')).toEqual({ text: '', exitCode: 0 })
    const controller = new AbortController()
    const chunks: string[] = []
    const cancelled = backend.run('pip install six', {
      write: (text) => void chunks.push(text),
      signal: controller.signal,
      columns: 80,
      rows: 24,
    })
    await vi.waitFor(
      () => {
        if (!chunks.join('').includes("Didn't find package micropip")) throw new Error('micropip is not being fetched yet')
      },
      { timeout: 5000, interval: 10 },
    )
    controller.abort()
    expect(await cancelled).toEqual({ output: '', exitCode: 130 })
    const seen = host.writes.length
    expect(await capture(backend, "import asyncio\nawait asyncio.sleep(0.6)\nprint('next')")).toEqual({
      text: 'next\n',
      exitCode: 0,
    })
    expect(host.writes.slice(seen)).toEqual([
      'Failed to load micropip\n',
      'The following error occurred while loading micropip:\n',
      `Failed to load '${MICROPIP_WHEEL}': request failed.\n`,
    ])
    expect([probe.errors, probe.unhandled]).toEqual([[], []])
  }, RUN_TIMEOUT)
})

describe('pyodide backend lifecycle', () => {
  it(
    'boots again after dispose and reuses one worker for a second init',
    async () => {
      const probe = newProbe()
      const backend = realBackend(probe, { packages: [] })
      const first = recordingHost()
      await backend.init(first)
      await backend.init(first)
      expect([first.writes, probe.workers]).toEqual([[BANNER, BANNER], 1])
      expect(await capture(backend, 'value = 2; value')).toEqual({ text: '2\n', exitCode: 0 })
      backend.dispose()
      expect(probe.terminated).toBe(1)
      expect(await backend.run('1 + 1')).toEqual({ output: 'environment is not ready yet', exitCode: 1 })
      const second = recordingHost('ru')
      await backend.init(second)
      expect(second.writes).toEqual([BANNER])
      expect(await capture(backend, '1 + 1')).toEqual({ text: '2\n', exitCode: 0 })
      const inputError = (message: string) =>
        [
          'Traceback (most recent call last):',
          '  File "<python-input-N>", line 1, in <module>',
          '    input()',
          '    ~~~~~^^',
          `EOFError: ${message}`,
          '',
        ].join('\n')
      expect([
        numbered(await capture(backend, 'input()')),
        numbered(await capture(backend, 'input()', { locale: 'en' })),
      ]).toEqual([
        { text: inputError('чтение ввода в этом терминале не поддерживается'), exitCode: 1 },
        { text: inputError('reading input is not supported in this terminal'), exitCode: 1 },
      ])
      expect([probe.workers, probe.errors]).toEqual([2, []])

      const running = capture(backend, 'import asyncio\nawait asyncio.sleep(10)')
      const queued = capture(backend, "print('queued before dispose')")
      await new Promise((resolve) => setTimeout(resolve, 100))
      backend.dispose()
      const third = recordingHost()
      const rebooting = backend.init(third)
      expect([await running, await queued]).toEqual([
        { text: '', exitCode: 130 },
        { text: '', exitCode: 130 },
      ])
      await rebooting
      expect([third.writes, probe.workers]).toEqual([[BANNER], 3])
      backend.dispose()
      expect(await capture(backend, '1', { locale: 'ru' })).toEqual({ text: 'окружение ещё не готово', exitCode: 1 })
    },
    BOOT_TIMEOUT,
  )

  it(
    'never lets a boot cut short by dispose win over the next one',
    async () => {
      const probe = newProbe()
      const backend = realBackend(probe, { packages: [] })
      const stale = recordingHost()
      const booting = backend.init(stale)
      backend.dispose()
      await booting
      expect([stale.writes, probe.workers, probe.terminated]).toEqual([[], 1, 1])
      const fresh = recordingHost()
      await backend.init(fresh)
      expect(fresh.writes).toEqual([BANNER])
      expect(await capture(backend, '1 + 1')).toEqual({ text: '2\n', exitCode: 0 })
      backend.dispose()
      expect([stale.writes, probe.workers, probe.terminated, probe.errors]).toEqual([[], 2, 2, []])
    },
    BOOT_TIMEOUT,
  )
})

interface WorkerMessage {
  type: string
  id?: number
}

class FakeWorker implements PyodideWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly posted: unknown[] = []
  terminated = false

  constructor(private readonly reply: (worker: FakeWorker, message: WorkerMessage) => void) {}

  postMessage(message: unknown): void {
    this.posted.push(message)
    queueMicrotask(() => this.reply(this, message as WorkerMessage))
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const silent = () => undefined
const READY = { type: 'ready', version: '314.0.7', python: '3.14.2' }
const answersReady = (worker: FakeWorker, message: WorkerMessage) => {
  if (message.type === 'boot') worker.emit(READY)
}
const postedTypes = (worker: FakeWorker | undefined) => worker?.posted.map((message) => (message as WorkerMessage).type)
const PENDING = 'pending'
const pendingAfter = <T>(value: T | Promise<T>, ms: number): Promise<T | typeof PENDING> =>
  Promise.race([Promise.resolve(value), new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))])

describe('pyodide backend defaults and failures', () => {
  it('loads the pinned runtime and micropip from jsDelivr by default', async () => {
    const workers: FakeWorker[] = []
    const backend = createPyodideBackend({
      createWorker: (source) => {
        expect(source).toBe(PYODIDE_WORKER_SOURCE)
        const worker = new FakeWorker(answersReady)
        workers.push(worker)
        return worker
      },
    })
    await backend.init(recordingHost())
    expect([DEFAULT_PYODIDE_VERSION, PYODIDE_VERSION]).toEqual(['314.0.7', '314.0.7'])
    expect(workers[0]?.posted).toEqual([{ type: 'boot', indexURL: CDN, packages: ['micropip'], buffer: null }])
    backend.dispose()
    expect(workers[0]?.terminated).toBe(true)
  })

  it('resolves a relative index URL against the page and adds the trailing slash', async () => {
    vi.stubGlobal('document', { baseURI: 'https://docs.example/guide/intro.html' })
    try {
      const posted: unknown[] = []
      const backend = createPyodideBackend({
        indexURL: 'static/pyodide',
        packages: ['numpy'],
        createWorker: () => {
          const worker = new FakeWorker(answersReady)
          posted.push(worker.posted)
          return worker
        },
      })
      await backend.init(recordingHost())
      expect(posted).toEqual([
        [{ type: 'boot', indexURL: 'https://docs.example/guide/static/pyodide/', packages: ['numpy'], buffer: null }],
      ])
      backend.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a worker that cannot start as a Content-Security-Policy problem', async () => {
    let prevented = 0
    const blocked = () =>
      new FakeWorker((worker) => worker.onerror?.({ preventDefault: () => void (prevented += 1) }))
    await expect(createPyodideBackend({ createWorker: blocked }).init(recordingHost())).rejects.toThrow(
      new Error('blocked by the page Content-Security-Policy (needs worker-src blob:)'),
    )
    await expect(createPyodideBackend({ createWorker: blocked }).init(recordingHost('ru'))).rejects.toThrow(
      new Error('заблокировано политикой Content-Security-Policy страницы (нужно worker-src blob:)'),
    )
    expect(prevented).toBe(2)
  })

  it('rejects init with the reason when the runtime cannot be loaded', async () => {
    const probe = newProbe()
    const backend = createPyodideBackend({
      indexURL: new URL('../node_modules/missing-pyodide/', import.meta.url).href,
      createWorker: nodeWorkers(probe),
    })
    await expect(backend.init(recordingHost())).rejects.toThrow(/^Cannot find module '.*\/missing-pyodide\/pyodide\.mjs'/)
    expect([probe.workers, probe.terminated]).toEqual([1, 1])
    backend.dispose()
  })

  it('rejects init when no worker can be created, and boots on a later init', async () => {
    let attempts = 0
    const backend = createPyodideBackend({
      createWorker: () => {
        attempts += 1
        if (attempts === 1) throw new Error('workers are disabled')
        return new FakeWorker(answersReady)
      },
    })
    await expect(backend.init(recordingHost())).rejects.toThrow(new Error('workers are disabled'))
    const host = recordingHost()
    await backend.init(host)
    expect([attempts, host.writes]).toEqual([2, [BANNER]])
    backend.dispose()
    await expect(createPyodideBackend().init(recordingHost())).rejects.toThrow(
      new ReferenceError('Worker is not defined'),
    )
  })

  it('prints a worker error event after boot and keeps the session and its command', async () => {
    const workers: FakeWorker[] = []
    const runs: number[] = []
    const backend = createPyodideBackend({
      createWorker: () => {
        const worker = new FakeWorker((target, message) => {
          answersReady(target, message)
          if (message.type === 'run' && message.id !== undefined) runs.push(message.id)
        })
        workers.push(worker)
        return worker
      },
    })
    const host = recordingHost()
    await backend.init(host)
    const chunks: string[] = []
    const running = backend.run('work()', {
      write: (text) => void chunks.push(text),
      signal: new AbortController().signal,
      columns: 80,
      rows: 24,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    let prevented = 0
    const errorEvent = (message: string) => ({ message, preventDefault: () => void (prevented += 1) })
    workers[0]?.onerror?.(errorEvent('Uncaught Error: during the command'))
    workers[0]?.emit({ type: 'done', id: runs[0], exitCode: 0 })
    expect([await running, chunks]).toEqual([{ output: '', exitCode: 0 }, ['Uncaught Error: during the command\n']])
    workers[0]?.onerror?.(errorEvent('Uncaught Error: while idle'))
    expect([host.writes, prevented, workers.length, workers[0]?.terminated]).toEqual([
      [BANNER, 'Uncaught Error: while idle\n'],
      2,
      1,
      false,
    ])
    backend.dispose()
  })

  it('restarts a runtime that ignores Ctrl+C and settles the stuck command with 130', async () => {
    const workers: FakeWorker[] = []
    const backend = createPyodideBackend({
      createWorker: () => {
        const worker = new FakeWorker(answersReady)
        workers.push(worker)
        return worker
      },
    })
    const host = recordingHost('ru')
    await backend.init(host)
    const controller = new AbortController()
    const running = backend.run('while True: pass', { write: silent, signal: controller.signal, columns: 80, rows: 24 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    expect(await running).toEqual({ output: '', exitCode: 130 })
    expect([
      host.writes,
      workers.length,
      workers[0]?.terminated,
      workers[0]?.posted.map((message) => (message as WorkerMessage).type),
    ]).toEqual([[BANNER, 'среда перезапущена, переменные сброшены\n'], 2, true, ['boot', 'run', 'interrupt']])
    backend.dispose()
  })

  it('explains a runtime that cannot boot again after a restart', async () => {
    const workers: FakeWorker[] = []
    const backend = createPyodideBackend({
      createWorker: () => {
        const first = workers.length === 0
        const worker = new FakeWorker((target, message) => {
          if (message.type !== 'boot') return
          if (first) answersReady(target, message)
          else target.emit({ type: 'boot-error', message: 'Failed to fetch dynamically imported module' })
        })
        workers.push(worker)
        return worker
      },
    })
    await backend.init(recordingHost())
    const controller = new AbortController()
    const stuck = backend.run('while True: pass', { write: silent, signal: controller.signal, columns: 80, rows: 24 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    expect(await stuck).toEqual({ output: '', exitCode: 130 })
    expect(await backend.run('1')).toEqual({
      output: 'environment failed to start: Failed to fetch dynamically imported module\nreload the page to try again.',
      exitCode: 1,
    })
    expect(await backend.run('1', { write: silent, signal: new AbortController().signal, columns: 80, rows: 24, locale: 'ru' })).toEqual({
      output: 'окружение не запустилось: Failed to fetch dynamically imported module\nперезагрузи страницу, чтобы попробовать ещё раз.',
      exitCode: 1,
    })
    backend.dispose()
  })

  it('treats a worker that crashes before ready after a restart as a crash, not a policy block, and retries', async () => {
    const workers: FakeWorker[] = []
    const backend = createPyodideBackend({
      createWorker: () => {
        const index = workers.length
        const worker = new FakeWorker((target, message) => {
          if (message.type === 'boot' && index === 1) {
            target.onerror?.({ message: 'Uncaught RangeError: Out of memory', preventDefault: silent })
            return
          }
          answersReady(target, message)
          if (message.type === 'run' && index === 2) {
            target.emit({ type: 'output', id: message.id, text: '1\n' })
            target.emit({ type: 'done', id: message.id, exitCode: 0 })
          }
        })
        workers.push(worker)
        return worker
      },
    })
    await backend.init(recordingHost())
    const controller = new AbortController()
    const stuck = backend.run('while True: pass', { write: silent, signal: controller.signal, columns: 80, rows: 24 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    expect(await stuck).toEqual({ output: '', exitCode: 130 })
    expect(await backend.run('1')).toEqual({
      output: 'environment failed to start: Uncaught RangeError: Out of memory\nreload the page to try again.',
      exitCode: 1,
    })
    const chunks: string[] = []
    const next = await backend.run('1', { write: (text) => void chunks.push(text), signal: new AbortController().signal, columns: 80, rows: 24 })
    expect([next, chunks, workers.length]).toEqual([{ output: '', exitCode: 0 }, ['1\n'], 3])
    backend.dispose()
  })

  it('stops retrying a runtime that keeps crashing before ready after three attempts', async () => {
    const workers: FakeWorker[] = []
    const backend = createPyodideBackend({
      createWorker: () => {
        const first = workers.length === 0
        const worker = new FakeWorker((target, message) => {
          if (message.type !== 'boot') return
          if (first) answersReady(target, message)
          else target.onerror?.({ message: 'Uncaught Error: boom', preventDefault: silent })
        })
        workers.push(worker)
        return worker
      },
    })
    await backend.init(recordingHost())
    const controller = new AbortController()
    const stuck = backend.run('while True: pass', { write: silent, signal: controller.signal, columns: 80, rows: 24 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await stuck
    const outputs: string[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) outputs.push((await backend.run('1')).output)
    expect(outputs).toEqual(Array(5).fill('environment failed to start: Uncaught Error: boom\nreload the page to try again.'))
    expect(workers.length).toBe(5)
    backend.dispose()
  })

  it('waits for the runtime to boot before it answers isComplete', async () => {
    const workers: FakeWorker[] = []
    const backend = createPyodideBackend({
      createWorker: () => {
        const worker = new FakeWorker((target, message) => {
          if (message.type === 'check') target.emit({ type: 'checked', id: message.id, complete: false })
        })
        workers.push(worker)
        return worker
      },
    })
    expect(await backend.isComplete?.('def f():')).toBe(true)
    const booting = backend.init(recordingHost())
    const judging = Promise.resolve(backend.isComplete?.('def f():'))
    expect([await pendingAfter(judging, 50), postedTypes(workers[0])]).toEqual([PENDING, ['boot']])
    workers[0]?.emit(READY)
    await booting
    expect([await judging, postedTypes(workers[0])]).toEqual([false, ['boot', 'check']])
    backend.dispose()
  })

  it('answers isComplete with true when the runtime cannot boot or is disposed while it waits', async () => {
    const failing = createPyodideBackend({
      createWorker: () =>
        new FakeWorker((target, message) => {
          if (message.type === 'boot') target.emit({ type: 'boot-error', message: 'offline' })
        }),
    })
    const failed = failing.init(recordingHost()).catch((error: unknown) => String(error))
    expect([await failing.isComplete?.('def f():'), await failed]).toEqual([true, 'Error: offline'])
    const stalled = createPyodideBackend({ createWorker: () => new FakeWorker(silent) })
    const booting = stalled.init(recordingHost())
    const judging = Promise.resolve(stalled.isComplete?.('def f():'))
    expect(await pendingAfter(judging, 50)).toBe(PENDING)
    stalled.dispose()
    expect([await judging, await booting]).toEqual([true, undefined])
  })

  it('keeps waiting past one second for a check while an isolated Ctrl+C is still landing', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    try {
      const workers: FakeWorker[] = []
      const ids = new Map<string, number[]>([
        ['run', []],
        ['check', []],
      ])
      const backend = createPyodideBackend({
        createWorker: () => {
          const worker = new FakeWorker((target, message) => {
            answersReady(target, message)
            if (message.id !== undefined) ids.get(message.type)?.push(message.id)
          })
          workers.push(worker)
          return worker
        },
      })
      await backend.init(recordingHost())
      const controller = new AbortController()
      const running = backend.run('while True: pass', { write: silent, signal: controller.signal, columns: 80, rows: 24 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort()
      const judging = Promise.resolve(backend.isComplete?.('def f():'))
      expect(await pendingAfter(judging, 1500)).toBe(PENDING)
      workers[0]?.emit({ type: 'done', id: ids.get('run')?.[0], exitCode: 130 })
      for (const id of ids.get('check') ?? []) workers[0]?.emit({ type: 'checked', id, complete: false })
      expect([await running, await judging, workers.length]).toEqual([{ output: '', exitCode: 130 }, false, 1])
      backend.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('answers isComplete with true when an idle runtime does not reply within a second', async () => {
    const backend = createPyodideBackend({ createWorker: () => new FakeWorker(answersReady) })
    await backend.init(recordingHost())
    const started = performance.now()
    expect(await backend.isComplete?.('def f():')).toBe(true)
    expect(performance.now() - started).toBeGreaterThan(900)
    backend.dispose()
  })

  it('describes the environment in the host locale and within the limit the other backends use', async () => {
    const backend = createPyodideBackend({ createWorker: () => new FakeWorker(answersReady) })
    const pending = backend.describe?.() ?? ''
    await backend.init(recordingHost('ru'))
    const ru = backend.describe?.() ?? ''
    backend.dispose()
    const english = createPyodideBackend({ createWorker: () => new FakeWorker(answersReady) })
    await english.init(recordingHost('en'))
    const en = english.describe?.() ?? ''
    english.dispose()
    const stalled = createPyodideBackend({ createWorker: () => new FakeWorker(silent) })
    const booting = stalled.init(recordingHost('ru'))
    const loadingRu = stalled.describe?.() ?? ''
    stalled.dispose()
    await booting
    expect([pending, ru, en, loadingRu]).toEqual([
      `Python on Pyodide: ${DESCRIPTION_EN}`,
      `Python 3.14.2 на Pyodide 314.0.7: ${DESCRIPTION_RU}`,
      `Python 3.14.2 on Pyodide 314.0.7: ${DESCRIPTION_EN}`,
      `Python на Pyodide: ${DESCRIPTION_RU}`,
    ])
    expect(Math.max(...[pending, ru, en, loadingRu].map((text) => text.length))).toBeLessThanOrEqual(DESCRIPTION_LIMIT)
  })

  it('accepts a real DOM Worker from createWorker without a cast', () => {
    expectTypeOf<Worker>().toExtend<PyodideWorker>()
  })

  it('never imports the pyodide npm package', () => {
    const folder = new URL('../src/pyodide/', import.meta.url)
    const imports = readdirSync(folder)
      .map((name) => readFileSync(new URL(name, folder), 'utf8'))
      .filter((source) => /from\s+['"]pyodide['"]|import\(\s*['"]pyodide['"]\s*\)/.test(source))
    expect(imports).toEqual([])
  })
})
