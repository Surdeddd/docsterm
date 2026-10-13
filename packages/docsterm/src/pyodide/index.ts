import { formatMessage, getMessages, type Messages } from '../messages.js'
import type { BackendHost, BackendRunResult, Locale, RunContext, SimpleBackend } from '../types.js'
import { WorkerBlockedError, WorkerSession, type PyodideWorker, type RuntimeInfo } from './session.js'

export { PYODIDE_WORKER_SOURCE } from './worker-source.js'
export type { PyodideWorker } from './session.js'
export type { WorkerLike } from '../worker-like.js'

export const DEFAULT_PYODIDE_VERSION = '314.0.7'
export const PYODIDE_VERSION = DEFAULT_PYODIDE_VERSION

const DEFAULT_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${DEFAULT_PYODIDE_VERSION}/full/`
const DEFAULT_PACKAGES = ['micropip']
const WORKER_DIRECTIVE = 'worker-src blob:'

export interface PyodideBackendOptions {
  indexURL?: string
  packages?: readonly string[]
  prompt?: string
  createWorker?: (source: string) => PyodideWorker
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

const MAX_RESPAWNS = 3

const bootFailure = (error: unknown, messages: Messages, proven: boolean): Error => {
  if (error instanceof WorkerBlockedError && !proven) {
    return new Error(formatMessage(messages.cspBlocked, { directive: WORKER_DIRECTIVE }))
  }
  return error instanceof Error ? error : new Error(String(error))
}

const pageBase = (): string | undefined => {
  if (typeof document !== 'undefined') return document.baseURI
  return typeof location === 'undefined' ? undefined : location.href
}

const absoluteIndexURL = (raw: string): string => {
  const withSlash = raw.endsWith('/') ? raw : `${raw}/`
  try {
    return new URL(withSlash, pageBase()).href
  } catch {
    return withSlash
  }
}

const isIsolated = (): boolean =>
  typeof SharedArrayBuffer === 'function' &&
  (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true

const createBlobWorker = (source: string): PyodideWorker => {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const worker = new Worker(url, { type: 'module', name: 'docsterm-pyodide' })
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => {
      terminate()
      URL.revokeObjectURL(url)
    }
    return worker
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

const describeRuntime = (runtime: RuntimeInfo | null, locale: Locale): string => {
  const messages = getMessages(locale)
  const name = runtime
    ? formatMessage(messages.pyodideRuntime, { python: runtime.python, pyodide: runtime.pyodide })
    : messages.pyodideRuntimeUnknown
  return formatMessage(messages.pyodideDescription, { runtime: name })
}

export function createPyodideBackend(options: PyodideBackendOptions = {}): SimpleBackend {
  const packages = [...(options.packages ?? DEFAULT_PACKAGES)]
  const createWorker = options.createWorker ?? createBlobWorker
  let host: BackendHost | null = null
  let session: WorkerSession | null = null
  let runtime: RuntimeInfo | null = null
  let lastLocale: Locale | undefined
  let generation = 0
  let crashes = 0
  let queue: Promise<unknown> = Promise.resolve()

  const localeOf = (context?: RunContext): Locale => context?.locale ?? host?.locale ?? 'en'

  const open = (): WorkerSession =>
    new WorkerSession({
      indexURL: absoluteIndexURL(options.indexURL ?? DEFAULT_INDEX_URL),
      packages,
      isolated: isIsolated(),
      createWorker,
      onOutput: (text) => host?.write(text),
      onStuck: (stale) => restart(stale),
    })

  const restart = (stale: WorkerSession): void => {
    if (session !== stale) return
    stale.close(130)
    session = open()
    if (host) host.write(`${getMessages(lastLocale ?? host.locale ?? 'en').runtimeRestarted}\n`)
  }

  const settled = async (): Promise<WorkerSession | null> => {
    for (;;) {
      const current = session
      if (!current) return null
      try {
        await current.ready
      } catch (error) {
        if (current === session) throw error
        continue
      }
      if (current === session) return current
    }
  }

  const execute = async (command: string, born: number, context?: RunContext): Promise<BackendRunResult> => {
    const messages = getMessages(localeOf(context))
    if (born !== generation) return { output: '', exitCode: 130 }
    if (!session) return { output: messages.notReady, exitCode: 1 }
    let current: WorkerSession | null
    try {
      current = await settled()
    } catch (error) {
      const proven = runtime !== null
      const reason = bootFailure(error, messages, proven).message
      if (proven && crashes < MAX_RESPAWNS && born === generation) {
        crashes += 1
        session = open()
      }
      return { output: `${messages.backendFailed}: ${reason}\n${messages.reloadHint}`, exitCode: 1 }
    }
    crashes = 0
    if (!current || born !== generation || context?.signal.aborted) return { output: '', exitCode: 130 }
    lastLocale = localeOf(context)
    return current.run(command, messages.inputUnsupported, context)
  }

  const judge = async (source: string, born: number): Promise<boolean> => {
    for (;;) {
      let current: WorkerSession | null
      try {
        current = await settled()
      } catch {
        return true
      }
      if (!current || born !== generation) return true
      const verdict = await current.check(source)
      if (verdict !== null) return verdict
      if (current === session) return true
    }
  }

  return {
    id: 'pyodide',
    prompt: options.prompt ?? '>>> ',
    continuationPrompt: '... ',

    async init(nextHost: BackendHost): Promise<void> {
      host = nextHost
      if (!session?.usable) session = open()
      const current = session
      let info: RuntimeInfo
      try {
        info = await current.ready
      } catch (error) {
        if (current !== session) return
        throw bootFailure(error, getMessages(nextHost.locale ?? 'en'), runtime !== null)
      }
      if (current !== session) return
      runtime = info
      nextHost.write(`Python ${info.python} (pyodide ${info.pyodide})\n`)
    },

    run(command: string, context?: RunContext): Promise<BackendRunResult> {
      const born = generation
      const result = queue.then(() => execute(command, born, context))
      queue = result.catch(() => undefined)
      return result
    },

    isComplete(source: string): Promise<boolean> {
      return judge(source, generation)
    },

    describe: () => describeRuntime(runtime, localeOf()),

    dispose(): void {
      generation += 1
      host = null
      const current = session
      session = null
      current?.close(130)
    },
  }
}
