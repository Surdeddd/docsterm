import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendHost, Locale, RunContext } from '../src/types.js'
import { createWasiBackend, type WorkerLike } from '../src/wasi/index.js'

interface NodeFs {
  readFileSync(path: URL): Uint8Array
}

const nodeFs = (globalThis as unknown as { process: { getBuiltinModule(id: string): NodeFs } }).process.getBuiltinModule(
  'node:fs',
)

const greetBytes = () => new Uint8Array(nodeFs.readFileSync(new URL('./fixtures/wasi/greet.wasm', import.meta.url)))

const GREETING = (name: string) => `Hello, ${name}! This is Rust compiled to WebAssembly.`

const BLOCKED = {
  en: 'blocked by the page Content-Security-Policy (needs worker-src blob:)',
  ru: 'заблокировано политикой Content-Security-Policy страницы (нужно worker-src blob:)',
}

const NO_WORKER = {
  en: 'WebAssembly programs need a Web Worker, and this environment has none',
  ru: 'программам WebAssembly нужен Web Worker, а в этой среде его нет',
}

const recordingHost = (locale?: Locale) => {
  const written: string[] = []
  const host: BackendHost = { write: (text) => written.push(text), locale }
  return { written, host }
}

const runContext = (locale?: Locale) => {
  const chunks: string[] = []
  const controller = new AbortController()
  const context: RunContext = { write: (text) => chunks.push(text), signal: controller.signal, columns: 80, rows: 24, locale }
  return { chunks, controller, context }
}

type Plan = 'ready' | 'error' | 'throw' | 'silent'

interface Spawned {
  readonly runs: Array<{ type: string; id?: number }>
  readonly terminated: boolean
  reply(data: unknown): void
}

const stubBlobWorker = (plans: Plan | Plan[]) => {
  const spawned: Spawned[] = []
  let attempts = 0
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:docs/wasi')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  class FakeWorker implements Spawned {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    readonly runs: Array<{ type: string; id?: number }> = []
    terminated = false
    private readonly plan: Plan

    constructor() {
      this.plan = Array.isArray(plans) ? (plans[attempts] ?? 'ready') : plans
      attempts += 1
      if (this.plan === 'throw') throw new DOMException('worker blocked', 'SecurityError')
      spawned.push(this)
    }

    postMessage(message: { type: string; id?: number }) {
      queueMicrotask(() => {
        if (message.type !== 'module') this.runs.push(message)
        else if (this.plan === 'error') this.onerror?.(new Event('error'))
        else if (this.plan === 'ready') this.reply({ type: 'ready' })
      })
    }

    reply(data: unknown) {
      this.onmessage?.({ data })
    }

    terminate() {
      this.terminated = true
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  return spawned
}

const scriptedWorker = (answer: (message: { type: string; id?: number }, worker: WorkerLike) => void): WorkerLike => {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => queueMicrotask(() => answer(message as { type: string; id?: number }, worker)),
    terminate: () => {},
  }
  return worker
}

const waitFor = async (condition: () => boolean) => {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > 3000) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createWasiBackend without a usable worker [security L6]', () => {
  it('fails every run with the localized CSP message when the page blocks the blob worker, and never runs on the page', async () => {
    const spawned = stubBlobWorker('error')
    const { written, host } = recordingHost()
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', banner: 'greet ready' })
    await backend.init(host)
    await expect(backend.run('greet csp')).resolves.toEqual({ output: BLOCKED.en, exitCode: 1 })
    await expect(backend.run('greet again', runContext('ru').context)).resolves.toEqual({ output: BLOCKED.ru, exitCode: 1 })
    expect(written).toEqual(['greet ready\n'])
    expect(spawned).toHaveLength(1)
    backend.dispose()
  })

  it('rejects init and every run in the host language when the Worker constructor itself refuses', async () => {
    stubBlobWorker('throw')
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', banner: 'greet ready' })
    const english = recordingHost()
    await expect(backend.init(english.host)).rejects.toThrowError(new Error(BLOCKED.en))
    expect(english.written).toEqual([])
    await expect(backend.run('greet inline')).resolves.toEqual({ output: BLOCKED.en, exitCode: 1 })
    backend.dispose()
    const russian = recordingHost('ru')
    await expect(backend.init(russian.host)).rejects.toThrowError(new Error(BLOCKED.ru))
    await expect(backend.run('greet inline')).resolves.toEqual({ output: BLOCKED.ru, exitCode: 1 })
    backend.dispose()
  })

  it('names the reason a custom worker gave when it cannot start, in en and ru', async () => {
    const failing = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () => scriptedWorker((_message, worker) => worker.onerror?.({ message: 'blocked by CSP' })),
    })
    await failing.init(recordingHost().host)
    await expect(failing.run('greet csp')).resolves.toEqual({
      output: 'the WebAssembly worker could not start: blocked by CSP',
      exitCode: 1,
    })
    await expect(failing.run('greet csp', runContext('ru').context)).resolves.toEqual({
      output: 'WebAssembly-воркер не смог запуститься: blocked by CSP',
      exitCode: 1,
    })
    failing.dispose()
    const throwing = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () => {
        throw new Error('no workers here')
      },
    })
    await expect(throwing.init(recordingHost('ru').host)).rejects.toThrowError(
      new Error('WebAssembly-воркер не смог запуститься: Error: no workers here'),
    )
    await expect(throwing.run('greet x', runContext('en').context)).resolves.toEqual({
      output: 'the WebAssembly worker could not start: Error: no workers here',
      exitCode: 1,
    })
    throwing.dispose()
  })

  it('fails runs once a worker misses its ready deadline, instead of running the program on the page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const spawned = stubBlobWorker('silent')
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet' })
    await backend.init(recordingHost().host)
    let result: unknown
    const pending = backend.run('greet late').then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(result).toEqual({ output: 'the WebAssembly worker did not start within 10 s', exitCode: 1 })
    await expect(backend.run('greet again', runContext('ru').context)).resolves.toEqual({
      output: 'WebAssembly-воркер не запустился за 10 с',
      exitCode: 1,
    })
    expect(spawned.map((worker) => worker.terminated)).toEqual([true])
    backend.dispose()
  })

  it('rejects init where there is no Worker global, unless worker: false asks to run on the page', async () => {
    vi.stubGlobal('Worker', undefined)
    for (const worker of [undefined, true]) {
      const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker })
      await expect(backend.init(recordingHost().host)).rejects.toThrowError(new Error(NO_WORKER.en))
      await expect(backend.run('greet node', runContext('ru').context)).resolves.toEqual({ output: NO_WORKER.ru, exitCode: 1 })
      backend.dispose()
    }
    const inline = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: false })
    await inline.init(recordingHost().host)
    await expect(inline.run('greet node')).resolves.toEqual({ output: GREETING('node'), exitCode: 0 })
    inline.dispose()
  })

  it('runs on the page when worker: false is chosen, even where workers exist', async () => {
    const spawned = stubBlobWorker('ready')
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet', worker: false })
    await backend.init(recordingHost().host)
    await expect(backend.run('greet page')).resolves.toEqual({ output: GREETING('page'), exitCode: 0 })
    expect(spawned).toHaveLength(0)
    backend.dispose()
  })

  it('never runs on the page when a worker that was ready can no longer be created', async () => {
    let created = 0
    const backend = createWasiBackend({
      bytes: greetBytes(),
      program: 'greet',
      createWorker: () => {
        created += 1
        if (created > 1) throw new Error('quota exceeded')
        return scriptedWorker((message, worker) => {
          if (message.type === 'module') worker.onmessage?.({ data: { type: 'ready' } })
        })
      },
    })
    await backend.init(recordingHost().host)
    const first = runContext()
    const looping = backend.run('greet forever', first.context)
    await new Promise((resolve) => setTimeout(resolve, 10))
    first.controller.abort()
    await expect(looping).resolves.toEqual({ output: '', exitCode: 130 })
    await expect(backend.run('greet next')).resolves.toEqual({ output: 'Error: quota exceeded', exitCode: 1 })
    expect(created).toBe(3)
    backend.dispose()
  })

  it('tries the worker again after dispose and init, once the page allows it', async () => {
    const spawned = stubBlobWorker(['error', 'ready'])
    const backend = createWasiBackend({ bytes: greetBytes(), program: 'greet' })
    await backend.init(recordingHost().host)
    await expect(backend.run('greet csp')).resolves.toEqual({ output: BLOCKED.en, exitCode: 1 })
    backend.dispose()
    await backend.init(recordingHost().host)
    const { chunks, context } = runContext()
    const running = backend.run('greet worker', context)
    await waitFor(() => spawned[1]?.runs.length === 1)
    const run = spawned[1]?.runs[0]
    spawned[1]?.reply({ type: 'output', id: run?.id, text: 'from the second worker\n' })
    spawned[1]?.reply({ type: 'exit', id: run?.id, code: 0 })
    await expect(running).resolves.toEqual({ output: '', exitCode: 0 })
    expect(chunks).toEqual(['from the second worker\n'])
    backend.dispose()
  })
})
