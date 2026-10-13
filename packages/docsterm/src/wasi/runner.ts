import type { WorkerLike } from '../worker-like.js'
import type { WasiExit } from './host.js'

export type { WorkerLike } from '../worker-like.js'

export interface WorkerJob {
  argv: string[]
  env: readonly string[]
  stdin: Uint8Array
  outputLimit: number
  write(text: string): void
  truncated(): void
}

export interface WorkerJobControls {
  signal?: AbortSignal
  timeoutMs: number | null
}

export const WORKER_UNAVAILABLE = 'unavailable'

export type WorkerOutcome = WasiExit | typeof WORKER_UNAVAILABLE

export type UnavailableReason = 'blocked' | 'stalled'

export interface WorkerRunnerOptions {
  readyTimeoutMs: number | null
  onUnavailable?(reason: UnavailableReason, detail: string): void
}

export interface WorkerRunner {
  run(job: WorkerJob, controls: WorkerJobControls): Promise<WorkerOutcome>
  dispose(): void
}

type WorkerReply =
  | { type: 'ready' }
  | { type: 'output'; id: number; text: string }
  | { type: 'truncated'; id: number }
  | { type: 'exit'; id: number; code: number; error?: string }

interface ActiveJob {
  id: number
  job: WorkerJob
  settle(outcome: WorkerOutcome): void
}

const EARLY_CRASH_LIMIT = 3

const crashText = (event: unknown): string => {
  if (event instanceof Error) return `${event.name}: ${event.message}`
  const message = (event as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : ''
}

export function createWorkerRunner(
  module: WebAssembly.Module,
  spawnWorker: () => WorkerLike,
  options: WorkerRunnerOptions,
): WorkerRunner {
  let worker: WorkerLike | null = null
  let ready = false
  let proven = false
  let unavailable = false
  let earlyCrashes = 0
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let active: ActiveJob | null = null
  let spawnError = ''
  let counter = 0

  const giveUp = (reason: UnavailableReason, detail: string) => {
    unavailable = true
    options.onUnavailable?.(reason, detail)
  }

  const settle = (outcome: WorkerOutcome) => {
    const current = active
    active = null
    current?.settle(outcome)
  }

  const stop = () => {
    clearTimeout(readyTimer)
    readyTimer = undefined
    worker?.terminate()
    worker = null
    ready = false
  }

  const receive = (reply: WorkerReply) => {
    if (reply.type === 'ready') {
      clearTimeout(readyTimer)
      readyTimer = undefined
      ready = true
      proven = true
      earlyCrashes = 0
      return
    }
    if (active === null || reply.id !== active.id) return
    if (reply.type === 'output') active.job.write(reply.text)
    else if (reply.type === 'truncated') active.job.truncated()
    else settle(reply.error === undefined ? { code: reply.code } : { code: reply.code, error: reply.error })
  }

  const fail = (reason: UnavailableReason, error: string) => {
    const started = ready
    stop()
    if (started) {
      settle({ code: 1, error })
      spawn()
      return
    }
    if (!proven) {
      giveUp(reason, error)
      settle(WORKER_UNAVAILABLE)
      return
    }
    earlyCrashes += 1
    settle({ code: 1, error })
    if (earlyCrashes < EARLY_CRASH_LIMIT) spawn()
  }

  const spawn = () => {
    let instance: WorkerLike
    try {
      instance = spawnWorker()
    } catch (error) {
      spawnError = crashText(error)
      if (!proven) giveUp('blocked', spawnError)
      return
    }
    instance.onmessage = (event) => {
      if (worker === instance) receive(event.data as WorkerReply)
    }
    instance.onerror = (event) => {
      if (worker === instance) fail('blocked', crashText(event))
    }
    worker = instance
    if (options.readyTimeoutMs !== null) {
      readyTimer = setTimeout(() => {
        if (worker === instance && !ready) fail('stalled', '')
      }, options.readyTimeoutMs)
    }
    instance.postMessage({ type: 'module', module })
  }

  const interrupt = (outcome: WasiExit) => {
    stop()
    settle(outcome)
    spawn()
  }

  spawn()

  return {
    run(job, controls) {
      if (controls.signal?.aborted) return Promise.resolve({ code: 130 })
      if (worker === null && !unavailable) spawn()
      const current = worker
      if (current === null) return Promise.resolve(unavailable ? WORKER_UNAVAILABLE : { code: 1, error: spawnError })
      const id = (counter += 1)
      return new Promise<WorkerOutcome>((resolve) => {
        const onAbort = () => interrupt({ code: 130 })
        const timer =
          controls.timeoutMs === null
            ? undefined
            : setTimeout(() => interrupt({ code: 124, timedOut: true }), controls.timeoutMs)
        active = {
          id,
          job,
          settle: (outcome) => {
            clearTimeout(timer)
            controls.signal?.removeEventListener('abort', onAbort)
            resolve(outcome)
          },
        }
        controls.signal?.addEventListener('abort', onAbort, { once: true })
        current.postMessage({
          type: 'run',
          id,
          argv: job.argv,
          env: job.env,
          stdin: job.stdin,
          outputLimit: job.outputLimit,
        })
      })
    },

    dispose() {
      stop()
      settle({ code: 130 })
    },
  }
}
