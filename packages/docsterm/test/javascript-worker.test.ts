import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createJavaScriptBackend,
  WORKER_SOURCE,
  type JavaScriptBackendOptions,
  type WorkerLike,
} from '../src/javascript/index.js'
import type { BackendHost, RunContext, SimpleBackend } from '../src/types.js'

const BROWSER_WORKER_GLOBALS = `(() => {
  const { parentPort } = process.getBuiltinModule('node:worker_threads')
  const NativeString = String
  const assign = Object.assign
  const listeners = { message: [], error: [], unhandledrejection: [] }
  globalThis.self = globalThis
  globalThis.addEventListener = (type, listener) => {
    if (listeners[type]) listeners[type].push(listener)
  }
  globalThis.postMessage = (message) => parentPort.postMessage(message)
  globalThis.importScripts = (...urls) => {
    globalThis.importedScripts = (globalThis.importedScripts || []).concat(urls.map((url) => NativeString(url)))
  }
  const dispatch = (type, event) => {
    listeners[type].forEach((listener) => listener(event))
    if (type === 'message' && typeof globalThis.onmessage === 'function') globalThis.onmessage(event)
    return event.defaultPrevented === true
  }
  globalThis.dispatchEvent = (event) => !dispatch(event.type, event)
  const cancellable = (fields) =>
    assign({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }, fields)
  parentPort.on('message', (data) => dispatch('message', { data }))
  process.on('uncaughtException', (error) => {
    if (!dispatch('error', cancellable({ error, message: 'Uncaught ' + String(error) }))) {
      parentPort.postMessage({ escapedError: 'Uncaught ' + String(error) })
    }
  })
  process.on('unhandledRejection', (reason) => {
    if (!dispatch('unhandledrejection', cancellable({ reason }))) {
      parentPort.postMessage({ escapedError: 'Uncaught (in promise) ' + String(reason) })
    }
  })
})()
`

const BLOB_LIKE_FETCH = `
globalThis.fetch = (input) => {
  const url = input instanceof Request ? input.url : new URL(String(input)).href
  return Promise.resolve(new Response(url, { status: 200 }))
}
`

const REJECTING_FETCH = `
globalThis.fetch = (input) => {
  try {
    return Promise.resolve(new Response(new URL(String(input)).href))
  } catch (error) {
    return Promise.reject(error)
  }
}
`

const NATIVE_LIKE_FETCH = `
{
  const NativePromise = Promise
  const NativeRequest = Request
  const NativeResponse = Response
  const NativeURL = URL
  globalThis.fetch = function fetch(input) {
    try {
      if (arguments.length === 0) throw new TypeError('fetch: 1 argument required, but only 0 present.')
      const href = input instanceof NativeRequest ? input.url : new NativeURL(\`\${input}\`).href
      return NativePromise.resolve(new NativeResponse(href))
    } catch (error) {
      return NativePromise.reject(error)
    }
  }
}
`

const XHR_RECORDER = `
globalThis.XMLHttpRequest = function XMLHttpRequest() {}
globalThis.XMLHttpRequest.prototype.open = function (method, url) {
  this.target = method + ' ' + url
}
`

const CSP_WITHOUT_UNSAFE_EVAL = `
globalThis.eval = () => {
  throw new EvalError('Evaluating a string as JavaScript violates the Content Security Policy')
}
`

const READ_ONLY_GLOBALS = `
for (const key of ['name', 'location']) {
  Object.defineProperty(globalThis, key, { get: () => 'worker ' + key, configurable: true, enumerable: true })
}
`

const CSP_BLOCKED = "blocked by the page Content-Security-Policy (needs worker-src blob:; script-src 'unsafe-eval')"
const RESTARTED = 'runtime restarted, variables were reset'
const NOT_CLONEABLE =
  'the global "helper" cannot be passed to the worker: only cloneable data is allowed (no functions or DOM objects)'

const isEscapedError = (data: unknown): data is { escapedError: string } =>
  typeof data === 'object' && data !== null && 'escapedError' in data

const errorEvent = (message: string, error?: unknown): ErrorEvent =>
  Object.assign(new Event('error', { cancelable: true }), { message, error }) as ErrorEvent

class ThreadWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  logs = 0
  private readonly thread: Worker

  constructor(source: string) {
    this.thread = new Worker(source, { eval: true })
    this.thread.on('message', (data: unknown) => {
      if (this.terminated) return
      if ((data as { type?: unknown } | null)?.type === 'log') this.logs += 1
      if (isEscapedError(data)) this.onerror?.(errorEvent(data.escapedError))
      else this.onmessage?.(new MessageEvent('message', { data }))
    })
    this.thread.on('error', (error: Error) => {
      if (!this.terminated) this.onerror?.(errorEvent(String(error), error))
    })
  }

  postMessage(message: unknown): void {
    if (!this.terminated) this.thread.postMessage(message)
  }

  terminate(): void {
    this.terminated = true
    void this.thread.terminate()
  }
}

const live: SimpleBackend[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const backend of live.splice(0)) backend.dispose()
})

interface Harness {
  backend: SimpleBackend
  workers: ThreadWorker[]
  host: string[]
}

interface HarnessOptions extends JavaScriptBackendOptions {
  prelude?: string
  source?: string
  locale?: BackendHost['locale']
}

function create(options: HarnessOptions = {}): Harness {
  const { prelude = '', source, locale: _locale, ...backendOptions } = options
  const workers: ThreadWorker[] = []
  const backend = createJavaScriptBackend({
    baseURL: 'https://docs.example/guide/intro',
    ...backendOptions,
    createWorker: () => {
      const worker = new ThreadWorker(source ?? `${BROWSER_WORKER_GLOBALS}${prelude}\n${WORKER_SOURCE}`)
      workers.push(worker)
      return worker
    },
  })
  live.push(backend)
  return { backend, workers, host: [] }
}

async function start(options: HarnessOptions = {}): Promise<Harness> {
  const harness = create(options)
  const host: BackendHost = { write: (text) => harness.host.push(text), locale: options.locale }
  await harness.backend.init(host)
  return harness
}

function session(columns = 80) {
  const writes: string[] = []
  const controller = new AbortController()
  const context: RunContext = {
    write: (text) => writes.push(text),
    signal: controller.signal,
    columns,
    rows: 24,
  }
  return { writes, controller, context }
}

const until = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('condition was not met in time')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const REPLY_LIMIT_MS = 5000
const REPLY_TEST_TIMEOUT_MS = 30_000

const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

const dispatched = () => until(() => vi.getTimerCount() > 0)

describe('console output', () => {
  it('prints console.log once, without the call count [js-1]', async () => {
    const { backend } = await start()
    const { writes, context } = session()
    expect(await backend.run("console.log('total:', 3)", context)).toEqual({ output: '', exitCode: 0 })
    expect(writes).toEqual(['total: 3\n'])
    expect(await backend.run("console.log('a'); console.log('b')")).toEqual({ output: 'a\nb', exitCode: 0 })
  })

  it('streams console lines while the command still runs [js-7]', async () => {
    const { backend } = await start()
    const { writes, context } = session()
    const running = backend.run(
      "console.log('step 1'); await new Promise((r) => setTimeout(r, 1000)); console.log('step 2'); 'done'",
      context,
    )
    await until(() => writes.length > 0)
    expect(writes).toEqual(['step 1\n'])
    expect(await running).toEqual({ output: "'done'", exitCode: 0 })
    expect(writes).toEqual(['step 1\n', 'step 2\n'])
  })

  it('sends output of timers that fire after the command to the host [js-7]', async () => {
    const { backend, host } = await start()
    expect(await backend.run("setTimeout(() => console.log('late'), 30); 'scheduled'")).toEqual({
      output: "'scheduled'",
      exitCode: 0,
    })
    await until(() => host.length > 0)
    expect(host).toEqual(['late\n'])
  })

  it('sends an exception thrown by a timer after the command to the host [js-7, js-12]', async () => {
    const { backend, host } = await start()
    expect(await backend.run("setTimeout(() => { throw new TypeError('later') }, 30); 'ok'")).toEqual({
      output: "'ok'",
      exitCode: 0,
    })
    await until(() => host.length > 0)
    expect(host).toEqual(['Uncaught TypeError: later\n'])
  })

  it('formats logged values for the width of the terminal', async () => {
    const { backend } = await start()
    const narrow = session(40)
    await backend.run("console.log({ alpha: 'xxxxxxxxxx', beta: 'yyyyyyyyyy' })", narrow.context)
    expect(narrow.writes).toEqual(["{\n  alpha: 'xxxxxxxxxx',\n  beta: 'yyyyyyyyyy'\n}\n"])
    const wide = session(120)
    await backend.run("console.log({ alpha: 'xxxxxxxxxx', beta: 'yyyyyyyyyy' })", wide.context)
    expect(wide.writes).toEqual(["{ alpha: 'xxxxxxxxxx', beta: 'yyyyyyyyyy' }\n"])
  })

  it('keeps output of microtasks the command queued in that command, as before [review: reply chain]', async () => {
    const { backend, host } = await start()
    const { writes, context } = session()
    const demo = "console.log('sync'); queueMicrotask(() => console.log('micro')); Promise.resolve().then(() => console.log('then')); 'done'"
    expect(await backend.run(demo, context)).toEqual({ output: "'done'", exitCode: 0 })
    expect(writes).toEqual(['sync\n', 'micro\n', 'then\n'])
    const failing = session()
    expect(await backend.run("queueMicrotask(() => console.log('queued')); throw new Error('sync')", failing.context)).toEqual({
      output: 'Error: sync',
      exitCode: 1,
    })
    expect(failing.writes).toEqual(['queued\n'])
    expect(host).toEqual([])
  })

  it('runs commands one at a time and gives each its own output [js-7]', async () => {
    const { backend } = await start()
    const first = session()
    const second = session()
    const slow = backend.run(
      "await new Promise((r) => setTimeout(r, 150)); console.log('first'); 1",
      first.context,
    )
    const fast = backend.run("console.log('second'); 2", second.context)
    expect(await Promise.all([slow, fast])).toEqual([
      { output: '1', exitCode: 0 },
      { output: '2', exitCode: 0 },
    ])
    expect(first.writes).toEqual(['first\n'])
    expect(second.writes).toEqual(['second\n'])
  })

  it('supports the console methods tutorials use [critic-4]', async () => {
    const { backend } = await start()
    const { writes, context } = session()
    const script = [
      "console.log('%s has %d items', 'cart', 3)",
      "console.info('%i|%f|%j|%c%%', 4.7, '1.5x', { a: 1 }, 'color: red')",
      'console.dir({ x: 1 })',
      "console.assert(1 === 2, 'math is broken')",
      "console.assert(true, 'never shown')",
      "console.count(); console.count('x'); console.count()",
      'console.countReset(); console.count()',
      "console.group('Group'); console.warn('inside'); console.groupEnd(); console.error('outside')",
      "console.table([{ a: 1, b: 'Y' }, { a: 'Z', b: 2 }])",
      "console.trace('here')",
      "console.debug(1, 'two', [3])",
    ].join('\n')
    expect(await backend.run(script, context)).toEqual({ output: '', exitCode: 0 })
    expect(writes.join('')).toBe(
      [
        'cart has 3 items',
        '4|1.5|{"a":1}|%',
        '{ x: 1 }',
        'Assertion failed: math is broken',
        'default: 1',
        'x: 1',
        'default: 2',
        'default: 1',
        'Group',
        '  inside',
        'outside',
        '┌─────────┬─────┬─────┐',
        '│ (index) │ a   │ b   │',
        '├─────────┼─────┼─────┤',
        '│ 0       │ 1   │ \'Y\' │',
        '│ 1       │ \'Z\' │ 2   │',
        '└─────────┴─────┴─────┘',
        'Trace: here',
        "1 two [ 3 ]",
        '',
      ].join('\n'),
    )
  })

  it('prints the message of a muted cross-origin script error instead of the null error [review: muted errors]', async () => {
    const { backend, host } = await start()
    const { writes, context } = session()
    const muted = "dispatchEvent({ type: 'error', message: 'Script error.', error: null, preventDefault() {} })"
    expect(await backend.run(`${muted}; 'after'`, context)).toEqual({ output: "'after'", exitCode: 0 })
    expect(writes).toEqual(['Script error.\n'])
    expect(await backend.run("setTimeout(() => { throw null }, 20); 'thrown later'")).toEqual({
      output: "'thrown later'",
      exitCode: 0,
    })
    await until(() => host.length > 0)
    expect(host).toEqual(['Uncaught null\n'])
  })

  it('prints string arguments unquoted when a logged value cannot be inspected [review: console fallback]', async () => {
    const { backend } = await start()
    const { writes, context } = session()
    const unreadable = "new Proxy({}, { ownKeys() { throw new Error('nope') } })"
    expect(await backend.run(`console.log('label:', ${unreadable}, 'tail', 3)`, context)).toEqual({ output: '', exitCode: 0 })
    expect(writes).toEqual(['label: [object Object] tail 3\n'])
  })

  it('measures console.time and reports unknown labels [critic-4]', async () => {
    const ticks = [0, 1.23456, 10, 10.5, 100, 1334.5678, 0, 61_250, 0, 3_723_004, 0, 2.5]
    const clock = `
{
  const ticks = ${JSON.stringify(ticks)}
  let next = 0
  Object.defineProperty(globalThis, 'performance', { value: { now: () => ticks[next++] }, configurable: true, writable: true })
}
`
    const { backend } = await start({ prelude: clock })
    const { writes, context } = session()
    const pairs = Array.from({ length: 5 }, () => "console.time('t'); console.timeEnd('t')").join('; ')
    await backend.run(`${pairs}; console.timeEnd('t'); console.time('u'); console.timeLog('u', 'x')`, context)
    expect(writes).toEqual([
      't: 1.235ms\n',
      't: 0.5ms\n',
      't: 1.235s\n',
      't: 1:01.250 (m:ss.mmm)\n',
      't: 1:02:03.004 (h:mm:ss.mmm)\n',
      "No such label 't' for console.timeEnd()\n",
      'u: 2.5ms x\n',
    ])
  })

  it('formats a failed console.assert like Node: only a string message is joined with a colon [review: assert]', async () => {
    const { backend } = await start()
    const { writes, context } = session()
    const script = [
      'console.assert(false, { a: 1 })',
      'console.assert(false)',
      "console.assert(0, '%s is %d', 'x', 5)",
      "console.assert(null, 42, 'more')",
      "console.assert(1, { never: 'shown' })",
    ].join('\n')
    expect(await backend.run(script, context)).toEqual({ output: '', exitCode: 0 })
    expect(writes).toEqual([
      'Assertion failed { a: 1 }\n',
      'Assertion failed\n',
      'Assertion failed: x is 5\n',
      'Assertion failed 42 more\n',
    ])
  })

  it('stops sending console output past the limit, so a print loop cannot flood the page [review: output cap]', async () => {
    const { backend, workers } = await start({ outputLimit: 10_000 })
    const note = '\noutput limit reached (10000 characters), the rest is dropped\n'
    const lines = [...Array.from({ length: 9 }, () => `${'x'.repeat(1000)}\n`), 'x'.repeat(991), note]
    for (let round = 1; round <= 2; round += 1) {
      const { writes, context } = session()
      expect(await backend.run("for (let i = 0; i < 100000; i++) console.log('x'.repeat(1000)); 'end'", context)).toEqual({
        output: "'end'",
        exitCode: 0,
      })
      expect(writes).toEqual(lines)
      expect(workers[0]?.logs).toBe(10 * round)
    }
    expect(workers).toHaveLength(1)
  })
})

describe('evaluation', () => {
  it('prints the value of a top-level await [js-2, js-await]', async () => {
    const { backend } = await start()
    expect(await backend.run('await Promise.resolve(42)')).toEqual({ output: '42', exitCode: 0 })
    expect(await backend.run('await Promise.resolve("awaited")')).toEqual({ output: "'awaited'", exitCode: 0 })
  })

  it('keeps declarations made together with await [js-2, js-await, docs-js-1]', async () => {
    const { backend } = await start()
    expect(await backend.run('const v = await Promise.resolve(5)')).toEqual({ output: '', exitCode: 0 })
    expect(await backend.run('v')).toEqual({ output: '5', exitCode: 0 })
    await backend.run('const client = await Promise.resolve({ ping: () => "pong" })')
    expect(await backend.run('client.ping()')).toEqual({ output: "'pong'", exitCode: 0 })
    await backend.run('var w = await Promise.resolve(7); let z = w * 2')
    expect(await backend.run('[w, z]')).toEqual({ output: '[ 7, 14 ]', exitCode: 0 })
  })

  it('keeps classes, functions and every declaration of a line [js-5]', async () => {
    const { backend } = await start()
    expect(await backend.run('class Foo { greet() { return "hi" } }')).toEqual({ output: '', exitCode: 0 })
    expect(await backend.run('typeof Foo')).toEqual({ output: "'function'", exitCode: 0 })
    expect(await backend.run('new Foo().greet()')).toEqual({ output: "'hi'", exitCode: 0 })
    expect(await backend.run('const a = 1; const b = 2')).toEqual({ output: '', exitCode: 0 })
    expect(await backend.run('[a, b]')).toEqual({ output: '[ 1, 2 ]', exitCode: 0 })
    await backend.run('function twice(n) { return n * 2 }')
    expect(await backend.run('twice(b)')).toEqual({ output: '4', exitCode: 0 })
  })

  it('leaves nested declarations and template literals alone [js-15]', async () => {
    const { backend } = await start()
    const loop = ['const fns = []', 'for (let i = 0; i < 3; i++) {', '  fns.push(() => i)', '}', 'fns.map((f) => f())']
    expect(await backend.run(loop.join('\n'))).toEqual({ output: '[ 0, 1, 2 ]', exitCode: 0 })
    await backend.run('const text = `first\nlet it be`')
    expect(await backend.run('text')).toEqual({ output: "'first\\nlet it be'", exitCode: 0 })
  })

  it('never runs a command twice when it throws a SyntaxError at runtime [js-6]', async () => {
    const { backend } = await start()
    expect(await backend.run('globalThis.counter = 0')).toEqual({ output: '0', exitCode: 0 })
    const failed = await backend.run("counter++; JSON.parse('{')")
    expect(failed.exitCode).toBe(1)
    expect(failed.output).toMatch(/^SyntaxError: /)
    expect(await backend.run('counter')).toEqual({ output: '1', exitCode: 0 })
    const { writes, context } = session()
    const regexp = await backend.run("console.log('once'); new RegExp('[')", context)
    expect(regexp.exitCode).toBe(1)
    expect(regexp.output).toMatch(/^SyntaxError: Invalid regular expression/)
    expect(writes).toEqual(['once\n'])
  })

  it("reports the parser's own error for code that does not parse [js-6]", async () => {
    const { backend } = await start()
    expect(await backend.run('1 +')).toEqual({ output: 'SyntaxError: Unexpected token (1:3)', exitCode: 1 })
  })

  it('reports a rejected await as the error of the command [js-2]', async () => {
    const { backend } = await start()
    expect(await backend.run("await Promise.reject(new RangeError('too far'))")).toEqual({
      output: 'RangeError: too far',
      exitCode: 1,
    })
    expect(await backend.run("await Promise.reject('plain')")).toEqual({ output: "Uncaught 'plain'", exitCode: 1 })
  })

  it('formats values like the Node.js REPL [js-4]', async () => {
    const { backend } = await start()
    const cases: Array<[string, string]> = [
      ['NaN', 'NaN'],
      ['-0', '-0'],
      ['[Infinity, -Infinity]', '[ Infinity, -Infinity ]'],
      ['new Map([[1, 2]])', 'Map(1) { 1 => 2 }'],
      ['new Set([1])', 'Set(1) { 1 }'],
      ['/ab+c/g', '/ab+c/g'],
      ["Symbol('x')", 'Symbol(x)'],
      ['[undefined]', '[ undefined ]'],
      ['new Date(0)', '1970-01-01T00:00:00.000Z'],
      ['new Uint8Array([1, 2])', 'Uint8Array(2) [ 1, 2 ]'],
      ['{a: 1}', '{ a: 1 }'],
      ['{a: 1, b: 2}', '{ a: 1, b: 2 }'],
      ['function f() {}; f', '[Function: f]'],
      ['(class Foo {})', '[class Foo]'],
      ['const c = {}; c.self = c; c', '<ref *1> { self: [Circular *1] }'],
    ]
    for (const [source, expected] of cases) {
      expect(await backend.run(source), source).toEqual({ output: expected, exitCode: 0 })
    }
    expect(await backend.run('throw { code: 1 }')).toEqual({ output: 'Uncaught { code: 1 }', exitCode: 1 })
    expect(await backend.run('notDefined()')).toEqual({
      output: 'ReferenceError: notDefined is not defined',
      exitCode: 1,
    })
  })

  it('always replies, even when a value cannot be formatted [js-11]', async () => {
    const { backend } = await start({ timeoutMs: 2000 })
    expect(await backend.run('var o = Object.create(null); o.self = o; o')).toEqual({
      output: '<ref *1> [Object: null prototype] { self: [Circular *1] }',
      exitCode: 0,
    })
    expect(
      await backend.run('new Proxy(Object.create(null), { ownKeys() { throw new Error("nope") } })'),
    ).toEqual({ output: '[object Object]', exitCode: 0 })
  })

  it('replies at once when the thrown value cannot be inspected, and keeps the runtime [js-11]', async () => {
    const { backend, workers } = await start({ timeoutMs: REPLY_LIMIT_MS })
    await backend.run('var kept = 1')
    expect(await backend.run('throw new Proxy({}, { get() { throw new Error("trap") } })')).toEqual({
      output: 'Uncaught {}',
      exitCode: 1,
    })
    expect(await backend.run('const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); throw proxy')).toEqual({
      output: 'Uncaught <Revoked Proxy>',
      exitCode: 1,
    })
    expect(await backend.run('kept')).toEqual({ output: '1', exitCode: 0 })
    expect(workers).toHaveLength(1)
  }, REPLY_TEST_TIMEOUT_MS)

  it('replies to every command when inspection or error detection throws, and keeps the queue going [js-11, review: reply chain]', async () => {
    const { backend, workers } = await start({ timeoutMs: REPLY_LIMIT_MS })
    await backend.run('var kept = 1; const { proxy: gone, revoke } = Proxy.revocable({}, {}); revoke()')
    await backend.run("const hostile = new Proxy({}, { ownKeys() { throw new Error('keys') }, get() { throw new Error('get') } })")
    const cases: Array<[string, string, number]> = [
      ['gone', '<Revoked Proxy>', 0],
      ['throw gone', 'Uncaught <Revoked Proxy>', 1],
      ['[gone, { inner: gone }]', '[ <Revoked Proxy>, { inner: <Revoked Proxy> } ]', 0],
      ['await Promise.reject(gone)', 'Uncaught <Revoked Proxy>', 1],
      ['await null; gone', "TypeError: Cannot perform 'get' on a proxy that has been revoked", 1],
      ['hostile', '[object Unknown]', 0],
      ['throw hostile', 'Uncaught [object Unknown]', 1],
      ['await Promise.reject(hostile)', 'Uncaught [object Unknown]', 1],
    ]
    for (const [source, output, exitCode] of cases) {
      expect(await backend.run(source), source).toEqual({ output, exitCode })
    }
    const { writes, context } = session()
    expect(await backend.run("console.log('seen:', gone); console.log(hostile)", context)).toEqual({ output: '', exitCode: 0 })
    expect(writes).toEqual(['seen: <Revoked Proxy>\n', '[object Unknown]\n'])
    expect(await backend.run('kept + 1')).toEqual({ output: '2', exitCode: 0 })
    expect(workers).toHaveLength(1)
  }, REPLY_TEST_TIMEOUT_MS)

  it('replies to values whose prototype chain never ends, and keeps the runtime [review: prototype walks]', async () => {
    const { backend, workers } = await start({ timeoutMs: REPLY_LIMIT_MS, prelude: BLOB_LIKE_FETCH })
    await backend.run('var kept = 1')
    await backend.run(
      'const cyclic = new Proxy({}, { getPrototypeOf: () => cyclic }); const fresh = () => new Proxy({}, { getPrototypeOf: () => fresh() })',
    )
    const bare = '[Object: null prototype] {}'
    const cases: Array<[string, string, number]> = [
      ['cyclic', bare, 0],
      ['fresh()', bare, 0],
      ['[cyclic, { inner: fresh() }]', `[ ${bare}, { inner: ${bare} } ]`, 0],
      ['throw cyclic', `Uncaught ${bare}`, 1],
      ['await Promise.reject(fresh())', `Uncaught ${bare}`, 1],
      ['await null; cyclic', bare, 0],
      ['Promise.resolve(fresh())', bare, 0],
      ['await fetch(cyclic).then((r) => r.text())', "'https://docs.example/guide/[object%20Object]'", 0],
    ]
    for (const [source, output, exitCode] of cases) {
      expect(await backend.run(source), source).toEqual({ output, exitCode })
    }
    const { writes, context } = session()
    const logging = "console.log(cyclic); console.log('%s and %o', cyclic, fresh()); console.assert(false, cyclic); console.dir(fresh())"
    expect(await backend.run(logging, context)).toEqual({ output: '', exitCode: 0 })
    expect(writes).toEqual([`${bare}\n`, `${bare} and ${bare}\n`, `Assertion failed ${bare}\n`, `${bare}\n`])
    expect(await backend.run('kept')).toEqual({ output: '1', exitCode: 0 })
    expect(workers).toHaveLength(1)
  }, REPLY_TEST_TIMEOUT_MS)

  it.each(['', 'await null; '])(
    'lets a top-level let, const or class win over a block function of the same name, as a script does, with the prefix %j [review: Annex B shadow]',
    async (prefix) => {
      const { backend } = await start()
      expect(await backend.run(`let shadow = 1; ${prefix}{ function shadow() {} } typeof shadow`)).toEqual({
        output: "'number'",
        exitCode: 0,
      })
      expect(await backend.run('shadow')).toEqual({ output: '1', exitCode: 0 })
      expect(await backend.run(`const fixed = 2; ${prefix}if (true) function fixed() {}; fixed`)).toEqual({ output: '2', exitCode: 0 })
      expect(
        await backend.run(`class Kept {}; ${prefix}switch (1) { case 1: function Kept() { return 'block' } }; String(Kept).slice(0, 5)`),
      ).toEqual({ output: "'class'", exitCode: 0 })
      expect(await backend.run('[shadow, fixed, String(Kept).slice(0, 5)]')).toEqual({ output: "[ 1, 2, 'class' ]", exitCode: 0 })
    },
  )

  it.each(['', 'await null; ', "'use strict'; "])(
    'lets a top-level function replace a read-only global such as name or location, with the prefix %j [review: accessor globals]',
    async (prefix) => {
      const { backend } = await start({ prelude: READ_ONLY_GLOBALS })
      expect(await backend.run('[name, location]')).toEqual({ output: "[ 'worker name', 'worker location' ]", exitCode: 0 })
      await backend.run(`${prefix}function name() { return 'mine' }; function location() { return 'here' }`)
      expect(await backend.run('[name(), location()]')).toEqual({ output: "[ 'mine', 'here' ]", exitCode: 0 })
    },
  )

  it('defines the top-level functions of code with top-level await before it runs, as a script does [review: accessor globals]', async () => {
    const { backend } = await start()
    expect(await backend.run("throw new Error('first'); await 0; function hoisted() { return 'ready' }")).toEqual({
      output: 'Error: first',
      exitCode: 1,
    })
    expect(await backend.run('hoisted()')).toEqual({ output: "'ready'", exitCode: 0 })
  })

  it('keeps working after commands replace the built-ins the runtime uses [review: primordials]', async () => {
    const { backend, workers } = await start({ timeoutMs: 2000, prelude: XHR_RECORDER })
    await backend.run(
      [
        "const m = new Map([[1, 'one']]); const s = new Set([1]); const bytes = new Uint8Array([1, 2]); const when = new Date(0)",
        "const boxed = Object(3); const sym = Symbol('s'); const failure = new TypeError('bad')",
      ].join('; '),
    )
    const shadow = [
      'const Map = 1; const Set = 2; class Promise {}; var JSON = null; var Object = null; var Array = null',
      'var String = null; var Number = null; var Boolean = null; var Symbol = null; var BigInt = null; var Math = null',
      'var Date = null; var RegExp = null; var Error = null; var TypeError = null; var Uint8Array = null',
      'var ArrayBuffer = null; var WeakMap = null; var WeakSet = null; var Reflect = null; var Proxy = null',
      'var Function = null; var parseInt = null; var parseFloat = null; var performance = null',
    ]
    expect(await backend.run(shadow.join('; '))).toEqual({ output: '', exitCode: 0 })
    const cases: Array<[string, string, number]> = [
      ['m', "Map(1) { 1 => 'one' }", 0],
      ['s', 'Set(1) { 1 }', 0],
      ['bytes', 'Uint8Array(2) [ 1, 2 ]', 0],
      ['when', '1970-01-01T00:00:00.000Z', 0],
      ['boxed', '[Number: 3]', 0],
      ['sym', 'Symbol(s)', 0],
      ['failure', 'TypeError: bad', 0],
      ['[/x/g, -0, 10n, [undefined]]', '[ /x/g, -0, 10n, [ undefined ] ]', 0],
      ['await null; ({ a: { b: 1 } })', '{ a: { b: 1 } }', 0],
      ['null.x', "TypeError: Cannot read properties of null (reading 'x')", 1],
      ["new URL('/x?q=1').href", "'https://docs.example/x?q=1'", 0],
      ["URL.canParse('../up')", 'true', 0],
      ["importScripts('/lib.js'); importedScripts", "[ 'https://docs.example/lib.js' ]", 0],
      [
        "const request = new XMLHttpRequest(); request.open('GET', 'data.json'); request.target",
        "'GET https://docs.example/guide/data.json'",
        0,
      ],
    ]
    for (const [source, output, exitCode] of cases) {
      expect(await backend.run(source), source).toEqual({ output, exitCode })
    }
    const { writes, context } = session()
    const logging = [
      "console.log('%s has %d items, %j %i %f', 'cart', 3, { a: 1 }, 4.7, '1.5x')",
      'console.count(); console.table([{ a: 1 }])',
      "console.group('G'); console.log('inside'); console.groupEnd()",
      "console.time('t'); console.timeEnd('t')",
    ]
    expect(await backend.run(logging.join('\n'), context)).toEqual({ output: '', exitCode: 0 })
    expect(writes.join('').replace(/^t: \d+(\.\d+)?ms\n$/m, 't: Nms\n')).toBe(
      [
        'cart has 3 items, {"a":1} 4 1.5',
        'default: 1',
        '┌─────────┬───┐',
        '│ (index) │ a │',
        '├─────────┼───┤',
        '│ 0       │ 1 │',
        '└─────────┴───┘',
        'G',
        '  inside',
        't: Nms',
        '',
      ].join('\n'),
    )
    expect(workers).toHaveLength(1)
  })

  it('keeps working after a command defines its own Promise, Map or Set class [js-11]', async () => {
    const { backend, workers } = await start({ timeoutMs: 2000 })
    expect(await backend.run('class Promise { constructor() { this.state = "pending" } }')).toEqual({ output: '', exitCode: 0 })
    expect(await backend.run('1 + 1')).toEqual({ output: '2', exitCode: 0 })
    expect(await backend.run('class Map { constructor() { this.items = [] } }; class Set {}')).toEqual({ output: '', exitCode: 0 })
    expect(await backend.run('({ a: 1, list: [1, 2] })')).toEqual({ output: '{ a: 1, list: [ 1, 2 ] }', exitCode: 0 })
    const { writes, context } = session()
    expect(await backend.run("console.log('total:', { n: 3 }); new Map().items", context)).toEqual({
      output: '[]',
      exitCode: 0,
    })
    expect(writes).toEqual(['total: { n: 3 }\n'])
    expect(workers).toHaveLength(1)
  })

  it('reports an exception thrown by a timer as a log line, without a crash [js-12]', async () => {
    const { backend, workers } = await start()
    await backend.run('var survivor = 7')
    const { writes, context } = session()
    expect(
      await backend.run(
        'setTimeout(() => { throw new Error("boom") }, 20); await new Promise((r) => setTimeout(r, 300)); 1',
        context,
      ),
    ).toEqual({ output: '1', exitCode: 0 })
    expect(writes).toEqual(['Uncaught Error: boom\n'])
    expect(await backend.run('survivor + 1')).toEqual({ output: '8', exitCode: 0 })
    expect(workers).toHaveLength(1)
  })

  it('prints the completion value of any statement, like the Node.js REPL [review: completion values]', async () => {
    const { backend } = await start()
    const cases: Array<[string, string]> = [
      ['if (true) { 5 }', '5'],
      ["try { throw new Error('bad') } catch (e) { e.message }", "'bad'"],
      ['for (const n of [1, 2]) n * 2', '4'],
      ["switch (1) { case 1: 'one' }", "'one'"],
      ['var flag = true; if (flag) { "yes" } else { "no" }', "'yes'"],
      ['let total = 0; for (let i = 1; i <= 3; i++) { total += i }', '6'],
      ['do { 7 } while (false)', '7'],
      ['label: { 9 }', '9'],
      ['x = 3; { x }', '3'],
      ['{ let inner = 1; inner }', '1'],
      ['try { 1 } finally { 2 }', '1'],
      ['while (false) {}', ''],
      ['if (false) 1', ''],
    ]
    for (const [source, expected] of cases) {
      expect(await backend.run(source), source).toEqual({ output: expected, exitCode: 0 })
    }
    expect(await backend.run('typeof inner')).toEqual({ output: "'undefined'", exitCode: 0 })
  })

  it('keeps the value printed before a declaration, as Node does, and still keeps the declaration [review: completion values]', async () => {
    const { backend } = await start()
    const cases: Array<[string, string]> = [
      ['1; let y = 2', '1'],
      ['5; function f() { return 50 }', '5'],
      ['6; class B {}', '6'],
      ['if (true) { 7 }; const z = 1', '7'],
      ['8; var m = 2', '8'],
      ['9; { var nested = 1 }', '9'],
      ['function g() {}', ''],
      ['class C {}', ''],
      ['const d = 1', ''],
      ['let e', ''],
    ]
    for (const [source, expected] of cases) {
      expect(await backend.run(source), source).toEqual({ output: expected, exitCode: 0 })
    }
    expect(await backend.run('[y, f(), typeof B, z, m, nested, typeof g, typeof C, d, e]')).toEqual({
      output: "[\n  2,          50,\n  'function', 1,\n  2,          1,\n  'function', 'function',\n  1,          undefined\n]",
      exitCode: 0,
    })
  })

  it('runs strict-mode code as strict and still keeps its declarations [review: completion values]', async () => {
    const { backend } = await start()
    expect(await backend.run("'use strict'; if (true) { 5 }")).toEqual({ output: '5', exitCode: 0 })
    expect(
      await backend.run("'use strict'\nif (true) { var w = 5 }; 1; var s = 2; let t = 3; function u() { return 4 }; class V {}"),
    ).toEqual({ output: '1', exitCode: 0 })
    expect(await backend.run('[s, t, u(), typeof V, w]')).toEqual({ output: "[ 2, 3, 4, 'function', 5 ]", exitCode: 0 })
    expect(await backend.run("'use strict'; let declared = 1; undeclared = 1")).toEqual({
      output: 'ReferenceError: undeclared is not defined',
      exitCode: 1,
    })
    expect(await backend.run("'use strict'")).toEqual({ output: "'use strict'", exitCode: 0 })
  })

  it('keeps sloppy-mode function declarations made inside a block, as Node does', async () => {
    const { backend } = await start()
    expect(await backend.run('if (true) { function inBlock() { return 1 } }')).toEqual({ output: '', exitCode: 0 })
    expect(await backend.run('inBlock()')).toEqual({ output: '1', exitCode: 0 })
  })

  it.each(['', 'await null; '])(
    'hoists block-level functions like sloppy global code, with the prefix %j [review: Annex B]',
    async (prefix) => {
      const { backend } = await start()
      const setup = [
        'if (true) { function inBlock() { return 1 } }',
        'if (true) function inClause() { return 2 }',
        'switch (1) { case 1: function inCase() { return 3 } }',
        'label: function labelled() { return 4 }',
        "{ function twice() { return 'outer' } { function twice() { return 'inner' } } }",
        'if (false) { function notReached() {} }',
        '{ function* generator() {} async function asyncOne() {} }',
        '{ let shadowed = 1; { function shadowed() {} } }',
        'for (const looped of [1]) { function looped() {} }',
        "'use strict'; { function strictLocal() {} } void 0",
      ]
      for (const line of setup) {
        const source = line.startsWith("'use strict'; ") ? `'use strict'; ${prefix}${line.slice(14)}` : prefix + line
        expect(await backend.run(source), source).toEqual({ output: '', exitCode: 0 })
      }
      expect(await backend.run('[inBlock(), inClause(), inCase(), labelled(), twice()]')).toEqual({
        output: "[ 1, 2, 3, 4, 'inner' ]",
        exitCode: 0,
      })
      const probe = [
        'typeof notReached',
        "'notReached' in globalThis",
        'typeof generator',
        'typeof asyncOne',
        'typeof shadowed',
        'typeof looped',
        'typeof strictLocal',
      ]
      expect(await backend.run(`[${probe.join(', ')}].join(' ')`)).toEqual({
        output: "'undefined true undefined undefined undefined undefined undefined'",
        exitCode: 0,
      })
    },
  )

  it('does not join a declaration with the next line when the line break ended it', async () => {
    const { backend } = await start()
    expect(await backend.run("let a\n[1, 2].forEach((n) => n)\n'done'")).toEqual({ output: "'done'", exitCode: 0 })
    expect(await backend.run("var b\n(() => 'called')()")).toEqual({ output: "'called'", exitCode: 0 })
    expect(await backend.run('class K {}\n(1)')).toEqual({ output: '1', exitCode: 0 })
  })

  it('accepts a hashbang line [review: completion values]', async () => {
    const { backend } = await start()
    expect(await backend.run('#!/usr/bin/env node\n1 + 1')).toEqual({ output: '2', exitCode: 0 })
    expect(await backend.run('#!/usr/bin/env node\nawait 3')).toEqual({ output: '3', exitCode: 0 })
  })

  it('awaits a promise value and prints any other object as it is', async () => {
    const { backend } = await start()
    expect(await backend.run('Promise.resolve(8)')).toEqual({ output: '8', exitCode: 0 })
    expect(await backend.run('await 1; Promise.resolve(9)')).toEqual({ output: '9', exitCode: 0 })
    expect(await backend.run('({ value: 5 })')).toEqual({ output: '{ value: 5 }', exitCode: 0 })
    expect(await backend.run('await 1; ({ value: 6 })')).toEqual({ output: '{ value: 6 }', exitCode: 0 })
  })

  it('prints only the last expression of code with top-level await, as Node does', async () => {
    const { backend } = await start()
    expect(await backend.run('await 1; 5')).toEqual({ output: '5', exitCode: 0 })
    expect(await backend.run('const v = await Promise.resolve(3); if (v) { v * 2 }')).toEqual({ output: '', exitCode: 0 })
    expect(await backend.run('v')).toEqual({ output: '3', exitCode: 0 })
  })

  it('reports an unhandled rejection as a log line [js-12]', async () => {
    const { backend } = await start()
    const { writes, context } = session()
    expect(
      await backend.run(
        'Promise.reject(new Error("nope")); await new Promise((r) => setTimeout(r, 100)); 2',
        context,
      ),
    ).toEqual({ output: '2', exitCode: 0 })
    expect(writes).toEqual(['Uncaught (in promise) Error: nope\n'])
  })
})

describe('cancellation and timeouts', () => {
  it('restarts the runtime on Ctrl+C and runs the next command at once [js-3, session-3, product-13, docs-js-2]', async () => {
    const { backend, workers, host } = await start({ timeoutMs: 1500 })
    await backend.run('var keep = 42')
    fakeTimers()
    const { controller, context } = session()
    const looping = backend.run('while (true) {}', context)
    await dispatched()
    controller.abort()
    expect(await looping).toEqual({ output: '', exitCode: 130 })
    expect(await backend.run('1 + 1')).toEqual({ output: '2', exitCode: 0 })
    expect(await backend.run('typeof keep')).toEqual({ output: "'undefined'", exitCode: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(2)
    expect(workers[0]?.terminated).toBe(true)
    expect(host).toEqual([`${RESTARTED}\n`])
  })

  it('abandons an await that never settles on Ctrl+C [js-3]', async () => {
    const { backend } = await start({ timeoutMs: 1500 })
    fakeTimers()
    const { controller, context } = session()
    const waiting = backend.run('await new Promise(() => {})', context)
    await dispatched()
    controller.abort()
    expect(await waiting).toEqual({ output: '', exitCode: 130 })
    expect(await backend.run('6 * 7')).toEqual({ output: '42', exitCode: 0 })
  })

  it('settles the commands queued behind an interrupted one instead of running them on the new runtime [review: queued runs]', async () => {
    const { backend, workers } = await start({ timeoutMs: 1500 })
    fakeTimers()
    const { controller, context } = session()
    const looping = backend.run('while (true) {}', context)
    const queued = [backend.run('globalThis.ran = true'), backend.run('2')]
    await dispatched()
    controller.abort()
    expect(await looping).toEqual({ output: '', exitCode: 130 })
    expect(await Promise.all(queued)).toEqual([
      { output: RESTARTED, exitCode: 130 },
      { output: RESTARTED, exitCode: 130 },
    ])
    expect(await backend.run('typeof ran')).toEqual({ output: "'undefined'", exitCode: 0 })
    expect(workers).toHaveLength(2)
  })

  it('settles the commands queued behind a timed-out one as interrupted [review: queued runs]', async () => {
    const { backend } = await start({ timeoutMs: 300 })
    fakeTimers()
    const looping = backend.run('while (true) {}')
    const queued = backend.run('globalThis.ran = true')
    await dispatched()
    await vi.advanceTimersByTimeAsync(300)
    expect(await looping).toEqual({ output: `timed out after 0.3 s\n${RESTARTED}`, exitCode: 124 })
    expect(await queued).toEqual({ output: RESTARTED, exitCode: 130 })
    expect(await backend.run('typeof ran')).toEqual({ output: "'undefined'", exitCode: 0 })
  })

  it('keeps the output printed before a timeout [js-13]', async () => {
    const { backend, workers } = await start({ timeoutMs: 300 })
    fakeTimers()
    const { writes, context } = session()
    const streamed = backend.run("console.log('started'); await new Promise((r) => setTimeout(r, 5000)); 'slow'", context)
    await until(() => writes.length > 0)
    await vi.advanceTimersByTimeAsync(300)
    expect(await streamed).toEqual({ output: `timed out after 0.3 s\n${RESTARTED}`, exitCode: 124 })
    expect(writes).toEqual(['started\n'])
    const buffered = backend.run("console.log('buffered'); while (true) {}")
    await until(() => workers[1]?.logs === 1)
    await vi.advanceTimersByTimeAsync(300)
    expect(await buffered).toEqual({ output: `buffered\ntimed out after 0.3 s\n${RESTARTED}`, exitCode: 124 })
    expect(workers).toHaveLength(3)
  })

  it('localizes the timeout notice', async () => {
    const { backend } = await start({ timeoutMs: 50, locale: 'ru' })
    expect(await backend.run('while (true) {}')).toEqual({
      output: 'превышено время ожидания: 0,05 с\nсреда перезапущена, переменные сброшены',
      exitCode: 124,
    })
  })

  it.each([Infinity, 0, -5, Number.NaN, 2 ** 31])(
    'treats timeoutMs %s as no limit or clamps it [js-14]',
    async (timeoutMs) => {
      const { backend, workers } = await start({ timeoutMs })
      expect(await backend.run('await new Promise((r) => setTimeout(r, 50)); 1 + 1')).toEqual({
        output: '2',
        exitCode: 0,
      })
      expect(workers).toHaveLength(1)
    },
  )
})

describe('lifecycle', () => {
  it('settles a running command on dispose and never respawns afterwards [js-8]', async () => {
    const { backend, workers } = await start({ timeoutMs: 200 })
    fakeTimers()
    const pending = backend.run('while (true) {}')
    await dispatched()
    backend.dispose()
    expect(await pending).toEqual({ output: '', exitCode: 130 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(workers).toHaveLength(1)
    expect(workers[0]?.terminated).toBe(true)
  })

  it('works again after dispose and init, and an old timer cannot kill the new runtime [js-8]', async () => {
    const { backend, workers } = await start({ timeoutMs: 300 })
    fakeTimers()
    void backend.run('while (true) {}')
    await dispatched()
    backend.dispose()
    await backend.init({ write: () => {} })
    expect(await backend.run('var x = 1; x')).toEqual({ output: '1', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(400)
    expect(await backend.run('x')).toEqual({ output: '1', exitCode: 0 })
    expect(workers).toHaveLength(2)
  })

  it('terminates the previous worker when init runs twice [js-8]', async () => {
    const { backend, workers } = await start()
    await backend.init({ write: () => {} })
    expect(workers).toHaveLength(2)
    expect(workers[0]?.terminated).toBe(true)
    expect(await backend.run('1')).toEqual({ output: '1', exitCode: 0 })
  })

  it('sends globals once, so changes made by commands stick [js-10]', async () => {
    const { backend } = await start({ globals: { config: { debug: false }, apiBase: 'https://x' } })
    expect(await backend.run('config.debug = true; apiBase = "changed"')).toEqual({
      output: "'changed'",
      exitCode: 0,
    })
    expect(await backend.run('[config.debug, apiBase]')).toEqual({ output: "[ true, 'changed' ]", exitCode: 0 })
  })

  it('re-reads and re-checks the globals when the runtime restarts, and names a global that cannot be cloned [js-10, review: respawn]', async () => {
    const globals: Record<string, unknown> = { config: { debug: false } }
    const { backend, workers } = await start({ globals, timeoutMs: 300 })
    fakeTimers()
    const timedOut = async (): Promise<unknown> => {
      const looping = backend.run('while (true) {}')
      await dispatched()
      await vi.advanceTimersByTimeAsync(300)
      return looping
    }
    ;(globals.config as { debug: boolean }).debug = true
    expect(await timedOut()).toEqual({ output: `timed out after 0.3 s\n${RESTARTED}`, exitCode: 124 })
    expect(await backend.run('config.debug')).toEqual({ output: 'true', exitCode: 0 })
    globals.helper = () => 1
    expect(await timedOut()).toEqual({ output: `timed out after 0.3 s\n${NOT_CLONEABLE}`, exitCode: 124 })
    expect(await backend.run('1 + 1')).toEqual({ output: NOT_CLONEABLE, exitCode: 1 })
    expect(workers).toHaveLength(2)
    expect(workers[1]?.terminated).toBe(true)
  })

  it('rejects a global that cannot be cloned at init, before any worker starts [js-10]', async () => {
    const { backend, workers } = create({ globals: { helper: () => 1 } })
    await expect(backend.init({ write: () => {} })).rejects.toThrow(
      new Error('the global "helper" cannot be passed to the worker: only cloneable data is allowed (no functions or DOM objects)'),
    )
    expect(workers).toHaveLength(0)
  })
})

describe('page integration', () => {
  it('resolves relative URLs against the page [js-9, js-fetch-hint, docs-js-3, product-14]', async () => {
    const { backend } = await start({ prelude: BLOB_LIKE_FETCH })
    expect(await backend.run('await fetch("/").then(r => r.status)')).toEqual({ output: '200', exitCode: 0 })
    expect(await backend.run("await fetch('data.json').then((r) => r.text())")).toEqual({
      output: "'https://docs.example/guide/data.json'",
      exitCode: 0,
    })
    expect(await backend.run("await fetch(new Request('/api/users')).then((r) => r.text())")).toEqual({
      output: "'https://docs.example/api/users'",
      exitCode: 0,
    })
    expect(await backend.run("new URL('/x?q=1').href")).toEqual({ output: "'https://docs.example/x?q=1'", exitCode: 0 })
    expect(await backend.run("new URL('/x', 'https://other.example').href")).toEqual({
      output: "'https://other.example/x'",
      exitCode: 0,
    })
    expect(await backend.run("new URL('/x') instanceof URL")).toEqual({ output: 'true', exitCode: 0 })
    expect(await backend.run("importScripts('/lib.js'); importedScripts")).toEqual({
      output: "[ 'https://docs.example/lib.js' ]",
      exitCode: 0,
    })
  })

  it('lets fetch reject a URL it cannot parse, as the real fetch does [js-9]', async () => {
    const { backend } = await start({ prelude: REJECTING_FETCH })
    expect(await backend.run("await fetch('http://[').catch((error) => error.name)")).toEqual({
      output: "'TypeError'",
      exitCode: 0,
    })
    expect(await backend.run("await fetch('data.json').then((r) => r.text())")).toEqual({
      output: "'https://docs.example/guide/data.json'",
      exitCode: 0,
    })
  })

  it('resolves only relative references in new URL, so URL validation still works [js-9]', async () => {
    const { backend } = await start()
    await backend.run('const isValidUrl = (text) => { try { new URL(text); return true } catch { return false } }')
    expect(await backend.run("[isValidUrl('not a url'), isValidUrl(''), isValidUrl('https://x.example')]")).toEqual({
      output: '[ false, false, true ]',
      exitCode: 0,
    })
    const cases: Array<[string, string]> = [
      ['./data.json', 'https://docs.example/guide/data.json'],
      ['../up', 'https://docs.example/up'],
      ['?q=1', 'https://docs.example/guide/intro?q=1'],
      ['#top', 'https://docs.example/guide/intro#top'],
      ['//cdn.example/x', 'https://cdn.example/x'],
      ['.', 'https://docs.example/guide/'],
    ]
    for (const [input, href] of cases) {
      expect(await backend.run(`new URL(${JSON.stringify(input)}).href`), input).toEqual({ output: `'${href}'`, exitCode: 0 })
    }
  })

  it('makes URL.canParse and URL.parse agree with new URL [review: URL]', async () => {
    const { backend } = await start()
    const inputs = ['/x?q=1', './data.json', '../up', '?q=1', '#top', '//cdn.example/x', '.', 'https://x.example/a']
    const invalid = ['not a url', '', 'data.json', 'http://[', ' /x']
    await backend.run(
      [
        'const built = (input, base) => { try { return new URL(input, base).href } catch { return null } }',
        'const parsed = (input, base) => { const url = URL.parse(input, base); return url === null ? null : url.href }',
        "const probe = (input, base) => [URL.canParse(input, base), parsed(input, base), built(input, base)].join(' ')",
      ].join('\n'),
    )
    for (const input of inputs) {
      const href = new URL(input, 'https://docs.example/guide/intro').href
      expect(await backend.run(`probe(${JSON.stringify(input)})`), input).toEqual({
        output: `'true ${href} ${href}'`,
        exitCode: 0,
      })
    }
    for (const input of invalid) {
      expect(await backend.run(`probe(${JSON.stringify(input)})`), input).toEqual({ output: "'false  '", exitCode: 0 })
    }
    expect(await backend.run("probe('/x', 'https://other.example/a/')")).toEqual({
      output: "'true https://other.example/x https://other.example/x'",
      exitCode: 0,
    })
    expect(await backend.run("URL.parse('/x') instanceof URL")).toEqual({ output: 'true', exitCode: 0 })
    expect(await backend.run('[URL.canParse, URL.parse, URL.canParse.length, URL.parse.length]')).toEqual({
      output: '[ [Function: canParse], [Function: parse], 1, 1 ]',
      exitCode: 0,
    })
    expect(await backend.run('URL.canParse()')).toEqual({ output: expect.stringMatching(/^TypeError: /), exitCode: 1 })
  })

  it('keeps fetch a function named fetch that always returns a promise [js-9, review: fetch wrapper]', async () => {
    const { backend } = await start({ prelude: NATIVE_LIKE_FETCH })
    expect(await backend.run('[fetch, fetch.length, importScripts, importScripts.length]')).toEqual({
      output: '[ [Function: fetch], 1, [Function: importScripts], 0 ]',
      exitCode: 0,
    })
    await backend.run('const { proxy: gone, revoke } = Proxy.revocable({}, {}); revoke()')
    const outcome = (call: string) =>
      `(() => { let promise; try { promise = ${call} } catch { return 'threw' } return promise.then(() => 'resolved', (error) => error.name) })()`
    expect(await backend.run(outcome('fetch(gone)'))).toEqual({ output: "'TypeError'", exitCode: 0 })
    expect(await backend.run(outcome("fetch(Symbol('s'))"))).toEqual({ output: "'TypeError'", exitCode: 0 })
    expect(await backend.run(outcome('fetch()'))).toEqual({ output: "'TypeError'", exitCode: 0 })
    expect(await backend.run(outcome("fetch('http://[')"))).toEqual({ output: "'TypeError'", exitCode: 0 })
    expect(await backend.run("await fetch('data.json').then((r) => r.text())")).toEqual({
      output: "'https://docs.example/guide/data.json'",
      exitCode: 0,
    })
  })

  it('resolves relative URLs given to XMLHttpRequest.open [js-9]', async () => {
    const { backend } = await start({ prelude: XHR_RECORDER })
    expect(
      await backend.run("const request = new XMLHttpRequest(); request.open('GET', 'data.json'); request.target"),
    ).toEqual({ output: "'GET https://docs.example/guide/data.json'", exitCode: 0 })
    expect(await backend.run('[XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.open.length]')).toEqual({
      output: '[ [Function: open], 2 ]',
      exitCode: 0,
    })
  })

  it('reports a worker that dies before its first reply as blocked by CSP [js-16]', async () => {
    const { backend } = create({ source: 'throw new Error("Refused to create a worker")' })
    await expect(backend.init({ write: () => {} })).rejects.toThrow(new Error(CSP_BLOCKED))
    expect(await backend.run('1 + 1')).toEqual({ output: CSP_BLOCKED, exitCode: 1 })
  })

  it('reports a page that forbids eval as blocked by CSP [js-16]', async () => {
    const { backend } = create({ prelude: CSP_WITHOUT_UNSAFE_EVAL })
    await expect(backend.init({ write: () => {}, locale: 'ru' })).rejects.toThrow(
      new Error("заблокировано политикой Content-Security-Policy страницы (нужно worker-src blob:; script-src 'unsafe-eval')"),
    )
  })
})
