import type { Backend, BackendHost, BackendRunResult, SimpleBackend } from '../types.js'

const WASI_ESUCCESS = 0
const WASI_EBADF = 8
const WASI_ENOSYS = 52

export interface WasiInstance {
  exports: {
    memory: WebAssembly.Memory
    _start?: () => void
    [name: string]: unknown
  }
}

export interface WasiBackendOptions {
  url?: string
  bytes?: BufferSource
  program?: string
  args?: string[]
  env?: Record<string, string>
  banner?: string
  prompt?: string
  stdin?: string
  instantiate?: (imports: WebAssembly.Imports) => Promise<WasiInstance>
}

export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
    this.name = 'ExitSignal'
  }
}

export function splitCommandLine(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ') {
      if (current !== '') parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') parts.push(current)
  return parts
}

export function encodeStringList(values: string[]): { bytes: Uint8Array[]; totalSize: number } {
  const encoder = new TextEncoder()
  const bytes = values.map((value) => encoder.encode(`${value}\0`))
  return { bytes, totalSize: bytes.reduce((sum, entry) => sum + entry.length, 0) }
}

export interface WasiHostState {
  stdout: string
  stderr: string
  exitCode: number | null
}

export function createWasiImports(
  state: WasiHostState,
  options: { argv: string[]; env: Record<string, string>; stdin: string; getMemory: () => WebAssembly.Memory },
): WebAssembly.Imports {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const envList = Object.entries(options.env).map(([key, value]) => `${key}=${value}`)
  let stdinOffset = 0

  const view = () => new DataView(options.getMemory().buffer)
  const bytesOf = () => new Uint8Array(options.getMemory().buffer)

  const writeList = (values: string[], pointersPtr: number, bufferPtr: number): number => {
    const { bytes } = encodeStringList(values)
    const memory = bytesOf()
    const data = view()
    let cursor = bufferPtr
    bytes.forEach((entry, index) => {
      data.setUint32(pointersPtr + index * 4, cursor, true)
      memory.set(entry, cursor)
      cursor += entry.length
    })
    return WASI_ESUCCESS
  }

  const sizes = (values: string[], countPtr: number, sizePtr: number): number => {
    const { bytes, totalSize } = encodeStringList(values)
    const data = view()
    data.setUint32(countPtr, bytes.length, true)
    data.setUint32(sizePtr, totalSize, true)
    return WASI_ESUCCESS
  }

  const wasi = {
    args_sizes_get: (countPtr: number, sizePtr: number) => sizes(options.argv, countPtr, sizePtr),
    args_get: (pointersPtr: number, bufferPtr: number) =>
      writeList(options.argv, pointersPtr, bufferPtr),
    environ_sizes_get: (countPtr: number, sizePtr: number) => sizes(envList, countPtr, sizePtr),
    environ_get: (pointersPtr: number, bufferPtr: number) =>
      writeList(envList, pointersPtr, bufferPtr),

    fd_write: (fd: number, iovsPtr: number, iovsLen: number, writtenPtr: number) => {
      if (fd !== 1 && fd !== 2) return WASI_EBADF
      const data = view()
      const memory = bytesOf()
      let written = 0
      let text = ''
      for (let index = 0; index < iovsLen; index += 1) {
        const base = data.getUint32(iovsPtr + index * 8, true)
        const length = data.getUint32(iovsPtr + index * 8 + 4, true)
        text += decoder.decode(memory.subarray(base, base + length))
        written += length
      }
      if (fd === 1) state.stdout += text
      else state.stderr += text
      data.setUint32(writtenPtr, written, true)
      return WASI_ESUCCESS
    },

    fd_read: (fd: number, iovsPtr: number, iovsLen: number, readPtr: number) => {
      if (fd !== 0) return WASI_EBADF
      const data = view()
      const memory = bytesOf()
      const pending = encoder.encode(options.stdin.slice(stdinOffset))
      let read = 0
      for (let index = 0; index < iovsLen && read < pending.length; index += 1) {
        const base = data.getUint32(iovsPtr + index * 8, true)
        const length = data.getUint32(iovsPtr + index * 8 + 4, true)
        const slice = pending.subarray(read, read + length)
        memory.set(slice, base)
        read += slice.length
      }
      stdinOffset += read
      data.setUint32(readPtr, read, true)
      return WASI_ESUCCESS
    },

    fd_close: () => WASI_ESUCCESS,
    fd_seek: () => WASI_ENOSYS,
    fd_fdstat_get: (_fd: number, statPtr: number) => {
      const data = view()
      data.setUint8(statPtr, 2)
      data.setUint16(statPtr + 2, 0, true)
      data.setBigUint64(statPtr + 8, 0n, true)
      data.setBigUint64(statPtr + 16, 0n, true)
      return WASI_ESUCCESS
    },
    fd_prestat_get: () => WASI_EBADF,
    fd_prestat_dir_name: () => WASI_EBADF,
    path_open: () => WASI_ENOSYS,
    clock_time_get: (_id: number, _precision: bigint, timePtr: number) => {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true)
      return WASI_ESUCCESS
    },
    random_get: (bufferPtr: number, length: number) => {
      const memory = bytesOf().subarray(bufferPtr, bufferPtr + length)
      crypto.getRandomValues(memory)
      return WASI_ESUCCESS
    },
    poll_oneoff: () => WASI_ENOSYS,
    sched_yield: () => WASI_ESUCCESS,
    proc_exit: (code: number) => {
      state.exitCode = code
      throw new ExitSignal(code)
    },
  }

  return { wasi_snapshot_preview1: wasi, wasi_unstable: wasi }
}

export function buildWasiResult(state: WasiHostState, thrown?: unknown): BackendRunResult {
  const parts = [state.stdout, state.stderr].filter((part) => part !== '')
  if (thrown instanceof ExitSignal) {
    return { output: parts.join('').replace(/\n$/, ''), exitCode: thrown.code }
  }
  if (thrown !== undefined) {
    const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
    return { output: [...parts, message].join('').replace(/\n$/, ''), exitCode: 1 }
  }
  return { output: parts.join('').replace(/\n$/, ''), exitCode: state.exitCode ?? 0 }
}

export function createWasiBackend(options: WasiBackendOptions): SimpleBackend {
  const program = options.program ?? 'main'
  let moduleBytes: BufferSource | null = options.bytes ?? null

  const instantiate = async (imports: WebAssembly.Imports): Promise<WasiInstance> => {
    if (options.instantiate) return options.instantiate(imports)
    if (!moduleBytes) throw new Error('wasm module is not loaded')
    const result = await WebAssembly.instantiate(moduleBytes, imports)
    return result.instance as unknown as WasiInstance
  }

  return {
    id: 'wasi',
    prompt: options.prompt ?? '$ ',

    async init(host: BackendHost): Promise<void> {
      if (!moduleBytes && options.url) {
        const response = await fetch(options.url)
        if (!response.ok) throw new Error(`cannot fetch ${options.url}: ${response.status}`)
        moduleBytes = await response.arrayBuffer()
      }
      if (options.banner) host.write(`${options.banner}\n`)
    },

    async run(command: string): Promise<BackendRunResult> {
      const parts = splitCommandLine(command)
      if (parts.length === 0) return { output: '', exitCode: 0 }
      if (parts[0] !== program) {
        return { output: `${parts[0]}: command not found (this terminal runs ${program})`, exitCode: 127 }
      }

      const state: WasiHostState = { stdout: '', stderr: '', exitCode: null }
      let instance: WasiInstance | null = null
      const imports = createWasiImports(state, {
        argv: [program, ...(options.args ?? []), ...parts.slice(1)],
        env: options.env ?? {},
        stdin: options.stdin ?? '',
        getMemory: () => {
          const memory = instance?.exports.memory
          if (!memory) throw new Error('wasm module exports no memory')
          return memory
        },
      })

      try {
        instance = await instantiate(imports)
        const start = instance.exports._start
        if (typeof start !== 'function') throw new Error('wasm module exports no _start')
        start()
        return buildWasiResult(state)
      } catch (error) {
        return buildWasiResult(state, error)
      }
    },

    dispose(): void {
      moduleBytes = null
    },
  }
}
