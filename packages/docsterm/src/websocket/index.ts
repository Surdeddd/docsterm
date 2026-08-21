import type { Backend, BackendHost, BackendRunResult } from '../types.js'

export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((event?: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event?: unknown) => void) | null
  onclose: ((event?: unknown) => void) | null
}

export interface WebSocketBackendOptions {
  url: string
  protocols?: string | string[]
  prompt?: string
  banner?: string
  timeoutMs?: number
  connectTimeoutMs?: number
  createSocket?: (url: string, protocols?: string | string[]) => SocketLike
}

export type ServerMessage =
  | { type: 'ready'; banner?: string }
  | { type: 'output'; id?: number; chunk: string }
  | { type: 'exit'; id?: number; code: number }

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw) as Partial<ServerMessage> & { type?: string }
    if (parsed.type === 'ready') return { type: 'ready', banner: (parsed as { banner?: string }).banner }
    if (parsed.type === 'output' && typeof (parsed as { chunk?: unknown }).chunk === 'string') {
      return { type: 'output', id: (parsed as { id?: number }).id, chunk: (parsed as { chunk: string }).chunk }
    }
    if (parsed.type === 'exit' && typeof (parsed as { code?: unknown }).code === 'number') {
      return { type: 'exit', id: (parsed as { id?: number }).id, code: (parsed as { code: number }).code }
    }
    return null
  } catch {
    return null
  }
}

const defaultSocketFactory = (url: string, protocols?: string | string[]): SocketLike =>
  new WebSocket(url, protocols) as unknown as SocketLike

export function createWebSocketBackend(options: WebSocketBackendOptions): Backend {
  const timeoutMs = options.timeoutMs ?? 120_000
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000
  const factory = options.createSocket ?? defaultSocketFactory

  let socket: SocketLike | null = null
  let host: BackendHost | null = null
  let counter = 0
  let active: { id: number; chunks: string[]; finish: (result: BackendRunResult) => void } | null = null

  const failActive = (message: string) => {
    if (!active) return
    const pending = active
    active = null
    pending.finish({ output: [...pending.chunks, message].filter(Boolean).join(''), exitCode: 1 })
  }

  return {
    id: 'websocket',
    prompt: options.prompt ?? '$ ',

    init(backendHost: BackendHost): Promise<void> {
      host = backendHost
      return new Promise((resolve, reject) => {
        const instance = factory(options.url, options.protocols)
        const timer = setTimeout(() => {
          instance.close()
          reject(new Error(`connection to ${options.url} timed out`))
        }, connectTimeoutMs)

        instance.onopen = () => {
          clearTimeout(timer)
          socket = instance
          if (options.banner) host?.write(`${options.banner}\n`)
          resolve()
        }
        instance.onerror = () => {
          clearTimeout(timer)
          failActive('\nconnection error')
          reject(new Error(`cannot connect to ${options.url}`))
        }
        instance.onclose = () => {
          socket = null
          failActive('\nconnection closed by the server')
        }
        instance.onmessage = (event) => {
          const message = parseServerMessage(event.data)
          if (!message) return
          if (message.type === 'ready') {
            if (message.banner) host?.write(`${message.banner}\n`)
            return
          }
          if (!active) return
          if (message.id !== undefined && message.id !== active.id) return
          if (message.type === 'output') {
            active.chunks.push(message.chunk)
            return
          }
          const pending = active
          active = null
          pending.finish({
            output: pending.chunks.join('').replace(/\n$/, ''),
            exitCode: message.code,
          })
        }
      })
    },

    run(command: string): Promise<BackendRunResult> {
      if (!socket) return Promise.resolve({ output: 'not connected', exitCode: 1 })
      const id = (counter += 1)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          failActive(`\ntimed out after ${timeoutMs}ms`)
        }, timeoutMs)
        active = {
          id,
          chunks: [],
          finish: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
        }
        socket?.send(JSON.stringify({ type: 'run', id, command }))
      })
    },

    dispose(): void {
      socket?.close()
      socket = null
      host = null
      active = null
    },
  }
}
