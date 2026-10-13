// @vitest-environment node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getMessages } from '../src/messages.js'
import { isInteractiveRun, type Backend, type InteractiveRun } from '../src/types.js'
import { createWebSocketBackend } from '../src/websocket/index.js'

const SERVER = fileURLToPath(new URL('../../../examples/websocket-server/server.mjs', import.meta.url))
const en = getMessages('en')

interface Server {
  url: string
  stop(): Promise<void>
}

interface Started {
  run: InteractiveRun
  output(): string
  until(text: string): Promise<void>
}

const waitFor = async (check: () => boolean, what: string, limit = 5000): Promise<void> => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > limit) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const isListening = (value: unknown): value is { event: 'listening'; url: string } =>
  typeof value === 'object' &&
  value !== null &&
  (value as { event?: unknown }).event === 'listening' &&
  typeof (value as { url?: unknown }).url === 'string'

const startServer = (env: Record<string, string> = {}): Promise<Server> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, SANDBOX: 'local', NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderr: string[] = []
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const exited = new Promise<void>((settle) => child.once('exit', () => settle()))
    const stop = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(killer)
    }
    const timer = setTimeout(() => {
      void stop()
      reject(new Error(`the server did not report its address\n${stderr.join('')}`))
    }, 15_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the server exited with ${code}\n${stderr.join('')}`))
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (!isListening(parsed)) return
      clearTimeout(timer)
      resolve({ url: parsed.url, stop })
    })
  })

const connect = async (url: string) => {
  const notices: string[] = []
  const backend = createWebSocketBackend({ url, readyTimeoutMs: 10_000 })
  await backend.init({ write: (text) => notices.push(text), locale: 'en' })
  return { backend, notices }
}

const start = async (backend: Backend, command: string, size = { columns: 80, rows: 24 }): Promise<Started> => {
  let output = ''
  const outcome = await backend.run(command, {
    write: (text) => {
      output += text
    },
    signal: new AbortController().signal,
    columns: size.columns,
    rows: size.rows,
    locale: 'en',
  })
  if (!isInteractiveRun(outcome)) throw new Error(`expected an interactive run for ${command}`)
  return {
    run: outcome,
    output: () => output,
    until: (text) => waitFor(() => output.includes(text), JSON.stringify(text)),
  }
}

describe.skipIf(!existsSync(SERVER))('websocket client against the reference server', () => {
  let server: Server | undefined
  let session: Awaited<ReturnType<typeof connect>>

  beforeAll(async () => {
    server = await startServer()
    session = await connect(server.url)
  }, 30_000)

  afterAll(async () => {
    session?.backend.dispose()
    await server?.stop()
  }, 15_000)

  it('negotiates the pty protocol and keeps shell state between commands, the prompt following cd', async () => {
    const { backend } = session
    expect(backend.prompt).toBe('sandbox:~$ ')
    expect(backend.describe?.()).toBe(en.wsPtyDescription)
    const moving = await start(backend, 'mkdir app && cd app')
    expect(await moving.run.done).toEqual({ output: '', exitCode: 0 })
    expect(backend.prompt).toBe('sandbox:~/app$ ')
    const where = await start(backend, 'basename "$PWD"; false')
    expect(await where.run.done).toEqual({ output: '', exitCode: 1 })
    expect(where.output()).toBe('app\r\n')
    const back = await start(backend, 'cd ..')
    await back.run.done
    expect(backend.prompt).toBe('sandbox:~$ ')
    expect(session.notices).toEqual([])
  })

  it('runs a multi-line loop, a here-document and a continued line as single commands', async () => {
    const { backend } = session
    const sources = [
      ['for i in 1 2', 'do', '  echo "n=$i"', 'done'],
      ['name=docs; cat <<EOF', 'hi $name', '  (indented', 'EOF'],
      ['echo one \\', '  two'],
    ]
    const verdicts = sources.map((lines) =>
      lines.map((_, index) => backend.isComplete?.(lines.slice(0, index + 1).join('\n'))),
    )
    expect(verdicts).toEqual([
      [false, false, false, true],
      [false, false, false, true],
      [false, true],
    ])
    const outputs: string[] = []
    for (const lines of sources) {
      const started = await start(backend, lines.join('\n'))
      expect(await started.run.done).toEqual({ output: '', exitCode: 0 })
      outputs.push(started.output())
    }
    expect(outputs).toEqual(['n=1\r\nn=2\r\n', 'hi docs\r\n  (indented\r\n', 'one two\r\n'])
  })

  it('answers a read prompt through forwarded keystrokes', async () => {
    const asking = await start(session.backend, `printf 'name? '; read name; echo "hi $name"`)
    await asking.until('name? ')
    for (const key of ['A', 'd', 'a', '\r']) asking.run.onKey(key)
    expect(await asking.run.done).toEqual({ output: '', exitCode: 0 })
    expect(asking.output()).toBe('name? Ada\r\nhi Ada\r\n')
  })

  it('stops a sleeping command with a Ctrl+C key within a second', async () => {
    const sleeping = await start(session.backend, "sh -c 'printf started; exec sleep 10'")
    await sleeping.until('started')
    const sent = Date.now()
    sleeping.run.onKey('\x03')
    expect(await sleeping.run.done).toEqual({ output: '', exitCode: 130 })
    expect(Date.now() - sent).toBeLessThan(1000)
    const after = await start(session.backend, 'echo still here')
    expect(await after.run.done).toEqual({ output: '', exitCode: 0 })
    expect(after.output()).toBe('still here\r\n')
  })

  it('cancel() ends a command at once and the next command still runs', async () => {
    const sleeping = await start(session.backend, "sh -c 'printf started; exec sleep 10'")
    await sleeping.until('started')
    sleeping.run.cancel?.()
    expect(await sleeping.run.done).toEqual({ output: '', exitCode: 130 })
    const after = await start(session.backend, 'echo next')
    expect(await after.run.done).toEqual({ output: '', exitCode: 0 })
    expect(after.output()).toBe('next\r\n')
  })

  it('sends the terminal size with every run and resizes the pty of a running program', async () => {
    const sized = await start(session.backend, 'stty size', { columns: 100, rows: 30 })
    expect(await sized.run.done).toEqual({ output: '', exitCode: 0 })
    expect(sized.output()).toBe('30 100\r\n')
    const growing = await start(session.backend, 'printf go; read x; stty size', { columns: 100, rows: 30 })
    await growing.until('go')
    growing.run.resize?.(132, 43)
    growing.run.onKey('\r')
    expect(await growing.run.done).toEqual({ output: '', exitCode: 0 })
    expect(growing.output()).toBe('go\r\n43 132\r\n')
  })

  it('reports a connection the server dropped and starts a new session on the next command', async () => {
    const idle = await startServer({ IDLE_TIMEOUT_MS: '1000' })
    let connected: Awaited<ReturnType<typeof connect>> | undefined
    try {
      connected = await connect(idle.url)
      const { backend, notices } = connected
      const moving = await start(backend, 'cd /tmp')
      await moving.run.done
      expect(backend.prompt).toBe('sandbox:/tmp$ ')
      await waitFor(() => notices.length > 0, 'the close notice')
      expect(notices).toEqual([`${en.connectionClosed} (1000: idle limit reached)\n`])
      expect(backend.prompt).toBe('$ ')
      const again = await start(backend, 'case "$PWD" in /tmp) echo old ;; *) echo new ;; esac')
      expect(await again.run.done).toEqual({ output: '', exitCode: 0 })
      expect(again.output()).toBe(`${en.reconnecting}\n${en.wsNewSession}\nnew\r\n`)
      expect(backend.prompt).toBe('sandbox:~$ ')
    } finally {
      connected?.backend.dispose()
      await idle.stop()
    }
  }, 20_000)
})
