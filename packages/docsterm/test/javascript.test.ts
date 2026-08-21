import { describe, expect, it, vi } from 'vitest'
import {
  buildOutput,
  createJavaScriptBackend,
  persistTopLevelDeclarations,
  WORKER_SOURCE,
  type WorkerLike,
} from '../src/javascript/index.js'

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  terminated = false
  received: unknown[] = []

  constructor(private readonly reply: (message: { id: number; code: string }) => unknown | null) {}

  postMessage(message: unknown): void {
    this.received.push(message)
    const answer = this.reply(message as { id: number; code: string })
    if (answer !== null) queueMicrotask(() => this.onmessage?.({ data: answer }))
  }

  terminate(): void {
    this.terminated = true
  }
}

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

describe('persistTopLevelDeclarations', () => {
  it('rewrites const and let so bindings survive between commands', () => {
    expect(persistTopLevelDeclarations('const users = [1, 2]')).toBe('var users = [1, 2]')
    expect(persistTopLevelDeclarations('let count = 0')).toBe('var count = 0')
  })

  it('leaves other statements untouched', () => {
    expect(persistTopLevelDeclarations('users.map(n => n * 2)')).toBe('users.map(n => n * 2)')
    expect(persistTopLevelDeclarations('await fetch(url)')).toBe('await fetch(url)')
    expect(persistTopLevelDeclarations('constant + letter')).toBe('constant + letter')
  })

  it('handles several declarations across lines', () => {
    expect(persistTopLevelDeclarations('const a = 1\nlet b = 2')).toBe('var a = 1\nvar b = 2')
  })
})

describe('worker source', () => {
  it('captures console methods and keeps eval in the global realm', () => {
    expect(WORKER_SOURCE).toContain('console.log = capture')
    expect(WORKER_SOURCE).toContain('(0, eval)(source)')
    expect(WORKER_SOURCE).toContain("'(async () => {' + source + '})()'")
    expect(WORKER_SOURCE).toContain('persistTopLevelDeclarations(code)')
  })
})

describe('createJavaScriptBackend', () => {
  it('sends code to the worker and returns its formatted answer', async () => {
    const worker = new FakeWorker((message) => ({ id: message.id, logs: ['hi'], value: '3' }))
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init({ write: () => {} })
    await expect(backend.run('1 + 2')).resolves.toEqual({ output: 'hi\n3', exitCode: 0 })
    expect(worker.received[0]).toMatchObject({ id: 1, code: '1 + 2' })
  })

  it('passes configured globals to the worker', async () => {
    const worker = new FakeWorker((message) => ({ id: message.id }))
    const backend = createJavaScriptBackend({
      createWorker: () => worker,
      globals: { apiKeyHint: 'demo' },
    })
    await backend.init({ write: () => {} })
    await backend.run('noop')
    expect(worker.received[0]).toMatchObject({ globals: { apiKeyHint: 'demo' } })
  })

  it('matches replies by id so a late answer cannot resolve the wrong command', async () => {
    const worker = new FakeWorker((message) =>
      message.code === 'slow' ? null : { id: message.id, value: `"${message.code}"` },
    )
    const backend = createJavaScriptBackend({ createWorker: () => worker, timeoutMs: 50 })
    await backend.init({ write: () => {} })
    const slow = backend.run('slow')
    const fast = await backend.run('fast')
    expect(fast.output).toBe('"fast"')
    const timedOut = await slow
    expect(timedOut.exitCode).toBe(1)
    expect(timedOut.output).toContain('timed out')
  })

  it('terminates and respawns the worker after a timeout', async () => {
    const workers: FakeWorker[] = []
    const backend = createJavaScriptBackend({
      timeoutMs: 30,
      createWorker: () => {
        const worker = new FakeWorker((message) =>
          workers.length === 1 ? null : { id: message.id, value: '"after restart"' },
        )
        workers.push(worker)
        return worker
      },
    })
    await backend.init({ write: () => {} })
    const first = await backend.run('while (true) {}')
    expect(first.output).toContain('runtime restarted')
    expect(workers[0]?.terminated).toBe(true)
    expect(workers).toHaveLength(2)
    await expect(backend.run('1')).resolves.toEqual({ output: '"after restart"', exitCode: 0 })
  })

  it('surfaces a worker crash instead of hanging', async () => {
    const worker = new FakeWorker(() => null)
    const backend = createJavaScriptBackend({ createWorker: () => worker, timeoutMs: 5_000 })
    await backend.init({ write: () => {} })
    const running = backend.run('boom()')
    worker.onerror?.({})
    await expect(running).resolves.toEqual({ output: 'worker crashed', exitCode: 1 })
  })

  it('writes the banner and refuses to run before init', async () => {
    const writes: string[] = []
    const backend = createJavaScriptBackend({
      banner: 'javascript sandbox',
      createWorker: () => new FakeWorker((message) => ({ id: message.id })),
    })
    await expect(backend.run('1')).resolves.toMatchObject({ exitCode: 1 })
    await backend.init({ write: (text) => writes.push(text) })
    expect(writes).toEqual(['javascript sandbox\n'])
  })

  it('terminates the worker on dispose', async () => {
    const worker = new FakeWorker((message) => ({ id: message.id }))
    const backend = createJavaScriptBackend({ createWorker: () => worker })
    await backend.init({ write: () => {} })
    backend.dispose()
    expect(worker.terminated).toBe(true)
  })
})
