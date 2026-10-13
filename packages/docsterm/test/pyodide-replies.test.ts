import { expect, it } from 'vitest'
import { createPyodideBackend, type PyodideWorker } from '../src/pyodide/index.js'

interface Message {
  type: string
  id?: number
}

class ScriptedWorker implements PyodideWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  runs: number[] = []

  postMessage(message: unknown): void {
    const request = message as Message
    queueMicrotask(() => {
      if (request.type === 'boot') this.emit({ type: 'ready', version: '314.0.7', python: '3.14.2' })
      if (request.type === 'run' && request.id !== undefined) this.runs.push(request.id)
    })
  }

  terminate(): void {}

  emit(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const host = () => {
  const writes: string[] = []
  return { writes, write: (text: string) => void writes.push(text), locale: 'en' as const }
}

it('ignores worker replies of the wrong shape and keeps the session working', async () => {
  const worker = new ScriptedWorker()
  const target = host()
  const backend = createPyodideBackend({ createWorker: () => worker })
  await backend.init(target)
  const chunks: string[] = []
  const running = backend.run('print(1)', {
    write: (text) => void chunks.push(text),
    signal: new AbortController().signal,
    columns: 80,
    rows: 24,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const id = worker.runs[0]
  const forged: unknown[] = [
    null,
    undefined,
    42,
    'done',
    [],
    { type: 'output', id, text: 42 },
    { type: 'output', id: 'x', text: 'wrong id\n' },
    { type: 'done', id: String(id), exitCode: 0 },
    { type: 'done', id, exitCode: '0' },
    { type: 'done', id, exitCode: Number.NaN },
    { type: 'checked', id: 1, complete: 'yes' },
    { type: 'ready', version: 7, python: null },
    { type: 'boot-error', message: { text: 'x' } },
    { type: 'unknown' },
  ]
  for (const data of forged) expect(() => worker.emit(data)).not.toThrow()
  worker.emit({ type: 'output', id, text: '1\n' })
  worker.emit({ type: 'done', id, exitCode: 0 })
  expect([await running, chunks, target.writes]).toEqual([
    { output: '', exitCode: 0 },
    ['1\n'],
    ['Python 3.14.2 (pyodide 314.0.7)\n'],
  ])
  backend.dispose()
})
