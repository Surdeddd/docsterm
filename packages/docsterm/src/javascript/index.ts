import { formatMessage, getMessages } from '../messages.js'
import type { BackendHost, BackendRunResult, Locale, RunContext, SimpleBackend } from '../types.js'
import type { WorkerLike } from '../worker-like.js'
import { createInspector } from './inspect.js'
import { workerRuntime, type HostMessage } from './runtime.js'
import { isCompleteSource, preloadTransform, transformSource } from './transform.js'

export type { HostMessage, InitMessage, RunMessage, WorkerMessage } from './runtime.js'
export type { WorkerLike } from '../worker-like.js'

export interface JavaScriptBackendOptions {
  timeoutMs?: number
  initTimeoutMs?: number
  outputLimit?: number
  banner?: string
  prompt?: string
  globals?: Record<string, unknown>
  baseURL?: string
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

export const WORKER_SOURCE = `;(${workerRuntime.toString()})(self, ${createInspector.toString()})\n`

const CSP_DIRECTIVE = "worker-src blob:; script-src 'unsafe-eval'"
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_INIT_TIMEOUT_MS = 10_000
const DEFAULT_OUTPUT_LIMIT = 1_048_576
const MAX_DELAY_MS = 2 ** 31 - 1
const DESCRIPTION_LIMIT = 600
const EARLY_CRASH_LIMIT = 3
const EXIT_INTERRUPTED = 130
const EXIT_TIMED_OUT = 124

type Reason = (locale: Locale) => string

interface Budget {
  used: number
  full: boolean
}

interface PendingRun {
  id: number
  code: string
  declarations: string
  context?: RunContext
  logs: string[]
  budget: Budget
  timer: ReturnType<typeof setTimeout> | null
  detach(): void
  settle(result: BackendRunResult): void
}

interface Slot {
  worker: WorkerLike
  replied: boolean
}

interface Starting {
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
}

function normalizeTimeout(value: number | undefined, fallback: number): number | null {
  const ms = value ?? fallback
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.min(ms, MAX_DELAY_MS)
}

function normalizeLimit(value: number | undefined): number | null {
  const limit = value ?? DEFAULT_OUTPUT_LIMIT
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null
}

function formatSeconds(ms: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3, useGrouping: false }).format(ms / 1000)
}

function pageBaseURL(): string | null {
  if (typeof document !== 'undefined' && typeof document.baseURI === 'string') return document.baseURI
  if (typeof location !== 'undefined' && typeof location.href === 'string') return location.href
  return null
}

function isSecurityError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'SecurityError'
}

const cspBlocked: Reason = (locale) => formatMessage(getMessages(locale).cspBlocked, { directive: CSP_DIRECTIVE })

const restarted: Reason = (locale) => getMessages(locale).runtimeRestarted

const notCloneable =
  (name: string): Reason =>
  (locale) =>
    formatMessage(getMessages(locale).jsGlobalNotCloneable, { name })

const initTimedOut =
  (ms: number): Reason =>
  (locale) =>
    formatMessage(getMessages(locale).jsInitTimedOut, { seconds: formatSeconds(ms, locale) })

const failedToStart =
  (detail: string | null): Reason =>
  (locale) => {
    const messages = getMessages(locale)
    return `${detail === null ? messages.backendFailed : `${messages.backendFailed}: ${detail}`}\n${messages.reloadHint}`
  }

const parserFailed: Reason = (locale) => `${getMessages(locale).jsParserFailed}\n${getMessages(locale).reloadHint}`

function cloneGlobals(source: Record<string, unknown> | undefined): { globals: Record<string, unknown> } | { failed: Reason } {
  const globals: Record<string, unknown> = {}
  if (!source) return { globals }
  for (const name of Object.keys(source)) {
    try {
      globals[name] = typeof structuredClone === 'function' ? structuredClone(source[name]) : source[name]
    } catch {
      return { failed: notCloneable(name) }
    }
  }
  return { globals }
}

function blobWorkerFactory(): { create(): WorkerLike; release(): void } {
  let url: string | null = null
  return {
    create(): WorkerLike {
      url ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
      return new Worker(url)
    },
    release(): void {
      if (url !== null) URL.revokeObjectURL(url)
      url = null
    },
  }
}

function describeRuntime(limit: number | null, globals: Record<string, unknown> | undefined, locale: Locale): string {
  const messages = getMessages(locale)
  const parts = [messages.jsReplDescription]
  if (limit !== null) parts.push(formatMessage(messages.jsTimeoutNote, { seconds: formatSeconds(limit, locale) }))
  const room = DESCRIPTION_LIMIT - parts.join(' ').length - formatMessage(messages.jsGlobals, { names: '' }).length - 1
  let list = ''
  for (const name of Object.keys(globals ?? {})) {
    const next = list === '' ? name : `${list}, ${name}`
    if (next.length > room) break
    list = next
  }
  if (list !== '') parts.push(formatMessage(messages.jsGlobals, { names: list }))
  return parts.join(' ')
}

export function createJavaScriptBackend(options: JavaScriptBackendOptions = {}): SimpleBackend {
  const limit = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const initLimit = normalizeTimeout(options.initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS)
  const outputLimit = normalizeLimit(options.outputLimit)
  const blob = options.createWorker ? null : blobWorkerFactory()
  const createWorker = options.createWorker ?? (() => (blob as ReturnType<typeof blobWorkerFactory>).create())
  const queue: PendingRun[] = []
  let host: BackendHost | null = null
  let slot: Slot | null = null
  let active: PendingRun | null = null
  let starting: Starting | null = null
  let broken: Reason | null = null
  let background: Budget = { used: 0, full: false }
  let proven = false
  let earlyCrashes = 0
  let counter = 0
  let lifetime = 0

  const localeOf = (context?: RunContext): Locale => context?.locale ?? host?.locale ?? 'en'

  const finish = (run: PendingRun, result: BackendRunResult): void => {
    if (run.timer !== null) clearTimeout(run.timer)
    run.timer = null
    run.detach()
    run.settle(result)
  }

  const takePending = (): PendingRun[] => {
    const pending = active === null ? [] : [active]
    active = null
    return pending.concat(queue.splice(0))
  }

  const stopWorker = (): void => {
    const previous = slot
    slot = null
    previous?.worker.terminate()
  }

  const settleStarting = (error?: Error): void => {
    const waiting = starting
    starting = null
    if (waiting === null) return
    if (waiting.timer !== null) clearTimeout(waiting.timer)
    if (error) waiting.reject(error)
    else waiting.resolve()
  }

  const breakDown = (reason: Reason): void => {
    broken = reason
    stopWorker()
    for (const run of takePending()) finish(run, { output: reason(localeOf(run.context)), exitCode: 1 })
    settleStarting(new Error(reason(localeOf())))
  }

  const routeLog = (id: number | null, text: string): void => {
    const run = active !== null && active.id === id ? active : null
    const budget = run === null ? background : run.budget
    if (budget.full) return
    let kept = `${text}\n`
    let note: string | null = null
    if (outputLimit !== null && budget.used + kept.length > outputLimit) {
      budget.full = true
      kept = kept.slice(0, outputLimit - budget.used)
      if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1)
      note = formatMessage(getMessages(localeOf(run?.context)).wasiOutputLimit, { limit: outputLimit })
    }
    budget.used += kept.length
    if (run !== null && !run.context) {
      if (kept !== '') run.logs.push(kept.endsWith('\n') ? kept.slice(0, -1) : kept)
      if (note !== null) run.logs.push(note)
      return
    }
    const write = (piece: string): void => {
      if (run === null) host?.write(piece)
      else run.context?.write(piece)
    }
    if (kept !== '') write(kept)
    if (note !== null) write(`${kept === '' || kept.endsWith('\n') ? '' : '\n'}${note}\n`)
  }

  const complete = (id: number, value: string | undefined, error: string | undefined): void => {
    const run = active
    if (run === null || run.id !== id) return
    active = null
    finish(run, buildOutput({ id, logs: run.logs, value, error }))
    pump()
  }

  const receive = (current: Slot, data: unknown): void => {
    if (typeof data !== 'object' || data === null) return
    const message = data as Record<string, unknown>
    current.replied = true
    if (message.type === 'ready') {
      if (message.evalBlocked === true) {
        breakDown(cspBlocked)
        return
      }
      proven = true
      earlyCrashes = 0
      settleStarting()
    } else if (message.type === 'log' && typeof message.text === 'string') {
      routeLog(typeof message.id === 'number' ? message.id : null, message.text)
    } else if (message.type === 'result' && typeof message.id === 'number') {
      complete(
        message.id,
        typeof message.value === 'string' ? message.value : undefined,
        typeof message.error === 'string' ? message.error : undefined,
      )
    }
  }

  const crash = (current: Slot, event: unknown): void => {
    const details = (typeof event === 'object' && event !== null ? event : {}) as {
      preventDefault?: () => void
      message?: unknown
    }
    if (typeof details.preventDefault === 'function') details.preventDefault()
    const detail = typeof details.message === 'string' && details.message !== '' ? details.message : null
    if (current.replied) {
      routeLog(active === null ? null : active.id, detail ?? getMessages(localeOf(active?.context)).backendError)
    } else if (proven) {
      recover(detail)
    } else {
      breakDown(cspBlocked)
    }
  }

  const recover = (detail: string | null): void => {
    earlyCrashes += 1
    if (earlyCrashes >= EARLY_CRASH_LIMIT) {
      breakDown(failedToStart(detail))
      return
    }
    const run = active
    active = null
    stopWorker()
    if (run !== null) {
      const text = detail ?? getMessages(localeOf(run.context)).backendError
      finish(run, { output: run.logs.concat(text).join('\n'), exitCode: 1 })
    }
    const failure = launch()
    if (failure === null) pump()
    else breakDown(failure)
  }

  const spawn = (globals: Record<string, unknown>): void => {
    const current: Slot = { worker: createWorker(), replied: false }
    slot = current
    current.worker.onmessage = (event) => {
      if (slot === current) receive(current, event.data)
    }
    current.worker.onerror = (event) => {
      if (slot === current) crash(current, event)
    }
    const init: HostMessage = { type: 'init', globals, baseURL: options.baseURL ?? pageBaseURL() }
    current.worker.postMessage(init)
  }

  const launch = (): Reason | null => {
    const cloned = cloneGlobals(options.globals)
    if ('failed' in cloned) return cloned.failed
    try {
      spawn(cloned.globals)
      return null
    } catch (error) {
      stopWorker()
      if (isSecurityError(error)) return cspBlocked
      const text = error instanceof Error ? error.message : String(error)
      return () => text
    }
  }

  const restart = (): Reason | null => {
    stopWorker()
    const failure = launch()
    if (failure !== null) breakDown(failure)
    return failure
  }

  const interruptQueued = (runs: PendingRun[], notice: Reason): void => {
    for (const run of runs) finish(run, { output: notice(localeOf(run.context)), exitCode: EXIT_INTERRUPTED })
  }

  const expire = (run: PendingRun): void => {
    run.timer = null
    if (active !== run) return
    active = null
    const queued = queue.splice(0)
    const notice = restart() ?? restarted
    const locale = localeOf(run.context)
    const timedOut = formatMessage(getMessages(locale).timedOut, { seconds: formatSeconds(limit ?? 0, locale) })
    finish(run, { output: run.logs.concat(timedOut, notice(locale)).join('\n'), exitCode: EXIT_TIMED_OUT })
    interruptQueued(queued, notice)
  }

  const pump = (): void => {
    if (active !== null || slot === null) return
    const run = queue.shift()
    if (run === undefined) return
    active = run
    background = { used: 0, full: false }
    if (limit !== null) run.timer = setTimeout(() => expire(run), limit)
    const message: HostMessage = {
      type: 'run',
      id: run.id,
      code: run.code,
      declarations: run.declarations,
      columns: run.context?.columns ?? 80,
      outputLimit,
    }
    slot.worker.postMessage(message)
  }

  const announce = (text: string): void => {
    const target = host
    const ticket = lifetime
    setTimeout(() => {
      if (target !== null && host === target && lifetime === ticket) target.write(`${text}\n`)
    }, 0)
  }

  const abort = (run: PendingRun): void => {
    const index = queue.indexOf(run)
    if (index !== -1) {
      queue.splice(index, 1)
      finish(run, { output: '', exitCode: EXIT_INTERRUPTED })
      return
    }
    if (active !== run) return
    active = null
    const queued = queue.splice(0)
    const notice = restart() ?? restarted
    finish(run, { output: '', exitCode: EXIT_INTERRUPTED })
    interruptQueued(queued, notice)
    announce(notice(localeOf()))
  }

  const unavailable = (locale: Locale): BackendRunResult | null => {
    if (broken !== null) return { output: broken(locale), exitCode: 1 }
    if (slot === null || starting !== null) return { output: getMessages(locale).notReady, exitCode: 1 }
    return null
  }

  const shutdown = (): void => {
    lifetime += 1
    for (const run of takePending()) finish(run, { output: '', exitCode: EXIT_INTERRUPTED })
    stopWorker()
    settleStarting()
    broken = null
    proven = false
    earlyCrashes = 0
    background = { used: 0, full: false }
  }

  return {
    id: 'javascript',
    prompt: options.prompt ?? '> ',
    continuationPrompt: '... ',

    async init(backendHost: BackendHost): Promise<void> {
      shutdown()
      host = backendHost
      const ticket = lifetime
      preloadTransform()
      const ready = new Promise<void>((resolve, reject) => {
        starting = { resolve, reject, timer: null }
      })
      const failure = launch()
      if (failure !== null) {
        starting = null
        broken = failure
        throw new Error(failure(localeOf()))
      }
      const waiting = starting
      if (waiting !== null && initLimit !== null) {
        waiting.timer = setTimeout(() => {
          waiting.timer = null
          if (starting === waiting) breakDown(initTimedOut(initLimit))
        }, initLimit)
      }
      await ready
      if (ticket === lifetime && options.banner) backendHost.write(`${options.banner}\n`)
    },

    async run(command: string, context?: RunContext): Promise<BackendRunResult> {
      const locale = localeOf(context)
      const refused = unavailable(locale)
      if (refused !== null) return refused
      if (context?.signal?.aborted) return { output: '', exitCode: EXIT_INTERRUPTED }
      const ticket = lifetime
      const transformed = await transformSource(command).catch(() => null)
      if (ticket !== lifetime || context?.signal?.aborted) return { output: '', exitCode: EXIT_INTERRUPTED }
      const late = unavailable(locale)
      if (late !== null) return late
      if (transformed === null) return { output: parserFailed(locale), exitCode: 1 }
      if (!transformed.ok) return { output: transformed.error, exitCode: 1 }
      return new Promise<BackendRunResult>((resolve) => {
        const run: PendingRun = {
          id: (counter += 1),
          code: transformed.code,
          declarations: transformed.declarations,
          context,
          logs: [],
          budget: { used: 0, full: false },
          timer: null,
          detach: () => {},
          settle: resolve,
        }
        const signal = context?.signal
        if (signal) {
          const onAbort = (): void => abort(run)
          signal.addEventListener('abort', onAbort, { once: true })
          run.detach = () => signal.removeEventListener('abort', onAbort)
        }
        queue.push(run)
        pump()
      })
    },

    isComplete(source: string): Promise<boolean> {
      return isCompleteSource(source).catch(() => true)
    },

    describe(): string {
      return describeRuntime(limit, options.globals, localeOf())
    },

    dispose(): void {
      shutdown()
      blob?.release()
      host = null
    },
  }
}
