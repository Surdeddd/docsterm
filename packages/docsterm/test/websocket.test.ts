import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { isAbortError } from '../src/errors.js'
import { getMessages } from '../src/messages.js'
import { SessionController } from '../src/session-controller.js'
import {
  isInteractiveRun,
  type Backend,
  type BackendHost,
  type InteractiveRun,
  type Locale,
  type RunContext,
  type RunOutcome,
} from '../src/types.js'
import {
  createWebSocketBackend,
  parseServerMessage,
  type SocketLike,
  type WebSocketBackendOptions,
} from '../src/websocket/index.js'

class FakeSocket implements SocketLike {
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  sent: string[] = []
  closed = false

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.onopen?.()
  }

  ready(banner?: string): void {
    this.emit(banner === undefined ? { type: 'ready' } : { type: 'ready', banner })
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  drop(event?: { code?: number; reason?: string }): void {
    this.onclose?.(event)
  }

  fail(): void {
    this.onerror?.({})
  }

  messages(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw) as unknown)
  }

  detached(): boolean {
    return this.onopen === null && this.onmessage === null && this.onerror === null && this.onclose === null
  }
}

const URL = 'wss://sandbox.test/shell'

const setup = (options: Partial<WebSocketBackendOptions> = {}, locale?: Locale) => {
  const sockets: FakeSocket[] = []
  const writes: string[] = []
  const host: BackendHost = { write: (text) => writes.push(text), locale }
  const backend = createWebSocketBackend({
    url: URL,
    createSocket: () => {
      const created = new FakeSocket()
      sockets.push(created)
      return created
    },
    ...options,
  })
  const socket = (index = sockets.length - 1): FakeSocket => {
    const found = sockets[index]
    if (!found) throw new Error(`no socket #${index}`)
    return found
  }
  return { backend, sockets, writes, host, socket }
}

const connected = async (options: Partial<WebSocketBackendOptions> = {}, locale?: Locale) => {
  const env = setup(options, locale)
  const ready = env.backend.init(env.host)
  env.socket().open()
  env.socket().ready()
  await ready
  return env
}

const runContext = (locale?: Locale) => {
  const controller = new AbortController()
  const written: string[] = []
  const context: RunContext = {
    write: (text) => written.push(text),
    signal: controller.signal,
    columns: 80,
    rows: 24,
    locale,
  }
  return { context, written, controller }
}

const track = <T>(promise: Promise<T>) => {
  const box: { settled: boolean; value?: T; error?: unknown } = { settled: false }
  promise.then(
    (value) => {
      box.settled = true
      box.value = value
    },
    (error: unknown) => {
      box.settled = true
      box.error = error
    },
  )
  return box
}

const flush = async () => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

const outcome = async (start: () => Promise<unknown>) => {
  let pending: Promise<unknown>
  try {
    pending = start()
  } catch (error) {
    return { thrown: error }
  }
  return pending.then(
    (value) => ({ resolved: value }),
    (error: unknown) => ({ rejected: error }),
  )
}

const throwingFactory = (error: unknown) => () => {
  throw error
}

describe('parseServerMessage', () => {
  it('accepts the documented message shapes', () => {
    expect(parseServerMessage('{"type":"output","id":1,"chunk":"hi"}')).toEqual({
      type: 'output',
      id: 1,
      chunk: 'hi',
    })
    expect(parseServerMessage('{"type":"exit","id":1,"code":0}')).toEqual({
      type: 'exit',
      id: 1,
      code: 0,
    })
    expect(parseServerMessage('{"type":"ready","banner":"container up"}')).toEqual({
      type: 'ready',
      banner: 'container up',
    })
  })

  it('rejects malformed or unknown payloads', () => {
    expect(parseServerMessage('not json')).toBeNull()
    expect(parseServerMessage('{"type":"output"}')).toBeNull()
    expect(parseServerMessage('{"type":"exit","code":"zero"}')).toBeNull()
    expect(parseServerMessage('{"type":"exit","id":"1","code":0}')).toBeNull()
    expect(parseServerMessage('null')).toBeNull()
    expect(parseServerMessage(42)).toBeNull()
  })

  it('treats a null id as a missing one', () => {
    expect(parseServerMessage('{"type":"output","id":null,"chunk":"hi"}')).toStrictEqual({
      type: 'output',
      id: undefined,
      chunk: 'hi',
    })
    expect(parseServerMessage('{"type":"exit","id":null,"code":3}')).toStrictEqual({
      type: 'exit',
      id: undefined,
      code: 3,
    })
  })
})

describe('createWebSocketBackend', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('assembles output until exit when called without a run context', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('docker ps')
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'docker ps' }])
    socket().emit({ type: 'output', id: 1, chunk: 'CONTAINER ID   IMAGE\n' })
    socket().emit({ type: 'output', id: 1, chunk: 'a1b2c3         nginx\n' })
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({
      output: 'CONTAINER ID   IMAGE\na1b2c3         nginx',
      exitCode: 0,
    })
  })

  it('passes a non-zero exit code through so explain can use it', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('git push')
    socket().emit({ type: 'output', id: 1, chunk: 'fatal: no upstream\n' })
    socket().emit({ type: 'exit', id: 1, code: 128 })
    await expect(running).resolves.toEqual({ output: 'fatal: no upstream', exitCode: 128 })
  })

  it('ignores messages belonging to an older command', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('ls')
    socket().emit({ type: 'output', id: 0, chunk: 'stale output\n' })
    socket().emit({ type: 'output', id: 1, chunk: 'fresh\n' })
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: 'fresh', exitCode: 0 })
  })

  it('streams output chunks through the run context while the command runs', async () => {
    const { socket, backend } = await connected()
    const { context, written } = runContext()
    const running = track(backend.run('docker build .', context))
    socket().emit({ type: 'output', id: 1, chunk: 'step 1/2\n' })
    expect(written).toEqual(['step 1/2\n'])
    socket().emit({ type: 'output', id: 1, chunk: 'step 2/2\n' })
    await flush()
    expect(running.settled).toBe(false)
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await flush()
    expect(running.value).toEqual({ output: '', exitCode: 0 })
    expect(written).toEqual(['step 1/2\n', 'step 2/2\n'])
  })

  it('sends cancel when the run is aborted and settles at once with exit 130', async () => {
    const { socket, backend } = await connected()
    const { context, written, controller } = runContext()
    const running = backend.run('ping example.com', context)
    socket().emit({ type: 'output', id: 1, chunk: 'PING example.com\n' })
    controller.abort()
    await expect(running).resolves.toEqual({ output: '', exitCode: 130 })
    expect(socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'ping example.com' },
      { type: 'cancel', id: 1 },
    ])
    socket().emit({ type: 'output', id: 1, chunk: '64 bytes from example.com\n' })
    expect(written).toEqual(['PING example.com\n'])
  })

  it('drops late messages of a cancelled run and delivers the next run intact', async () => {
    const { socket, backend } = await connected()
    const first = runContext()
    void backend.run('tail -f app.log', first.context)
    first.controller.abort()
    const second = runContext()
    const running = track(backend.run('echo hi', second.context))
    socket().emit({ type: 'output', id: 1, chunk: 'GET /health 200\n' })
    socket().emit({ type: 'exit', id: 1, code: 130 })
    socket().emit({ type: 'output', id: 2, chunk: 'hi\n' })
    await flush()
    expect(running.settled).toBe(false)
    socket().emit({ type: 'exit', id: 2, code: 0 })
    await flush()
    expect(second.written).toEqual(['hi\n'])
    expect(running.value).toEqual({ output: '', exitCode: 0 })
  })

  it('drops id-less messages after an abort until the abandoned run exits', async () => {
    const { socket, backend } = await connected()
    const first = runContext()
    void backend.run('tail -f app.log', first.context)
    first.controller.abort()
    const second = runContext()
    const running = track(backend.run('echo hi', second.context))
    socket().emit({ type: 'output', chunk: '2026-10-03 GET /health 200\n' })
    socket().emit({ type: 'exit', code: 130 })
    await flush()
    expect(running.settled).toBe(false)
    socket().emit({ type: 'output', chunk: 'hi\n' })
    socket().emit({ type: 'exit', code: 0 })
    await flush()
    expect(second.written).toEqual(['hi\n'])
    expect(running.value).toEqual({ output: '', exitCode: 0 })
  })

  it('delivers output and exit with a null id to the running command', async () => {
    const { socket, backend } = await connected()
    const { context, written } = runContext()
    const running = track(backend.run('uname', context))
    socket().emit({ type: 'output', id: null, chunk: 'Linux\n' })
    socket().emit({ type: 'exit', id: null, code: 0 })
    await flush()
    expect(written).toEqual(['Linux\n'])
    expect(running.value).toEqual({ output: '', exitCode: 0 })
  })

  it('settles an active run with 130 and cancels it when a new run starts', async () => {
    const { socket, backend } = await connected()
    const first = backend.run('sleep 100', runContext().context)
    const second = track(backend.run('ls', runContext().context))
    await expect(first).resolves.toEqual({ output: '', exitCode: 130 })
    expect(socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'sleep 100' },
      { type: 'cancel', id: 1 },
      { type: 'run', id: 2, command: 'ls' },
    ])
    expect(second.settled).toBe(false)
  })

  it('does not send a command whose signal is already aborted', async () => {
    const { socket, backend } = await connected()
    const { context, controller } = runContext()
    controller.abort()
    await expect(backend.run('ls', context)).resolves.toEqual({ output: '', exitCode: 130 })
    expect(socket().messages()).toEqual([])
  })

  it("does not let an abandoned run's timer fail the next command", async () => {
    vi.useFakeTimers()
    const { socket, backend } = await connected({ timeoutMs: 1000 })
    const first = runContext()
    void backend.run('sleep 100000', first.context)
    await vi.advanceTimersByTimeAsync(100)
    first.controller.abort()
    await vi.advanceTimersByTimeAsync(100)
    const second = runContext()
    const running = track(backend.run('sleep 1', second.context))
    await vi.advanceTimersByTimeAsync(900)
    expect(running.settled).toBe(false)
    socket().emit({ type: 'exit', id: 2, code: 0 })
    await flush()
    expect(running.value).toEqual({ output: '', exitCode: 0 })
  })

  it('treats timeoutMs as inactivity: output keeps a long command alive', async () => {
    vi.useFakeTimers()
    const { socket, backend } = await connected({ timeoutMs: 1000 })
    const running = track(backend.run('npm ci', runContext().context))
    for (let step = 0; step < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(900)
      socket().emit({ type: 'output', id: 1, chunk: `step ${step}\n` })
    }
    expect(running.settled).toBe(false)
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await flush()
    expect(running.value).toEqual({ output: '', exitCode: 0 })
  })

  it('times out after timeoutMs of silence, sends cancel and reports it in the reader language', async () => {
    vi.useFakeTimers()
    const { socket, backend } = await connected({ timeoutMs: 1500 })
    const { context, written } = runContext('ru')
    const running = track(backend.run('apt install curl', context))
    socket().emit({ type: 'output', id: 1, chunk: 'Do you want to continue? [Y/n] ' })
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(running.value).toEqual({ output: '\nнет вывода 1,5 с, команда отменена', exitCode: 124 })
    expect(written).toEqual(['Do you want to continue? [Y/n] '])
    expect(socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'apt install curl', locale: 'ru' },
      { type: 'cancel', id: 1 },
    ])
  })

  it('times out a command that never finishes', async () => {
    const { backend } = await connected({ timeoutMs: 30 })
    await expect(backend.run('hang')).resolves.toEqual({
      output: 'no output for 0.03 s, command cancelled',
      exitCode: 124,
    })
  })

  it('reports the inactivity timeout in the host language when the run has no locale', async () => {
    vi.useFakeTimers()
    const { backend } = await connected({ timeoutMs: 120_000 }, 'ru')
    const running = track(backend.run('make', runContext().context))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(running.value).toEqual({ output: 'нет вывода 120 с, команда отменена', exitCode: 124 })
  })

  it('never times out when timeoutMs is 0', async () => {
    vi.useFakeTimers()
    const { backend } = await connected({ timeoutMs: 0 })
    const running = track(backend.run('watch date', runContext().context))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(running.settled).toBe(false)
  })

  it('clamps delays above 2^31-1 ms instead of letting them fire at once', async () => {
    vi.useFakeTimers()
    const huge = 2 ** 31
    const { backend, host, socket } = setup({ connectTimeoutMs: huge, readyTimeoutMs: huge, timeoutMs: huge })
    const init = track(backend.init(host))
    await vi.advanceTimersByTimeAsync(1000)
    expect(init.settled).toBe(false)
    socket().open()
    await vi.advanceTimersByTimeAsync(1000)
    expect(init.settled).toBe(false)
    socket().ready()
    await flush()
    expect(init).toEqual({ settled: true, value: undefined })
    const running = track(backend.run('tail -f app.log', runContext().context))
    await vi.advanceTimersByTimeAsync(1000)
    expect(running.settled).toBe(false)
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'tail -f app.log' }])
  })

  it('settles a pending run with 130 on dispose, cancels it and clears its timer', async () => {
    vi.useFakeTimers()
    const { socket, backend } = await connected({ timeoutMs: 1000 })
    const running = track(backend.run('sleep 5000', runContext().context))
    backend.dispose()
    await flush()
    expect(running.value).toEqual({ output: '', exitCode: 130 })
    expect(socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'sleep 5000' },
      { type: 'cancel', id: 1 },
    ])
    expect(socket().closed).toBe(true)
    expect(socket().detached()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes a still-connecting socket on dispose and opens exactly one live socket on re-init', async () => {
    const { backend, host, sockets, writes, socket } = setup()
    const first = backend.init(host)
    const stale = socket(0)
    const staleOpen = stale.onopen
    const staleMessage = stale.onmessage
    const staleClose = stale.onclose
    backend.dispose()
    const error = await first.then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(isAbortError(error)).toBe(true)
    expect(stale.closed).toBe(true)
    expect(stale.detached()).toBe(true)

    const second = backend.init(host)
    staleOpen?.()
    staleMessage?.({ data: JSON.stringify({ type: 'ready', banner: 'stale sandbox' }) })
    socket(1).open()
    socket(1).ready('ubuntu sandbox')
    await second
    staleClose?.({ code: 1006 })
    expect(sockets).toHaveLength(2)
    expect(socket(1).closed).toBe(false)
    expect(writes).toEqual(['ubuntu sandbox\n'])

    const running = backend.run('ls', runContext().context)
    expect(socket(1).messages()).toEqual([{ type: 'run', id: 1, command: 'ls' }])
    socket(1).emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('closes the previous socket when init runs twice without dispose', async () => {
    const { backend, host, sockets, socket } = await connected()
    const again = backend.init(host)
    expect(socket(0).closed).toBe(true)
    expect(socket(0).detached()).toBe(true)
    socket(1).open()
    socket(1).ready()
    await again
    expect(sockets).toHaveLength(2)
    expect(socket(1).closed).toBe(false)
  })

  it('resolves init on the server ready message, after printing its banner', async () => {
    const { backend, socket } = setup({ banner: 'docsterm sandbox' })
    const events: string[] = []
    const init = backend.init({ write: (text) => events.push(`write ${text}`) }).then(() => {
      events.push('ready')
    })
    socket().open()
    await flush()
    expect(events).toEqual(['write docsterm sandbox\n'])
    socket().ready('ubuntu sandbox')
    await init
    expect(events).toEqual(['write docsterm sandbox\n', 'write ubuntu sandbox\n', 'ready'])
  })

  it('falls back to readyTimeoutMs after open when the server never sends ready', async () => {
    vi.useFakeTimers()
    const { backend, host, socket } = setup()
    const init = track(backend.init(host))
    socket().open()
    await vi.advanceTimersByTimeAsync(1499)
    expect(init.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(init).toEqual({ settled: true, value: undefined })
  })

  it('prints a ready banner that arrives after init already resolved', async () => {
    const { backend, host, socket, writes } = setup({ readyTimeoutMs: 0 })
    const init = backend.init(host)
    socket().open()
    await init
    socket().ready('late banner')
    expect(writes).toEqual(['late banner\n'])
  })

  it('rejects init when the socket never opens and closes it', async () => {
    const { backend, host, socket } = setup({ connectTimeoutMs: 20 })
    await expect(backend.init(host)).rejects.toThrow(new Error('connection to wss://sandbox.test/shell timed out'))
    expect(socket().closed).toBe(true)
  })

  it('rejects init in the host language when the connection fails', async () => {
    const { backend, host, socket } = setup({}, 'ru')
    const init = backend.init(host)
    socket().fail()
    await expect(init).rejects.toThrow(new Error('не удаётся подключиться к wss://sandbox.test/shell'))
    expect(socket().closed).toBe(true)
  })

  it('returns a rejected promise in the host language when the socket cannot be created', async () => {
    const insecure = new DOMException('The operation is insecure.', 'SecurityError')
    const attempts = (['en', 'ru'] as const).map((locale) => {
      const backend = createWebSocketBackend({ url: URL, createSocket: throwingFactory(insecure) })
      return outcome(() => backend.init({ write: () => undefined, locale }))
    })
    expect(await Promise.all(attempts)).toEqual([
      { rejected: new Error('cannot connect to wss://sandbox.test/shell', { cause: insecure }) },
      { rejected: new Error('не удаётся подключиться к wss://sandbox.test/shell', { cause: insecure }) },
    ])
  })

  it('rejects init without throwing when the built-in WebSocket refuses the url', async () => {
    const backend = createWebSocketBackend({ url: 'ws://bad host/' })
    const result = await outcome(() => backend.init({ write: () => undefined }))
    expect(result).toEqual({ rejected: new Error('cannot connect to ws://bad host/') })
    const { cause } = (result as { rejected: Error }).rejected
    expect(cause).toBeInstanceOf(DOMException)
    expect((cause as DOMException).name).toBe('SyntaxError')
  })

  it('rejects the next run with notConnected while the socket still cannot be created', async () => {
    const insecure = new DOMException('The operation is insecure.', 'SecurityError')
    const backend = createWebSocketBackend({ url: URL, createSocket: throwingFactory(insecure) })
    await outcome(() => backend.init({ write: () => undefined }))
    const { context, written } = runContext()
    expect(await outcome(() => backend.run('ls', context))).toEqual({
      rejected: new Error('not connected to the server', {
        cause: new Error('cannot connect to wss://sandbox.test/shell', { cause: insecure }),
      }),
    })
    expect(written).toEqual(['reconnecting...\n'])
  })

  it('fails the running command when the connection drops', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('sleep 100')
    socket().drop()
    await expect(running).resolves.toEqual({ output: 'connection closed by the server', exitCode: 1 })
  })

  it('settles the running command with the close code and reason when the server closes', async () => {
    const { socket, backend } = await connected()
    const { context, written } = runContext()
    const running = backend.run('make test', context)
    socket().emit({ type: 'output', id: 1, chunk: 'running 120 tests\n' })
    socket().drop({ code: 1011, reason: 'server\x1b[2J\r\nrestart' })
    await expect(running).resolves.toEqual({
      output: 'connection closed by the server (1011: server restart)',
      exitCode: 1,
    })
    expect(written).toEqual(['running 120 tests\n'])
  })

  it('tells the reader when the server closes an idle connection', async () => {
    const { socket, writes } = await connected({}, 'ru')
    socket().drop({ code: 1006, reason: '' })
    expect(writes).toEqual(['сервер закрыл соединение (1006)\n'])
  })

  it('reconnects on the next run after a close and then runs the command', async () => {
    const { socket, sockets, backend } = await connected()
    socket().drop({ code: 1001 })
    const { context, written } = runContext()
    const running = backend.run('ls', context)
    expect(written).toEqual(['reconnecting...\n'])
    expect(sockets).toHaveLength(2)
    socket(1).open()
    socket(1).ready()
    await flush()
    expect(socket(1).messages()).toEqual([{ type: 'run', id: 1, command: 'ls' }])
    socket(1).emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('prints the static banner on the initial connect only, not on a reconnect', async () => {
    const { backend, host, socket, writes } = setup({ banner: 'docsterm sandbox' })
    const init = backend.init(host)
    socket(0).open()
    socket(0).ready()
    await init
    socket(0).drop({ code: 1001 })
    const { context, written } = runContext()
    const running = backend.run('ls', context)
    socket(1).open()
    socket(1).ready()
    await flush()
    socket(1).emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: '', exitCode: 0 })
    expect(writes).toEqual(['docsterm sandbox\n', 'connection closed by the server (1001)\n'])
    expect(written).toEqual(['reconnecting...\n'])
  })

  it('settles at once with 130 when the run is aborted while reconnecting', async () => {
    const { socket, sockets, backend } = await connected()
    socket(0).drop({ code: 1006 })
    const first = runContext()
    const aborted = track(backend.run('rm -rf build', first.context))
    await flush()
    first.controller.abort()
    await flush()
    expect(aborted.value).toEqual({ output: '', exitCode: 130 })
    expect(first.written).toEqual(['reconnecting...\n'])

    const second = runContext()
    const running = track(backend.run('ls', second.context))
    socket(1).open()
    socket(1).ready()
    await flush()
    expect(sockets).toHaveLength(2)
    expect(second.written).toEqual([])
    expect(socket(1).messages()).toEqual([{ type: 'run', id: 1, command: 'ls' }])
    socket(1).emit({ type: 'exit', id: 1, code: 0 })
    await flush()
    expect(running.value).toEqual({ output: '', exitCode: 0 })
  })

  it('reconnects again on the next run after an aborted reconnect fails', async () => {
    const { socket, sockets, backend } = await connected()
    socket(0).drop({ code: 1006 })
    const first = runContext()
    const aborted = track(backend.run('ls', first.context))
    first.controller.abort()
    await flush()
    expect(aborted.value).toEqual({ output: '', exitCode: 130 })
    socket(1).fail()
    await flush()

    const second = runContext()
    const running = backend.run('pwd', second.context)
    expect(sockets).toHaveLength(3)
    expect(second.written).toEqual(['reconnecting...\n'])
    socket(2).open()
    socket(2).ready()
    await flush()
    socket(2).emit({ type: 'output', id: 1, chunk: '/home/reader\n' })
    socket(2).emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: '', exitCode: 0 })
    expect(second.written).toEqual(['reconnecting...\n', '/home/reader\n'])
  })

  it('rejects the run with notConnected when the reconnect fails', async () => {
    const { socket, backend } = await connected({}, 'ru')
    socket().drop({ code: 1006 })
    const { context, written } = runContext('ru')
    const running = backend.run('ls', context)
    socket(1).fail()
    await expect(running).rejects.toThrow(new Error('нет соединения с сервером'))
    expect(written).toEqual(['переподключаюсь...\n'])
  })

  it('never sends a command whose run was aborted while reconnecting', async () => {
    const { socket, backend } = await connected()
    socket().drop({ code: 1006 })
    const { context, controller } = runContext()
    const running = backend.run('rm -rf build', context)
    controller.abort()
    socket(1).open()
    socket(1).ready()
    await expect(running).resolves.toEqual({ output: '', exitCode: 130 })
    expect(socket(1).messages()).toEqual([])
  })

  it('rejects a run before init with notConnected and opens nothing', async () => {
    const { backend, sockets } = setup()
    await expect(backend.run('ls')).rejects.toThrow(new Error('not connected to the server'))
    expect(sockets).toHaveLength(0)
  })

  it('closes the socket on dispose', async () => {
    const { socket, backend } = await connected()
    backend.dispose()
    expect(socket().closed).toBe(true)
  })

  it('describes the remote environment from the description option', () => {
    const described = createWebSocketBackend({ url: URL, description: 'Ubuntu 24.04 container with git and kubectl' })
    expect(described.describe?.()).toBe('Ubuntu 24.04 container with git and kubectl')
    expect(createWebSocketBackend({ url: URL }).describe?.()).toBe('')
  })

  it('takes a real WebSocket from createSocket without a cast, and the default factory builds one', async () => {
    expectTypeOf<WebSocket>().toExtend<SocketLike>()
    const created: Array<[string, string | string[] | undefined]> = []
    const sockets: FakeSocket[] = []
    class StubWebSocket extends FakeSocket {
      constructor(url: string, protocols?: string | string[]) {
        super()
        created.push([url, protocols])
        sockets.push(this)
      }
    }
    vi.stubGlobal('WebSocket', StubWebSocket)
    try {
      const custom = createWebSocketBackend({
        url: URL,
        protocols: ['docsterm.v2'],
        createSocket: (url, protocols) => new WebSocket(url, protocols),
      })
      const builtIn = createWebSocketBackend({ url: 'wss://sandbox.test/default', protocols: 'docsterm.v2' })
      for (const backend of [custom, builtIn]) {
        const ready = backend.init({ write: () => undefined })
        sockets.at(-1)?.open()
        sockets.at(-1)?.ready()
        await ready
        backend.dispose()
      }
      expect(created).toEqual([
        [URL, ['docsterm.v2']],
        ['wss://sandbox.test/default', 'docsterm.v2'],
      ])
      expect(sockets.map((socket) => socket.closed)).toEqual([true, true])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

const SILENT = {
  en: 'the server stopped answering, connection dropped',
  ru: 'сервер перестал отвечать, соединение разорвано',
}

const NEW_SESSION = {
  en: 'reconnected to a new session: the working directory and variables start over',
  ru: 'подключён новый сеанс: рабочий каталог и переменные начинаются заново',
}

const attemptNotice = (attempt: number) => `reconnecting, attempt ${attempt} of 5...\n`

const connectedV2 = async (
  features: string[],
  extra: Record<string, unknown> = {},
  options: Partial<WebSocketBackendOptions> = {},
  locale?: Locale,
) => {
  const env = setup(options, locale)
  const ready = env.backend.init(env.host)
  env.socket().open()
  env.socket().emit({ type: 'ready', protocol: 2, features, ...extra })
  await ready
  return env
}

const interactive = async (outcome: Promise<RunOutcome>): Promise<InteractiveRun> => {
  const value = await outcome
  if (!isInteractiveRun(value)) throw new Error('expected an interactive run')
  return value
}

const ofType = (socket: FakeSocket, type: string): unknown[] =>
  socket.messages().filter((message) => (message as { type?: unknown }).type === type)

describe('parseServerMessage protocol v2', () => {
  it('reads protocol, features and prompt from ready, the prompt from exit, and pong', () => {
    expect(
      parseServerMessage(
        '{"type":"ready","banner":"sandbox up","protocol":2,"features":["pty","resize","prompt","ping"],"prompt":"$ "}',
      ),
    ).toStrictEqual({
      type: 'ready',
      banner: 'sandbox up',
      protocol: 2,
      features: ['pty', 'resize', 'prompt', 'ping'],
      prompt: '$ ',
    })
    expect(parseServerMessage('{"type":"exit","id":4,"code":0,"prompt":"reader@sandbox:/work/app$ "}')).toStrictEqual({
      type: 'exit',
      id: 4,
      code: 0,
      prompt: 'reader@sandbox:/work/app$ ',
    })
    expect(parseServerMessage('{"type":"pong"}')).toStrictEqual({ type: 'pong' })
  })

  it('drops malformed v2 fields instead of trusting them', () => {
    expect(parseServerMessage('{"type":"ready","protocol":"2","features":"pty","prompt":7}')).toStrictEqual({
      type: 'ready',
      banner: undefined,
    })
    expect(parseServerMessage('{"type":"ready","protocol":2,"features":["pty",1,null,"ping"]}')).toStrictEqual({
      type: 'ready',
      banner: undefined,
      protocol: 2,
      features: ['pty', 'ping'],
    })
    expect(parseServerMessage('{"type":"exit","id":1,"code":0,"prompt":["$ "]}')).toStrictEqual({
      type: 'exit',
      id: 1,
      code: 0,
    })
    expect(parseServerMessage('{"type":"stdin","id":1,"data":"x"}')).toBeNull()
  })
})

describe('createWebSocketBackend protocol v2', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the v1 behaviour for a protocol 2 server without features', async () => {
    const { socket, backend } = await connectedV2([])
    const { context, written } = runContext()
    const running = backend.run('ls', context)
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'ls' }])
    socket().emit({ type: 'output', id: 1, chunk: 'notes.md\n' })
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: '', exitCode: 0 })
    expect(written).toEqual(['notes.md\n'])
  })

  it('returns an interactive run for a pty server that forwards every key raw and streams output untouched', async () => {
    const { socket, backend } = await connectedV2(['pty'])
    const { context, written } = runContext()
    const run = await interactive(backend.run('read name', context))
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'read name', columns: 80, rows: 24 }])
    socket().emit({ type: 'output', id: 1, chunk: '\x1b[?2004hname? ' })
    for (const key of ['A', 'd', '\x7f', '\x1b[D', '\x03', '\r']) run.onKey(key)
    socket().emit({ type: 'output', id: 1, chunk: 'Ad\x08 \x08\r\n' })
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 0 })
    run.onKey('x')
    expect(written).toEqual(['\x1b[?2004hname? ', 'Ad\x08 \x08\r\n'])
    expect(ofType(socket(), 'stdin')).toEqual(
      ['A', 'd', '\x7f', '\x1b[D', '\x03', '\r'].map((data) => ({ type: 'stdin', id: 1, data })),
    )
  })

  it('passes the exit code of a pty run through, Ctrl+C included', async () => {
    const { socket, backend } = await connectedV2(['pty'])
    const { context } = runContext()
    const run = await interactive(backend.run('sleep 10', context))
    run.onKey('\x03')
    socket().emit({ type: 'output', id: 1, chunk: '^C\r\n' })
    socket().emit({ type: 'exit', id: 1, code: 130 })
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 130 })
    expect(ofType(socket(), 'cancel')).toEqual([])
  })

  it('cancel() sends cancel, settles at once with 130 and drops what the cancelled command still sends', async () => {
    const { socket, backend } = await connectedV2(['pty'])
    const first = runContext()
    const run = await interactive(backend.run('top', first.context))
    run.cancel?.()
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 130 })
    expect(socket().messages().at(-1)).toEqual({ type: 'cancel', id: 1 })
    socket().emit({ type: 'output', id: 1, chunk: '\x1b[?1049l' })
    socket().emit({ type: 'exit', id: 1, code: 130 })
    const second = runContext()
    const next = await interactive(backend.run('pwd', second.context))
    socket().emit({ type: 'output', id: 2, chunk: '/work\r\n' })
    socket().emit({ type: 'exit', id: 2, code: 0 })
    await expect(next.done).resolves.toEqual({ output: '', exitCode: 0 })
    expect(first.written).toEqual([])
    expect(second.written).toEqual(['/work\r\n'])
  })

  it('cancels the remote command when the run context is aborted', async () => {
    const { socket, backend } = await connectedV2(['pty'])
    const { context, controller } = runContext()
    const run = await interactive(backend.run('vim notes.md', context))
    controller.abort()
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 130 })
    expect(ofType(socket(), 'cancel')).toEqual([{ type: 'cancel', id: 1 }])
    run.onKey('i')
    expect(ofType(socket(), 'stdin')).toEqual([])
  })

  it('never applies the silence timeout to a pty run, so a reader can think at a prompt', async () => {
    vi.useFakeTimers()
    const { socket, backend } = await connectedV2(['pty'], {}, { timeoutMs: 1000 })
    const { context } = runContext()
    const run = await interactive(backend.run('read answer', context))
    const done = track(run.done)
    vi.advanceTimersByTime(600_000)
    await flush()
    expect(done.settled).toBe(false)
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'read answer', columns: 80, rows: 24 }])
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await flush()
    expect(done.value).toEqual({ output: '', exitCode: 0 })
  })

  it('sends resizes of a running program only to a server with the resize feature', async () => {
    const sized = await connectedV2(['pty', 'resize'])
    const run = await interactive(sized.backend.run('top', runContext().context))
    run.resize?.(120, 40)
    expect(sized.socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'top', columns: 80, rows: 24 },
      { type: 'resize', columns: 120, rows: 40 },
    ])

    const fixed = await connectedV2(['pty'])
    const other = await interactive(fixed.backend.run('top', runContext().context))
    other.resize?.(120, 40)
    expect(ofType(fixed.socket(), 'resize')).toEqual([])
  })

  it('sends the terminal size with every run to a resize server even without a pty', async () => {
    const { socket, backend } = await connectedV2(['resize'])
    const { context } = runContext()
    const running = backend.run('stty size', context)
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'stty size', columns: 80, rows: 24 }])
    socket().emit({ type: 'output', id: 1, chunk: '24 80\n' })
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('buffers a pty server run that has no run context, as with v1', async () => {
    const { socket, backend } = await connectedV2(['pty'])
    const running = backend.run('echo hi')
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'echo hi' }])
    socket().emit({ type: 'output', id: 1, chunk: 'hi\r\n' })
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await expect(running).resolves.toEqual({ output: 'hi', exitCode: 0 })
  })

  it('follows the prompt that the server sends in ready and exit', async () => {
    const { socket, backend } = await connectedV2(['pty', 'prompt'], { prompt: 'reader@sandbox:/work$ ' })
    expect(backend.prompt).toBe('reader@sandbox:/work$ ')
    const run = await interactive(backend.run('cd app', runContext().context))
    socket().emit({ type: 'exit', id: 1, code: 0, prompt: 'reader@sandbox:/work/app$ ' })
    await run.done
    expect(backend.prompt).toBe('reader@sandbox:/work/app$ ')
    socket().emit({ type: 'exit', id: 1, code: 0 })
    expect(backend.prompt).toBe('reader@sandbox:/work/app$ ')
    socket().drop({ code: 1001, reason: 'going away' })
    expect(backend.prompt).toBe('$ ')
  })

  it('keeps its own prompt when the server lacks the prompt feature', async () => {
    const { socket, backend } = await connectedV2(['pty'], { prompt: 'root# ' }, { prompt: 'docs$ ' })
    expect(backend.prompt).toBe('docs$ ')
    const run = await interactive(backend.run('cd /', runContext().context))
    socket().emit({ type: 'exit', id: 1, code: 0, prompt: 'root:/# ' })
    await run.done
    expect(backend.prompt).toBe('docs$ ')
  })

  it('lets the session controller drive a pty run: keys, resize, the new prompt and a double Ctrl+C', async () => {
    const { socket, backend } = await connectedV2(['pty', 'prompt', 'resize'], { prompt: 'reader@sandbox:/work$ ' })
    const screen: string[] = []
    const prompts: string[] = []
    const session: SessionController = new SessionController({
      backend,
      messages: getMessages('en'),
      locale: 'en',
      pageContext: { title: 'Orbit docs', url: 'https://docs.test', description: '', headings: [] },
      io: {
        write: (text) => screen.push(text),
        print: (line) => screen.push(`${line}\n`),
        printPrompt: () => prompts.push(session.promptText),
        clearScreen: () => undefined,
        setBusy: () => undefined,
        size: () => ({ columns: 100, rows: 30 }),
      },
    })
    const reading = session.submit('read name; cd app')
    await flush()
    expect(session.isInteractive).toBe(true)
    socket().emit({ type: 'output', id: 1, chunk: 'name? ' })
    for (const key of ['A', '\r']) session.handleInteractiveKey(key)
    socket().emit({ type: 'output', id: 1, chunk: 'A\r\n' })
    session.resize(120, 40)
    socket().emit({ type: 'exit', id: 1, code: 0, prompt: 'reader@sandbox:/work/app$ ' })
    await reading
    expect(prompts).toEqual(['reader@sandbox:/work/app$ '])

    const sleeping = session.submit('sleep 100')
    await flush()
    session.handleInteractiveKey('\x03')
    session.handleInteractiveKey('\x03')
    await sleeping
    expect(socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'read name; cd app', columns: 100, rows: 30, locale: 'en' },
      { type: 'stdin', id: 1, data: 'A' },
      { type: 'stdin', id: 1, data: '\r' },
      { type: 'resize', columns: 120, rows: 40 },
      { type: 'run', id: 2, command: 'sleep 100', columns: 100, rows: 30, locale: 'en' },
      { type: 'stdin', id: 2, data: '\x03' },
      { type: 'cancel', id: 2 },
    ])
    expect(screen.join('')).toBe('name? A\r\n^C\n')
    expect(prompts).toEqual(['reader@sandbox:/work/app$ ', 'reader@sandbox:/work/app$ '])
  })

  it('sends the token as the first message of every connection', async () => {
    const { socket, backend, host } = setup({ token: 's3cret' })
    const init = backend.init(host)
    expect(socket().sent).toEqual([])
    socket().open()
    socket().emit({ type: 'ready', protocol: 2, features: [] })
    await init
    const running = backend.run('ls')
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await running
    socket().drop({ code: 1006 })
    const again = backend.run('pwd', runContext().context)
    socket().open()
    socket().emit({ type: 'ready', protocol: 2, features: [] })
    await flush()
    socket().emit({ type: 'exit', id: 2, code: 0 })
    await again
    expect(socket(0).messages()).toEqual([
      { type: 'auth', token: 's3cret' },
      { type: 'run', id: 1, command: 'ls' },
    ])
    expect(socket(1).messages()).toEqual([
      { type: 'auth', token: 's3cret' },
      { type: 'run', id: 2, command: 'pwd' },
    ])
  })

  it('sends no auth message without a token', async () => {
    const { socket } = await connectedV2(['pty'])
    expect(socket().sent).toEqual([])
  })

  it('tells the reader that a reconnect to a v2 server started a new session', async () => {
    for (const locale of ['en', 'ru'] as const) {
      const { socket, backend, writes } = await connectedV2(['pty'], {}, {}, locale)
      socket().drop({ code: 1001, reason: 'restart' })
      const { context, written } = runContext(locale)
      const outcome = backend.run('pwd', context)
      socket().open()
      socket().emit({ type: 'ready', protocol: 2, features: ['pty'] })
      const run = await interactive(outcome)
      socket().emit({ type: 'exit', id: 1, code: 0 })
      await run.done
      expect(writes, locale).toEqual([`${getMessages(locale).connectionClosed} (1001: restart)\n`])
      expect(written, locale).toEqual([`${getMessages(locale).reconnecting}\n`, `${NEW_SESSION[locale]}\n`])
    }
  })

  it('sends a ping every 20 s and stays connected while pongs come back', async () => {
    vi.useFakeTimers()
    const { socket, sockets, writes } = await connectedV2(['ping'])
    vi.advanceTimersByTime(19_999)
    expect(ofType(socket(), 'ping')).toHaveLength(0)
    for (let round = 1; round <= 5; round += 1) {
      vi.advanceTimersByTime(round === 1 ? 1 : 20_000)
      expect(ofType(socket(), 'ping')).toHaveLength(round)
      socket().emit({ type: 'pong' })
    }
    vi.advanceTimersByTime(40_000)
    expect(socket().closed).toBe(false)
    expect(sockets).toHaveLength(1)
    expect(writes).toEqual([])
  })

  it('never pings a server without the ping feature', async () => {
    vi.useFakeTimers()
    const { socket, sockets } = await connectedV2(['pty'])
    vi.advanceTimersByTime(300_000)
    expect(ofType(socket(), 'ping')).toEqual([])
    expect(socket().closed).toBe(false)
    expect(sockets).toHaveLength(1)
  })

  it('treats two missed pongs as a dead server and settles the running command with a localized notice', async () => {
    vi.useFakeTimers()
    for (const locale of ['en', 'ru'] as const) {
      const { socket, backend } = await connectedV2(['pty', 'ping'])
      const { context, written } = runContext(locale)
      const run = await interactive(backend.run('make test', context))
      socket().emit({ type: 'output', id: 1, chunk: 'compiling' })
      const done = track(run.done)
      vi.advanceTimersByTime(59_999)
      await flush()
      expect(done.settled, locale).toBe(false)
      expect(ofType(socket(), 'ping'), locale).toHaveLength(2)
      vi.advanceTimersByTime(1)
      await flush()
      expect(done.value, locale).toEqual({ output: `\n${SILENT[locale]}`, exitCode: 1 })
      expect(socket(0).closed && socket(0).detached(), locale).toBe(true)
      expect(written, locale).toEqual(['compiling'])
      backend.dispose()
    }
  })

  it('reconnects with backoff after a dead heartbeat: 0.5, 1, 2, 4 and 8 s, then says a new session started', async () => {
    vi.useFakeTimers()
    const { socket, sockets, writes } = await connectedV2(['ping'])
    vi.advanceTimersByTime(60_000)
    await flush()
    expect(writes).toEqual([`${SILENT.en}\n`])
    for (const [index, delay] of [500, 1000, 2000, 4000, 8000].entries()) {
      vi.advanceTimersByTime(delay - 1)
      expect(sockets, `attempt ${index + 1}`).toHaveLength(index + 1)
      vi.advanceTimersByTime(1)
      expect(sockets, `attempt ${index + 1}`).toHaveLength(index + 2)
      if (index < 4) {
        socket().fail()
        await flush()
      }
    }
    socket().open()
    socket().emit({ type: 'ready', protocol: 2, features: ['ping'] })
    await flush()
    expect(writes).toEqual([`${SILENT.en}\n`, ...[1, 2, 3, 4, 5].map(attemptNotice), `${NEW_SESSION.en}\n`])
    vi.advanceTimersByTime(30_000)
    expect(sockets).toHaveLength(6)
  })

  it('gives up after five failed attempts, says so in the reader language, and the next run reconnects', async () => {
    vi.useFakeTimers()
    const { socket, sockets, backend, writes } = await connectedV2(['ping'], {}, {}, 'ru')
    vi.advanceTimersByTime(60_000)
    await flush()
    for (const delay of [500, 1000, 2000, 4000, 8000]) {
      vi.advanceTimersByTime(delay)
      socket().fail()
      await flush()
    }
    vi.advanceTimersByTime(120_000)
    expect(sockets).toHaveLength(6)
    expect(writes).toEqual([
      `${SILENT.ru}\n`,
      ...[1, 2, 3, 4, 5].map((attempt) => `переподключаюсь, попытка ${attempt} из 5...\n`),
      'не удалось переподключиться за 5 попыток; следующая команда попробует снова\n',
    ])
    const { context, written } = runContext('ru')
    const outcome = backend.run('ls', context)
    socket().open()
    socket().emit({ type: 'ready', protocol: 2, features: [] })
    await flush()
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await expect(outcome).resolves.toEqual({ output: '', exitCode: 0 })
    expect(sockets).toHaveLength(7)
    expect(written).toEqual(['переподключаюсь...\n', `${NEW_SESSION.ru}\n`])
  })

  it('stops the backoff when a run reconnects between attempts or joins the attempt in flight', async () => {
    vi.useFakeTimers()
    const gap = await connectedV2(['ping'])
    vi.advanceTimersByTime(60_000)
    await flush()
    const early = runContext()
    const outcome = gap.backend.run('ls', early.context)
    gap.socket().open()
    gap.socket().emit({ type: 'ready', protocol: 2, features: ['ping'] })
    await flush()
    gap.socket().emit({ type: 'exit', id: 1, code: 0 })
    await outcome
    gap.socket().emit({ type: 'pong' })
    vi.advanceTimersByTime(20_000)
    gap.socket().emit({ type: 'pong' })
    vi.advanceTimersByTime(20_000)
    expect(gap.sockets).toHaveLength(2)
    expect(gap.writes).toEqual([`${SILENT.en}\n`])
    expect(early.written).toEqual(['reconnecting...\n', `${NEW_SESSION.en}\n`])

    const flight = await connectedV2(['ping'])
    vi.advanceTimersByTime(60_500)
    await flush()
    expect(flight.sockets).toHaveLength(2)
    const joined = runContext()
    const pending = flight.backend.run('pwd', joined.context)
    flight.socket().open()
    flight.socket().emit({ type: 'ready', protocol: 2, features: [] })
    await flush()
    flight.socket().emit({ type: 'exit', id: 1, code: 0 })
    await pending
    vi.advanceTimersByTime(120_000)
    expect(flight.sockets).toHaveLength(2)
    expect(flight.writes).toEqual([`${SILENT.en}\n`, attemptNotice(1)])
    expect(joined.written).toEqual([`${NEW_SESSION.en}\n`])
  })

  it('dispose cancels a running pty command and stops the heartbeat and the backoff', async () => {
    vi.useFakeTimers()
    const live = await connectedV2(['pty', 'ping'])
    const run = await interactive(live.backend.run('top', runContext().context))
    live.backend.dispose()
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 130 })
    expect(live.socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'top', columns: 80, rows: 24 },
      { type: 'cancel', id: 1 },
    ])
    vi.advanceTimersByTime(300_000)
    expect(ofType(live.socket(), 'ping')).toEqual([])
    expect(live.sockets).toHaveLength(1)

    const retrying = await connectedV2(['ping'])
    vi.advanceTimersByTime(60_000)
    await flush()
    retrying.backend.dispose()
    vi.advanceTimersByTime(300_000)
    expect(retrying.sockets).toHaveLength(1)
    expect(retrying.writes).toEqual([`${SILENT.en}\n`])
  })

  it('ignores malformed server messages during a pty run', async () => {
    const { socket, backend } = await connectedV2(['pty'])
    const { context, written } = runContext()
    const run = await interactive(backend.run('ls', context))
    for (const data of [
      '{"type":"output","id":1}',
      '{"type":"exit","id":1,"code":"0"}',
      '{"type":"output","id":"1","chunk":"x"}',
      '{"type":"stdin","id":1,"data":"x"}',
      '[1,2]',
      'not json',
      new Uint8Array([123, 125]),
    ]) {
      socket().onmessage?.({ data })
    }
    const done = track(run.done)
    await flush()
    expect(done.settled).toBe(false)
    socket().emit({ type: 'output', id: 1, chunk: 'notes.md\r\n' })
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await flush()
    expect(done.value).toEqual({ output: '', exitCode: 0 })
    expect(written).toEqual(['notes.md\r\n'])
  })

  it('says in describe() that the server runs a real terminal, in the host language', async () => {
    const en = await connectedV2(['pty'], {}, { description: 'Ubuntu 24.04 with git' })
    expect(en.backend.describe?.()).toBe(
      'Ubuntu 24.04 with git\nCommands run in a real terminal (pty) on the server: full-screen programs and input prompts work.',
    )
    const ru = await connectedV2(['pty'], {}, {}, 'ru')
    expect(ru.backend.describe?.()).toBe(
      'Команды выполняются на сервере в настоящем терминале (pty): полноэкранные программы и запросы ввода работают.',
    )
    const plain = await connectedV2([], {}, { description: 'Ubuntu 24.04 with git' })
    expect(plain.backend.describe?.()).toBe('Ubuntu 24.04 with git')
  })
})

const controllerFor = (backend: Backend) => {
  const prompts: string[] = []
  const session: SessionController = new SessionController({
    backend,
    messages: getMessages('en'),
    locale: 'en',
    pageContext: { title: 'Orbit docs', url: 'https://docs.test', description: '', headings: [] },
    io: {
      write: () => undefined,
      print: () => undefined,
      printPrompt: () => prompts.push(session.promptText),
      clearScreen: () => undefined,
      setBusy: () => undefined,
      size: () => ({ columns: 100, rows: 30 }),
    },
  })
  return { session, prompts }
}

describe('createWebSocketBackend shell input and run metadata', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks for the rest of an unfinished shell construct with a "> " prompt', async () => {
    const { backend } = await connected()
    expect(backend.continuationPrompt).toBe('> ')
    expect(backend.isComplete?.('for i in 1 2')).toBe(false)
    expect(backend.isComplete?.('for i in 1 2\ndo echo $i\ndone')).toBe(true)
    expect(backend.isComplete?.('ls -la')).toBe(true)
  })

  it('lets the session controller send typed multi-line constructs as one command', async () => {
    const { socket, backend } = await connected()
    const { session, prompts } = controllerFor(backend)
    for (const line of ['for i in 1 2', 'do echo $i', 'done']) {
      const submitted = session.submit(line)
      if (line === 'done') {
        await flush()
        socket().emit({ type: 'exit', id: 1, code: 0 })
      }
      await submitted
    }
    for (const line of ['echo one \\', '  two']) {
      const submitted = session.submit(line)
      if (line === '  two') {
        await flush()
        socket().emit({ type: 'exit', id: 2, code: 0 })
      }
      await submitted
    }
    expect(prompts).toEqual(['> ', '> ', '$ ', '> ', '$ '])
    expect(socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'for i in 1 2\ndo echo $i\ndone', locale: 'en' },
      { type: 'run', id: 2, command: 'echo one \\\n  two', locale: 'en' },
    ])
  })

  it('tells the server the reader language in every run message, from the run or else the host', async () => {
    const { socket, backend } = await connectedV2(['pty'], {}, {}, 'ru')
    const english = await interactive(backend.run('ls', runContext('en').context))
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await english.done
    const hosted = await interactive(backend.run('pwd', runContext().context))
    socket().emit({ type: 'exit', id: 2, code: 0 })
    await hosted.done
    const bare = backend.run('date')
    socket().emit({ type: 'exit', id: 3, code: 0 })
    await bare
    expect(socket().messages()).toEqual([
      { type: 'run', id: 1, command: 'ls', columns: 80, rows: 24, locale: 'en' },
      { type: 'run', id: 2, command: 'pwd', columns: 80, rows: 24, locale: 'ru' },
      { type: 'run', id: 3, command: 'date', locale: 'ru' },
    ])
  })

  it('leaves locale out of the run message when neither the run nor the host has one', async () => {
    const { socket, backend } = await connectedV2(['pty'])
    const run = await interactive(backend.run('ls', runContext().context))
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await run.done
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'ls', columns: 80, rows: 24 }])
  })

  it('waits for the ready message of an automatic reconnect before choosing how to run a command', async () => {
    vi.useFakeTimers()
    const { socket, sockets, backend, writes } = await connectedV2(['pty', 'ping'])
    vi.advanceTimersByTime(60_000)
    await flush()
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(2)
    socket().open()
    const { context, written } = runContext()
    const outcome = backend.run('vim notes.md', context)
    await flush()
    expect(socket().messages()).toEqual([])
    socket().emit({ type: 'ready', protocol: 2, features: ['pty', 'ping'] })
    const run = await interactive(outcome)
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'vim notes.md', columns: 80, rows: 24 }])
    expect(written).toEqual([`${NEW_SESSION.en}\n`])
    expect(writes).toEqual([`${SILENT.en}\n`, attemptNotice(1)])
    run.cancel?.()
  })

  it('runs a command the v1 way when the reconnected server never sends ready', async () => {
    vi.useFakeTimers()
    const { socket, backend } = await connectedV2(['ping'], {}, { readyTimeoutMs: 1000 })
    vi.advanceTimersByTime(60_500)
    await flush()
    socket().open()
    const outcome = track(backend.run('ls', runContext().context))
    await flush()
    expect(socket().messages()).toEqual([])
    vi.advanceTimersByTime(1000)
    await flush()
    expect(socket().messages()).toEqual([{ type: 'run', id: 1, command: 'ls' }])
    socket().emit({ type: 'exit', id: 1, code: 0 })
    await flush()
    expect(outcome.value).toEqual({ output: '', exitCode: 0 })
  })
})

describe('createWebSocketBackend server address in messages', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows only scheme, host, port and path of the server address in connect errors', async () => {
    const secret = 'wss://reader:hunter2@sandbox.test:8443/shell?token=SECRET#frag'
    const seen: string[] = []
    const thrown = createWebSocketBackend({ url: secret, createSocket: throwingFactory(new Error('refused')) })
    seen.push(((await outcome(() => thrown.init({ write: () => undefined }))) as { rejected: Error }).rejected.message)

    const failing = setup({ url: secret }, 'ru')
    const refused = outcome(() => failing.backend.init(failing.host))
    failing.socket().fail()
    seen.push(((await refused) as { rejected: Error }).rejected.message)

    vi.useFakeTimers()
    const silent = setup({ url: secret, connectTimeoutMs: 1000 })
    const waiting = outcome(() => silent.backend.init(silent.host))
    vi.advanceTimersByTime(1000)
    seen.push(((await waiting) as { rejected: Error }).rejected.message)
    vi.useRealTimers()

    const relative = createWebSocketBackend({ url: '/ws?token=SECRET', createSocket: throwingFactory(new Error('x')) })
    seen.push(((await outcome(() => relative.init({ write: () => undefined }))) as { rejected: Error }).rejected.message)

    expect(seen).toEqual([
      'cannot connect to wss://sandbox.test:8443/shell',
      'не удаётся подключиться к wss://sandbox.test:8443/shell',
      'connection to wss://sandbox.test:8443/shell timed out',
      'cannot connect to /ws',
    ])
  })

  it('keeps the token out of the error of the built-in WebSocket when the server is not there', async () => {
    const backend = createWebSocketBackend({ url: 'ws://127.0.0.1:9/?token=SECRET', connectTimeoutMs: 5000 })
    const result = await outcome(() => backend.init({ write: () => undefined }))
    expect(result).toEqual({ rejected: new Error('cannot connect to ws://127.0.0.1:9/') })
    backend.dispose()
  })
})

describe('createWebSocketBackend closes between open and ready', () => {
  it('rejects init with the localized close notice, code and reason included, and the next run reconnects', async () => {
    const cases: Array<[{ code?: number; reason?: string } | undefined, Locale, string]> = [
      [{ code: 4401, reason: 'unauthorized' }, 'en', 'connection closed by the server (4401: unauthorized)'],
      [{ code: 1011, reason: '' }, 'ru', 'сервер закрыл соединение (1011)'],
      [undefined, 'en', 'connection closed by the server'],
      [{ reason: 'no code' }, 'ru', 'сервер закрыл соединение'],
    ]
    for (const [event, locale, notice] of cases) {
      const { socket, sockets, backend, host, writes } = setup({}, locale)
      const init = outcome(() => backend.init(host))
      socket().open()
      socket().drop(event)
      expect(await init, notice).toEqual({ rejected: new Error(notice) })
      expect(socket(0).closed && socket(0).detached(), notice).toBe(true)
      const { context, written } = runContext(locale)
      const running = backend.run('ls', context)
      expect(sockets, notice).toHaveLength(2)
      socket(1).open()
      socket(1).ready()
      await flush()
      socket(1).emit({ type: 'exit', id: 1, code: 0 })
      await expect(running, notice).resolves.toEqual({ output: '', exitCode: 0 })
      expect(written, notice).toEqual([`${getMessages(locale).reconnecting}\n`])
      expect(socket(1).messages(), notice).toEqual([{ type: 'run', id: 1, command: 'ls', locale }])
      expect(writes, notice).toEqual([])
    }
  })

  it('still reports a close before open as a failed connection', async () => {
    const { socket, backend, host } = setup()
    const init = outcome(() => backend.init(host))
    socket().drop({ code: 1006, reason: 'refused' })
    expect(await init).toEqual({ rejected: new Error('cannot connect to wss://sandbox.test/shell') })
  })

  it('never sends a command whose run was aborted after the reconnect settled but before it was sent', async () => {
    const { socket, backend } = await connected()
    socket().drop({ code: 1006 })
    let aborted = false
    const signal = Object.defineProperty(new EventTarget(), 'aborted', { get: () => aborted }) as unknown as AbortSignal
    const written: string[] = []
    const context: RunContext = {
      write: (text) => written.push(text),
      signal,
      columns: 80,
      rows: 24,
    }
    const running = backend.run('rm -rf build', context)
    socket(1).open()
    socket(1).ready()
    aborted = true
    await expect(running).resolves.toEqual({ output: '', exitCode: 130 })
    expect(socket(1).messages()).toEqual([])
    expect(written).toEqual(['reconnecting...\n'])
  })
})
