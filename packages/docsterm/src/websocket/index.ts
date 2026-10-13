import { formatMessage, getMessages, type Messages } from '../messages.js'
import { sanitizeProse } from '../text.js'
import type { Backend, BackendHost, BackendRunResult, Locale, RunContext, RunOutcome } from '../types.js'
import { isShellComplete } from './syntax.js'

interface SocketEvents {
  open(event?: unknown): void
  message(event: { data: unknown }): void
  error(event?: unknown): void
  close(event?: unknown): void
}

export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: SocketEvents['open'] | null
  onmessage: SocketEvents['message'] | null
  onerror: SocketEvents['error'] | null
  onclose: SocketEvents['close'] | null
}

export interface WebSocketBackendOptions {
  url: string
  protocols?: string | string[]
  prompt?: string
  banner?: string
  description?: string
  token?: string
  timeoutMs?: number
  connectTimeoutMs?: number
  readyTimeoutMs?: number
  createSocket?: (url: string, protocols?: string | string[]) => SocketLike
}

export type ServerMessage =
  | { type: 'ready'; banner?: string; protocol?: number; features?: string[]; prompt?: string }
  | { type: 'output'; id?: number; chunk: string }
  | { type: 'exit'; id?: number; code: number; prompt?: string }
  | { type: 'pong' }

export type ClientMessage =
  | { type: 'run'; id: number; command: string; columns?: number; rows?: number; locale?: Locale }
  | { type: 'cancel'; id: number }
  | { type: 'stdin'; id: number; data: string }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'ping' }
  | { type: 'auth'; token: string }

type ReadyMessage = Extract<ServerMessage, { type: 'ready' }>

const readyOf = (fields: Record<string, unknown>): ReadyMessage => ({
  type: 'ready',
  banner: typeof fields.banner === 'string' ? fields.banner : undefined,
  ...(typeof fields.protocol === 'number' ? { protocol: fields.protocol } : {}),
  ...(Array.isArray(fields.features)
    ? { features: fields.features.filter((feature): feature is string => typeof feature === 'string') }
    : {}),
  ...(typeof fields.prompt === 'string' ? { prompt: fields.prompt } : {}),
})

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const fields = parsed as Record<string, unknown>
  if (fields.type === 'ready') return readyOf(fields)
  if (fields.type === 'pong') return { type: 'pong' }
  const id = typeof fields.id === 'number' ? fields.id : undefined
  if (fields.id !== undefined && fields.id !== null && id === undefined) return null
  if (fields.type === 'output' && typeof fields.chunk === 'string') return { type: 'output', id, chunk: fields.chunk }
  if (fields.type === 'exit' && typeof fields.code === 'number') {
    return { type: 'exit', id, code: fields.code, ...(typeof fields.prompt === 'string' ? { prompt: fields.prompt } : {}) }
  }
  return null
}

const MAX_DELAY = 2_147_483_647
const EXIT_FAILURE = 1
const EXIT_TIMED_OUT = 124
const EXIT_INTERRUPTED = 130
const HEARTBEAT_MS = 20_000
const MISSED_PONGS = 2
const RETRY_ATTEMPTS = 5
const RETRY_FIRST_MS = 500
const RETRY_LAST_MS = 8_000

type Timer = ReturnType<typeof setTimeout>
type Interval = ReturnType<typeof setInterval>

interface PendingRun {
  readonly id: number
  readonly context?: RunContext
  readonly pty: boolean
  buffered: string
  atLineStart: boolean
  timer: Timer | undefined
  done: boolean
  settle(result: BackendRunResult): void
}

interface ConnectAttempt {
  readonly promise: Promise<void>
  readonly initial: boolean
  fail(error: Error): void
}

const limitOf = (value: number): number | null =>
  value > 0 && Number.isFinite(value) ? Math.min(value, MAX_DELAY) : null

const abortError = (): Error => new DOMException('The operation was aborted.', 'AbortError')

const secondsText = (milliseconds: number, locale: Locale): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 3, useGrouping: false }).format(milliseconds / 1000)

const unlessAborted = async (work: Promise<void>, signal?: AbortSignal): Promise<boolean> => {
  if (!signal) {
    await work
    return true
  }
  let onAbort = (): void => undefined
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work.then(() => true), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const displayUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return url.replace(/[?#][\s\S]*$/, '').replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]*@/i, '$1')
  }
}

const defaultSocketFactory =(url: string, protocols?: string | string[]): SocketLike => new WebSocket(url, protocols)

const detach = (socket: SocketLike): void => {
  socket.onopen = null
  socket.onmessage = null
  socket.onerror = null
  socket.onclose = null
}

const closeNotice = (messages: Messages, event: unknown): string => {
  const { code, reason } = (typeof event === 'object' && event !== null ? event : {}) as {
    code?: unknown
    reason?: unknown
  }
  if (typeof code !== 'number') return messages.connectionClosed
  const detail = typeof reason === 'string' ? sanitizeProse(reason).replace(/\s+/g, ' ').trim() : ''
  return `${messages.connectionClosed} (${detail ? `${code}: ${detail}` : code})`
}

const outputOf = (run: PendingRun, notice: string): string => {
  const separated = notice && !run.atLineStart ? `\n${notice}` : notice
  if (run.context) return separated
  return notice ? `${run.buffered}${separated}` : run.buffered.replace(/\r?\n$/, '')
}

export function createWebSocketBackend(options: WebSocketBackendOptions): Backend {
  const factory = options.createSocket ?? defaultSocketFactory
  const shownUrl = displayUrl(options.url)
  const runLimit = limitOf(options.timeoutMs ?? 120_000)
  const connectLimit = limitOf(options.connectTimeoutMs ?? 15_000)
  const readyDelay = Math.min(Math.max(options.readyTimeoutMs ?? 1500, 0), MAX_DELAY)

  let host: BackendHost | null = null
  let socket: SocketLike | null = null
  let open = false
  let generation = 0
  let counter = 0
  let active: PendingRun | null = null
  let abandoned: number[] = []
  let connecting: ConnectAttempt | null = null
  let features: ReadonlySet<string> = new Set()
  let protocol = 1
  let serverPrompt: string | null = null
  let heartbeat: Interval | undefined
  let missed = 0
  let retrying = false
  let retryTimer: Timer | undefined

  const localeFor = (locale?: Locale): Locale => locale ?? host?.locale ?? 'en'
  const messagesFor = (locale?: Locale): Messages => getMessages(localeFor(locale))
  const supports = (feature: string): boolean => features.has(feature)

  const send = (message: ClientMessage): boolean => {
    if (!socket || !open) return false
    socket.send(JSON.stringify(message))
    return true
  }

  const finish = (run: PendingRun, notice: string, exitCode: number): void => {
    if (run.done) return
    run.done = true
    if (active === run) active = null
    clearTimeout(run.timer)
    run.settle({ output: outputOf(run, notice), exitCode })
  }

  const abandon = (run: PendingRun, notice: string, exitCode: number): void => {
    if (run.done) return
    if (send({ type: 'cancel', id: run.id })) abandoned.push(run.id)
    finish(run, notice, exitCode)
  }

  const arm = (run: PendingRun): void => {
    if (runLimit === null || run.pty) return
    clearTimeout(run.timer)
    run.timer = setTimeout(() => {
      const locale = localeFor(run.context?.locale)
      const notice = formatMessage(getMessages(locale).noOutputTimeout, { seconds: secondsText(runLimit, locale) })
      abandon(run, notice, EXIT_TIMED_OUT)
    }, runLimit)
  }

  const owner = (id: number | undefined): PendingRun | null => {
    if (id === undefined) return abandoned.length > 0 ? null : active
    return active?.id === id ? active : null
  }

  const deliver = (id: number | undefined, chunk: string): void => {
    const run = owner(id)
    if (!run) return
    arm(run)
    if (chunk.length > 0) run.atLineStart = chunk.endsWith('\n')
    if (run.context) run.context.write(chunk)
    else run.buffered += chunk
  }

  const abandonedIndex = (id: number | undefined): number => {
    if (id !== undefined) return abandoned.indexOf(id)
    return abandoned.length > 0 ? 0 : -1
  }

  const exit = (id: number | undefined, code: number, prompt: string | undefined): void => {
    if (prompt !== undefined && supports('prompt')) serverPrompt = prompt
    const index = abandonedIndex(id)
    if (index !== -1) {
      abandoned.splice(index, 1)
      return
    }
    const run = owner(id)
    if (run) finish(run, '', code)
  }

  const stopHeartbeat = (): void => {
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  const disconnect = (): void => {
    generation += 1
    stopHeartbeat()
    features = new Set()
    protocol = 1
    serverPrompt = null
    const current = socket
    socket = null
    open = false
    abandoned = []
    if (!current) return
    detach(current)
    current.close()
  }

  const teardown = (): void => {
    if (active) abandon(active, '', EXIT_INTERRUPTED)
    connecting?.fail(abortError())
    disconnect()
  }

  const lost = (event: unknown): void => {
    const run = active
    const notice = closeNotice(messagesFor(run?.context?.locale), event)
    if (run) finish(run, notice, EXIT_FAILURE)
    else host?.write(`${notice}\n`)
  }

  const stopRetry = (): void => {
    retrying = false
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const scheduleRetry = (attempt: number): void => {
    if (!retrying) return
    if (attempt > RETRY_ATTEMPTS) {
      retrying = false
      host?.write(`${formatMessage(messagesFor().wsReconnectFailed, { attempts: RETRY_ATTEMPTS })}\n`)
      return
    }
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined
        host?.write(`${formatMessage(messagesFor().wsReconnectAttempt, { attempt, attempts: RETRY_ATTEMPTS })}\n`)
        connect(false).then(
          () => {
            if (!retrying) return
            retrying = false
            if (protocol >= 2) host?.write(`${messagesFor().wsNewSession}\n`)
          },
          () => scheduleRetry(attempt + 1),
        )
      },
      Math.min(RETRY_FIRST_MS * 2 ** (attempt - 1), RETRY_LAST_MS),
    )
  }

  const silent = (): void => {
    const run = active
    disconnect()
    const notice = messagesFor(run?.context?.locale).wsServerSilent
    if (run) finish(run, notice, EXIT_FAILURE)
    else host?.write(`${notice}\n`)
    stopRetry()
    retrying = true
    scheduleRetry(1)
  }

  const startHeartbeat = (): void => {
    stopHeartbeat()
    missed = 0
    heartbeat = setInterval(() => {
      if (missed >= MISSED_PONGS) {
        silent()
        return
      }
      missed += 1
      send({ type: 'ping' })
    }, HEARTBEAT_MS)
  }

  const adopt = (message: ReadyMessage): void => {
    features = new Set(message.features ?? [])
    protocol = message.protocol ?? 1
    serverPrompt = supports('prompt') && message.prompt !== undefined ? message.prompt : null
    if (supports('ping')) startHeartbeat()
    else stopHeartbeat()
  }

  const connect = (announce: boolean): Promise<void> => {
    teardown()
    const current = generation
    const failedToConnect = (errorOptions?: ErrorOptions): Error =>
      new Error(formatMessage(messagesFor().connectFailed, { url: shownUrl }), errorOptions)
    let instance: SocketLike
    try {
      instance = factory(options.url, options.protocols)
    } catch (cause) {
      return Promise.reject(failedToConnect({ cause }))
    }
    let connectTimer: Timer | undefined
    let readyTimer: Timer | undefined
    let settled = false
    let resolveAttempt: () => void = () => undefined
    let rejectAttempt: (error: Error) => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve
      rejectAttempt = reject
    })
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(readyTimer)
      if (connecting === attempt) connecting = null
      if (error) rejectAttempt(error)
      else resolveAttempt()
    }
    const attempt: ConnectAttempt = {
      promise,
      initial: announce,
      fail: (error) => {
        if (settled) return
        if (current === generation) disconnect()
        settle(error)
      },
    }
    connecting = attempt
    socket = instance

    if (connectLimit !== null) {
      connectTimer = setTimeout(() => {
        attempt.fail(new Error(formatMessage(messagesFor().connectTimedOut, { url: shownUrl })))
      }, connectLimit)
    }

    instance.onopen = () => {
      if (current !== generation) return
      open = true
      clearTimeout(connectTimer)
      if (options.token) send({ type: 'auth', token: options.token })
      if (announce && options.banner) host?.write(`${options.banner}\n`)
      readyTimer = setTimeout(() => settle(), readyDelay)
    }
    instance.onmessage = (event) => {
      if (current !== generation) return
      const message = parseServerMessage(event.data)
      if (!message) return
      missed = 0
      if (message.type === 'ready') {
        adopt(message)
        if (message.banner) host?.write(`${message.banner}\n`)
        settle()
        return
      }
      if (message.type === 'output') deliver(message.id, message.chunk)
      else if (message.type === 'exit') exit(message.id, message.code, message.prompt)
    }
    instance.onerror = () => {
      if (current !== generation || open) return
      attempt.fail(failedToConnect())
    }
    instance.onclose = (event) => {
      if (current !== generation) return
      const wasOpen = open
      disconnect()
      if (settled) lost(event)
      else settle(wasOpen ? new Error(closeNotice(messagesFor(), event)) : failedToConnect())
    }
    return promise
  }

  const reconnect = async (context?: RunContext): Promise<void> => {
    const messages = messagesFor(context?.locale)
    if (!host) throw new Error(messages.notConnected)
    stopRetry()
    const say = (text: string): void => {
      if (context) context.write(text)
      else host?.write(text)
    }
    const pending = connecting
    if (!pending) say(`${messages.reconnecting}\n`)
    try {
      await (pending ? pending.promise : connect(false))
    } catch (error) {
      throw new Error(messages.notConnected, { cause: error })
    }
    if (!pending?.initial && protocol >= 2) say(`${messages.wsNewSession}\n`)
  }

  return {
    id: 'websocket',
    continuationPrompt: '> ',

    get prompt(): string {
      return serverPrompt ?? options.prompt ?? '$ '
    },

    init(backendHost: BackendHost): Promise<void> {
      stopRetry()
      host = backendHost
      return connect(true)
    },

    async run(command: string, context?: RunContext): Promise<RunOutcome> {
      if (context?.signal.aborted) return { output: '', exitCode: EXIT_INTERRUPTED }
      if (!socket || !open || connecting) {
        const reconnected = await unlessAborted(reconnect(context), context?.signal)
        if (!reconnected) return { output: '', exitCode: EXIT_INTERRUPTED }
      }
      if (context?.signal.aborted) return { output: '', exitCode: EXIT_INTERRUPTED }
      if (active) abandon(active, '', EXIT_INTERRUPTED)
      const id = (counter += 1)
      const pty = context !== undefined && supports('pty')
      const signal = context?.signal
      let resolveDone: (result: BackendRunResult) => void = () => undefined
      const done = new Promise<BackendRunResult>((resolve) => {
        resolveDone = resolve
      })
      const run: PendingRun = {
        id,
        context,
        pty,
        buffered: '',
        atLineStart: true,
        timer: undefined,
        done: false,
        settle: (result) => {
          signal?.removeEventListener('abort', onAbort)
          resolveDone(result)
        },
      }
      const onAbort = (): void => abandon(run, '', EXIT_INTERRUPTED)
      signal?.addEventListener('abort', onAbort, { once: true })
      active = run
      arm(run)
      const sized = context && (pty || supports('resize'))
      const locale = context?.locale ?? host?.locale
      send({
        type: 'run',
        id,
        command,
        ...(sized ? { columns: context.columns, rows: context.rows } : {}),
        ...(locale ? { locale } : {}),
      })
      if (!pty) return done
      return {
        done,
        onKey: (data: string) => {
          if (!run.done) send({ type: 'stdin', id, data })
        },
        resize: (columns: number, rows: number) => {
          if (!run.done && supports('resize')) send({ type: 'resize', columns, rows })
        },
        cancel: () => abandon(run, '', EXIT_INTERRUPTED),
      }
    },

    isComplete(source: string): boolean {
      return isShellComplete(source)
    },

    describe(): string {
      const note = supports('pty') ? messagesFor().wsPtyDescription : ''
      return [options.description ?? '', note].filter((part) => part !== '').join('\n')
    },

    dispose(): void {
      stopRetry()
      teardown()
      host = null
    },
  }
}
