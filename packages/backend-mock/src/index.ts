import type { Backend, BackendHost, BackendRunResult } from 'docsterm'

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createMockBackend(options: MockBackendOptions): Backend {
  return {
    id: 'mock',
    prompt: options.prompt ?? '$ ',
    async init(host: BackendHost): Promise<void> {
      if (options.banner) host.write(`${options.banner}\n`)
    },
    async run(command: string): Promise<BackendRunResult> {
      const key = command.trim()
      const entry = options.script[key] ?? options.fallback ?? {
        output: `command not found: ${key}`,
        exitCode: 127,
      }
      if (entry.delayMs) await wait(entry.delayMs)
      return { output: entry.output, exitCode: entry.exitCode ?? 0 }
    },
    dispose(): void {},
  }
}
