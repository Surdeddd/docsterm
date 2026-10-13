import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendHost, Locale, RunContext } from '../src/types.js'
import {
  CommandLineError,
  createWasiBackend,
  createWasiHost,
  isCompleteCommandLine,
  splitCommandLine,
  WASI_WORKER_SOURCE,
  type WasiInstance,
  type WorkerLike,
} from '../src/wasi/index.js'

interface NodeFs {
  readFileSync(path: URL): Uint8Array
}

interface NodeWorker {
  postMessage(message: unknown): void
  terminate(): Promise<number>
  on(event: 'message' | 'error', listener: (value: unknown) => void): void
  unref(): void
}

interface NodeWorkerThreads {
  Worker: new (source: string, options: { eval: true }) => NodeWorker
}

const nodeModule = <T>(id: string): T =>
  (globalThis as unknown as { process: { getBuiltinModule(id: string): T } }).process.getBuiltinModule(id)

const readBytes = (url: URL) => new Uint8Array(nodeModule<NodeFs>('node:fs').readFileSync(url))
const fixture = (name: string) => readBytes(new URL(`./fixtures/wasi/${name}.wasm`, import.meta.url))
const greetBytes = () => fixture('greet')

const RUSSIAN_LINE = 'Съешь же ещё этих мягких французских булок, да выпей чаю'
const GREETING = (name: string) => `Hello, ${name}! This is Rust compiled to WebAssembly.`

const quietHost = (locale?: Locale): BackendHost => ({ write: () => {}, locale })

const runContext = (locale?: Locale) => {
  const chunks: string[] = []
  const controller = new AbortController()
  const context: RunContext = {
    write: (text) => chunks.push(text),
    signal: controller.signal,
    columns: 80,
    rows: 24,
    locale,
  }
  return { chunks, controller, context }
}

const leb = (input: number): number[] => {
  const out: number[] = []
  let value = input
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    out.push(byte)
  } while (value !== 0)
  return out
}
const name = (text: string) => {
  const bytes = [...new TextEncoder().encode(text)]
  return [...leb(bytes.length), ...bytes]
}
const section = (id: number, items: number[][]) => {
  const body = [...leb(items.length), ...items.flat()]
  return [id, ...leb(body.length), ...body]
}

const wasmCommand = (options: { imports: Array<[string, string]>; body: number[]; start?: boolean }) =>
  new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [
      [0x60, 0x00, 0x01, 0x7f],
      [0x60, 0x01, 0x7f, 0x00],
      [0x60, 0x00, 0x00],
    ]),
    ...section(2, [
      ...options.imports.map(([module, field]) => [...name(module), ...name(field), 0x00, 0x00]),
      [...name('wasi_snapshot_preview1'), ...name('proc_exit'), 0x00, 0x01],
    ]),
    ...section(3, [[0x02]]),
    ...section(5, [[0x00, 0x01]]),
    ...section(7, [
      ...(options.start === false ? [] : [[...name('_start'), 0x00, ...leb(options.imports.length + 1)]]),
      [...name('memory'), 0x02, 0x00],
    ]),
    ...section(10, [[...leb(options.body.length + 2), 0x00, ...options.body, 0x0b]]),
  ])

type Call = (name: string, ...args: Array<number | bigint>) => number

interface Exercise {
  call: Call
  view: () => DataView
  bytes: () => Uint8Array
}

const exercise = (
  body: (tools: Exercise) => void,
  options: { stdin?: string; argv?: string[]; env?: string[] } = {},
) => {
  const memory = new WebAssembly.Memory({ initial: 2 })
  const chunks: string[] = []
  const host = createWasiHost({
    argv: options.argv ?? ['demo'],
    env: options.env ?? [],
    stdin: new TextEncoder().encode(options.stdin ?? ''),
    write: (text) => chunks.push(text),
  })
  const wasi = host.imports.wasi_snapshot_preview1 as unknown as Record<
    string,
    (...args: Array<number | bigint>) => number
  >
  const tools: Exercise = {
    call: (field, ...args) => {
      const fn = wasi[field]
      if (!fn) throw new Error(`no import ${field}`)
      return fn(...args)
    },
    view: () => new DataView(memory.buffer),
    bytes: () => new Uint8Array(memory.buffer),
  }
  let failure: unknown
  host.run({
    exports: {
      memory,
      _start: () => {
        try {
          body(tools)
        } catch (error) {
          failure = error
          throw error
        }
      },
    },
  })
  if (failure !== undefined) throw failure
  return { output: chunks.join('') }
}

const setIovec = (tools: Exercise, at: number, pointer: number, length: number) => {
  tools.view().setUint32(at, pointer, true)
  tools.view().setUint32(at + 4, length, true)
}

const SELF_SHIM = [
  "const { parentPort } = require('node:worker_threads')",
  'const self = globalThis',
  'self.postMessage = (message) => parentPort.postMessage(message)',
  "parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }))",
  '',
].join('\n')

const liveWorkers = new Set<NodeWorker>()

const workerStats = () => {
  const stats = { created: 0, terminated: 0, sources: [] as string[], modules: [] as unknown[] }
  const createWorker = (source: string): WorkerLike => {
    const { Worker } = nodeModule<NodeWorkerThreads>('node:worker_threads')
    const worker = new Worker(SELF_SHIM + source, { eval: true })
    worker.unref()
    liveWorkers.add(worker)
    stats.created += 1
    stats.sources.push(source)
    const like: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (message) => {
        const sent = message as { type: string; module?: unknown }
        if (sent.type === 'module') stats.modules.push(sent.module)
        worker.postMessage(message)
      },
      terminate: () => {
        stats.terminated += 1
        liveWorkers.delete(worker)
        void worker.terminate()
      },
    }
    worker.on('message', (data) => like.onmessage?.({ data }))
    worker.on('error', (error) => like.onerror?.(error))
    return like
  }
  return { stats, createWorker }
}

const scriptedWorker = (answer: (message: { type: string; id?: number }, worker: WorkerLike) => void) => {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => queueMicrotask(() => answer(message as { type: string; id?: number }, worker)),
    terminate: () => {},
  }
  return worker
}

const waitFor = async (condition: () => boolean, timeoutMs = 3000) => {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const guessTranscript = (limit: number) =>
  `Guess the number!\n${'Please input your guess.\n'.repeat(Math.ceil(limit / 25))}`.slice(0, limit)

const deferred = <T>() => {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: (value: T) => settle(value) }
}

const wasmResponse = () => new Response(greetBytes(), { headers: { 'content-type': 'application/wasm' } })

interface PostedMessage {
  type: string
  id?: number
  argv?: string[]
}

interface FakeBrowserWorker {
  readonly url: string | URL
  readonly options?: WorkerOptions
  readonly runs: PostedMessage[]
  readonly terminated: boolean
  reply(data: unknown): void
  fail(): void
}

type WorkerStart = 'ready' | 'error' | 'throw' | 'silent'

const stubBrowserWorker = (start: WorkerStart | WorkerStart[]) => {
  const spawned: FakeBrowserWorker[] = []
  const blobs: Blob[] = []
  let serial = 0
  let attempts = 0
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (blob instanceof Blob) blobs.push(blob)
    serial += 1
    return `blob:docs/wasi-${serial}`
  })
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  class FakeWorker implements FakeBrowserWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    readonly runs: PostedMessage[] = []
    terminated = false
    private readonly plan: WorkerStart

    constructor(
      readonly url: string | URL,
      readonly options?: WorkerOptions,
    ) {
      this.plan = Array.isArray(start) ? (start[attempts] ?? 'ready') : start
      attempts += 1
      if (this.plan === 'throw') throw new DOMException('worker blocked', 'SecurityError')
      spawned.push(this)
    }

    postMessage(message: PostedMessage) {
      queueMicrotask(() => {
        if (message.type === 'module' && this.plan === 'error') this.onerror?.(new Event('error'))
        else if (message.type === 'module' && this.plan === 'ready') this.reply({ type: 'ready' })
        else if (message.type !== 'module') this.runs.push(message)
      })
    }

    reply(data: unknown) {
      this.onmessage?.({ data })
    }

    fail() {
      this.onerror?.(new Event('error'))
    }

    terminate() {
      this.terminated = true
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  return { spawned, blobs, createObjectURL, revokeObjectURL }
}

const CSP_REFUSAL = {
  en: 'blocked by the page Content-Security-Policy (needs worker-src blob:)',
  ru: 'заблокировано политикой Content-Security-Policy страницы (нужно worker-src blob:)',
}

const traceCompilation = (compiler: 'compile' | 'compileStreaming') => {
  const compile = vi.spyOn(WebAssembly, compiler)
  const instantiate = vi.spyOn(WebAssembly, 'instantiate')
  return async () => {
    const modules: unknown[] = await Promise.all(compile.mock.results.map((result) => result.value))
    return {
      compiled: modules.length,
      instantiatedFrom: instantiate.mock.calls.map(([source]) => modules.indexOf(source)),
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const worker of liveWorkers) void worker.terminate()
  liveWorkers.clear()
})

describe('splitCommandLine', () => {
  it('splits on blanks and honours quotes', () => {
    expect(splitCommandLine('  greet  world ')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet "two words" \'and more\'')).toEqual(['greet', 'two words', 'and more'])
    expect(splitCommandLine('greet\tTAB')).toEqual(['greet', 'TAB'])
    expect(splitCommandLine('   ')).toEqual([])
  })

  it('keeps empty quoted arguments', () => {
    expect(splitCommandLine('greet ""')).toEqual(['greet', ''])
    expect(splitCommandLine("greet '' x")).toEqual(['greet', '', 'x'])
    expect(splitCommandLine('greet a""b')).toEqual(['greet', 'ab'])
  })

  it('applies backslash escapes like a POSIX shell', () => {
    expect(splitCommandLine('greet a\\ b')).toEqual(['greet', 'a b'])
    expect(splitCommandLine('greet \\"quoted\\"')).toEqual(['greet', '"quoted"'])
    expect(splitCommandLine('greet "say \\"hi\\""')).toEqual(['greet', 'say "hi"'])
    expect(splitCommandLine('greet "a\\\\b" "a\\x"')).toEqual(['greet', 'a\\b', 'a\\x'])
    expect(splitCommandLine("greet 'a\\b'")).toEqual(['greet', 'a\\b'])
    expect(splitCommandLine('greet a\\|b \\$HOME')).toEqual(['greet', 'a|b', '$HOME'])
  })

  it('keeps shell characters that are quoted or not an expansion', () => {
    expect(splitCommandLine('greet "a | b" \'cost $5\' "x;y" "a > b"')).toEqual([
      'greet',
      'a | b',
      'cost $5',
      'x;y',
      'a > b',
    ])
    expect(splitCommandLine('greet $ 5$')).toEqual(['greet', '$', '5$'])
    expect(splitCommandLine('greet "(a)" \'b)\' \\(c\\)')).toEqual(['greet', '(a)', 'b)', '(c)'])
  })

  it('drops a comment that starts an unquoted word, up to the end of its line', () => {
    expect(splitCommandLine('greet world # the reader')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet world #')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet world #"unclosed | $x')).toEqual(['greet', 'world'])
    expect(splitCommandLine('# only a note')).toEqual([])
    expect(splitCommandLine('# a note\ngreet world')).toEqual(['greet', 'world'])
  })

  it('keeps a # that is quoted, escaped or inside a word', () => {
    const words = splitCommandLine('greet a#b c# "#x" \'#y\' \\#z ""#w')
    expect(words).toEqual(['greet', 'a#b', 'c#', '#x', '#y', '#z', '#w'])
  })

  it('joins lines ended by an unquoted or double-quoted backslash, and reads pasted CRLF as blanks [review: continuation]', () => {
    expect(splitCommandLine('greet wor\\\nld')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet \\\nworld')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet "two \\\nwords"')).toEqual(['greet', 'two words'])
    expect(splitCommandLine("greet 'kept \\\nas typed'")).toEqual(['greet', 'kept \\\nas typed'])
    expect(splitCommandLine('greet wor\\\r\nld')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet\r\n')).toEqual(['greet'])
    expect(splitCommandLine('greet\rworld\r')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet "a\nb"')).toEqual(['greet', 'a\nb'])
  })

  it('treats an unquoted newline between two commands as unsupported shell syntax [review: newline]', () => {
    const problemOf = (line: string) => {
      try {
        return splitCommandLine(line)
      } catch (error) {
        return error instanceof CommandLineError ? [error.problem, error.token] : error
      }
    }
    expect(problemOf('greet a\ngreet b')).toEqual(['syntax', '\n'])
    expect(problemOf('greet a\r\ngreet b')).toEqual(['syntax', '\n'])
    expect(problemOf("greet a\n'b'")).toEqual(['syntax', '\n'])
    expect(problemOf('greet a\n\\b')).toEqual(['syntax', '\n'])
    expect(problemOf('greet a\n\n# only a note\n')).toEqual(['greet', 'a'])
    expect(problemOf('\n# a note\ngreet a # trailing\n')).toEqual(['greet', 'a'])
  })

  it('throws a CommandLineError that names the problem and the offending character', () => {
    const problemOf = (line: string) => {
      try {
        splitCommandLine(line)
        return null
      } catch (error) {
        return error instanceof CommandLineError ? [error.problem, error.token] : error
      }
    }
    expect(problemOf("greet 'open")).toEqual(['quote', "'"])
    expect(problemOf('greet a | b')).toEqual(['syntax', '|'])
    expect(problemOf('greet "$HOME"')).toEqual(['syntax', '$'])
    expect(problemOf('greet (a)')).toEqual(['syntax', '('])
    expect(problemOf('greet a)')).toEqual(['syntax', ')'])
    expect(problemOf('greet ok')).toBe(null)
  })
})

describe('isCompleteCommandLine', () => {
  it.each<[string, boolean]>([
    ['greet world', true],
    ['', true],
    ['greet "open', false],
    ["greet 'open", false],
    ['greet a\\', false],
    ['greet a\\\\', true],
    ['greet "a\\', false],
    ["greet 'a\\'", true],
    ["greet a # it's open \\", true],
    ['greet wor\\\nld', true],
    ['greet "two\nlines"', true],
    ["greet a | 'b", true],
  ])('%j is complete: %s [review: continuation]', (line, expected) => {
    expect(isCompleteCommandLine(line)).toBe(expected)
  })
})

describe('createWasiBackend command line', () => {
  const greet = async (locale?: Locale) => {
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: false })
    await backend.init(quietHost(locale))
    return backend
  }

  it('asks for another line after a trailing backslash or an open quote, with a sh-like prompt [review: continuation]', async () => {
    const backend = await greet()
    expect(backend.continuationPrompt).toBe('> ')
    expect([backend.isComplete?.('greet a\\'), backend.isComplete?.('greet "a'), backend.isComplete?.('greet a')]).toEqual([
      false,
      false,
      true,
    ])
    await expect(backend.run('greet wor\\\nld')).resolves.toEqual({ output: GREETING('world'), exitCode: 0 })
    await expect(backend.run('greet "Ann\nBob"')).resolves.toEqual({ output: GREETING('Ann\nBob'), exitCode: 0 })
  })

  it('runs nothing when a newline separates two commands [review: newline]', async () => {
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: async () => {
        throw new Error('must not run')
      },
    })
    await backend.init(quietHost('ru'))
    await expect(backend.run('greet a\ngreet b')).resolves.toEqual({
      output: 'конвейеры, перенаправления и переменные в этом терминале не поддерживаются',
      exitCode: 2,
    })
  })

  it('rejects an unmatched quote with exit 2', async () => {
    const backend = await greet()
    await expect(backend.run('greet "unterminated')).resolves.toEqual({
      output: 'syntax error: unmatched "',
      exitCode: 2,
    })
    await expect(backend.run("greet 'open")).resolves.toEqual({ output: "syntax error: unmatched '", exitCode: 2 })
  })

  it('refuses shell syntax instead of passing it to the program', async () => {
    const backend = await greet()
    const refused = { output: 'pipes, redirects and variables are not supported in this terminal', exitCode: 2 }
    for (const line of [
      'greet world | wc -c',
      'greet Ann && greet Bob',
      'greet a || greet b',
      'greet a; greet b',
      'greet > out.txt',
      'greet < in.txt',
      'greet a & b',
      'greet $USER',
      'greet ${USER}',
      'greet "$USER"',
      'greet `whoami`',
      'greet $(whoami)',
      'greet (world)',
      'greet world)',
    ]) {
      await expect(backend.run(line), line).resolves.toEqual(refused)
    }
  })

  it('passes quoted shell characters through as plain arguments', async () => {
    const backend = await greet()
    await expect(backend.run("greet 'Ann && Bob'")).resolves.toEqual({ output: GREETING('Ann && Bob'), exitCode: 0 })
    await expect(backend.run('greet "(Ann)"')).resolves.toEqual({ output: GREETING('(Ann)'), exitCode: 0 })
    await expect(backend.run('greet "#1 fan"')).resolves.toEqual({ output: GREETING('#1 fan'), exitCode: 0 })
  })

  it('drops a trailing comment like a shell does', async () => {
    const backend = await greet()
    await expect(backend.run('greet world # the reader')).resolves.toEqual({ output: GREETING('world'), exitCode: 0 })
    await expect(backend.run('# greet nobody')).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('names the program it runs when another command is typed, in the run locale', async () => {
    const backend = await greet()
    await expect(backend.run('ls -la')).resolves.toEqual({
      output: 'ls: command not found (this terminal runs greet)',
      exitCode: 127,
    })
    await expect(backend.run('ls -la', runContext('ru').context)).resolves.toEqual({
      output: 'ls: команда не найдена (этот терминал запускает greet)',
      exitCode: 127,
    })
  })

  it('falls back to the host locale for its messages', async () => {
    const backend = await greet('ru')
    await expect(backend.run('greet | wc')).resolves.toEqual({
      output: 'конвейеры, перенаправления и переменные в этом терминале не поддерживаются',
      exitCode: 2,
    })
    await expect(backend.run('greet "x')).resolves.toEqual({
      output: 'синтаксическая ошибка: непарная кавычка "',
      exitCode: 2,
    })
  })
})

describe('createWasiBackend with real wasm32-wasip1 binaries', () => {
  const load = async (program: string, extra: { stdin?: string } = {}) => {
    const backend = createWasiBackend({ bytes: fixture(program), program, worker: false, ...extra })
    await backend.init(quietHost())
    return backend
  }

  it('runs greet.wasm with its arguments', async () => {
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: false })
    await backend.init(quietHost())
    await expect(backend.run('greet world')).resolves.toEqual({ output: GREETING('world'), exitCode: 0 })
    await expect(backend.run('greet')).resolves.toEqual({ output: 'greet: missing a name', exitCode: 2 })
  })

  it('links a binary that imports WASI calls the host does not implement, so its own error path runs', async () => {
    const backend = await load('fs')
    await expect(backend.run('fs')).resolves.toEqual({
      output: 'fs: cannot read notes.txt: No such file or directory (os error 44)',
      exitCode: 2,
    })
  })

  it('answers ENOSYS for every unknown preview1 and unstable function', async () => {
    const probe = wasmCommand({
      imports: [
        ['wasi_snapshot_preview1', 'fd_readdir'],
        ['wasi_unstable', 'sock_accept'],
        ['wasi_snapshot_preview1', 'call_from_the_future'],
      ],
      body: [0x10, 0x02, 0x10, 0x03],
    })
    const backend = createWasiBackend({ bytes: probe, program: 'probe', worker: false })
    await backend.init(quietHost())
    await expect(backend.run('probe')).resolves.toEqual({ output: '', exitCode: 52 })
  })

  it('sleeps through poll_oneoff clock subscriptions', async () => {
    const backend = await load('sleep')
    const started = performance.now()
    await expect(backend.run('sleep')).resolves.toEqual({ output: 'before sleep\nafter sleep: ok', exitCode: 0 })
    expect(performance.now() - started).toBeGreaterThanOrEqual(10)
  })

  it('feeds non-ASCII stdin byte by byte', async () => {
    const backend = await load('stdin', { stdin: `${RUSSIAN_LINE}\n` })
    await expect(backend.run('stdin')).resolves.toEqual({ output: `read 103 bytes: ${RUSSIAN_LINE}`, exitCode: 0 })
    await expect(backend.run('stdin')).resolves.toEqual({ output: `read 103 bytes: ${RUSSIAN_LINE}`, exitCode: 0 })
  })

  it('keeps stdout and stderr in the order they were written', async () => {
    const backend = await load('interleave')
    await expect(backend.run('interleave')).resolves.toEqual({
      output: 'step 1\nwarning: low disk\nstep 2\nprogress 50%\nerror: crashed',
      exitCode: 1,
    })
  })

  it('streams output through the run context and returns only what was not streamed', async () => {
    const backend = await load('interleave')
    const { chunks, context } = runContext()
    await expect(backend.run('interleave', context)).resolves.toEqual({ output: '', exitCode: 1 })
    expect(chunks.join('')).toBe('step 1\nwarning: low disk\nstep 2\nprogress 50%\nerror: crashed\n')
  })

  it('hands the configured environment to the program', async () => {
    const backend = createWasiBackend({
      bytes: fixture('env'),
      program: 'env',
      env: { LANG: 'ru', GREETING: 'привет, мир' },
      worker: false,
    })
    await backend.init(quietHost())
    await expect(backend.run('env')).resolves.toEqual({ output: 'LANG=ru\nGREETING=привет, мир', exitCode: 0 })
  })

  it('prints the trap of a program that hits unreachable on a line of its own', async () => {
    const backend = await load('trap')
    await expect(backend.run('trap')).resolves.toEqual({ output: 'partial\nRuntimeError: unreachable', exitCode: 1 })
  })
})

describe('createWasiBackend module loading', () => {
  it('compiles the module once and instantiates it for every run', async () => {
    const compilation = traceCompilation('compile')
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: false })
    await backend.init(quietHost())
    for (const who of ['a', 'b', 'c']) {
      await expect(backend.run(`greet ${who}`)).resolves.toEqual({ output: GREETING(who), exitCode: 0 })
    }
    await expect(compilation()).resolves.toEqual({ compiled: 1, instantiatedFrom: [0, 0, 0] })
  })

  it('keeps a bytes module across dispose and init', async () => {
    const compilation = traceCompilation('compile')
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: false })
    await backend.init(quietHost())
    await expect(backend.run('greet world')).resolves.toEqual({ output: GREETING('world'), exitCode: 0 })
    backend.dispose()
    await backend.init(quietHost())
    await expect(backend.run('greet again')).resolves.toEqual({ output: GREETING('again'), exitCode: 0 })
    await expect(compilation()).resolves.toEqual({ compiled: 1, instantiatedFrom: [0, 0] })
  })

  it('downloads and compiles a url module once across runs, dispose and init', async () => {
    const fetchMock = vi.fn(
      async () => new Response(greetBytes(), { headers: { 'content-type': 'application/wasm' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const compilation = traceCompilation('compileStreaming')
    const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', worker: false })
    await backend.init(quietHost())
    await expect(backend.run('greet world')).resolves.toEqual({ output: GREETING('world'), exitCode: 0 })
    backend.dispose()
    await backend.init(quietHost())
    await expect(backend.run('greet again')).resolves.toEqual({ output: GREETING('again'), exitCode: 0 })
    await expect(compilation()).resolves.toEqual({ compiled: 1, instantiatedFrom: [0, 0] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('compiles a url module served without the wasm content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(greetBytes(), { headers: { 'content-type': 'application/octet-stream' } })),
    )
    const written: string[] = []
    const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', worker: false, banner: 'greet ready' })
    await backend.init({ write: (text) => written.push(text) })
    expect(written).toEqual(['greet ready\n'])
    await expect(backend.run('greet octet')).resolves.toEqual({ output: GREETING('octet'), exitCode: 0 })
  })

  it('fails at init when the server sends an html page instead of the module', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } })),
    )
    const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', worker: false })
    await expect(backend.init(quietHost())).rejects.toThrowError(/^not a WebAssembly module: \/greet\.wasm$/)
    await expect(backend.init(quietHost('ru'))).rejects.toThrowError(/^это не модуль WebAssembly: \/greet\.wasm$/)
  })

  it('fails at init when the module cannot be downloaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', worker: false })
    await expect(backend.init(quietHost())).rejects.toThrowError(/^cannot download \/greet\.wasm: HTTP 404$/)
  })

  it('names a network failure at init in the host locale and keeps the browser error as the cause', async () => {
    const failure = new TypeError('Failed to fetch')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw failure
      }),
    )
    const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', worker: false })
    const error = await backend.init(quietHost()).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty('message', 'cannot download /greet.wasm: network error')
    expect(error).toHaveProperty('cause', failure)
    await expect(backend.init(quietHost('ru'))).rejects.toThrowError(/^не удалось скачать \/greet\.wasm: ошибка сети$/)
  })

  it('says at init, in the host locale, that it needs url, bytes or instantiate', async () => {
    const backend = createWasiBackend({ program: 'greet', worker: false })
    await expect(backend.init(quietHost())).rejects.toThrowError(/^createWasiBackend needs url, bytes or instantiate$/)
    await expect(backend.init(quietHost('ru'))).rejects.toThrowError(
      /^для createWasiBackend нужен url, bytes или instantiate$/,
    )
  })

  it('starts nothing when dispose() lands while init() is still downloading', async () => {
    const download = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => download.promise))
    const { stats, createWorker } = workerStats()
    const written: string[] = []
    const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', createWorker, banner: 'greet ready' })
    const init = backend.init({ write: (text) => written.push(text) })
    backend.dispose()
    download.resolve(wasmResponse())
    await expect(init).resolves.toBeUndefined()
    expect(stats.created).toBe(0)
    expect(written).toEqual([])
    await expect(backend.run('greet late')).resolves.toEqual({ output: 'environment is not ready yet', exitCode: 1 })
  })

  it('works after the StrictMode order init, dispose, init while the module is still downloading', async () => {
    const download = deferred<Response>()
    const fetchMock = vi.fn(() => download.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { stats, createWorker } = workerStats()
    const first: string[] = []
    const second: string[] = []
    const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', createWorker, banner: 'greet ready' })
    const firstInit = backend.init({ write: (text) => first.push(text) })
    backend.dispose()
    const secondInit = backend.init({ write: (text) => second.push(text) })
    download.resolve(wasmResponse())
    await expect(Promise.all([firstInit, secondInit])).resolves.toEqual([undefined, undefined])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stats.created).toBe(1)
    expect(first).toEqual([])
    expect(second).toEqual(['greet ready\n'])
    const { chunks, context } = runContext()
    await expect(backend.run('greet strict', context)).resolves.toEqual({ output: '', exitCode: 0 })
    expect(chunks.join('')).toBe(`${GREETING('strict')}\n`)
    backend.dispose()
    expect(stats.terminated).toBe(1)
  })

  it('fails at init when the bytes are not WebAssembly', async () => {
    const backend = createWasiBackend({
      bytes: new TextEncoder().encode('<!doctype html>'),
      program: 'greet',
      worker: false,
    })
    await expect(backend.init(quietHost())).rejects.toThrowError(/^not a WebAssembly module: options\.bytes$/)
  })

  it('names a download that breaks after the headers as a network error, with or without the wasm type [review: init errors]', async () => {
    const failure = new TypeError('terminated')
    for (const type of ['application/wasm', 'application/octet-stream']) {
      const broken = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0x00, 0x61, 0x73, 0x6d]))
              controller.error(failure)
            },
          }),
          { headers: { 'content-type': type } },
        )
      vi.stubGlobal('fetch', vi.fn(async () => broken()))
      const backend = createWasiBackend({ url: '/greet.wasm', program: 'greet', worker: false })
      const error = await backend.init(quietHost()).catch((reason: unknown) => reason)
      expect(error, type).toBeInstanceOf(Error)
      expect(error, type).toHaveProperty('message', 'cannot download /greet.wasm: network error')
      expect(error, type).toHaveProperty('cause', failure)
      await expect(backend.init(quietHost('ru'))).rejects.toThrowError(/^не удалось скачать \/greet\.wasm: ошибка сети$/)
    }
  })

  it('names a module that does not compile behind a valid header, keeping the engine detail [review: init errors]', async () => {
    const corrupt = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x0a, 0xff])
    const backend = createWasiBackend({ bytes: corrupt, program: 'greet', worker: false })
    const error = await backend.init(quietHost()).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/^cannot compile options\.bytes: \S/)
    expect((error as Error).cause).toBeInstanceOf(WebAssembly.CompileError)
    await expect(backend.init(quietHost('ru'))).rejects.toThrowError(/^не удалось скомпилировать options\.bytes: \S/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(corrupt, { headers: { 'content-type': 'application/wasm' } })))
    const streamed = createWasiBackend({ url: '/broken.wasm', program: 'greet', worker: false })
    await expect(streamed.init(quietHost())).rejects.toThrowError(/^cannot compile \/broken\.wasm: \S/)
  })

  it('fails at init when the module is not a WASI command', async () => {
    const reactor = wasmCommand({ imports: [], body: [], start: false })
    const backend = createWasiBackend({ bytes: reactor, program: 'lib', worker: false })
    await expect(backend.init(quietHost())).rejects.toThrowError(
      /^not a WASI command: the module has no _start function or no memory export$/,
    )
  })
})

describe('wasi preview1 host', () => {
  it('decodes UTF-8 split across fd_write calls and iovecs', () => {
    const written: number[] = []
    const { output } = exercise((tools) => {
      tools.bytes().set([0xd0, 0xbf], 1024)
      setIovec(tools, 16, 1024, 1)
      setIovec(tools, 24, 1025, 1)
      expect(tools.call('fd_write', 1, 16, 1, 8)).toBe(0)
      written.push(tools.view().getUint32(8, true))
      expect(tools.call('fd_write', 1, 24, 1, 8)).toBe(0)
      written.push(tools.view().getUint32(8, true))
      expect(tools.call('fd_write', 1, 16, 2, 8)).toBe(0)
      written.push(tools.view().getUint32(8, true))
    })
    expect(output).toBe('пп')
    expect(written).toEqual([1, 1, 2])
  })

  it('reports argv and environ counts and their total size in bytes', () => {
    const sizes: number[] = []
    exercise(
      (tools) => {
        expect(tools.call('args_sizes_get', 0, 4)).toBe(0)
        sizes.push(tools.view().getUint32(0, true), tools.view().getUint32(4, true))
        expect(tools.call('environ_sizes_get', 0, 4)).toBe(0)
        sizes.push(tools.view().getUint32(0, true), tools.view().getUint32(4, true))
      },
      { argv: ['greet', 'мир'], env: ['LANG=ru', 'GREETING=привет'] },
    )
    expect(sizes).toEqual([2, 13, 2, 30])
  })

  it('reads multi-byte stdin by byte offset', () => {
    const received: number[] = []
    exercise(
      (tools) => {
        setIovec(tools, 16, 1024, 4)
        for (;;) {
          expect(tools.call('fd_read', 0, 16, 1, 8)).toBe(0)
          const count = tools.view().getUint32(8, true)
          if (count === 0) break
          received.push(...tools.bytes().subarray(1024, 1024 + count))
        }
      },
      { stdin: 'привет' },
    )
    expect(new TextDecoder().decode(new Uint8Array(received))).toBe('привет')
  })

  it('answers EBADF for descriptors that do not exist', () => {
    const codes: number[] = []
    exercise((tools) => {
      codes.push(
        tools.call('fd_fdstat_get', 99, 256),
        tools.call('fd_fdstat_get', 3, 256),
        tools.call('fd_read', 5, 16, 1, 8),
        tools.call('fd_write', 7, 16, 1, 8),
        tools.call('fd_seek', 9, 0n, 1, 300),
        tools.call('fd_close', 42),
        tools.call('fd_filestat_get', 9, 256),
        tools.call('fd_fdstat_set_flags', 9, 0),
      )
    })
    expect(codes).toEqual([8, 8, 8, 8, 8, 8, 8, 8])
  })

  it('describes stdio as character devices with read and write rights', () => {
    const stats: Array<{ code: number; filetype: number; base: bigint; inheriting: bigint }> = []
    exercise((tools) => {
      for (const fd of [0, 1, 2]) {
        const code = tools.call('fd_fdstat_get', fd, 256)
        const view = tools.view()
        stats.push({
          code,
          filetype: view.getUint8(256),
          base: view.getBigUint64(264, true),
          inheriting: view.getBigUint64(272, true),
        })
      }
    })
    expect(stats).toEqual([
      { code: 0, filetype: 2, base: 136314890n, inheriting: 0n },
      { code: 0, filetype: 2, base: 136314952n, inheriting: 0n },
      { code: 0, filetype: 2, base: 136314952n, inheriting: 0n },
    ])
  })

  it('reports stdio file stats, flag changes and the clock resolution', () => {
    const results: Array<number | bigint> = []
    exercise((tools) => {
      tools.bytes().fill(0xff, 256, 320)
      results.push(tools.call('fd_filestat_get', 1, 256), tools.view().getUint8(272))
      results.push(tools.view().getBigUint64(288, true))
      results.push(tools.call('fd_fdstat_set_flags', 1, 4))
      results.push(tools.call('clock_res_get', 1, 400), tools.view().getBigUint64(400, true))
      results.push(tools.call('clock_res_get', 0, 400), tools.view().getBigUint64(400, true))
      results.push(tools.call('clock_res_get', 7, 400))
    })
    expect(results).toEqual([0, 2, 0n, 0, 0, 1000n, 0, 1000000n, 28])
  })

  it('answers ESPIPE when a program seeks on stdio', () => {
    const codes: number[] = []
    exercise((tools) => {
      codes.push(tools.call('fd_seek', 1, 0n, 1, 300), tools.call('fd_tell', 0, 300))
    })
    expect(codes).toEqual([70, 70])
  })

  it('reads a monotonic clock with sub-millisecond precision', () => {
    const readings: bigint[] = []
    let spins = 0
    exercise((tools) => {
      for (let index = 0; index < 20; index += 1) {
        expect(tools.call('clock_time_get', 1, 1000n, 512)).toBe(0)
        readings.push(tools.view().getBigUint64(512, true))
        const until = performance.now() + 0.05
        while (performance.now() < until) spins += 1
      }
    })
    expect(spins).toBeGreaterThan(0)
    expect(readings.every((value, index) => index === 0 || value >= (readings[index - 1] ?? 0n))).toBe(true)
    expect(readings.some((value) => value % 1_000_000n !== 0n)).toBe(true)
  })

  it('reads the realtime clock as wall-clock nanoseconds', () => {
    let before = 0n
    let realtime = 0n
    let after = 0n
    exercise((tools) => {
      before = BigInt(Date.now()) * 1_000_000n
      expect(tools.call('clock_time_get', 0, 1000n, 512)).toBe(0)
      realtime = tools.view().getBigUint64(512, true)
      after = BigInt(Date.now()) * 1_000_000n
    })
    expect(realtime).toBeGreaterThanOrEqual(before)
    expect(realtime).toBeLessThanOrEqual(after)
  })

  it('fills random_get requests larger than 64 KiB', () => {
    const codes: number[] = []
    let tail = new Uint8Array()
    exercise((tools) => {
      codes.push(tools.call('random_get', 1024, 70_000))
      tail = tools.bytes().slice(1024 + 65_536, 1024 + 70_000)
    })
    expect(codes).toEqual([0])
    expect(tail.some((byte) => byte !== 0)).toBe(true)
  })

  const napFor = (tools: Exercise, nanoseconds: bigint) => {
    const view = tools.view()
    view.setBigUint64(1024, 7n, true)
    view.setUint8(1032, 0)
    view.setUint32(1040, 1, true)
    view.setBigUint64(1048, nanoseconds, true)
    view.setBigUint64(1056, 0n, true)
    view.setUint16(1064, 0, true)
    const code = tools.call('poll_oneoff', 1024, 2048, 1, 8)
    const after = tools.view()
    const event = [after.getBigUint64(2048, true), after.getUint16(2056, true), after.getUint8(2058)]
    return [code, after.getUint32(8, true), ...event]
  }

  it('sleeps for a relative clock subscription with Atomics.wait and reports the event', () => {
    const wait = vi.spyOn(Atomics, 'wait')
    let results: Array<number | bigint> = []
    const started = performance.now()
    exercise((tools) => {
      results = napFor(tools, 5_000_000n)
    })
    expect(performance.now() - started).toBeGreaterThanOrEqual(5)
    expect(results).toEqual([0, 1, 7n, 0, 0])
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('sleeps by spinning when the page offers no SharedArrayBuffer', () => {
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const wait = vi.spyOn(Atomics, 'wait')
    let results: Array<number | bigint> = []
    const started = performance.now()
    exercise((tools) => {
      results = napFor(tools, 5_000_000n)
    })
    expect(performance.now() - started).toBeGreaterThanOrEqual(5)
    expect(results).toEqual([0, 1, 7n, 0, 0])
    expect(wait).not.toHaveBeenCalled()
  })

  it('raises the hang-up flag on a stdin subscription once stdin is exhausted', () => {
    const results: Array<number | bigint> = []
    exercise(
      (tools) => {
        const poll = () => {
          const view = tools.view()
          view.setBigUint64(1024, 5n, true)
          view.setUint8(1032, 1)
          view.setUint32(1040, 0, true)
          results.push(tools.call('poll_oneoff', 1024, 2048, 1, 8))
          const after = tools.view()
          results.push(after.getUint32(8, true), after.getBigUint64(2048, true), after.getUint16(2056, true))
          results.push(after.getUint8(2058), after.getBigUint64(2064, true), after.getUint16(2072, true))
        }
        poll()
        setIovec(tools, 16, 512, 16)
        expect(tools.call('fd_read', 0, 16, 1, 8)).toBe(0)
        poll()
      },
      { stdin: 'ab' },
    )
    expect(results).toEqual([0, 1, 5n, 0, 1, 2n, 0, 0, 1, 5n, 0, 1, 0n, 1])
  })

  it('leaves wasi_unstable calls with a different struct layout unsupported', () => {
    const host = createWasiHost({ argv: ['demo'], env: [], stdin: new Uint8Array(), write: () => {} })
    const unstable = host.imports.wasi_unstable as Record<string, unknown>
    const preview1 = host.imports.wasi_snapshot_preview1 as Record<string, unknown>
    const call = (table: Record<string, unknown>, field: string) => (table[field] as () => number)()
    expect([call(unstable, 'fd_filestat_get'), call(unstable, 'poll_oneoff')]).toEqual([52, 52])
    expect(unstable.fd_write).toBe(preview1.fd_write)
    expect(Object.getPrototypeOf(unstable)).toBe(null)
  })

  it('reports every clock subscription whose absolute deadline has passed', () => {
    const results: Array<number | bigint> = []
    exercise((tools) => {
      const view = tools.view()
      const expired = (at: number, userdata: bigint, pastNs: bigint) => {
        view.setBigUint64(at, userdata, true)
        view.setUint8(at + 8, 0)
        view.setUint32(at + 16, 0, true)
        view.setBigUint64(at + 24, BigInt(Date.now()) * 1_000_000n - pastNs, true)
        view.setUint16(at + 40, 1, true)
      }
      expired(1024, 11n, 5_000_000n)
      expired(1072, 12n, 3_000_000n)
      results.push(tools.call('poll_oneoff', 1024, 2048, 2, 8))
      const after = tools.view()
      results.push(after.getUint32(8, true), after.getBigUint64(2048, true), after.getBigUint64(2080, true))
    })
    expect(results).toEqual([0, 2, 11n, 12n])
  })

  it('reports ready stdio subscriptions without sleeping', () => {
    const results: Array<number | bigint> = []
    const started = performance.now()
    exercise(
      (tools) => {
        const view = tools.view()
        const subscribe = (at: number, userdata: bigint, tag: number, fd: number) => {
          view.setBigUint64(at, userdata, true)
          view.setUint8(at + 8, tag)
          view.setUint32(at + 16, fd, true)
        }
        view.setBigUint64(1024, 1n, true)
        view.setUint8(1032, 0)
        view.setUint32(1040, 1, true)
        view.setBigUint64(1048, 1_000_000_000n, true)
        subscribe(1072, 2n, 1, 0)
        subscribe(1120, 3n, 2, 1)
        subscribe(1168, 4n, 1, 9)
        results.push(tools.call('poll_oneoff', 1024, 2048, 4, 8))
        const after = tools.view()
        results.push(after.getUint32(8, true))
        for (let index = 0; index < 3; index += 1) {
          const at = 2048 + index * 32
          results.push(after.getBigUint64(at, true), after.getUint16(at + 8, true), after.getUint8(at + 10))
          results.push(after.getBigUint64(at + 16, true))
        }
        results.push(tools.call('poll_oneoff', 1024, 2048, 0, 8))
      },
      { stdin: 'abc' },
    )
    expect(performance.now() - started).toBeLessThan(500)
    expect(results).toEqual([0, 3, 2n, 0, 1, 3n, 3n, 0, 2, 0n, 4n, 8, 1, 0n, 28])
  })
})

describe('createWasiBackend with instantiate()', () => {
  const memoryOf = () => new WebAssembly.Memory({ initial: 1 })
  type Preview1 = Record<string, (...args: Array<number | bigint>) => number>

  const writeIovec = (memory: WebAssembly.Memory, text: string, textPtr: number, iovPtr: number) => {
    const bytes = new TextEncoder().encode(text)
    new Uint8Array(memory.buffer).set(bytes, textPtr)
    const view = new DataView(memory.buffer)
    view.setUint32(iovPtr, textPtr, true)
    view.setUint32(iovPtr + 4, bytes.length, true)
  }

  const fakeModule = (behaviour: (wasi: Preview1, memory: WebAssembly.Memory) => void) => {
    const memory = memoryOf()
    return async (imports: WebAssembly.Imports): Promise<WasiInstance> => {
      const wasi = imports.wasi_snapshot_preview1 as unknown as Preview1
      return { exports: { memory, _start: () => behaviour(wasi, memory) } }
    }
  }

  const call = (wasi: Preview1, field: string, ...args: number[]) => wasi[field]?.(...args)

  it('runs the module and returns what it printed', async () => {
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: fakeModule((wasi, memory) => {
        writeIovec(memory, 'hello from rust\n', 1024, 16)
        call(wasi, 'fd_write', 1, 16, 1, 8)
      }),
    })
    await backend.init(quietHost())
    await expect(backend.run('greet world')).resolves.toEqual({ output: 'hello from rust', exitCode: 0 })
  })

  it('passes command line arguments into argv after the program name', async () => {
    let seen: string[] = []
    const backend = createWasiBackend({
      program: 'greet',
      args: ['--preset'],
      instantiate: fakeModule((wasi, memory) => {
        call(wasi, 'args_sizes_get', 0, 4)
        call(wasi, 'args_get', 64, 256)
        const view = new DataView(memory.buffer)
        const bytes = new Uint8Array(memory.buffer)
        seen = Array.from({ length: view.getUint32(0, true) }, (_, index) => {
          const pointer = view.getUint32(64 + index * 4, true)
          return new TextDecoder().decode(bytes.subarray(pointer, bytes.indexOf(0, pointer)))
        })
      }),
    })
    await backend.init(quietHost())
    await backend.run('greet --loud "" \'two words\' a\\ b')
    expect(seen).toEqual(['greet', '--preset', '--loud', '', 'two words', 'a b'])
  })

  it('exposes environment variables as KEY=VALUE pairs', async () => {
    let seen = ''
    const backend = createWasiBackend({
      program: 'env',
      env: { LANG: 'ru' },
      instantiate: fakeModule((wasi, memory) => {
        call(wasi, 'environ_sizes_get', 0, 4)
        call(wasi, 'environ_get', 64, 128)
        const bytes = new Uint8Array(memory.buffer)
        const pointer = new DataView(memory.buffer).getUint32(64, true)
        seen = `${new DataView(memory.buffer).getUint32(0, true)} ${new TextDecoder().decode(bytes.subarray(pointer, bytes.indexOf(0, pointer)))}`
      }),
    })
    await backend.init(quietHost())
    await backend.run('env')
    expect(seen).toBe('1 LANG=ru')
  })

  it('propagates a non-zero exit code so explain can use it', async () => {
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: fakeModule((wasi, memory) => {
        writeIovec(memory, 'missing argument\n', 1024, 16)
        call(wasi, 'fd_write', 2, 16, 1, 8)
        call(wasi, 'proc_exit', 2)
      }),
    })
    await backend.init(quietHost())
    await expect(backend.run('greet')).resolves.toEqual({ output: 'missing argument', exitCode: 2 })
  })

  it('reports exit statuses the way a shell does, modulo 256', async () => {
    const backend = createWasiBackend({
      program: 'status',
      instantiate: fakeModule((wasi) => {
        call(wasi, 'proc_exit', -1)
      }),
    })
    await backend.init(quietHost())
    await expect(backend.run('status')).resolves.toEqual({ output: '', exitCode: 255 })
  })

  it('reports a trapping module on a line of its own instead of throwing', async () => {
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: fakeModule((wasi, memory) => {
        writeIovec(memory, 'partial', 1024, 16)
        call(wasi, 'fd_write', 1, 16, 1, 8)
        throw new WebAssembly.RuntimeError('unreachable executed')
      }),
    })
    await backend.init(quietHost())
    await expect(backend.run('greet')).resolves.toEqual({
      output: 'partial\nRuntimeError: unreachable executed',
      exitCode: 1,
    })
    const { chunks, context } = runContext()
    await expect(backend.run('greet', context)).resolves.toEqual({
      output: '\nRuntimeError: unreachable executed',
      exitCode: 1,
    })
    expect(chunks).toEqual(['partial'])
  })

  it('gives each run a fresh instance so state does not leak between commands', async () => {
    let instances = 0
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: async (imports) => {
        instances += 1
        const memory = memoryOf()
        const wasi = imports.wasi_snapshot_preview1 as unknown as Preview1
        return {
          exports: {
            memory,
            _start: () => {
              writeIovec(memory, `run ${instances}\n`, 1024, 16)
              call(wasi, 'fd_write', 1, 16, 1, 8)
            },
          },
        }
      },
    })
    await backend.init(quietHost())
    expect((await backend.run('greet')).output).toBe('run 1')
    expect((await backend.run('greet')).output).toBe('run 2')
  })

  it('answers notReady before init', async () => {
    const backend = createWasiBackend({ program: 'greet', instantiate: fakeModule(() => {}) })
    await expect(backend.run('greet')).resolves.toEqual({ output: 'environment is not ready yet', exitCode: 1 })
  })

  it('gives an inline run 30 s by default, checked on every system call', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const codes: Array<number | undefined> = []
    const backend = createWasiBackend({
      program: 'spin',
      instantiate: fakeModule((wasi) => {
        now = 31_000
        codes.push(call(wasi, 'sched_yield'))
        now = 31_001
        codes.push(call(wasi, 'sched_yield'))
      }),
    })
    await backend.init(quietHost())
    await expect(backend.run('spin')).resolves.toEqual({ output: 'timed out after 30 s', exitCode: 124 })
    expect(codes).toEqual([0])
  })

  it('caps output at 1 MiB characters by default and keeps the program running', async () => {
    const written: number[] = []
    const backend = createWasiBackend({
      program: 'flood',
      instantiate: fakeModule((wasi, memory) => {
        writeIovec(memory, 'x'.repeat(32_768), 1024, 16)
        for (let index = 0; index < 33; index += 1) {
          call(wasi, 'fd_write', 1, 16, 1, 8)
          written.push(new DataView(memory.buffer).getUint32(8, true))
        }
      }),
    })
    await backend.init(quietHost())
    const result = await backend.run('flood')
    expect(result.exitCode).toBe(0)
    expect(result.output.length).toBe(1_048_576 + 63)
    expect(result.output).toBe(
      `${'x'.repeat(1_048_576)}\noutput limit reached (1048576 characters), the rest is dropped`,
    )
    expect(written).toEqual(Array.from({ length: 33 }, () => 32_768))
  })

  it('never splits a surrogate pair where the output limit cuts', async () => {
    const backend = createWasiBackend({
      program: 'emoji',
      outputLimit: 3,
      instantiate: fakeModule((wasi, memory) => {
        writeIovec(memory, 'ab😀c', 1024, 16)
        call(wasi, 'fd_write', 1, 16, 1, 8)
      }),
    })
    await backend.init(quietHost())
    await expect(backend.run('emoji')).resolves.toEqual({
      output: 'ab\noutput limit reached (3 characters), the rest is dropped',
      exitCode: 0,
    })
  })

  it('cuts a sleep short at the inline deadline', async () => {
    const backend = createWasiBackend({
      program: 'nap',
      timeoutMs: 50,
      instantiate: fakeModule((wasi, memory) => {
        const view = new DataView(memory.buffer)
        view.setBigUint64(1024, 1n, true)
        view.setUint8(1032, 0)
        view.setUint32(1040, 1, true)
        view.setBigUint64(1048, 10_000_000_000n, true)
        view.setUint16(1064, 0, true)
        call(wasi, 'poll_oneoff', 1024, 2048, 1, 8)
        writeIovec(memory, 'woke up\n', 4096, 16)
        call(wasi, 'fd_write', 1, 16, 1, 8)
      }),
    })
    await backend.init(quietHost())
    const started = performance.now()
    await expect(backend.run('nap')).resolves.toEqual({ output: 'timed out after 0.05 s', exitCode: 124 })
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(5000)
  }, 30_000)
})

describe('createWasiBackend in a worker', () => {
  it('runs the program in a worker and streams its output', async () => {
    const compile = vi.spyOn(WebAssembly, 'compile')
    const { stats, createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', createWorker })
    await backend.init(quietHost())
    for (const who of ['world', 'again']) {
      const { chunks, context } = runContext()
      await expect(backend.run(`greet ${who}`, context)).resolves.toEqual({ output: '', exitCode: 0 })
      expect(chunks.join('')).toBe(`${GREETING(who)}\n`)
    }
    expect(stats.created).toBe(1)
    expect(stats.sources).toEqual([WASI_WORKER_SOURCE])
    expect(compile).toHaveBeenCalledTimes(1)
    expect(stats.modules).toHaveLength(1)
    expect(stats.modules[0]).toBe(await compile.mock.results[0]?.value)
    backend.dispose()
    expect(stats.terminated).toBe(1)
  })

  it('links, sleeps and reads stdin inside the worker', async () => {
    const { createWorker } = workerStats()
    const run = async (program: string, extra: { stdin?: string } = {}) => {
      const backend = createWasiBackend({ bytes: fixture(program), program, createWorker, ...extra })
      await backend.init(quietHost())
      const { chunks, context } = runContext()
      const result = await backend.run(program, context)
      backend.dispose()
      return { ...result, streamed: chunks.join('') }
    }
    await expect(run('fs')).resolves.toEqual({
      output: '',
      exitCode: 2,
      streamed: 'fs: cannot read notes.txt: No such file or directory (os error 44)\n',
    })
    await expect(run('sleep')).resolves.toEqual({
      output: '',
      exitCode: 0,
      streamed: 'before sleep\nafter sleep: ok\n',
    })
    await expect(run('stdin', { stdin: `${RUSSIAN_LINE}\n` })).resolves.toEqual({
      output: '',
      exitCode: 0,
      streamed: `read 103 bytes: ${RUSSIAN_LINE}\n`,
    })
  })

  it('hands the configured environment to the program inside the worker', async () => {
    const { createWorker } = workerStats()
    const backend = createWasiBackend({
      bytes: fixture('env'),
      program: 'env',
      env: { LANG: 'ru', GREETING: 'привет, мир' },
      createWorker,
    })
    await backend.init(quietHost())
    const { chunks, context } = runContext()
    await expect(backend.run('env', context)).resolves.toEqual({ output: '', exitCode: 0 })
    expect(chunks.join('')).toBe('LANG=ru\nGREETING=привет, мир\n')
    backend.dispose()
  })

  it('reports the trap of a program inside the worker on a line of its own', async () => {
    const { createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: fixture('trap'), program: 'trap', createWorker })
    await backend.init(quietHost())
    const { chunks, context } = runContext()
    await expect(backend.run('trap', context)).resolves.toEqual({ output: '\nRuntimeError: unreachable', exitCode: 1 })
    expect(chunks).toEqual(['partial'])
    await expect(backend.run('trap')).resolves.toEqual({ output: 'partial\nRuntimeError: unreachable', exitCode: 1 })
    backend.dispose()
  })

  it('detaches its abort listener when a run finishes', async () => {
    const { stats, createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', createWorker })
    await backend.init(quietHost())
    const { controller, context } = runContext()
    await expect(backend.run('greet done', context)).resolves.toEqual({ output: '', exitCode: 0 })
    controller.abort()
    expect(stats).toMatchObject({ created: 1, terminated: 0 })
    await expect(backend.run('greet next')).resolves.toEqual({ output: GREETING('next'), exitCode: 0 })
    expect(stats).toMatchObject({ created: 1, terminated: 0 })
    backend.dispose()
  })

  it('never starts a run that was still queued when dispose() came', async () => {
    const { stats, createWorker } = workerStats()
    const backend = createWasiBackend({
      bytes: fixture('guess'),
      program: 'guess',
      createWorker,
      timeoutMs: 2000,
      outputLimit: 200,
    })
    await backend.init(quietHost())
    const first = runContext()
    const queued = runContext()
    const running = backend.run('guess', first.context)
    const waiting = backend.run('guess', queued.context)
    await waitFor(() => first.chunks.length > 0)
    backend.dispose()
    await expect(running).resolves.toEqual({ output: '', exitCode: 130 })
    await expect(waiting).resolves.toEqual({ output: '', exitCode: 130 })
    await backend.init(quietHost())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(queued.chunks).toEqual([])
    expect(stats).toMatchObject({ created: 2, terminated: 1 })
    backend.dispose()
  })

  it('stops a run after 30 s by default and tells the worker the 1 MiB output limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const posted: unknown[] = []
    const backend = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () =>
        scriptedWorker((message, worker) => {
          posted.push(message)
          if (message.type === 'module') worker.onmessage?.({ data: { type: 'ready' } })
        }),
    })
    await backend.init(quietHost())
    let result: unknown
    const pending = backend.run('greet slow').then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(result).toEqual({ output: 'timed out after 30 s', exitCode: 124 })
    expect(posted[1]).toEqual({
      type: 'run',
      id: 1,
      argv: ['greet', 'slow'],
      env: [],
      stdin: new Uint8Array(),
      outputLimit: 1_048_576,
    })
    backend.dispose()
  })

  it('stops a looping program on Ctrl+C and runs the next command at once', async () => {
    const { stats, createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: fixture('loop'), program: 'loop', createWorker })
    await backend.init(quietHost())
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const { chunks, controller, context } = runContext()
      let settled = false
      const pending = backend.run('loop', context).finally(() => {
        settled = true
      })
      await waitFor(() => chunks.join('') === 'looping\n')
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(true)
      await expect(pending).resolves.toEqual({ output: '', exitCode: 130 })
    }
    expect(stats).toMatchObject({ created: 3, terminated: 2 })
    backend.dispose()
  })

  it('ends a looping program by timeout without blocking the event loop', async () => {
    const { createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: fixture('loop'), program: 'loop', createWorker, timeoutMs: 500 })
    await backend.init(quietHost())
    let ticks = 0
    const interval = setInterval(() => {
      ticks += 1
    }, 20)
    const { chunks, context } = runContext()
    const result = await backend.run('loop', context)
    clearInterval(interval)
    expect(result).toEqual({ output: 'timed out after 0.5 s', exitCode: 124 })
    expect(chunks.join('')).toBe('looping\n')
    expect(ticks).toBeGreaterThan(5)
    backend.dispose()
  })

  it('ends the guessing game that loops on EOF by timeout and caps its output', async () => {
    const { createWorker } = workerStats()
    const backend = createWasiBackend({
      bytes: fixture('guess'),
      program: 'guess',
      createWorker,
      timeoutMs: 500,
      outputLimit: 1000,
    })
    await backend.init(quietHost())
    const { chunks, context } = runContext()
    await expect(backend.run('guess', context)).resolves.toEqual({
      output: 'timed out after 0.5 s',
      exitCode: 124,
    })
    expect(chunks.join('')).toBe(
      `${guessTranscript(1000)}\noutput limit reached (1000 characters), the rest is dropped\n`,
    )
    backend.dispose()
  })

  it('treats a zero or infinite timeout as no timeout', async () => {
    const { createWorker } = workerStats()
    for (const timeoutMs of [0, Number.POSITIVE_INFINITY]) {
      const backend = createWasiBackend({ bytes: fixture('loop'), program: 'loop', createWorker, timeoutMs })
      await backend.init(quietHost())
      const { controller, context } = runContext()
      const pending = backend.run('loop', context)
      await new Promise((resolve) => setTimeout(resolve, 150))
      controller.abort()
      await expect(pending).resolves.toEqual({ output: '', exitCode: 130 })
      backend.dispose()
    }
  })

  it('runs commands one after another', async () => {
    const { createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: fixture('loop'), program: 'loop', createWorker })
    await backend.init(quietHost())
    const first = runContext()
    const second = runContext()
    const firstRun = backend.run('loop', first.context)
    const secondRun = backend.run('loop', second.context)
    await waitFor(() => first.chunks.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.chunks).toEqual([])
    first.controller.abort()
    await expect(firstRun).resolves.toEqual({ output: '', exitCode: 130 })
    await waitFor(() => second.chunks.join('') === 'looping\n')
    second.controller.abort()
    await expect(secondRun).resolves.toEqual({ output: '', exitCode: 130 })
    backend.dispose()
  })

  it('settles a running program on dispose and works again after init', async () => {
    const { stats, createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: fixture('loop'), program: 'loop', createWorker })
    await backend.init(quietHost())
    const first = runContext()
    const pending = backend.run('loop', first.context)
    await waitFor(() => first.chunks.length > 0)
    backend.dispose()
    await expect(pending).resolves.toEqual({ output: '', exitCode: 130 })
    await expect(backend.run('loop')).resolves.toEqual({ output: 'environment is not ready yet', exitCode: 1 })
    await backend.init(quietHost())
    const second = runContext()
    const again = backend.run('loop', second.context)
    await waitFor(() => second.chunks.join('') === 'looping\n')
    second.controller.abort()
    await expect(again).resolves.toEqual({ output: '', exitCode: 130 })
    backend.dispose()
    expect(stats).toMatchObject({ created: 3, terminated: 3 })
  })

  it('does not spawn a second worker when init runs twice', async () => {
    const { stats, createWorker } = workerStats()
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', createWorker })
    await backend.init(quietHost())
    await backend.init(quietHost())
    await expect(backend.run('greet twice')).resolves.toEqual({ output: GREETING('twice'), exitCode: 0 })
    expect(stats.created).toBe(1)
    backend.dispose()
  })

  it('fails runs instead of running on the page when a custom worker cannot start, and tries it once [security L6]', async () => {
    let attempts = 0
    const written: string[] = []
    const host: BackendHost = { write: (text) => written.push(text) }
    const blocked = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () => {
        attempts += 1
        return scriptedWorker((_message, worker) => worker.onerror?.({ message: 'blocked by CSP' }))
      },
    })
    await blocked.init(host)
    const refused = { output: 'the WebAssembly worker could not start: blocked by CSP', exitCode: 1 }
    await expect(blocked.run('greet csp')).resolves.toEqual(refused)
    await expect(blocked.run('greet again')).resolves.toEqual(refused)
    expect(attempts).toBe(1)

    const throwing = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () => {
        attempts += 1
        throw new Error('SecurityError')
      },
    })
    await expect(throwing.init(host)).rejects.toThrowError(new Error('the WebAssembly worker could not start: Error: SecurityError'))
    await expect(throwing.run('greet sync')).resolves.toEqual({
      output: 'the WebAssembly worker could not start: Error: SecurityError',
      exitCode: 1,
    })
    expect(attempts).toBe(2)
    expect(written).toEqual([])
  })

  it('reports a worker crash and gives the next run a fresh worker', async () => {
    let created = 0
    const backend = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () => {
        created += 1
        const crashes = created === 1
        return scriptedWorker((message, worker) => {
          if (message.type === 'module') worker.onmessage?.({ data: { type: 'ready' } })
          else if (crashes) worker.onerror?.({ message: 'Out of memory' })
          else {
            worker.onmessage?.({ data: { type: 'output', id: message.id, text: 'fresh worker\n' } })
            worker.onmessage?.({ data: { type: 'exit', id: message.id, code: 0 } })
          }
        })
      },
    })
    await backend.init(quietHost())
    await expect(backend.run('greet')).resolves.toEqual({ output: 'Out of memory', exitCode: 1 })
    await expect(backend.run('greet')).resolves.toEqual({ output: 'fresh worker', exitCode: 0 })
    expect(created).toBe(2)
    backend.dispose()
  })
})

describe('createWasiBackend default browser worker', () => {
  it('starts a classic worker from one blob URL, reuses the URL on respawn and revokes it on dispose', async () => {
    const { spawned, blobs, createObjectURL, revokeObjectURL } = stubBrowserWorker('ready')
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet' })
    await backend.init(quietHost())
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(blobs.map((blob) => blob.type)).toEqual(['text/javascript'])
    await expect(blobs[0]?.text()).resolves.toBe(WASI_WORKER_SOURCE)
    expect(spawned.map((worker) => [worker.url, worker.options])).toEqual([['blob:docs/wasi-1', undefined]])

    const first = runContext()
    const finished = backend.run('greet world', first.context)
    await waitFor(() => spawned[0]?.runs.length === 1)
    const run = spawned[0]?.runs[0]
    expect(run).toMatchObject({ type: 'run', argv: ['greet', 'world'] })
    spawned[0]?.reply({ type: 'output', id: run?.id, text: 'from the worker\n' })
    spawned[0]?.reply({ type: 'exit', id: run?.id, code: 0 })
    await expect(finished).resolves.toEqual({ output: '', exitCode: 0 })
    expect(first.chunks).toEqual(['from the worker\n'])

    const second = runContext()
    const aborted = backend.run('greet again', second.context)
    await waitFor(() => spawned[0]?.runs.length === 2)
    second.controller.abort()
    await expect(aborted).resolves.toEqual({ output: '', exitCode: 130 })
    expect(spawned.map((worker) => [worker.url, worker.terminated])).toEqual([
      ['blob:docs/wasi-1', true],
      ['blob:docs/wasi-1', false],
    ])
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    backend.dispose()
    expect(spawned[1]?.terminated).toBe(true)
    expect(revokeObjectURL.mock.calls).toEqual([['blob:docs/wasi-1']])

    await backend.init(quietHost())
    expect(spawned.map((worker) => worker.url)).toEqual(['blob:docs/wasi-1', 'blob:docs/wasi-1', 'blob:docs/wasi-2'])
    backend.dispose()
    expect(revokeObjectURL.mock.calls).toEqual([['blob:docs/wasi-1'], ['blob:docs/wasi-2']])
  })

  it('takes a real Worker from createWorker without a cast', async () => {
    const { spawned, createObjectURL } = stubBrowserWorker('ready')
    const backend = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () => new Worker('/wasi-worker.js', { name: 'docsterm-wasi' }),
    })
    await backend.init(quietHost())
    expect(spawned.map((worker) => [worker.url, worker.options])).toEqual([
      ['/wasi-worker.js', { name: 'docsterm-wasi' }],
    ])
    expect(createObjectURL).not.toHaveBeenCalled()
    backend.dispose()
    expect(spawned[0]?.terminated).toBe(true)
  })

  it('fails every run in the host locale when the page blocks blob workers, instead of running on the page [security L6]', async () => {
    const { spawned } = stubBrowserWorker('error')
    const written: string[] = []
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet' })
    await backend.init({ write: (text) => written.push(text), locale: 'ru' })
    await expect(backend.run('greet csp')).resolves.toEqual({ output: CSP_REFUSAL.ru, exitCode: 1 })
    await expect(backend.run('greet again')).resolves.toEqual({ output: CSP_REFUSAL.ru, exitCode: 1 })
    expect(written).toEqual([])
    expect(spawned).toHaveLength(1)
    backend.dispose()
  })

  it('rejects init before the banner when the Worker constructor itself refuses [security L6]', async () => {
    stubBrowserWorker('throw')
    const written: string[] = []
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', banner: 'greet ready' })
    await expect(backend.init({ write: (text) => written.push(text) })).rejects.toThrowError(new Error(CSP_REFUSAL.en))
    expect(written).toEqual([])
    await expect(backend.run('greet inline')).resolves.toEqual({ output: CSP_REFUSAL.en, exitCode: 1 })
    backend.dispose()
  })

  it('respawns a worker that dies before ready once an earlier one was ready, without the CSP notice [review: proven]', async () => {
    const { spawned } = stubBrowserWorker(['ready', 'error', 'ready'])
    const written: string[] = []
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet' })
    await backend.init({ write: (text) => written.push(text) })
    const first = runContext()
    const aborted = backend.run('greet world', first.context)
    await waitFor(() => spawned[0]?.runs.length === 1)
    first.controller.abort()
    await expect(aborted).resolves.toEqual({ output: '', exitCode: 130 })
    await waitFor(() => spawned.length === 3)
    const second = runContext()
    const next = backend.run('greet again', second.context)
    await waitFor(() => spawned[2]?.runs.length === 1)
    const run = spawned[2]?.runs[0]
    spawned[2]?.reply({ type: 'output', id: run?.id, text: 'from the third worker\n' })
    spawned[2]?.reply({ type: 'exit', id: run?.id, code: 0 })
    await expect(next).resolves.toEqual({ output: '', exitCode: 0 })
    expect(second.chunks).toEqual(['from the third worker\n'])
    expect(spawned.map((worker) => worker.terminated)).toEqual([true, true, false])
    expect(written).toEqual([])
    backend.dispose()
  })

  it('fails a run whose worker died before ready, stops respawning after three in a row, and starts afresh for the next run [review: proven]', async () => {
    const { spawned } = stubBrowserWorker(['ready', 'silent', 'silent', 'silent', 'ready'])
    const written: string[] = []
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet' })
    await backend.init({ write: (text) => written.push(text), locale: 'ru' })
    const first = runContext()
    const aborted = backend.run('greet world', first.context)
    await waitFor(() => spawned[0]?.runs.length === 1)
    first.controller.abort()
    await expect(aborted).resolves.toEqual({ output: '', exitCode: 130 })
    const waiting = backend.run('greet waiting')
    await waitFor(() => spawned[1]?.runs.length === 1)
    spawned[1]?.fail()
    await expect(waiting).resolves.toEqual({ output: 'ошибка окружения', exitCode: 1 })
    spawned[2]?.fail()
    spawned[3]?.fail()
    expect(spawned).toHaveLength(4)
    const next = backend.run('greet next')
    await waitFor(() => spawned[4]?.runs.length === 1)
    const run = spawned[4]?.runs[0]
    spawned[4]?.reply({ type: 'output', id: run?.id, text: 'fresh\n' })
    spawned[4]?.reply({ type: 'exit', id: run?.id, code: 0 })
    await expect(next).resolves.toEqual({ output: 'fresh', exitCode: 0 })
    expect(written).toEqual([])
    backend.dispose()
  })

  it('fails runs after a worker that never says ready, giving it 10 s by default [review: ready deadline, security L6]', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { spawned } = stubBrowserWorker('silent')
    const written: string[] = []
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet' })
    await backend.init({ write: (text) => written.push(text) })
    let result: unknown
    const pending = backend.run('greet late').then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(result).toBeUndefined()
    expect(spawned[0]?.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    const stalled = { output: 'the WebAssembly worker did not start within 10 s', exitCode: 1 }
    expect(result).toEqual(stalled)
    expect(spawned[0]?.terminated).toBe(true)
    expect(written).toEqual([])
    await expect(backend.run('greet again')).resolves.toEqual(stalled)
    expect(spawned).toHaveLength(1)
    expect(written).toEqual([])
    backend.dispose()
  })

  it('applies initTimeoutMs to a custom worker, fails its runs in the host locale, and takes 0 as no deadline [review: ready deadline, security L6]', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const written: string[] = []
    const silent = () => scriptedWorker(() => {})
    const quick = createWasiBackend({ bytes: greetBytes(), program: 'greet', createWorker: silent, initTimeoutMs: 50 })
    await quick.init({ write: (text) => written.push(text), locale: 'ru' })
    const late = quick.run('greet late')
    await vi.advanceTimersByTimeAsync(50)
    await expect(late).resolves.toEqual({ output: 'WebAssembly-воркер не запустился за 0,05 с', exitCode: 1 })
    expect(written).toEqual([])
    quick.dispose()
    const patient = createWasiBackend({ bytes: greetBytes(), program: 'greet', createWorker: silent, initTimeoutMs: 0, timeoutMs: 0 })
    await patient.init(quietHost())
    let result: unknown
    void patient.run('greet never').then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(result).toBeUndefined()
    patient.dispose()
  })

  it('refuses to start, without a CSP notice, when worker: true is asked for where there is no Worker [review: no Worker, security L6]', async () => {
    vi.stubGlobal('Worker', undefined)
    const written: string[] = []
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: true, banner: 'greet ready' })
    const missing = 'WebAssembly programs need a Web Worker, and this environment has none'
    await expect(backend.init({ write: (text) => written.push(text) })).rejects.toThrowError(new Error(missing))
    await expect(backend.run('greet node')).resolves.toEqual({ output: missing, exitCode: 1 })
    expect(written).toEqual([])
    backend.dispose()
  })
})

describe('createWasiBackend lifecycle details', () => {
  it('prints the banner once, for the last init, when init runs twice without dispose [review: banner]', async () => {
    const first: string[] = []
    const second: string[] = []
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: false, banner: 'greet ready' })
    await Promise.all([
      backend.init({ write: (text) => first.push(text) }),
      backend.init({ write: (text) => second.push(text) }),
    ])
    expect(first).toEqual([])
    expect(second).toEqual(['greet ready\n'])
    await expect(backend.run('greet twice')).resolves.toEqual({ output: GREETING('twice'), exitCode: 0 })
  })

  it('prints a long timeout without digit grouping in either language [review: seconds]', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const backend = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      timeoutMs: 3_600_000,
      createWorker: () =>
        scriptedWorker((message, worker) => {
          if (message.type === 'module') worker.onmessage?.({ data: { type: 'ready' } })
        }),
    })
    await backend.init(quietHost())
    const en = backend.run('greet slow')
    await vi.advanceTimersByTimeAsync(3_600_000)
    await expect(en).resolves.toEqual({ output: 'timed out after 3600 s', exitCode: 124 })
    const ru = backend.run('greet slow', runContext('ru').context)
    await vi.advanceTimersByTimeAsync(3_600_000)
    await expect(ru).resolves.toEqual({ output: 'превышено время ожидания: 3600 с', exitCode: 124 })
    backend.dispose()
  })

  it('clamps a timeout beyond the 32-bit timer range instead of letting it fire at once', async () => {
    const backend = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      timeoutMs: 2 ** 40,
      createWorker: () =>
        scriptedWorker((message, worker) => {
          if (message.type === 'module') worker.onmessage?.({ data: { type: 'ready' } })
          if (message.type !== 'run') return
          setTimeout(() => worker.onmessage?.({ data: { type: 'exit', id: message.id, code: 0 } }), 30)
        }),
    })
    await backend.init(quietHost())
    await expect(backend.run('greet slow')).resolves.toEqual({ output: '', exitCode: 0 })
    backend.dispose()
  })
})

describe('createWasiBackend timeouts without a worker', () => {
  it('stops a program that keeps calling the host once the timeout passes', async () => {
    const backend = createWasiBackend({
      bytes: fixture('guess'),
      program: 'guess',
      worker: false,
      timeoutMs: 300,
      outputLimit: 1000,
    })
    await backend.init(quietHost())
    const { chunks, context } = runContext('ru')
    await expect(backend.run('guess', context)).resolves.toEqual({
      output: 'превышено время ожидания: 0,3 с',
      exitCode: 124,
    })
    expect(chunks.join('')).toBe(
      `${guessTranscript(1000)}\nдостигнут предел вывода (1000 символов), остальное отброшено\n`,
    )
  })
})

describe('createWasiBackend describe()', () => {
  it('describes the program, its usage, # comments and the missing shell features [review: describe]', async () => {
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', usage: 'greet <name>', worker: false })
    expect(backend.describe?.()).toBe(
      'This terminal runs one WebAssembly program, greet (wasm32-wasi). Type greet followed by its arguments. ' +
        'Quotes, backslash escapes and # comments work; pipes, redirects, variables, several commands and other programs do not. ' +
        'The program cannot read what you type: its standard input is fixed by the page.\nusage: greet <name>',
    )
    await backend.init(quietHost('ru'))
    expect(backend.describe?.()).toBe(
      'Этот терминал запускает одну программу WebAssembly - greet (wasm32-wasi). Введи greet и аргументы. ' +
        'Кавычки, экранирование обратной косой чертой и комментарии # работают; конвейеры, перенаправления, переменные, ' +
        'несколько команд и другие программы - нет. ' +
        'Набранный текст программа не читает: её стандартный ввод задаёт страница.\nиспользование: greet <name>',
    )
  })

  it('keeps the description within 600 characters in both languages, however long the usage is [review: describe limit]', async () => {
    const usage = Array.from({ length: 160 }, (_, index) => `greet <name${index}>`).join(' | ')
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', usage, worker: false })
    const en = backend.describe?.() ?? ''
    expect(en.length).toBe(600)
    expect(en.startsWith('This terminal runs one WebAssembly program, greet (wasm32-wasi).')).toBe(true)
    expect(en).toMatch(/\nusage: greet <name0> \| greet <name1> \|.*…$/)
    await backend.init(quietHost('ru'))
    const ru = backend.describe?.() ?? ''
    expect(ru.length).toBe(600)
    expect(ru).toMatch(/\nиспользование: greet <name0> \| .*…$/)
    const emoji = createWasiBackend({ bytes: greetBytes(), program: 'greet', usage: '😀'.repeat(400), worker: false })
    const cut = emoji.describe?.() ?? ''
    expect(cut.length).toBeLessThanOrEqual(600)
    expect(cut).toMatch(/😀…$/)
  })
})
