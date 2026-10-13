import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  buildOutput,
  createJavaScriptBackend,
  WORKER_SOURCE,
  type HostMessage,
  type RunMessage,
  type WorkerLike,
  type WorkerMessage,
} from '../src/javascript/index.js'
import type { BackendHost, RunContext } from '../src/types.js'
import type { WorkerLike as WasiWorkerLike } from '../src/wasi/index.js'
import type { WorkerLike as SharedWorkerLike } from '../src/worker-like.js'

type Respond = (message: RunMessage, worker: FakeWorker) => void

const RESTARTED = 'runtime restarted, variables were reset'
const LIMIT_NOTE = (limit: number) => `output limit reached (${limit} characters), the rest is dropped`
const CSP_BLOCKED = "blocked by the page Content-Security-Policy (needs worker-src blob:; script-src 'unsafe-eval')"
const NOT_CLONEABLE =
  'the global "helper" cannot be passed to the worker: only cloneable data is allowed (no functions or DOM objects)'

const errorEvent = (message?: string): ErrorEvent => {
  const event = new Event('error', { cancelable: true })
  return (message === undefined ? event : Object.assign(event, { message })) as ErrorEvent
}

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  received: HostMessage[] = []

  constructor(
    private readonly respond: Respond = () => {},
    private readonly ready: boolean = true,
  ) {}

  postMessage(message: HostMessage): void {
    this.received.push(message)
    if (message.type === 'init' && this.ready) queueMicrotask(() => this.emit({ type: 'ready', evalBlocked: false }))
    if (message.type === 'run') this.respond(message, this)
  }

  emit(data: WorkerMessage): void {
    if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data }))
  }

  terminate(): void {
    this.terminated = true
  }
}

class LegacyWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false

  postMessage(message: unknown): void {
    const id = (message as { id?: unknown }).id
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: { id, logs: [], error: 'ReferenceError: x' } }))
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

const isRun = (message: HostMessage): boolean => message.type === 'run'

const answer =
  (value: string): Respond =>
  (message, worker) =>
    queueMicrotask(() => worker.emit({ type: 'result', id: message.id, value }))

const host = (writes: string[] = [], locale?: BackendHost['locale']): BackendHost => ({
  write: (text) => writes.push(text),
  locale,
})

function session(locale?: RunContext['locale']) {
  const writes: string[] = []
  const controller = new AbortController()
  const context: RunContext = { write: (text) => writes.push(text), signal: controller.signal, columns: 72, rows: 24, locale }
  return { writes, controller, context }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (condition: () => boolean): Promise<void> => {
  for (let turn = 0; !condition(); turn += 1) {
    if (turn === 10_000) throw new Error('condition was not met in time')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const runsOf = (worker: FakeWorker | undefined): number => worker?.received.filter(isRun).length ?? 0

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('buildOutput', () => {
  it('prints console output followed by the value', () => {
    expect(buildOutput({ id: 1, logs: ['hello'], value: '42' })).toEqual({
      output: 'hello\n42',
      exitCode: 0,
    })
  })

  it('omits an undefined value', () => {
    expect(buildOutput({ id: 1, logs: ['side effect'] })).toEqual({
      output: 'side effect',
      exitCode: 0,
    })
  })

  it('reports errors with exit code 1 after any logs', () => {
    expect(buildOutput({ id: 1, logs: ['before'], error: 'TypeError: x is not a function' })).toEqual({
      output: 'before\nTypeError: x is not a function',
      exitCode: 1,
    })
  })
})

describe('createJavaScriptBackend protocol', () => {
  it('sends globals and the base URL once, when the worker starts [js-10]', async () => {
    const worker = new FakeWorker(answer('3'))
    const backend = createJavaScriptBackend({
      createWorker: () => worker,
      globals: { apiKeyHint: 'demo' },
      baseURL: 'https://docs.example/guide/',
    })
    await backend.init(host())
    const { context } = session()
    await expect(backend.run('1 + 2', context)).resolves.toEqual({ output: '3', exitCode: 0 })
    await backend.run('4')
    expect(worker.received[0]).toEqual({ type: 'init', globals: { apiKeyHint: 'demo' }, baseURL: 'https://docs.example/guide/' })
    expect(worker.received.slice(1).map((message) => Object.keys(message as object).sort())).toEqual([
      ['code', 'columns', 'declarations', 'id', 'outputLimit', 'type'],
      ['code', 'columns', 'declarations', 'id', 'outputLimit', 'type'],
    ])
    expect(worker.received.slice(1).map((message) => (message as RunMessage).columns)).toEqual([72, 80])
  })

  it('sends the declarations apart from the rewritten command [review: completion values]', async () => {
    const worker = new FakeWorker(answer('1'))
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init(host())
    await backend.run("'use strict'; let a = 1; a")
    expect(worker.received[1]).toEqual({
      type: 'run',
      id: 1,
      code: "'use strict'; var {} = [ (a = 1)]; a",
      declarations: 'var a;',
      columns: 80,
      outputLimit: 1_048_576,
    })
  })

  it('tells the worker the output limit, and null when there is none [review: output cap]', async () => {
    const limits: unknown[] = []
    for (const outputLimit of [64, 0, Number.POSITIVE_INFINITY, Number.NaN]) {
      const worker = new FakeWorker(answer('1'))
      const backend = createJavaScriptBackend({ createWorker: () => worker, outputLimit })
      await backend.init(host())
      await backend.run('1')
      limits.push((worker.received[1] as RunMessage).outputLimit)
      backend.dispose()
    }
    expect(limits).toEqual([64, null, null, null])
  })

  it('waits for the worker before printing the banner, and refuses to run before init', async () => {
    const writes: string[] = []
    const worker = new FakeWorker(answer('1'), false)
    const backend = createJavaScriptBackend({ banner: 'javascript sandbox', createWorker: () => worker })
    await expect(backend.run('1')).resolves.toEqual({ output: 'environment is not ready yet', exitCode: 1 })
    const starting = backend.init(host(writes))
    await delay(10)
    expect(writes).toEqual([])
    worker.emit({ type: 'ready', evalBlocked: false })
    await starting
    expect(writes).toEqual(['javascript sandbox\n'])
  })

  it('ignores a reply for a command that is not running', async () => {
    const worker = new FakeWorker()
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init(host())
    const running = backend.run('1')
    await delay(10)
    const sent = worker.received[1] as RunMessage
    worker.emit({ type: 'result', id: sent.id + 1, value: "'stale'" })
    worker.emit({ type: 'result', id: sent.id, value: '1' })
    await expect(running).resolves.toEqual({ output: '1', exitCode: 0 })
  })

  it('restarts the worker after a timeout and reports it in the language of the run [js-13, js-14]', async () => {
    const workers: FakeWorker[] = []
    const backend = createJavaScriptBackend({
      timeoutMs: 30,
      createWorker: () => {
        const worker = new FakeWorker(workers.length === 0 ? (message, self) => self.emit({ type: 'log', id: message.id, text: 'partial' }) : answer('2'))
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host())
    const { writes, context } = session('ru')
    await expect(backend.run('while (true) {}', context)).resolves.toEqual({
      output: 'превышено время ожидания: 0,03 с\nсреда перезапущена, переменные сброшены',
      exitCode: 124,
    })
    expect(writes).toEqual(['partial\n'])
    expect(workers).toHaveLength(2)
    expect(workers[0]?.terminated).toBe(true)
    await expect(backend.run('1 + 1')).resolves.toEqual({ output: '2', exitCode: 0 })
  })

  it('restarts at once on abort and announces it once, through the host after the current task [js-3, review: notice once]', async () => {
    const workers: FakeWorker[] = []
    const hostWrites: string[] = []
    const backend = createJavaScriptBackend({
      createWorker: () => {
        const worker = new FakeWorker(workers.length === 0 ? () => {} : answer('2'))
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host(hostWrites))
    const { controller, context } = session()
    const looping = backend.run('while (true) {}', context)
    await delay(10)
    controller.abort()
    expect(workers).toHaveLength(2)
    expect(workers[0]?.terminated).toBe(true)
    expect(hostWrites).toEqual([])
    await expect(looping).resolves.toEqual({ output: '', exitCode: 130 })
    await delay(0)
    expect(hostWrites).toEqual([`${RESTARTED}\n`])
    await expect(backend.run('1 + 1')).resolves.toEqual({ output: '2', exitCode: 0 })
  })

  it('drops a queued command on abort without restarting the worker', async () => {
    const workers: FakeWorker[] = []
    const backend = createJavaScriptBackend({
      createWorker: () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host())
    const first = backend.run('first')
    const queued = session()
    const second = backend.run('second', queued.context)
    await until(() => runsOf(workers[0]) === 1)
    await delay(5)
    queued.controller.abort()
    await expect(second).resolves.toEqual({ output: '', exitCode: 130 })
    const running = workers[0]?.received.find(isRun) as RunMessage
    workers[0]?.emit({ type: 'result', id: running.id, value: '1' })
    await expect(first).resolves.toEqual({ output: '1', exitCode: 0 })
    expect(workers).toHaveLength(1)
    expect(workers[0]?.received.filter((message) => (message as { type: string }).type === 'run')).toHaveLength(1)
  })

  it('returns 130 at once for a signal that is already aborted', async () => {
    const worker = new FakeWorker(answer('1'))
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init(host())
    const { controller, context } = session()
    controller.abort()
    await expect(backend.run('1', context)).resolves.toEqual({ output: '', exitCode: 130 })
    expect(worker.received).toHaveLength(1)
  })

  it('settles pending commands on dispose and lets no timer fire afterwards [js-8]', async () => {
    const workers: FakeWorker[] = []
    const backend = createJavaScriptBackend({
      timeoutMs: 20,
      createWorker: () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = backend.run('hang')
    const second = backend.run('queued')
    await until(() => runsOf(workers[0]) === 1 && vi.getTimerCount() === 1)
    backend.dispose()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { output: '', exitCode: 130 },
      { output: '', exitCode: 130 },
    ])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60)
    expect(workers).toHaveLength(1)
    expect(workers[0]?.terminated).toBe(true)
  })

  it('finishes an init that dispose interrupted without printing the banner', async () => {
    const writes: string[] = []
    const worker = new FakeWorker(answer('1'), false)
    const backend = createJavaScriptBackend({ banner: 'banner', createWorker: () => worker })
    const starting = backend.init(host(writes))
    backend.dispose()
    await expect(starting).resolves.toBeUndefined()
    expect(writes).toEqual([])
    expect(worker.terminated).toBe(true)
  })

  it('shows an error event after the first reply as a line and keeps the command running [js-12]', async () => {
    const worker = new FakeWorker()
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init(host())
    const { writes, context } = session()
    const running = backend.run('work()', context)
    await delay(10)
    const event = errorEvent('Uncaught Error: boom')
    worker.onerror?.(event)
    expect(event.defaultPrevented).toBe(true)
    expect(writes).toEqual(['Uncaught Error: boom\n'])
    worker.emit({ type: 'result', id: (worker.received[1] as RunMessage).id, value: '1' })
    await expect(running).resolves.toEqual({ output: '1', exitCode: 0 })
  })

  it('treats an error before the first reply as a CSP block [js-16]', async () => {
    const worker = new FakeWorker(answer('1'), false)
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    const starting = backend.init(host())
    worker.onerror?.(errorEvent())
    await expect(starting).rejects.toThrow(new Error(CSP_BLOCKED))
    expect(worker.terminated).toBe(true)
    await expect(backend.run('1')).resolves.toEqual({ output: CSP_BLOCKED, exitCode: 1 })
  })

  it('treats a SecurityError from the Worker constructor as a CSP block [js-16]', async () => {
    const backend = createJavaScriptBackend({
      createWorker: () => {
        throw Object.assign(new Error('Access to the script is denied'), { name: 'SecurityError' })
      },
    })
    await expect(backend.init(host())).rejects.toThrow(new Error(CSP_BLOCKED))
  })

  it('terminates the worker on dispose and can start again', async () => {
    const workers: FakeWorker[] = []
    const backend = createJavaScriptBackend({
      createWorker: () => {
        const worker = new FakeWorker(answer('2'))
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host())
    backend.dispose()
    expect(workers[0]?.terminated).toBe(true)
    await backend.init(host())
    await expect(backend.run('1 + 1')).resolves.toEqual({ output: '2', exitCode: 0 })
    expect(workers).toHaveLength(2)
  })

  it('settles the commands queued behind an interrupted one with the restart notice [review: queued runs]', async () => {
    const workers: FakeWorker[] = []
    const hostWrites: string[] = []
    const backend = createJavaScriptBackend({
      createWorker: () => {
        const worker = new FakeWorker(workers.length === 0 ? () => {} : answer('2'))
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host(hostWrites))
    const { controller, context } = session()
    const running = backend.run('while (true) {}', context)
    const queued = [backend.run('queued()', session('ru').context), backend.run('also()')]
    await delay(10)
    controller.abort()
    await expect(running).resolves.toEqual({ output: '', exitCode: 130 })
    await expect(Promise.all(queued)).resolves.toEqual([
      { output: 'среда перезапущена, переменные сброшены', exitCode: 130 },
      { output: RESTARTED, exitCode: 130 },
    ])
    expect(workers).toHaveLength(2)
    expect(workers[1]?.received.filter(isRun)).toHaveLength(0)
    await delay(0)
    expect(hostWrites).toEqual([`${RESTARTED}\n`])
    await expect(backend.run('1 + 1')).resolves.toEqual({ output: '2', exitCode: 0 })
  })

  it('settles the commands queued behind a timed-out one as interrupted [review: queued runs]', async () => {
    const workers: FakeWorker[] = []
    const backend = createJavaScriptBackend({
      timeoutMs: 20,
      createWorker: () => {
        const worker = new FakeWorker(workers.length === 0 ? () => {} : answer('2'))
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host())
    const running = backend.run('while (true) {}')
    const queued = backend.run('queued()')
    await expect(running).resolves.toEqual({ output: `timed out after 0.02 s\n${RESTARTED}`, exitCode: 124 })
    await expect(queued).resolves.toEqual({ output: RESTARTED, exitCode: 130 })
    expect(workers[1]?.received.filter(isRun)).toHaveLength(0)
  })
})

describe('restarts that fail', () => {
  it('reports a global that can no longer be cloned instead of saying the runtime is not ready [review: respawn]', async () => {
    const workers: FakeWorker[] = []
    const globals: Record<string, unknown> = { config: { debug: false } }
    const backend = createJavaScriptBackend({
      timeoutMs: 20,
      globals,
      createWorker: () => {
        const worker = new FakeWorker(workers.length === 0 ? () => {} : answer('2'))
        workers.push(worker)
        return worker
      },
    })
    await backend.init(host())
    globals.helper = () => 1
    await expect(backend.run('while (true) {}')).resolves.toEqual({
      output: `timed out after 0.02 s\n${NOT_CLONEABLE}`,
      exitCode: 124,
    })
    expect(workers).toHaveLength(1)
    expect(workers[0]?.terminated).toBe(true)
    await expect(backend.run('1 + 1', session('ru').context)).resolves.toEqual({
      output:
        'глобальную переменную "helper" нельзя передать в воркер: допустимы только клонируемые данные (без функций и DOM-объектов)',
      exitCode: 1,
    })
    delete globals.helper
    await backend.init(host())
    await expect(backend.run('1 + 1')).resolves.toEqual({ output: '2', exitCode: 0 })
  })

  it('reports an exception thrown by createWorker during a restart [review: respawn]', async () => {
    const hostWrites: string[] = []
    let calls = 0
    const backend = createJavaScriptBackend({
      createWorker: () => {
        calls += 1
        if (calls > 1) throw new Error('no more workers')
        return new FakeWorker()
      },
    })
    await backend.init(host(hostWrites))
    const { controller, context } = session()
    const running = backend.run('while (true) {}', context)
    await delay(10)
    controller.abort()
    await expect(running).resolves.toEqual({ output: '', exitCode: 130 })
    await expect(backend.run('1')).resolves.toEqual({ output: 'no more workers', exitCode: 1 })
    await delay(0)
    expect(hostWrites).toEqual(['no more workers\n'])
  })
})

describe('output limit', () => {
  const flood =
    (lines: string[]): Respond =>
    (message, worker) => {
      for (const text of lines) worker.emit({ type: 'log', id: message.id, text })
      queueMicrotask(() => worker.emit({ type: 'result', id: message.id, value: '1' }))
    }

  it('drops console output past outputLimit characters and says so once, on its own line [review: output cap]', async () => {
    const worker = new FakeWorker(flood(['abcd', 'abcd', 'abcd', 'abcd', 'abcd']))
    const backend = createJavaScriptBackend({ createWorker: () => worker, outputLimit: 12 })
    await backend.init(host())
    const { writes, context } = session()
    await expect(backend.run('spam()', context)).resolves.toEqual({ output: '1', exitCode: 0 })
    expect(writes).toEqual(['abcd\n', 'abcd\n', 'ab', `\n${LIMIT_NOTE(12)}\n`])
    await expect(backend.run('spam()')).resolves.toEqual({
      output: `abcd\nabcd\nab\n${LIMIT_NOTE(12)}\n1`,
      exitCode: 0,
    })
  })

  it('cuts at a line end without an empty line, and never splits a surrogate pair [review: output cap]', async () => {
    const worker = new FakeWorker(flood(['abcde', 'x😀yz', 'more']))
    const backend = createJavaScriptBackend({ createWorker: () => worker, outputLimit: 8 })
    await backend.init(host())
    const { writes, context } = session('ru')
    await expect(backend.run('spam()', context)).resolves.toEqual({ output: '1', exitCode: 0 })
    expect(writes).toEqual(['abcde\n', 'x', '\nдостигнут предел вывода (8 символов), остальное отброшено\n'])
    const exact = new FakeWorker(flood(['abc', 'def', 'ghi']))
    const sized = createJavaScriptBackend({ createWorker: () => exact, outputLimit: 8 })
    await sized.init(host())
    const second = session()
    await sized.run('spam()', second.context)
    expect(second.writes).toEqual(['abc\n', 'def\n', `${LIMIT_NOTE(8)}\n`])
  })

  it('caps every run on its own and keeps 1 MiB by default [review: output cap]', async () => {
    const worker = new FakeWorker(flood(['x'.repeat(600_000), 'y'.repeat(600_000), 'z']))
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init(host())
    for (let round = 0; round < 2; round += 1) {
      const { writes, context } = session()
      await expect(backend.run('spam()', context)).resolves.toEqual({ output: '1', exitCode: 0 })
      expect(writes).toEqual([`${'x'.repeat(600_000)}\n`, 'y'.repeat(448_575), `\n${LIMIT_NOTE(1_048_576)}\n`])
    }
  })

  it('caps output that arrives between commands as well [review: output cap]', async () => {
    const hostWrites: string[] = []
    const worker = new FakeWorker(answer('1'))
    const backend = createJavaScriptBackend({ createWorker: () => worker, outputLimit: 6 })
    await backend.init(host(hostWrites))
    for (const text of ['late', 'later', 'latest']) worker.emit({ type: 'log', id: null, text })
    expect(hostWrites).toEqual(['late\n', 'l', `\n${LIMIT_NOTE(6)}\n`])
  })
})

describe('workers that die before they reply', () => {
  const sequence = (plans: Array<'ready' | 'mute' | 'crash' | 'silent'>, respond: Respond = answer('2')) => {
    const workers: FakeWorker[] = []
    const createWorker = () => {
      const plan = plans[workers.length] ?? 'ready'
      const worker = new FakeWorker(plan === 'ready' ? respond : () => {}, plan === 'ready' || plan === 'mute')
      if (plan === 'crash') queueMicrotask(() => worker.onerror?.(errorEvent('Uncaught RangeError: out of memory')))
      workers.push(worker)
      return worker
    }
    return { workers, createWorker }
  }

  it('respawns a worker that dies before its first reply once an earlier one was ready, instead of blaming CSP [review: proven]', async () => {
    const hostWrites: string[] = []
    const { workers, createWorker } = sequence(['mute', 'crash', 'ready'])
    const backend = createJavaScriptBackend({ createWorker })
    await backend.init(host(hostWrites))
    const { controller, context } = session()
    const looping = backend.run('while (true) {}', context)
    await delay(5)
    controller.abort()
    await expect(looping).resolves.toEqual({ output: '', exitCode: 130 })
    await delay(10)
    expect(workers).toHaveLength(3)
    expect(workers[1]?.terminated).toBe(true)
    await expect(backend.run('1 + 1')).resolves.toEqual({ output: '2', exitCode: 0 })
    expect(hostWrites).toEqual([`${RESTARTED}\n`])
  })

  it('fails the command that waited on a worker that died before replying and runs the next one [review: proven]', async () => {
    const { workers, createWorker } = sequence(['mute', 'silent', 'ready'])
    const backend = createJavaScriptBackend({ createWorker, timeoutMs: 20 })
    await backend.init(host())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timedOut = backend.run('while (true) {}')
    await until(() => vi.getTimerCount() === 1)
    await vi.advanceTimersByTimeAsync(20)
    await expect(timedOut).resolves.toEqual({ output: `timed out after 0.02 s\n${RESTARTED}`, exitCode: 124 })
    const waiting = backend.run('1 + 1', session('ru').context)
    const next = backend.run('2')
    await until(() => runsOf(workers[1]) === 1)
    workers[1]?.onerror?.(errorEvent('Uncaught RangeError: out of memory'))
    await expect(waiting).resolves.toEqual({ output: 'Uncaught RangeError: out of memory', exitCode: 1 })
    await expect(next).resolves.toEqual({ output: '2', exitCode: 0 })
    expect(workers).toHaveLength(3)
  })

  it('gives up after three workers in a row die before replying, with a localized hint [review: proven]', async () => {
    const { workers, createWorker } = sequence(['mute', 'crash', 'crash', 'crash', 'ready'])
    const backend = createJavaScriptBackend({ createWorker, timeoutMs: 20 })
    await backend.init(host())
    await expect(backend.run('while (true) {}')).resolves.toEqual({
      output: `timed out after 0.02 s\n${RESTARTED}`,
      exitCode: 124,
    })
    await delay(20)
    expect(workers).toHaveLength(4)
    expect(workers.every((worker) => worker.terminated)).toBe(true)
    await expect(backend.run('1 + 1')).resolves.toEqual({
      output: 'environment failed to start: Uncaught RangeError: out of memory\nreload the page to try again.',
      exitCode: 1,
    })
    await expect(backend.run('1 + 1', session('ru').context)).resolves.toEqual({
      output: 'окружение не запустилось: Uncaught RangeError: out of memory\nперезагрузи страницу, чтобы попробовать ещё раз.',
      exitCode: 1,
    })
  })

  it('names an error event without a message in the language of the run, not in English [review: Uncaught error]', async () => {
    const worker = new FakeWorker()
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init(host())
    const { writes, context } = session('ru')
    const running = backend.run('work()', context)
    await delay(5)
    worker.onerror?.(errorEvent())
    expect(writes).toEqual(['ошибка окружения\n'])
    worker.emit({ type: 'result', id: (worker.received[1] as RunMessage).id, value: '1' })
    await expect(running).resolves.toEqual({ output: '1', exitCode: 0 })
  })
})

describe('init deadline', () => {
  it('rejects init with a localized error when the worker never says it is ready [review: init deadline]', async () => {
    const worker = new FakeWorker(answer('1'), false)
    const backend = createJavaScriptBackend({ initTimeoutMs: 30, createWorker: () => worker })
    await expect(backend.init(host([], 'ru'))).rejects.toThrow(new Error('JavaScript-воркер не запустился за 0,03 с'))
    expect(worker.terminated).toBe(true)
    await expect(backend.run('1')).resolves.toEqual({ output: 'JavaScript-воркер не запустился за 0,03 с', exitCode: 1 })
    await expect(backend.run('1', session('en').context)).resolves.toEqual({
      output: 'the JavaScript worker did not start within 0.03 s',
      exitCode: 1,
    })
  })

  it('gives a worker 10 s by default, so a worker written for the 0.7 protocol fails clearly [review: init deadline]', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = new LegacyWorker()
    const backend = createJavaScriptBackend({ createWorker: () => legacy })
    const outcome = backend.init(host()).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(9_999)
    expect(legacy.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('the JavaScript worker did not start within 10 s')
    expect(legacy.terminated).toBe(true)
  })

  it.each([0, Number.POSITIVE_INFINITY])('waits for the worker without a deadline when initTimeoutMs is %s', async (initTimeoutMs) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const worker = new FakeWorker(answer('1'), false)
    const backend = createJavaScriptBackend({ initTimeoutMs, createWorker: () => worker })
    const starting = backend.init(host())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.terminated).toBe(false)
    worker.emit({ type: 'ready', evalBlocked: false })
    await expect(starting).resolves.toBeUndefined()
    backend.dispose()
  })

  it('clears the deadline once the worker is ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const worker = new FakeWorker(answer('3'))
    const backend = createJavaScriptBackend({ initTimeoutMs: 50, createWorker: () => worker })
    await backend.init(host())
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(worker.terminated).toBe(false)
    await expect(backend.run('1 + 2')).resolves.toEqual({ output: '3', exitCode: 0 })
    backend.dispose()
  })
})

describe('default worker factory', () => {
  it('takes a DOM Worker as a WorkerLike without casts [review: worker types]', () => {
    expectTypeOf<Worker>().toExtend<WorkerLike>()
    expectTypeOf<WorkerMessage>().toExtend<{ type: 'ready' | 'log' | 'result' }>()
    expectTypeOf<HostMessage>().toExtend<{ type: 'init' | 'run' }>()
  })

  it('shares one DOM-free WorkerLike with the wasi backend, so adapters need no DOM events [review: WorkerLike]', () => {
    expectTypeOf<WorkerLike>().toEqualTypeOf<SharedWorkerLike>()
    expectTypeOf<WasiWorkerLike>().toEqualTypeOf<SharedWorkerLike>()
    expectTypeOf<Worker>().toExtend<SharedWorkerLike>()
    const received: unknown[] = []
    const adapter = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onerror: null as ((event: unknown) => void) | null,
      postMessage: (message: unknown) => received.push(message),
      terminate: () => {},
    }
    expectTypeOf(adapter).toExtend<SharedWorkerLike>()
    const like: SharedWorkerLike = adapter
    like.onmessage = (event) => received.push(event.data)
    like.onerror = (event) => received.push(event)
    like.onmessage({ data: 'plain message' })
    like.onerror(new Error('plain error'))
    expect(received).toEqual(['plain message', new Error('plain error')])
  })

  it('reads the page base URL again for every worker it starts, unless baseURL is given [review: base URL]', async () => {
    const instances: FakeWorker[] = []
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          const worker = new FakeWorker()
          instances.push(worker)
          return worker
        }
      },
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:docsterm-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const page = { baseURI: 'https://docs.example/guide/' }
    vi.stubGlobal('document', page)
    const baseOf = (worker: FakeWorker | undefined) => (worker?.received[0] as { baseURL?: unknown } | undefined)?.baseURL
    const backend = createJavaScriptBackend({ timeoutMs: 20 })
    await backend.init(host())
    page.baseURI = 'https://docs.example/reference/api/'
    await backend.run('while (true) {}')
    expect(instances.map(baseOf)).toEqual(['https://docs.example/guide/', 'https://docs.example/reference/api/'])
    backend.dispose()
    const pinned = createJavaScriptBackend({ timeoutMs: 20, baseURL: 'https://pinned.example/' })
    await pinned.init(host())
    page.baseURI = 'https://docs.example/elsewhere/'
    await pinned.run('while (true) {}')
    expect(instances.slice(2).map(baseOf)).toEqual(['https://pinned.example/', 'https://pinned.example/'])
    pinned.dispose()
  })

  it('creates one blob URL, reuses it on restart, revokes it on dispose and uses document.baseURI [js-8, js-9]', async () => {
    const created: string[] = []
    const instances: FakeWorker[] = []
    vi.stubGlobal(
      'Worker',
      class {
        constructor(url: string) {
          created.push(url)
          const worker = new FakeWorker()
          instances.push(worker)
          return worker
        }
      },
    )
    vi.stubGlobal('document', { baseURI: 'https://docs.example/guide/' })
    const blobs: unknown[] = []
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob)
      return 'blob:docsterm-test'
    })
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const backend = createJavaScriptBackend({ timeoutMs: 20 })
    await backend.init(host())
    const blob = blobs[0]
    expect([blobs.length, blob instanceof Blob ? blob.type : null]).toEqual([1, 'text/javascript'])
    await expect((blob as Blob).text()).resolves.toBe(WORKER_SOURCE)
    expect(instances[0]?.received[0]).toEqual({ type: 'init', globals: {}, baseURL: 'https://docs.example/guide/' })
    await backend.run('while (true) {}')
    expect(created).toEqual(['blob:docsterm-test', 'blob:docsterm-test'])
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    backend.dispose()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:docsterm-test')
    expect(instances.every((worker) => worker.terminated)).toBe(true)
  })
})

describe('parser chunk that cannot load', () => {
  afterEach(() => {
    vi.doUnmock('acorn')
    vi.resetModules()
  })

  it('answers with a localized failure instead of rejecting with the bundler message [review: parser chunk]', async () => {
    vi.resetModules()
    vi.doMock('acorn', () => {
      throw new TypeError('Failed to fetch dynamically imported module: https://docs.example/assets/acorn-1a2b.js')
    })
    const fresh = await import('../src/javascript/index.js')
    const worker = new FakeWorker(answer('2'))
    const backend = fresh.createJavaScriptBackend({ createWorker: () => worker })
    await backend.init(host())
    await expect(backend.run('1 + 1')).resolves.toEqual({
      output: 'cannot load the JavaScript parser\nreload the page to try again.',
      exitCode: 1,
    })
    await expect(backend.run('1 + 1', session('ru').context)).resolves.toEqual({
      output: 'не удалось загрузить парсер JavaScript\nперезагрузи страницу, чтобы попробовать ещё раз.',
      exitCode: 1,
    })
    await expect(backend.isComplete?.('function f() {')).resolves.toBe(true)
    expect(worker.received.filter(isRun)).toHaveLength(0)
    backend.dispose()
  })
})

describe('REPL metadata', () => {
  it('asks for more lines while the input is unfinished', async () => {
    const backend = createJavaScriptBackend({ createWorker: () => new FakeWorker() })
    expect(backend.continuationPrompt).toBe('... ')
    expect(await backend.isComplete?.('function f() {')).toBe(false)
    expect(await backend.isComplete?.('function f() {\n  return 1\n}')).toBe(true)
    expect(await backend.isComplete?.('1 +* 2')).toBe(true)
  })

  it('describes the environment for the AI, naming only the APIs that resolve relative URLs [review: describe]', () => {
    const base =
      'JavaScript REPL in a browser Web Worker, like the Node.js REPL: the value of the last expression is printed, ' +
      'top-level await works, and variables, functions and classes persist between commands. ' +
      'console.log, table, dir, count, time and group print to the terminal. ' +
      'There is no DOM (no document or window). Relative URLs (/, ./, ../) resolve against the page only in ' +
      'fetch, Request, XMLHttpRequest, importScripts and new URL; import() needs an absolute URL.'
    expect(createJavaScriptBackend({ createWorker: () => new FakeWorker() }).describe?.()).toBe(
      `${base} A command that runs longer than 10 s is stopped and the runtime restarts, losing all variables.`,
    )
    expect(
      createJavaScriptBackend({
        createWorker: () => new FakeWorker(),
        timeoutMs: 0,
        globals: { config: {}, apiBase: '' },
      }).describe?.(),
    ).toBe(`${base} Predefined globals: config, apiBase.`)
    const full = createJavaScriptBackend({
      createWorker: () => new FakeWorker(),
      globals: { config: {}, apiBase: '' },
    }).describe?.()
    expect(full?.endsWith('losing all variables. Predefined globals: config, apiBase.')).toBe(true)
    expect(full?.length).toBeLessThanOrEqual(600)
  })

  it('keeps the Russian description within 600 characters too, whatever the timeout and globals [review: describe limit]', async () => {
    const globals = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`setting${index}`, index]))
    for (const timeoutMs of [10_000, 2 ** 31 - 1, 0]) {
      const backend = createJavaScriptBackend({ createWorker: () => new FakeWorker(), timeoutMs, globals })
      await backend.init(host([], 'ru'))
      const text = backend.describe?.() ?? ''
      expect(text.startsWith('REPL JavaScript в Web Worker браузера')).toBe(true)
      expect(text).toMatch(/Заранее заданные глобальные переменные: setting0(, setting\d+)*\.$/)
      expect(text.length).toBeLessThanOrEqual(600)
      backend.dispose()
    }
  })

  it('describes the environment in the language of the page', async () => {
    const backend = createJavaScriptBackend({ createWorker: () => new FakeWorker(), timeoutMs: 5000 })
    await backend.init(host([], 'ru'))
    expect(backend.describe?.()).toBe(
      'REPL JavaScript в Web Worker браузера, как REPL Node.js: печатается значение последнего выражения, ' +
        'await работает на верхнем уровне, а переменные, функции и классы сохраняются между командами. ' +
        'console.log, table, dir, count, time и group выводят в терминал. ' +
        'DOM нет (нет document и window). Относительные URL (/, ./, ../) отсчитываются от страницы только в ' +
        'fetch, Request, XMLHttpRequest, importScripts и new URL; для import() нужен абсолютный URL. ' +
        'Команда дольше 5 с останавливается, среда перезапускается, и все переменные теряются.',
    )
    backend.dispose()
  })
})
