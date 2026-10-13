// @vitest-environment node
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const serverDir = `${root}examples/websocket-server/`
const serverPath = `${serverDir}server.mjs`
const WAIT_MS = 8000
const SERVER_START_MS = 8000
const SLEEPER = "sh -c 'echo started; exec sleep 10'"

interface ServerMessage {
  type: string
  id?: number
  chunk?: string
  code?: number
  prompt?: string
  banner?: string
  protocol?: number
  features?: string[]
}

interface RunResult {
  output: string
  chunks: string[]
  code: number
  prompt: string | undefined
}

interface ScannerEvent {
  kind: 'data' | 'prompt' | 'exit'
  text?: string
  seq?: number
  code?: number
  pwd?: string
}

interface BoundaryModule {
  createBoundaryScanner(nonce: string, maxMarkerLength?: number): {
    push(chunk: string): ScannerEvent[]
    flush(): string
  }
  quoteForShell(text: string, maxLineBytes?: number): string
  markersFor(nonce: string): { start: string; end: string }
  promptFor(pwd: string, home: string): string
  initScript(nonce: string): string
  MAX_LINE_BYTES: number
}

interface NoticesModule {
  formatSeconds(ms: number, locale: 'en' | 'ru'): string
  formatBytes(bytes: number, locale: 'en' | 'ru'): string
  localeOf(value: unknown): 'en' | 'ru'
}

interface LimitsModule {
  createTokenBucket(options: { capacity: number; perSecond: number; now?: () => number }): {
    take(amount?: number): boolean
  }
  clientKey(address: unknown): string
  createLogLimiter(
    log: (event: string, fields?: Record<string, unknown>) => void,
    options?: { perWindow?: number; windowMs?: number; now?: () => number },
  ): (event: string, fields?: Record<string, unknown>) => void
}

interface TestServer {
  url: string
  port: number
  pid: number
  logs(): string
  hardKill(): Promise<void>
  stop(): Promise<void>
}

const SANDBOX_PREFIX = 'docsterm-sandbox-'
const sandboxDirsOf = (pid: number): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith(`${SANDBOX_PREFIX}${pid}-`))
const removeSandboxDirsOf = (pid: number): void => {
  for (const name of sandboxDirsOf(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true })
}

const baseEnv = (overrides: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  SANDBOX: 'local',
  NODE_ENV: 'test',
  PORT: '0',
  HOST: '127.0.0.1',
  TOKEN: '',
  ALLOWED_ORIGINS: '',
  BANNER: '',
  ...overrides,
})

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const poll = (probe: () => boolean, label: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (probe()) resolve()
      else if (Date.now() - started > WAIT_MS) reject(new Error(`timed out waiting for ${label}`))
      else setTimeout(tick, 10)
    }
    tick()
  })

const exited = (child: ChildProcess): Promise<number | null> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once('exit', (code) => resolve(code)))

const startServer = (overrides: Record<string, string> = {}): Promise<TestServer> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: baseEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    const startup = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`server did not report its address within ${SERVER_START_MS} ms: ${stderr}`))
    }, SERVER_START_MS)
    child.once('exit', (code) => {
      clearTimeout(startup)
      reject(new Error(`server exited early (${code}): ${stderr}`))
    })
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let parsed: { event?: string; url?: string; port?: number }
      try {
        parsed = JSON.parse(line) as typeof parsed
      } catch {
        return
      }
      if (parsed.event !== 'listening' || !parsed.url || !parsed.port) return
      clearTimeout(startup)
      const pid = child.pid ?? 0
      const ended = exited(child)
      resolve({
        url: parsed.url,
        port: parsed.port,
        pid,
        logs: () => stderr,
        hardKill: async () => {
          child.kill('SIGKILL')
          await ended
        },
        stop: async () => {
          child.kill('SIGTERM')
          const force = setTimeout(() => child.kill('SIGKILL'), 5000)
          await ended
          clearTimeout(force)
          removeSandboxDirsOf(pid)
        },
      })
    })
  })

class Client {
  readonly socket: WebSocket
  readonly general: ServerMessage[] = []
  readonly stray: ServerMessage[] = []
  readonly arrivals: string[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  private readonly handlers = new Map<number, (message: ServerMessage) => void>()
  private readonly waiters = new Set<() => void>()
  private isClosed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        this.isClosed = true
        resolve({ code: event.code, reason: event.reason })
        this.notify()
      })
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage
      const kind = message.id === undefined ? message.type : `${message.type} ${message.id}`
      if (this.arrivals.at(-1) !== kind) this.arrivals.push(kind)
      const handler = message.id === undefined ? undefined : this.handlers.get(message.id)
      if (handler) handler(message)
      else if (message.id === undefined) this.general.push(message)
      else this.stray.push(message)
      this.notify()
    })
  }

  static open(url: string): Promise<Client> {
    const socket = new WebSocket(url)
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(new Client(socket)), { once: true })
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
    })
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter()
  }

  until<T>(probe: () => T | undefined, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`timed out waiting for ${label}`))
      }, WAIT_MS)
      const check = (): void => {
        const value = probe()
        if (value === undefined && !this.isClosed) return
        clearTimeout(timer)
        this.waiters.delete(check)
        if (value === undefined) reject(new Error(`the connection closed while waiting for ${label}`))
        else resolve(value)
      }
      this.waiters.add(check)
      check()
    })
  }

  nextGeneral(type: string): Promise<ServerMessage> {
    return this.until(() => {
      const index = this.general.findIndex((message) => message.type === type)
      return index === -1 ? undefined : this.general.splice(index, 1)[0]
    }, type)
  }

  ready(): Promise<ServerMessage> {
    return this.nextGeneral('ready')
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  start(id: number, command: string, extra: Record<string, unknown> = {}) {
    let output = ''
    const chunks: string[] = []
    let result: RunResult | undefined
    this.handlers.set(id, (message) => {
      if (message.type === 'output' && typeof message.chunk === 'string') {
        output += message.chunk
        chunks.push(message.chunk)
      } else if (message.type === 'exit' && typeof message.code === 'number') {
        result = { output, chunks, code: message.code, prompt: message.prompt }
        this.handlers.delete(id)
      }
    })
    this.send({ type: 'run', id, command, ...extra })
    const done = this.until(() => result, `exit of run ${id}`)
    done.catch(() => undefined)
    return {
      done,
      output: () => output,
      waitFor: (text: string) => this.until(() => (output.includes(text) ? true : undefined), `"${text}"`),
      stdin: (data: string) => this.send({ type: 'stdin', id, data }),
      cancel: () => this.send({ type: 'cancel', id }),
    }
  }

  run(id: number, command: string, extra: Record<string, unknown> = {}): Promise<RunResult> {
    return this.start(id, command, extra).done
  }

  close(): Promise<{ code: number; reason: string }> {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close()
    return this.closed
  }
}

const upgrade = (port: number, path: string, headers: Record<string, string> = {}): Promise<number> =>
  new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    })
    outgoing.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    outgoing.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })

const upgradeSocket = (port: number): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    outgoing.on('upgrade', (_response, socket) => resolve(socket))
    outgoing.on('response', (response) => reject(new Error(`upgrade refused with ${response.statusCode}`)))
    outgoing.on('error', reject)
    outgoing.end()
  })

const maskedTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text)
  const mask = randomBytes(4)
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
  const masked = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!
  return Buffer.concat([header, mask, masked])
}

const clients: Client[] = []
const connect = async (url: string): Promise<Client> => {
  const client = await Client.open(url)
  clients.push(client)
  return client
}
const connectReady = async (url: string): Promise<Client> => {
  const client = await connect(url)
  await client.ready()
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

describe('websocket reference server: boundary module', () => {
  let boundary: BoundaryModule
  const nonce = '0123456789abcdef0123456789abcdef'

  let notices: NoticesModule

  beforeAll(async () => {
    const specifier = pathToFileURL(`${serverDir}boundary.mjs`).href
    boundary = (await import(specifier)) as BoundaryModule
    notices = (await import(pathToFileURL(`${serverDir}notices.mjs`).href)) as NoticesModule
  })

  it('never writes a complete marker or a raw separator into the shell', () => {
    const { start, end } = boundary.markersFor(nonce)
    const script = boundary.initScript(nonce)
    expect(script).not.toContain(start)
    expect(script).not.toContain(end)
    expect(script).not.toMatch(/[\u001e\u001f]/)
    expect(script).toContain("PS1='${__dt_a}${__dt_n}P${__dt_n}${__dt_b}'")
  })

  it('formats notice units per locale and maps run locales to en or ru', () => {
    expect(notices.formatSeconds(1000, 'en')).toBe('1 s')
    expect(notices.formatSeconds(1500, 'ru')).toBe('1,5 с')
    expect(notices.formatBytes(5 * 1024 * 1024, 'en')).toBe('5 MB')
    expect(notices.formatBytes(4096, 'ru')).toBe('4 КБ')
    expect(notices.formatBytes(1500, 'ru')).toBe('1500 байт')
    expect(['ru', 'ru-RU', 'RU_ru', 'en', 'de', undefined, 42, 'russian'].map(notices.localeOf)).toEqual([
      'ru',
      'ru',
      'ru',
      'en',
      'en',
      'en',
      'en',
      'en',
    ])
  })

  it('strips a sentinel split at every position without touching the output around it', () => {
    const { start, end } = boundary.markersFor(nonce)
    const stream = `out\r\nno newline${start}X7;3;/work/app${end}${start}P${end}after`
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const scanner = boundary.createBoundaryScanner(nonce)
      const events = [...scanner.push(stream.slice(0, cut)), ...scanner.push(stream.slice(cut))]
      const data = events
        .filter((event) => event.kind === 'data')
        .map((event) => event.text)
        .join('')
      expect(data).toBe('out\r\nno newlineafter')
      expect(events.filter((event) => event.kind !== 'data')).toEqual([
        { kind: 'exit', seq: 7, code: 3, pwd: '/work/app' },
        { kind: 'prompt' },
      ])
      expect(scanner.flush()).toBe('')
    }
  })

  it('handles byte-at-a-time chunks, stray separators and foreign nonces', () => {
    const { start, end } = boundary.markersFor(nonce)
    const foreign = boundary.markersFor('f'.repeat(32))
    const stream = `a\u001eb${foreign.start}X1;0;/x${foreign.end}${start}X2;0;/dir\r\nwith newline${end}`
    const scanner = boundary.createBoundaryScanner(nonce)
    const events = [...stream].flatMap((char) => scanner.push(char))
    const data = events
      .filter((event) => event.kind === 'data')
      .map((event) => event.text)
      .join('')
    expect(data).toBe(`a\u001eb${foreign.start}X1;0;/x${foreign.end}`)
    expect(events.at(-1)).toEqual({ kind: 'exit', seq: 2, code: 0, pwd: '/dir\nwith newline' })
  })

  it('releases an unterminated marker once it exceeds the marker limit', () => {
    const { start } = boundary.markersFor(nonce)
    const scanner = boundary.createBoundaryScanner(nonce, 64)
    expect(scanner.push(`x${start}`)).toEqual([{ kind: 'data', text: 'x' }])
    const events = scanner.push('y'.repeat(100))
    expect(events).toEqual([{ kind: 'data', text: `${start}${'y'.repeat(100)}` }])
  })

  it('quotes commands so that a POSIX shell reads them back byte for byte in short lines', () => {
    const samples = [
      "it's a 'quoted' \\ string",
      'line one\nline two\n',
      `${'é日本🙂'.repeat(200)}'${'x'.repeat(900)}`,
      'trailing backslash \\',
      '',
    ]
    for (const text of samples) {
      const quoted = boundary.quoteForShell(text)
      for (const line of quoted.split('\n')) {
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(boundary.MAX_LINE_BYTES)
      }
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`]).toString()).toBe(text)
    }
  })

  it('derives a short prompt from the working directory', () => {
    expect(boundary.promptFor('/work', '/work')).toBe('sandbox:~$ ')
    expect(boundary.promptFor('/work/app', '/work')).toBe('sandbox:~/app$ ')
    expect(boundary.promptFor('/', '/work')).toBe('sandbox:/$ ')
    expect(boundary.promptFor('/work/a\u001b[31mb', '/work')).toBe('sandbox:~/a?[31mb$ ')
    expect(boundary.promptFor('/usr/local/share/very/long/path/to/some/thing', '/work')).toBe('sandbox:…/some/thing$ ')
    expect(boundary.promptFor(`/work/${'d'.repeat(30)}/${'e'.repeat(30)}`, '/work')).toBe(
      `sandbox:…${'d'.repeat(8)}/${'e'.repeat(30)}$ `,
    )
  })
})

describe('websocket reference server: limits module', () => {
  let limits: LimitsModule

  beforeAll(async () => {
    limits = (await import(pathToFileURL(`${serverDir}limits.mjs`).href)) as LimitsModule
  })

  it('refills a token bucket over time', () => {
    let now = 0
    const bucket = limits.createTokenBucket({ capacity: 2, perSecond: 1, now: () => now })
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false])
    now = 500
    expect(bucket.take()).toBe(false)
    now = 1000
    expect(bucket.take()).toBe(true)
    now = 10_000
    expect(bucket.take(5)).toBe(false)
    expect(bucket.take(2)).toBe(true)
  })

  it('groups clients by IPv4 address and by IPv6 /64', () => {
    expect(limits.clientKey('127.0.0.1')).toBe('127.0.0.1')
    expect(limits.clientKey('::ffff:10.0.0.7')).toBe('10.0.0.7')
    expect(limits.clientKey('2001:db8:0:1:aaaa::1')).toBe('2001:db8:0:1::/64')
    expect(limits.clientKey('2001:DB8:0:1:ffff:2::9%en0')).toBe('2001:db8:0:1::/64')
    expect(limits.clientKey('::1')).toBe('0:0:0:0::/64')
    expect(limits.clientKey(undefined)).toBe('unknown')
  })

  it('rate-limits repeated log lines and reports how many were suppressed', () => {
    let now = 0
    const lines: string[] = []
    const limited = limits.createLogLimiter((event, fields) => lines.push(`${event} ${JSON.stringify(fields)}`), {
      perWindow: 2,
      windowMs: 1000,
      now: () => now,
    })
    for (let index = 0; index < 5; index += 1) limited('refused', { index })
    now = 1000
    limited('refused', { index: 5 })
    expect(lines).toEqual([
      'refused {"index":0}',
      'refused {"index":1}',
      'refused-suppressed {"count":3}',
      'refused {"index":5}',
    ])
  })
})

describe('websocket reference server: sessions', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startServer({ READY_WAIT_MS: '1000' })
  })

  afterAll(async () => {
    await server?.stop()
  })

  it('announces protocol 2 with its features and prompt', async () => {
    const client = await connect(server.url)
    expect(await client.ready()).toEqual({
      type: 'ready',
      protocol: 2,
      features: ['pty', 'resize', 'prompt', 'ping'],
      prompt: 'sandbox:~$ ',
    })
    client.send({ type: 'ping' })
    expect(await client.nextGeneral('pong')).toEqual({ type: 'pong' })
  })

  it('keeps cd and export between runs and updates the prompt', async () => {
    const client = await connectReady(server.url)
    const first = await client.run(1, 'mkdir -p app && cd app && export GREETING=hello')
    expect(first).toMatchObject({ output: '', code: 0, prompt: 'sandbox:~/app$ ' })
    const second = await client.run(2, 'echo "$GREETING" "${PWD##*/}"')
    expect(second).toMatchObject({ output: 'hello app\r\n', code: 0, prompt: 'sandbox:~/app$ ' })
    expect(await client.run(3, 'cd /')).toMatchObject({ code: 0, prompt: 'sandbox:/$ ' })
    expect(await client.run(4, 'cd')).toMatchObject({ code: 0, prompt: 'sandbox:~$ ' })
  })

  it('streams chunks in order and reports exit codes', async () => {
    const client = await connectReady(server.url)
    const streamed = await client.run(1, 'echo one; sleep 0.3; echo two')
    expect(streamed.output).toBe('one\r\ntwo\r\n')
    const one = streamed.chunks.findIndex((chunk) => chunk.includes('one'))
    const two = streamed.chunks.findIndex((chunk) => chunk.includes('two'))
    expect(one).toBeGreaterThanOrEqual(0)
    expect(two).toBeGreaterThan(one)
    expect(await client.run(2, 'false')).toMatchObject({ output: '', code: 1 })
    expect(await client.run(3, "sh -c 'exit 42'")).toMatchObject({ output: '', code: 42 })
    expect(await client.run(4, 'printf no-newline')).toMatchObject({ output: 'no-newline', code: 0 })
    const long = await client.run(5, `s='${'x'.repeat(3000)}'; echo "\${#s}" ü日本`)
    expect(long).toMatchObject({ output: '3000 ü日本\r\n', code: 0 })
  })

  it('runs multi-line commands and commands ending in a comment', async () => {
    const client = await connectReady(server.url)
    const loop = await client.run(1, 'for i in 1 2 3\ndo\n  echo "n$i"\ndone # count')
    expect(loop).toMatchObject({ output: 'n1\r\nn2\r\nn3\r\n', code: 0 })
    expect(await client.run(2, 'echo kept # trailing comment')).toMatchObject({ output: 'kept\r\n', code: 0 })
    const heredoc = await client.run(3, 'cat <<EOF\nfrom heredoc\nEOF')
    expect(heredoc).toMatchObject({ output: 'from heredoc\r\n', code: 0 })
  })

  it('answers read through forwarded keystrokes, with echo while the command runs', async () => {
    const client = await connectReady(server.url)
    const run = client.start(1, 'printf "name? "; read name; echo "hello $name"')
    await run.waitFor('name? ')
    run.stdin('Ada\r')
    expect(await run.done).toMatchObject({ output: 'name? Ada\r\nhello Ada\r\n', code: 0 })
    const multi = client.start(2, 'read a\nread b\necho "$b-$a"')
    multi.stdin('first\r')
    multi.stdin('second\r')
    expect((await multi.done).output.endsWith('second-first\r\n')).toBe(true)
  })

  it('forwards raw keys to a program in non-canonical mode', async () => {
    const client = await connectReady(server.url)
    const run = client.start(
      1,
      'stty -echo -icanon min 1 time 0; printf "ready>"; k=$(dd bs=1 count=1 2>/dev/null); stty icanon echo; printf "\\nkey=%s\\n" "$k"',
    )
    await run.waitFor('ready>')
    run.stdin('q')
    expect(await run.done).toMatchObject({ output: 'ready>\r\nkey=q\r\n', code: 0 })
  })

  it('settles Ctrl+C sent as stdin with 130 quickly and keeps the session usable', async () => {
    const client = await connectReady(server.url)
    const run = client.start(1, SLEEPER)
    await run.waitFor('started')
    const sent = Date.now()
    run.stdin('\u0003')
    const result = await run.done
    expect(result.code).toBe(130)
    expect(Date.now() - sent).toBeLessThan(1500)
    expect(await client.run(2, 'echo alive')).toMatchObject({ output: 'alive\r\n', code: 0 })
  })

  it('cancels through the cancel message and queues a run sent right after it', async () => {
    const client = await connectReady(server.url)
    const run = client.start(1, SLEEPER)
    await run.waitFor('started')
    run.cancel()
    const next = client.start(2, 'echo after')
    expect((await run.done).code).toBe(130)
    expect(await next.done).toMatchObject({ output: 'after\r\n', code: 0 })
  })

  it('answers a second concurrent run as busy', async () => {
    const client = await connectReady(server.url)
    const run = client.start(1, SLEEPER)
    await run.waitFor('started')
    const second = await client.run(2, 'echo second')
    expect(second).toMatchObject({ output: 'docsterm-server: another command is still running\r\n', code: 1 })
    run.cancel()
    expect((await run.done).code).toBe(130)
  })

  it('passes escape sequences of full-screen programs through untouched', async () => {
    const client = await connectReady(server.url)
    const result = await client.run(
      1,
      "printf '\\033[?1049h\\033[2J\\033[H\\033[1;31mfull\\033[0m\\033]0;title\\007\\033[?1049l'",
    )
    expect(result).toMatchObject({
      output: '\u001b[?1049h\u001b[2J\u001b[H\u001b[1;31mfull\u001b[0m\u001b]0;title\u0007\u001b[?1049l',
      code: 0,
    })
  })

  it('answers a burst of pings with one pong', async () => {
    const client = await connectReady(server.url)
    for (let index = 0; index < 10; index += 1) client.send({ type: 'ping' })
    expect(await client.run(1, 'echo ok')).toMatchObject({ output: 'ok\r\n', code: 0 })
    expect(client.general).toEqual([{ type: 'pong' }])
  })

  it('coalesces a burst of resizes into the latest size', async () => {
    const client = await connectReady(server.url)
    for (let columns = 60; columns <= 90; columns += 1) client.send({ type: 'resize', columns, rows: 25 })
    expect(await client.run(1, 'stty size')).toMatchObject({ output: '25 90\r\n', code: 0 })
  })

  it('applies resize messages and run sizes to the pty', async () => {
    const client = await connectReady(server.url)
    client.send({ type: 'resize', columns: 100, rows: 30 })
    expect(await client.run(1, 'stty size')).toMatchObject({ output: '30 100\r\n', code: 0 })
    expect(await client.run(2, 'stty size', { columns: 72, rows: 12 })).toMatchObject({
      output: '12 72\r\n',
      code: 0,
    })
  })

  it('reports exit N and continues in a fresh sandbox', async () => {
    const client = await connectReady(server.url)
    await client.run(1, 'export MARK=old; mkdir -p sub; cd sub')
    const result = await client.run(2, 'exit 3')
    expect(result.code).toBe(3)
    expect(result.prompt).toBe('sandbox:~$ ')
    expect(result.output.endsWith('docsterm-server: the shell exited with code 3; started a fresh sandbox\r\n')).toBe(true)
    expect(await client.run(3, 'echo "[$MARK]"; ls')).toMatchObject({
      output: '[]\r\n',
      code: 0,
      prompt: 'sandbox:~$ ',
    })
  })

  it('survives printing its own prompt and shell variables', async () => {
    const client = await connectReady(server.url)
    expect(await client.run(1, 'export KEEP=yes; cd /tmp')).toMatchObject({ code: 0, prompt: 'sandbox:/tmp$ ' })
    const listed = await client.run(2, 'set | grep -a -E "^(PS1|__dt_[a-z]+)="')
    expect(listed).toMatchObject({ code: 0, prompt: 'sandbox:/tmp$ ' })
    expect(listed.output).toContain('PS1=')
    expect(await client.run(3, 'echo "$PS1"; echo visible-after; sleep 0.3; echo end')).toMatchObject({
      output: '${__dt_a}${__dt_n}P${__dt_n}${__dt_b}\r\nvisible-after\r\nend\r\n',
      code: 0,
    })
    const dumped = await client.run(
      4,
      'set; env; declare -p 2>/dev/null; declare -f 2>/dev/null; typeset 2>/dev/null; echo tail-ok',
    )
    expect(dumped.code).toBe(0)
    expect(dumped.output.endsWith('tail-ok\r\n')).toBe(true)
    expect(await client.run(5, 'echo "$KEEP" "$PWD"')).toMatchObject({
      output: 'yes /tmp\r\n',
      code: 0,
      prompt: 'sandbox:/tmp$ ',
    })
  })

  it('writes its notices in the language of the run', async () => {
    const client = await connectReady(server.url)
    expect(await client.run(1, 'echo \u0007', { locale: 'ru' })).toMatchObject({
      output: 'docsterm-server: команда содержит управляющие символы\r\n',
      code: 2,
    })
    expect(await client.run(2, 'echo \u0007', { locale: 'de' })).toMatchObject({
      output: 'docsterm-server: the command contains control characters\r\n',
      code: 2,
    })
    const run = client.start(3, SLEEPER)
    await run.waitFor('started')
    expect(await client.run(4, 'echo busy', { locale: 'ru-RU' })).toMatchObject({
      output: 'docsterm-server: другая команда ещё выполняется\r\n',
      code: 1,
    })
    run.cancel()
    expect((await run.done).code).toBe(130)
    const exited = await client.run(5, 'exit 4', { locale: 'ru' })
    expect(exited.code).toBe(4)
    expect(exited.output.endsWith('docsterm-server: оболочка завершилась с кодом 4; запущена новая песочница\r\n')).toBe(
      true,
    )
  })

  it('ignores malformed, unknown and oversized frames and rejects control characters', async () => {
    const client = await connectReady(server.url)
    client.socket.send('not json')
    client.socket.send('{"type":')
    client.socket.send('[1,2,3]')
    client.socket.send('"run"')
    client.socket.send(new Uint8Array([1, 2, 3]))
    client.send({ type: 'bogus', id: 9 })
    client.send({ type: 'run', id: 'x', command: 'echo bad' })
    client.send({ type: 'run', id: 1.5, command: 'echo bad' })
    client.send({ type: 'resize', columns: 0, rows: 99999 })
    client.send({ type: 'stdin', id: 4, data: 42 })
    client.send({ type: 'run', id: 99, command: `echo ${'x'.repeat(70_000)}` })
    expect(await client.run(5, 'echo \u0007')).toMatchObject({
      output: 'docsterm-server: the command contains control characters\r\n',
      code: 2,
    })
    expect(await client.run(6, 'echo ok')).toMatchObject({ output: 'ok\r\n', code: 0 })
    expect(client.stray).toEqual([])
    expect(client.general).toEqual([])
  })

  it('rejects cross-site origins and accepts loopback origins by default', async () => {
    expect(await upgrade(server.port, '/', { Origin: 'https://evil.example' })).toBe(403)
    expect(await upgrade(server.port, '/', { Origin: 'http://localhost:5173' })).toBe(101)
    expect(await upgrade(server.port, '/', {})).toBe(101)
  })
})

describe('websocket reference server: limits', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startServer({
      COMMAND_TIMEOUT_MS: '1000',
      OUTPUT_LIMIT_BYTES: '4096',
      CANCEL_GRACE_MS: '300',
      IDLE_TIMEOUT_MS: '1000',
      STDIN_BURST_BYTES: '1024',
      STDIN_BYTES_PER_SECOND: '1024',
    })
  })

  afterAll(async () => {
    await server?.stop()
  })

  it('times an unattended command out with 124 and a notice', async () => {
    const client = await connectReady(server.url)
    const started = Date.now()
    const result = await client.run(1, 'echo started; sleep 30')
    const elapsed = Date.now() - started
    expect(result.code).toBe(124)
    expect(elapsed).toBeGreaterThanOrEqual(1000)
    expect(elapsed).toBeLessThan(6000)
    expect(result.output.startsWith('started\r\ndocsterm-server: command timed out after 1 s without input\r\n')).toBe(
      true,
    )
  }, 20_000)

  it('measures the timeout from the last keystroke of the reader', async () => {
    const client = await connectReady(server.url)
    const run = client.start(1, 'for i in 1 2 3 4 5 6; do read k; s="$s$k"; done; echo "got $s"')
    for (const key of ['a\r', 'b\r', 'c\r', 'd\r', 'e\r', 'f\r']) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      run.stdin(key)
    }
    const result = await run.done
    expect(result.code).toBe(0)
    expect(result.output).not.toContain('timed out')
    expect(result.output.endsWith('got abcdef\r\n')).toBe(true)
  }, 20_000)

  it('caps output per command with a notice and discards the rest', async () => {
    const client = await connectReady(server.url)
    const result = await client.run(1, "yes | tr -d '\\n'")
    const notice = 'docsterm-server: output limit of 4 KB reached; the rest is discarded\r\n'
    expect(result.output).toBe(`${'y'.repeat(4096)}\r\n${notice}`)
    expect(result.code).toBe(130)
    expect(await client.run(2, 'echo next')).toMatchObject({ output: 'next\r\n', code: 0 })
  })

  it('counts the output limit in JSON-encoded bytes', async () => {
    const client = await connectReady(server.url)
    const notice = 'docsterm-server: output limit of 4 KB reached; the rest is discarded\r\n'
    const zeros = await client.run(1, 'cat /dev/zero')
    expect(zeros.output).toBe(`${'\u0000'.repeat(682)}\r\n${notice}`)
    expect(await client.run(2, 'echo next')).toMatchObject({ output: 'next\r\n', code: 0 })
  })

  it('drops stdin above the byte rate without restarting the timeout', async () => {
    const client = await connectReady(server.url)
    const run = client.start(
      1,
      'stty -icanon -echo min 1 time 0; printf ready; n=$(dd bs=1 count=1800 2>/dev/null | wc -c); stty icanon echo; echo " got=$n"',
    )
    await run.waitFor('ready')
    for (let index = 0; index < 3; index += 1) run.stdin('a'.repeat(600))
    const result = await run.done
    expect(result.code).toBe(124)
    expect(result.output).not.toContain('got=1800')
    expect(await client.run(2, 'echo ok')).toMatchObject({ output: 'ok\r\n', code: 0 })
  }, 20_000)

  it('writes the timeout and output limit notices in Russian for a Russian run', async () => {
    const client = await connectReady(server.url)
    const capped = await client.run(1, 'yes', { locale: 'ru' })
    expect(capped.output.endsWith('docsterm-server: достигнут лимит вывода 4 КБ; остальное отброшено\r\n')).toBe(true)
    const timed = await client.run(2, 'echo started; sleep 30', { locale: 'ru' })
    expect(timed.code).toBe(124)
    expect(timed.output.startsWith('started\r\ndocsterm-server: команда остановлена: 1 с без ввода\r\n')).toBe(true)
  })

  it('kills a foreground job that ignores SIGINT after the grace period', async () => {
    const client = await connectReady(server.url)
    const run = client.start(1, "(trap '' INT; echo started; sleep 30)")
    await run.waitFor('started')
    const sent = Date.now()
    run.cancel()
    expect((await run.done).code).toBe(130)
    expect(Date.now() - sent).toBeLessThan(5000)
    expect(await client.run(2, 'echo alive')).toMatchObject({ output: 'alive\r\n', code: 0 })
  })

  it('closes an idle connection', async () => {
    const client = await connectReady(server.url)
    expect(await client.closed).toEqual({ code: 1000, reason: 'idle limit reached' })
  })
})

describe('websocket reference server: flow control and abuse limits', () => {
  it('stops reading the sandbox and closes the connection when the client stops reading', async () => {
    const flow = await startServer({ STALL_TIMEOUT_MS: '1000', OUTPUT_LIMIT_BYTES: String(64 * 1024 * 1024) })
    const socket = await upgradeSocket(flow.port)
    try {
      socket.pause()
      socket.write(maskedTextFrame(JSON.stringify({ type: 'run', id: 1, command: 'yes' })))
      await poll(() => flow.logs().includes(' stalled-close '), 'the stalled connection to be closed')
    } finally {
      socket.destroy()
      await flow.stop()
    }
  }, 20_000)

  it('limits the connection rate per client address', async () => {
    const rated = await startServer({ CONNECTS_PER_MINUTE_PER_IP: '3' })
    try {
      for (let index = 0; index < 3; index += 1) expect(await upgrade(rated.port, '/', {})).toBe(101)
      expect(await upgrade(rated.port, '/', {})).toBe(429)
    } finally {
      await rated.stop()
    }
  })

  it('ends a session after MAX_SESSION_MS with a notice', async () => {
    const short = await startServer({ MAX_SESSION_MS: '1500', READY_WAIT_MS: '1000' })
    try {
      const client = await connectReady(short.url)
      const run = client.start(1, SLEEPER)
      await run.waitFor('started')
      expect(await client.closed).toEqual({ code: 1000, reason: 'session limit reached' })
      expect(run.output()).toBe('started\r\ndocsterm-server: session time limit of 1.5 s reached\r\n')
    } finally {
      await short.stop()
    }
  })

  it('drops messages above the per-connection rate', async () => {
    const rated = await startServer({ MESSAGE_BURST: '20', MESSAGES_PER_SECOND: '5', READY_WAIT_MS: '1000' })
    try {
      const client = await connectReady(rated.url)
      for (let columns = 31; columns <= 55; columns += 1) client.send({ type: 'resize', columns, rows: 10 })
      await poll(() => rated.logs().includes(' messages-dropped '), 'the rate limit to drop messages')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await client.run(1, 'stty size')).toMatchObject({ output: '10 50\r\n', code: 0 })
    } finally {
      await rated.stop()
    }
  })
})

describe('websocket reference server: slow sandbox start', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startServer({ LOCAL_START_DELAY_MS: '1200', READY_WAIT_MS: '100' })
  })

  afterAll(async () => {
    await server?.stop()
  })

  it('sends ready before the sandbox is up and holds an early run until the shell is ready', async () => {
    const client = await connect(server.url)
    const run = client.start(1, 'echo hi')
    expect(await client.ready()).toEqual({ type: 'ready', protocol: 2, features: ['pty', 'resize', 'prompt', 'ping'] })
    expect(await run.done).toMatchObject({ output: 'hi\r\n', code: 0, prompt: 'sandbox:~$ ' })
    expect(client.arrivals).toEqual(['ready', 'output 1', 'exit 1'])
  })

  it('answers a waiting run and closes with 1011 when the sandbox cannot start', async () => {
    const broken = await startServer({ LOCAL_SHELL: '/nonexistent/sh', LOCAL_START_DELAY_MS: '1000', READY_WAIT_MS: '50' })
    try {
      const client = await connect(broken.url)
      const run = client.start(1, 'echo never')
      expect(await client.ready()).toEqual({ type: 'ready', protocol: 2, features: ['pty', 'resize', 'prompt', 'ping'] })
      expect(await run.done).toEqual({
        output: 'docsterm-server: the sandbox could not be started\r\n',
        chunks: ['docsterm-server: the sandbox could not be started\r\n'],
        code: 125,
        prompt: undefined,
      })
      expect(await client.closed).toEqual({ code: 1011, reason: 'sandbox unavailable' })
      expect(client.arrivals).toEqual(['ready', 'output 1', 'exit 1'])
    } finally {
      await broken.stop()
    }
  })
})

describe('websocket reference server: token and origin allowlist', () => {
  const token = 'test-token-0123456789'
  let server: TestServer

  beforeAll(async () => {
    server = await startServer({ TOKEN: token, ALLOWED_ORIGINS: 'https://docs.example.com' })
  })

  afterAll(async () => {
    await server?.stop()
  })

  it('checks origins against ALLOWED_ORIGINS and the query token', async () => {
    const path = `/?token=${token}`
    expect(await upgrade(server.port, path, { Origin: 'https://docs.example.com' })).toBe(101)
    expect(await upgrade(server.port, path, { Origin: 'http://localhost:5173' })).toBe(403)
    expect(await upgrade(server.port, '/?token=wrong', {})).toBe(401)
    const client = await connect(`${server.url}/?token=${token}`)
    expect((await client.ready()).type).toBe('ready')
  })

  it('accepts the token as the first message and refuses anything else', async () => {
    const good = await connect(server.url)
    good.send({ type: 'auth', token })
    expect((await good.ready()).type).toBe('ready')
    const wrong = await connect(server.url)
    wrong.send({ type: 'auth', token: 'nope' })
    expect(await wrong.closed).toEqual({ code: 1008, reason: 'unauthorized' })
    const early = await connect(server.url)
    early.send({ type: 'ping' })
    expect(await early.closed).toEqual({ code: 1008, reason: 'unauthorized' })
  })
})

describe('websocket reference server: connection limits and startup', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startServer({ MAX_CONNECTIONS_PER_IP: '2' })
  })

  afterAll(async () => {
    await server?.stop()
  })

  it('limits connections per IP', async () => {
    await connectReady(server.url)
    await connectReady(server.url)
    expect(await upgrade(server.port, '/', {})).toBe(429)
  })

  it('refuses the local sandbox outside NODE_ENV=test', async () => {
    const child = spawn(process.execPath, [serverPath], {
      env: baseEnv({ NODE_ENV: 'production' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    expect(await exited(child)).toBe(1)
    expect(stderr).toContain('only allowed with NODE_ENV=test')
  })

  it('shuts a local test server down when the process that started it dies', async () => {
    const launcher = spawn(
      process.execPath,
      [
        '-e',
        `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(serverPath)}], { env: process.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true }); child.stdout.once('data', () => { console.log(child.pid); process.exit(0) })`,
      ],
      { env: baseEnv({}), stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let printed = ''
    launcher.stdout?.on('data', (data: Buffer) => {
      printed += data.toString()
    })
    await exited(launcher)
    const pid = Number(printed.trim())
    try {
      expect(pid).toBeGreaterThan(0)
      await poll(() => !isRunning(pid), 'the orphaned server to exit')
    } finally {
      if (pid > 0 && isRunning(pid)) process.kill(pid, 'SIGKILL')
      if (pid > 0) removeSandboxDirsOf(pid)
    }
  })

  it('sweeps the sandboxes of a hard-killed server at the next start and keeps those of live servers', async () => {
    const live = join(tmpdir(), `${SANDBOX_PREFIX}${process.pid}-live`)
    const untaggedOld = join(tmpdir(), `${SANDBOX_PREFIX}${randomBytes(3).toString('hex')}`)
    const untaggedFresh = join(tmpdir(), `${SANDBOX_PREFIX}${randomBytes(3).toString('hex')}`)
    for (const dir of [live, untaggedOld, untaggedFresh]) mkdirSync(dir, { recursive: true })
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(untaggedOld, hourAgo, hourAgo)
    const killed = await startServer()
    let next: TestServer | undefined
    try {
      const client = await connectReady(killed.url)
      const shellPid = Number((await client.run(1, 'echo $$')).output.trim())
      expect(sandboxDirsOf(killed.pid)).toHaveLength(1)
      await killed.hardKill()
      await client.closed
      await poll(() => !isRunning(shellPid), 'the orphaned shell to exit')
      next = await startServer()
      expect(sandboxDirsOf(killed.pid)).toEqual([])
      expect(existsSync(live)).toBe(true)
      expect(existsSync(untaggedOld)).toBe(false)
      expect(existsSync(untaggedFresh)).toBe(true)
    } finally {
      for (const dir of [live, untaggedOld, untaggedFresh]) rmSync(dir, { recursive: true, force: true })
      removeSandboxDirsOf(killed.pid)
      await next?.stop()
    }
  })
})
