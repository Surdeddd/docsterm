import type { BackendRunResult, RunContext } from '../types.js'
import type { WorkerLike } from '../worker-like.js'
import { PYODIDE_WORKER_SOURCE } from './worker-source.js'

export type PyodideWorker = WorkerLike

export interface RuntimeInfo {
  pyodide: string
  python: string
}

export interface SessionSettings {
  indexURL: string
  packages: readonly string[]
  isolated: boolean
  createWorker(source: string): PyodideWorker
  onOutput(text: string): void
  onStuck(session: WorkerSession): void
}

export class WorkerBlockedError extends Error {}

class SessionClosedError extends Error {}

type WorkerReply =
  | { type: 'ready'; version: string; python: string }
  | { type: 'boot-error'; message: string }
  | { type: 'output'; id: number | null; text: string }
  | { type: 'done'; id: number; exitCode: number }
  | { type: 'checked'; id: number; complete: boolean }

interface RunSlot {
  write(text: string): void
  finish(exitCode: number): void
}

const SIGINT = 2
const SIGINT_REPEAT_MS = 50
const INTERRUPT_GRACE_MS = 500
const ISOLATED_INTERRUPT_GRACE_MS = 3000
const CHECK_TIMEOUT_MS = 1000

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

const isId = (value: unknown): value is number => Number.isSafeInteger(value)

const parseReply = (data: unknown): WorkerReply | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const reply = data as Record<string, unknown>
  switch (reply.type) {
    case 'ready':
      return typeof reply.version === 'string' && typeof reply.python === 'string'
        ? { type: 'ready', version: reply.version, python: reply.python }
        : null
    case 'boot-error':
      return typeof reply.message === 'string' ? { type: 'boot-error', message: reply.message } : null
    case 'output':
      return typeof reply.text === 'string' && (reply.id === null || isId(reply.id))
        ? { type: 'output', id: reply.id, text: reply.text }
        : null
    case 'done':
      return isId(reply.id) && Number.isFinite(reply.exitCode)
        ? { type: 'done', id: reply.id, exitCode: reply.exitCode as number }
        : null
    case 'checked':
      return isId(reply.id) && typeof reply.complete === 'boolean'
        ? { type: 'checked', id: reply.id, complete: reply.complete }
        : null
    default:
      return null
  }
}

const preventDefault = (event: unknown): void => {
  const cancel = (event as { preventDefault?: unknown } | null)?.preventDefault
  if (typeof cancel === 'function') cancel.call(event)
}

const eventText = (event: unknown): string => {
  const message = (event as { message?: unknown } | null)?.message
  const text = typeof message === 'string' && message !== '' ? message : String(event)
  return text.endsWith('\n') ? text : `${text}\n`
}

export class WorkerSession {
  readonly ready: Promise<RuntimeInfo>
  info: RuntimeInfo | null = null
  private readonly settings: SessionSettings
  private readonly buffer: Uint8Array | null
  private readonly runs = new Map<number, RunSlot>()
  private readonly checks = new Map<number, (complete: boolean | null) => void>()
  private worker: PyodideWorker | null = null
  private closed = false
  private counter = 0
  private resolveBoot: (info: RuntimeInfo) => void = () => undefined
  private rejectBoot: (error: Error) => void = () => undefined

  constructor(settings: SessionSettings) {
    this.settings = settings
    this.buffer = settings.isolated ? new Uint8Array(new SharedArrayBuffer(1)) : null
    this.ready = new Promise<RuntimeInfo>((resolve, reject) => {
      this.resolveBoot = resolve
      this.rejectBoot = reject
    })
    this.ready.catch(() => undefined)
    this.start()
  }

  get usable(): boolean {
    return !this.closed
  }

  run(code: string, inputMessage: string, context?: RunContext): Promise<BackendRunResult> {
    return new Promise((resolve) => {
      const id = (this.counter += 1)
      const signal = context?.signal
      let output = ''
      let aborted = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let repeat: ReturnType<typeof setInterval> | undefined
      const onAbort = () => {
        if (aborted || !this.runs.has(id)) return
        aborted = true
        this.post({ type: 'interrupt', id })
        if (this.buffer) {
          this.signalInterrupt()
          repeat = setInterval(() => this.signalInterrupt(), SIGINT_REPEAT_MS)
        }
        timer = setTimeout(
          () => this.settings.onStuck(this),
          this.buffer ? ISOLATED_INTERRUPT_GRACE_MS : INTERRUPT_GRACE_MS,
        )
      }
      this.runs.set(id, {
        write: (text) => {
          if (aborted) return
          if (context) context.write(text)
          else output += text
        },
        finish: (exitCode) => {
          this.runs.delete(id)
          clearTimeout(timer)
          clearInterval(repeat)
          signal?.removeEventListener('abort', onAbort)
          resolve({ output: context ? '' : output.replace(/\n$/, ''), exitCode: aborted ? 130 : exitCode })
        },
      })
      if (this.closed) {
        this.runs.get(id)?.finish(130)
        return
      }
      signal?.addEventListener('abort', onAbort)
      if (this.buffer) this.buffer[0] = 0
      this.post({ type: 'run', id, code, inputMessage })
    })
  }

  check(source: string): Promise<boolean | null> {
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      const id = (this.counter += 1)
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (complete: boolean | null) => {
        clearTimeout(timer)
        this.checks.delete(id)
        resolve(complete)
      }
      if (this.runs.size === 0) timer = setTimeout(() => settle(true), CHECK_TIMEOUT_MS)
      this.checks.set(id, settle)
      this.post({ type: 'check', id, source })
    })
  }

  close(exitCode: number): void {
    if (this.closed) return
    this.closed = true
    const worker = this.worker
    this.worker = null
    for (const slot of this.runs.values()) slot.finish(exitCode)
    for (const settle of this.checks.values()) settle(null)
    this.rejectBoot(new SessionClosedError('session closed'))
    worker?.terminate()
  }

  private start(): void {
    let worker: PyodideWorker
    try {
      worker = this.settings.createWorker(PYODIDE_WORKER_SOURCE)
    } catch (error) {
      this.closed = true
      this.rejectBoot(asError(error))
      return
    }
    this.worker = worker
    worker.onmessage = (event) => {
      const reply = parseReply(event.data)
      if (reply) this.receive(reply)
    }
    worker.onerror = (event) => this.workerError(event)
    worker.postMessage({
      type: 'boot',
      indexURL: this.settings.indexURL,
      packages: [...this.settings.packages],
      buffer: this.buffer,
    })
  }

  private receive(reply: WorkerReply): void {
    if (this.closed) return
    if (reply.type === 'ready') {
      this.info = { pyodide: reply.version, python: reply.python }
      this.resolveBoot(this.info)
    } else if (reply.type === 'boot-error') {
      this.rejectBoot(new Error(reply.message))
      this.close(1)
    } else if (reply.type === 'output') {
      const slot = reply.id === null ? undefined : this.runs.get(reply.id)
      if (slot) slot.write(reply.text)
      else this.settings.onOutput(reply.text)
    } else if (reply.type === 'done') {
      this.runs.get(reply.id)?.finish(reply.exitCode)
    } else if (reply.type === 'checked') {
      this.checks.get(reply.id)?.(reply.complete)
    }
  }

  private workerError(event: unknown): void {
    preventDefault(event)
    if (this.closed) return
    if (this.info) {
      this.report(eventText(event))
      return
    }
    this.rejectBoot(new WorkerBlockedError(eventText(event).trimEnd()))
    this.close(1)
  }

  private report(text: string): void {
    const active = this.runs.values().next().value
    if (active) active.write(text)
    else this.settings.onOutput(text)
  }

  private signalInterrupt(): void {
    if (this.buffer) this.buffer[0] = SIGINT
  }

  private post(message: unknown): void {
    if (!this.closed) this.worker?.postMessage(message)
  }
}
