import type { BackendHost, BackendRunResult, RunContext, SimpleBackend } from '../types.js'

export interface MockScriptEntry {
  output: string
  exitCode?: number
  delayMs?: number
}

export interface MockBackendOptions {
  script: Record<string, MockScriptEntry>
  fallback?: MockScriptEntry
  prompt?: string
  banner?: string
}

const INTERRUPTED: BackendRunResult = { output: '', exitCode: 130 }

const wait = (ms: number, signal?: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    const done = (finished: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(finished)
    }
    const abort = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', abort, { once: true })
  })

export function createMockBackend(options: MockBackendOptions): SimpleBackend {
  return {
    id: 'mock',
    prompt: options.prompt ?? '$ ',
    async init(host: BackendHost): Promise<void> {
      if (options.banner) host.write(`${options.banner}\n`)
    },
    async run(command: string, context?: RunContext): Promise<BackendRunResult> {
      if (context?.signal.aborted) return INTERRUPTED
      const key = command.trim()
      const entry = options.script[key] ?? options.fallback ?? {
        output: `command not found: ${key}`,
        exitCode: 127,
      }
      if (entry.delayMs && !(await wait(entry.delayMs, context?.signal))) return INTERRUPTED
      return { output: entry.output, exitCode: entry.exitCode ?? 0 }
    },
    dispose(): void {},
  }
}
