import { formatMessage, getMessages, type Messages } from '../messages.js'
import type { BackendHost, BackendRunResult, Locale, RunContext, SimpleBackend } from '../types.js'
import type { WorkerLike } from '../worker-like.js'
import { CommandLineError, isCompleteCommandLine, splitCommandLine } from './command-line.js'
import { createWasiHost, type WasiExit, type WasiInstance } from './host.js'
import {
  createWorkerRunner,
  WORKER_UNAVAILABLE,
  type UnavailableReason,
  type WorkerJob,
  type WorkerRunner,
} from './runner.js'
import { WASI_WORKER_SOURCE } from './worker-source.js'

export { CommandLineError, isCompleteCommandLine, splitCommandLine, type CommandLineProblem } from './command-line.js'
export { createWasiHost, type WasiExit, type WasiHost, type WasiHostOptions, type WasiInstance } from './host.js'
export type { WorkerLike } from '../worker-like.js'
export { WASI_WORKER_SOURCE } from './worker-source.js'

export interface WasiBackendOptions {
  url?: string
  bytes?: BufferSource
  program?: string
  args?: string[]
  env?: Record<string, string>
  banner?: string
  prompt?: string
  stdin?: string
  usage?: string
  timeoutMs?: number
  initTimeoutMs?: number
  outputLimit?: number
  worker?: boolean
  createWorker?: (source: string) => WorkerLike
  instantiate?: (imports: WebAssembly.Imports) => Promise<WasiInstance>
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_INIT_TIMEOUT_MS = 10_000
const DEFAULT_OUTPUT_LIMIT = 1_048_576
const MAX_TIMER_MS = 2_147_483_647
const DESCRIPTION_LIMIT = 600
const EXIT_INTERRUPTED = 130
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]
const WORKER_DIRECTIVE = 'worker-src blob:'

const timeoutOf = (value: number | undefined, fallback: number): number | null => {
  const ms = value ?? fallback
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : null
}

const bytesOf = (source: BufferSource): Uint8Array<ArrayBuffer> =>
  ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source)

const loadFailure = (error: unknown, source: string, messages: Messages): Error =>
  error instanceof WebAssembly.CompileError
    ? new Error(formatMessage(messages.wasiCompileFailed, { source, detail: error.message }), { cause: error })
    : new Error(formatMessage(messages.wasiFetchNetworkError, { url: source }), { cause: error })

const compileBytes = async (bytes: Uint8Array<ArrayBuffer>, source: string, messages: Messages) => {
  if (!WASM_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error(formatMessage(messages.wasiNotModule, { source }))
  }
  try {
    return await WebAssembly.compile(bytes)
  } catch (error) {
    throw error instanceof WebAssembly.CompileError ? loadFailure(error, source, messages) : error
  }
}

const download = async (url: string, messages: Messages): Promise<WebAssembly.Module> => {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(formatMessage(messages.wasiFetchNetworkError, { url }), { cause: error })
  }
  if (!response.ok) throw new Error(formatMessage(messages.wasiFetchFailed, { url, status: response.status }))
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim()
  if (type === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') {
    return WebAssembly.compileStreaming(response).catch((error: unknown) => {
      throw loadFailure(error, url, messages)
    })
  }
  let body: ArrayBuffer
  try {
    body = await response.arrayBuffer()
  } catch (error) {
    throw loadFailure(error, url, messages)
  }
  return compileBytes(new Uint8Array(body), url, messages)
}

const isCommand = (module: WebAssembly.Module) => {
  const exports = WebAssembly.Module.exports(module)
  const has = (name: string, kind: string) => exports.some((entry) => entry.name === name && entry.kind === kind)
  return has('_start', 'function') && has('memory', 'memory')
}

const isCommandInstance = (instance: WasiInstance) =>
  typeof instance.exports._start === 'function' && instance.exports.memory instanceof WebAssembly.Memory

const commandLineMessage = (error: CommandLineError, messages: Messages) =>
  error.problem === 'quote' ? formatMessage(messages.wasiUnmatchedQuote, { quote: error.token }) : messages.noShellSyntax

const secondsText = (milliseconds: number, locale: Locale) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 3, useGrouping: false }).format(milliseconds / 1000)

type Reason = (locale: Locale) => string

const noWorker: Reason = (locale) => getMessages(locale).wasiNoWorker

const clipDescription = (text: string): string => {
  if (text.length <= DESCRIPTION_LIMIT) return text
  const kept = text.slice(0, DESCRIPTION_LIMIT - 1)
  return `${/[\ud800-\udbff]$/.test(kept) ? kept.slice(0, -1) : kept}…`
}

interface OutputSink {
  write(text: string): void
  note(text: string): void
  finish(exit: WasiExit, tail: string | undefined): BackendRunResult
}

const createSink = (context: RunContext | undefined): OutputSink => {
  let buffered = ''
  let lineOpen = false
  const push = (text: string) => {
    if (text === '') return
    if (context) context.write(text)
    else buffered += text
    lineOpen = !text.endsWith('\n')
  }
  const onOwnLine = (text: string) => (lineOpen ? `\n${text}` : text)
  return {
    write: push,
    note: (text) => push(`${onOwnLine(text)}\n`),
    finish: (exit, tail) => {
      const rest = tail === undefined ? '' : onOwnLine(tail)
      if (context) return { output: rest, exitCode: exit.code }
      return { output: `${buffered}${rest}`.replace(/\n$/, ''), exitCode: exit.code }
    },
  }
}

export function createWasiBackend(options: WasiBackendOptions): SimpleBackend {
  const program = options.program ?? 'main'
  const timeoutMs = timeoutOf(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const readyTimeoutMs = timeoutOf(options.initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS)
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT
  const stdin = new TextEncoder().encode(options.stdin ?? '')
  const env = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`)
  let host: BackendHost | null = null
  let compiled: WebAssembly.Module | null = null
  let loading: Promise<WebAssembly.Module> | null = null
  let runner: WorkerRunner | null = null
  let releaseWorkerUrl = () => {}
  const inline = options.worker === false || options.instantiate !== undefined
  let ready = false
  let broken: Reason | null = null
  let generation = 0
  let attempts = 0
  let queue: Promise<unknown> = Promise.resolve()

  const load = async (messages: Messages): Promise<WebAssembly.Module> => {
    let module: WebAssembly.Module
    if (options.bytes !== undefined) module = await compileBytes(bytesOf(options.bytes), 'options.bytes', messages)
    else if (options.url !== undefined) module = await download(options.url, messages)
    else throw new Error(messages.wasiNoModule)
    if (!isCommand(module)) throw new Error(messages.wasiNotCommand)
    return module
  }

  const workerFailure =
    (cause: UnavailableReason, detail: string, custom: boolean): Reason =>
    (locale) => {
      const messages = getMessages(locale)
      if (cause === 'stalled') {
        return formatMessage(messages.wasiWorkerTimedOut, { seconds: secondsText(readyTimeoutMs ?? 0, locale) })
      }
      if (!custom) return formatMessage(messages.cspBlocked, { directive: WORKER_DIRECTIVE })
      return detail === '' ? messages.wasiWorkerFailed : `${messages.wasiWorkerFailed}: ${detail}`
    }

  const startRunner = (module: WebAssembly.Module): WorkerRunner | null => {
    const create = options.createWorker
    const ticket = generation
    const onUnavailable = (cause: UnavailableReason, detail: string) => {
      if (ticket === generation) broken = workerFailure(cause, detail, create !== undefined)
    }
    if (create) return createWorkerRunner(module, () => create(WASI_WORKER_SOURCE), { readyTimeoutMs, onUnavailable })
    if (typeof Worker !== 'function') {
      broken = noWorker
      return null
    }
    let url: string | null = null
    releaseWorkerUrl = () => {
      if (url !== null) URL.revokeObjectURL(url)
      url = null
    }
    const spawnBlobWorker = (): WorkerLike => {
      url ??= URL.createObjectURL(new Blob([WASI_WORKER_SOURCE], { type: 'text/javascript' }))
      return new Worker(url)
    }
    return createWorkerRunner(module, spawnBlobWorker, { readyTimeoutMs, onUnavailable })
  }

  const stopRunner = () => {
    runner?.dispose()
    runner = null
    releaseWorkerUrl()
    releaseWorkerUrl = () => {}
    broken = null
  }

  const instantiate = async (imports: WebAssembly.Imports): Promise<WasiInstance> => {
    if (options.instantiate) return options.instantiate(imports)
    if (compiled === null) throw new Error('wasm module is not compiled')
    return (await WebAssembly.instantiate(compiled, imports)) as unknown as WasiInstance
  }

  const runInline = async (job: WorkerJob, messages: Messages): Promise<WasiExit> => {
    const wasi = createWasiHost({
      ...job,
      imports: compiled === null ? undefined : WebAssembly.Module.imports(compiled),
      deadline: timeoutMs === null ? undefined : performance.now() + timeoutMs,
    })
    try {
      const instance = await instantiate(wasi.imports)
      if (!isCommandInstance(instance)) return { code: 1, error: messages.wasiNotCommand }
      return wasi.run(instance)
    } catch (error) {
      return wasi.fail(error)
    }
  }

  const tailOf = (exit: WasiExit, messages: Messages, locale: Locale) => {
    if (exit.timedOut) return formatMessage(messages.timedOut, { seconds: secondsText(timeoutMs ?? 0, locale) })
    if (exit.error === '') return messages.backendError
    return exit.error
  }

  const execute = async (
    argv: string[],
    context: RunContext | undefined,
    locale: Locale,
    ticket: number,
  ): Promise<BackendRunResult> => {
    if (ticket !== generation || context?.signal.aborted) return { output: '', exitCode: EXIT_INTERRUPTED }
    const messages = getMessages(locale)
    const sink = createSink(context)
    const job: WorkerJob = {
      argv,
      env,
      stdin,
      outputLimit,
      write: sink.write,
      truncated: () => sink.note(formatMessage(messages.wasiOutputLimit, { limit: outputLimit })),
    }
    let exit = runner === null ? WORKER_UNAVAILABLE : await runner.run(job, { signal: context?.signal, timeoutMs })
    if (exit === WORKER_UNAVAILABLE) {
      if (!inline) return { output: broken === null ? messages.notReady : broken(locale), exitCode: 1 }
      exit = await runInline(job, messages)
    }
    return sink.finish(exit, tailOf(exit, messages, locale))
  }

  return {
    id: 'wasi',
    prompt: options.prompt ?? '$ ',
    continuationPrompt: '> ',

    async init(backendHost: BackendHost): Promise<void> {
      host = backendHost
      const ticket = generation
      const attempt = (attempts += 1)
      if (!options.instantiate && compiled === null) {
        loading ??= load(getMessages(backendHost.locale ?? 'en')).finally(() => {
          loading = null
        })
        const module = await loading
        compiled ??= module
      }
      if (ticket !== generation || attempt !== attempts) return
      if (broken !== null) stopRunner()
      if (!inline && runner === null && compiled !== null) runner = startRunner(compiled)
      ready = true
      if (broken !== null) throw new Error(broken(backendHost.locale ?? 'en'))
      if (options.banner) backendHost.write(`${options.banner}\n`)
    },

    async run(command: string, context?: RunContext): Promise<BackendRunResult> {
      const locale = context?.locale ?? host?.locale ?? 'en'
      const messages = getMessages(locale)
      if (broken !== null) return { output: broken(locale), exitCode: 1 }
      if (!ready) return { output: messages.notReady, exitCode: 1 }
      let words: string[]
      try {
        words = splitCommandLine(command)
      } catch (error) {
        if (!(error instanceof CommandLineError)) throw error
        return { output: commandLineMessage(error, messages), exitCode: 2 }
      }
      const [name, ...rest] = words
      if (name === undefined) return { output: '', exitCode: 0 }
      if (name !== program) {
        return { output: formatMessage(messages.commandNotFoundIn, { name, program }), exitCode: 127 }
      }
      const ticket = generation
      const argv = [program, ...(options.args ?? []), ...rest]
      const task = queue.then(() => execute(argv, context, locale, ticket))
      queue = task.catch(() => undefined)
      return task
    },

    isComplete(source: string): boolean {
      return isCompleteCommandLine(source)
    },

    describe(): string {
      const messages = getMessages(host?.locale ?? 'en')
      const summary = formatMessage(messages.wasiDescribe, { program })
      if (options.usage === undefined) return clipDescription(summary)
      return clipDescription(`${summary}\n${formatMessage(messages.wasiUsage, { usage: options.usage })}`)
    },

    dispose(): void {
      generation += 1
      ready = false
      stopRunner()
    },
  }
}
