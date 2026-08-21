import type { Backend, BackendHost, BackendRunResult } from '../types.js'

export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface JavaScriptBackendOptions {
  timeoutMs?: number
  banner?: string
  prompt?: string
  globals?: Record<string, unknown>
  createWorker?: () => WorkerLike
}

export interface EvalReply {
  id: number
  logs?: string[]
  value?: string
  error?: string
}

export function buildOutput(reply: EvalReply): BackendRunResult {
  const parts = [...(reply.logs ?? [])]
  if (reply.error) {
    parts.push(reply.error)
    return { output: parts.join('\n'), exitCode: 1 }
  }
  if (reply.value !== undefined) parts.push(reply.value)
  return { output: parts.join('\n'), exitCode: 0 }
}

export function persistTopLevelDeclarations(source: string): string {
  return source.replace(/^(\s*)(?:const|let)\s+/gm, '$1var ')
}

export const WORKER_SOURCE = `
const persistTopLevelDeclarations = ${persistTopLevelDeclarations.toString()}

const format = (value, quoteStrings) => {
  if (typeof value === 'string') return quoteStrings ? JSON.stringify(value) : value
  if (typeof value === 'bigint') return String(value) + 'n'
  if (typeof value === 'function') return '[Function: ' + (value.name || 'anonymous') + ']'
  if (value instanceof Error) return value.name + ': ' + value.message
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    return JSON.stringify(value, (_, inner) => (typeof inner === 'bigint' ? String(inner) + 'n' : inner), 2)
  } catch {
    return String(value)
  }
}

let logs = []
const capture = (...args) => logs.push(args.map((arg) => format(arg, false)).join(' '))
console.log = capture
console.info = capture
console.warn = capture
console.error = capture
console.debug = capture

self.onmessage = async (event) => {
  const { id, code, globals } = event.data
  logs = []
  if (globals) for (const [key, value] of Object.entries(globals)) self[key] = value
  const source = persistTopLevelDeclarations(code)
  let value
  let error
  try {
    try {
      value = (0, eval)(source)
    } catch (syntaxError) {
      if (syntaxError instanceof SyntaxError) {
        value = (0, eval)('(async () => {' + source + '})()')
      } else {
        throw syntaxError
      }
    }
    if (value && typeof value.then === 'function') value = await value
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.name + ': ' + thrown.message : String(thrown)
  }
  self.postMessage({
    id,
    logs,
    value: error === undefined && value !== undefined ? format(value, true) : undefined,
    error,
  })
}
`

const defaultWorkerFactory = (): WorkerLike => {
  const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' })
  return new Worker(URL.createObjectURL(blob)) as unknown as WorkerLike
}

export function createJavaScriptBackend(options: JavaScriptBackendOptions = {}): Backend {
  const timeoutMs = options.timeoutMs ?? 10_000
  const factory = options.createWorker ?? defaultWorkerFactory
  let worker: WorkerLike | null = null
  let counter = 0
  let host: BackendHost | null = null

  const pending = new Map<number, (reply: EvalReply) => void>()

  const spawn = (): WorkerLike => {
    const instance = factory()
    instance.onmessage = (event) => {
      const reply = event.data as EvalReply
      const resolve = pending.get(reply.id)
      if (!resolve) return
      pending.delete(reply.id)
      resolve(reply)
    }
    instance.onerror = () => {
      for (const [id, resolve] of pending) resolve({ id, error: 'worker crashed' })
      pending.clear()
    }
    return instance
  }

  const restart = () => {
    worker?.terminate()
    pending.clear()
    worker = spawn()
  }

  return {
    id: 'javascript',
    prompt: options.prompt ?? '> ',

    async init(backendHost: BackendHost): Promise<void> {
      host = backendHost
      worker = spawn()
      if (options.banner) host.write(`${options.banner}\n`)
    },

    async run(command: string): Promise<BackendRunResult> {
      if (!worker) return { output: 'javascript runtime is not ready yet', exitCode: 1 }
      const id = (counter += 1)
      const reply = await new Promise<EvalReply>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          restart()
          resolve({ id, error: `timed out after ${timeoutMs}ms (runtime restarted)` })
        }, timeoutMs)
        pending.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
        worker?.postMessage({ id, code: command, globals: options.globals })
      })
      return buildOutput(reply)
    },

    dispose(): void {
      worker?.terminate()
      worker = null
      pending.clear()
      host = null
    },
  }
}
