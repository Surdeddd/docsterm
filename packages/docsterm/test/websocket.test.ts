import { describe, expect, it } from 'vitest'
import {
  createWebSocketBackend,
  parseServerMessage,
  type SocketLike,
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

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  lastCommand(): { type: string; id: number; command: string } {
    return JSON.parse(this.sent[this.sent.length - 1] ?? '{}') as {
      type: string
      id: number
      command: string
    }
  }
}

const connected = async (options: { timeoutMs?: number } = {}) => {
  const socket = new FakeSocket()
  const backend = createWebSocketBackend({
    url: 'wss://sandbox.test/shell',
    createSocket: () => socket,
    ...options,
  })
  const ready = backend.init({ write: () => {} })
  socket.open()
  await ready
  return { socket, backend }
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
    expect(parseServerMessage(42)).toBeNull()
  })
})

describe('createWebSocketBackend', () => {
  it('sends the command and assembles streamed chunks until exit', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('docker ps')
    expect(socket.lastCommand()).toMatchObject({ type: 'run', command: 'docker ps' })
    const { id } = socket.lastCommand()
    socket.emit({ type: 'output', id, chunk: 'CONTAINER ID   IMAGE\n' })
    socket.emit({ type: 'output', id, chunk: 'a1b2c3         nginx\n' })
    socket.emit({ type: 'exit', id, code: 0 })
    await expect(running).resolves.toEqual({
      output: 'CONTAINER ID   IMAGE\na1b2c3         nginx',
      exitCode: 0,
    })
  })

  it('passes a non-zero exit code through so explain can use it', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('git push')
    const { id } = socket.lastCommand()
    socket.emit({ type: 'output', id, chunk: 'fatal: no upstream\n' })
    socket.emit({ type: 'exit', id, code: 128 })
    await expect(running).resolves.toEqual({ output: 'fatal: no upstream', exitCode: 128 })
  })

  it('ignores messages belonging to an older command', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('ls')
    const { id } = socket.lastCommand()
    socket.emit({ type: 'output', id: id - 1, chunk: 'stale output\n' })
    socket.emit({ type: 'output', id, chunk: 'fresh\n' })
    socket.emit({ type: 'exit', id, code: 0 })
    await expect(running).resolves.toEqual({ output: 'fresh', exitCode: 0 })
  })

  it('writes a server banner when the session becomes ready', async () => {
    const socket = new FakeSocket()
    const writes: string[] = []
    const backend = createWebSocketBackend({
      url: 'wss://sandbox.test/shell',
      createSocket: () => socket,
    })
    const ready = backend.init({ write: (text) => writes.push(text) })
    socket.open()
    await ready
    socket.emit({ type: 'ready', banner: 'ubuntu container ready' })
    expect(writes).toEqual(['ubuntu container ready\n'])
  })

  it('fails the running command when the connection drops', async () => {
    const { socket, backend } = await connected()
    const running = backend.run('sleep 100')
    socket.onclose?.()
    const result = await running
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('connection closed')
  })

  it('times out a command that never finishes', async () => {
    const { backend } = await connected({ timeoutMs: 30 })
    const result = await backend.run('hang')
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('timed out')
  })

  it('rejects init when the socket never opens', async () => {
    const socket = new FakeSocket()
    const backend = createWebSocketBackend({
      url: 'wss://sandbox.test/shell',
      createSocket: () => socket,
      connectTimeoutMs: 20,
    })
    await expect(backend.init({ write: () => {} })).rejects.toThrow('timed out')
    expect(socket.closed).toBe(true)
  })

  it('refuses to run before a connection exists', async () => {
    const backend = createWebSocketBackend({
      url: 'wss://sandbox.test/shell',
      createSocket: () => new FakeSocket(),
    })
    await expect(backend.run('ls')).resolves.toEqual({ output: 'not connected', exitCode: 1 })
  })

  it('closes the socket on dispose', async () => {
    const { socket, backend } = await connected()
    backend.dispose()
    expect(socket.closed).toBe(true)
  })
})
