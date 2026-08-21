import type { Backend, BackendHost, BackendRunResult } from '../types.js'
import { loadPyodide, type PyodideInterface } from 'pyodide'

export const PYODIDE_VERSION = '314.0.5'
const DEFAULT_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

export interface PyodideBackendOptions {
  indexURL?: string
}

const FRAME_RE = /^ {2}File "(.+?)"/

export function formatPythonError(raw: string): string {
  const lines = raw.replace(/\r/g, '').split('\n')
  const start = lines.findIndex((line) => line.startsWith('Traceback'))
  const scoped = start === -1 ? lines : lines.slice(start)
  const kept: string[] = []
  let skippingFrame = false
  for (const line of scoped) {
    const frame = FRAME_RE.exec(line)
    if (frame) {
      const path = frame[1] ?? ''
      skippingFrame = path.includes('_pyodide') || path.includes('/lib/python')
      if (!skippingFrame) kept.push(line)
      continue
    }
    if (skippingFrame && line.startsWith('    ')) continue
    skippingFrame = false
    kept.push(line)
  }
  return kept.join('\n').trim()
}

export function createPyodideBackend(options: PyodideBackendOptions = {}): Backend {
  let py: PyodideInterface | null = null
  let host: BackendHost | null = null
  let capture: string[] | null = null
  let disposed = false

  const sink = (line: string) => {
    if (capture) capture.push(`${line}\n`)
    else host?.write(`${line}\n`)
  }

  return {
    id: 'pyodide',
    prompt: '>>> ',
    async init(backendHost: BackendHost): Promise<void> {
      host = backendHost
      if (py) return
      const instance = await loadPyodide({ indexURL: options.indexURL ?? DEFAULT_INDEX_URL })
      instance.setStdout({ batched: sink })
      instance.setStderr({ batched: sink })
      if (disposed) return
      py = instance
      const version = instance.runPython('import sys; sys.version.split()[0]') as string
      host.write(`Python ${version} (pyodide ${PYODIDE_VERSION})\n`)
    },
    async run(command: string): Promise<BackendRunResult> {
      if (!py) return { output: 'python environment is not ready yet', exitCode: 1 }
      capture = []
      try {
        const result = await py.runPythonAsync(command)
        let output = capture.join('')
        if (result !== undefined && result !== null) {
          const value = result as { destroy?: () => void }
          output += `${String(result)}\n`
          if (typeof value.destroy === 'function') value.destroy()
        }
        return { output: output.replace(/\n$/, ''), exitCode: 0 }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const printed = capture.join('')
        const traceback = formatPythonError(message)
        return {
          output: [printed.replace(/\n$/, ''), traceback].filter(Boolean).join('\n'),
          exitCode: 1,
        }
      } finally {
        capture = null
      }
    },
    dispose(): void {
      disposed = true
      py = null
      host = null
    },
  }
}
