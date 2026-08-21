import { describe, expect, it } from 'vitest'
import {
  buildWasiResult,
  createWasiBackend,
  createWasiImports,
  encodeStringList,
  ExitSignal,
  splitCommandLine,
  type WasiHostState,
  type WasiInstance,
} from '../src/wasi/index.js'

const memoryOf = () => new WebAssembly.Memory({ initial: 1 })

type Preview1 = Record<string, (...args: never[]) => number>

const importsFor = (
  state: WasiHostState,
  memory: WebAssembly.Memory,
  overrides: { argv?: string[]; env?: Record<string, string>; stdin?: string } = {},
) =>
  createWasiImports(state, {
    argv: overrides.argv ?? ['demo'],
    env: overrides.env ?? {},
    stdin: overrides.stdin ?? '',
    getMemory: () => memory,
  }).wasi_snapshot_preview1 as unknown as Preview1

const writeIovec = (memory: WebAssembly.Memory, text: string, textPtr: number, iovPtr: number) => {
  const bytes = new TextEncoder().encode(text)
  new Uint8Array(memory.buffer).set(bytes, textPtr)
  const view = new DataView(memory.buffer)
  view.setUint32(iovPtr, textPtr, true)
  view.setUint32(iovPtr + 4, bytes.length, true)
  return bytes.length
}

describe('splitCommandLine', () => {
  it('splits on spaces and honours quotes', () => {
    expect(splitCommandLine('  greet  world ')).toEqual(['greet', 'world'])
    expect(splitCommandLine('greet "two words" \'and more\'')).toEqual([
      'greet',
      'two words',
      'and more',
    ])
    expect(splitCommandLine('   ')).toEqual([])
  })
})

describe('encodeStringList', () => {
  it('null terminates every entry and reports the total size', () => {
    const { bytes, totalSize } = encodeStringList(['ab', 'c'])
    expect(bytes.map((entry) => entry.length)).toEqual([3, 2])
    expect(totalSize).toBe(5)
    expect(bytes[0]?.at(-1)).toBe(0)
  })
})

describe('wasi preview1 host', () => {
  it('captures stdout and stderr separately through fd_write', () => {
    const memory = memoryOf()
    const state: WasiHostState = { stdout: '', stderr: '', exitCode: null }
    const wasi = importsFor(state, memory)

    writeIovec(memory, 'hello wasm\n', 1024, 16)
    expect(wasi.fd_write?.(1 as never, 16 as never, 1 as never, 8 as never)).toBe(0)
    writeIovec(memory, 'oh no\n', 2048, 32)
    expect(wasi.fd_write?.(2 as never, 32 as never, 1 as never, 8 as never)).toBe(0)

    expect(state.stdout).toBe('hello wasm\n')
    expect(state.stderr).toBe('oh no\n')
    expect(new DataView(memory.buffer).getUint32(8, true)).toBe(6)
  })

  it('rejects writes to an unknown descriptor', () => {
    const memory = memoryOf()
    const state: WasiHostState = { stdout: '', stderr: '', exitCode: null }
    expect(importsFor(state, memory).fd_write?.(7 as never, 0 as never, 0 as never, 0 as never)).toBe(8)
  })

  it('exposes argv through args_sizes_get and args_get', () => {
    const memory = memoryOf()
    const state: WasiHostState = { stdout: '', stderr: '', exitCode: null }
    const wasi = importsFor(state, memory, { argv: ['greet', 'world'] })

    wasi.args_sizes_get?.(0 as never, 4 as never)
    const view = new DataView(memory.buffer)
    expect(view.getUint32(0, true)).toBe(2)
    expect(view.getUint32(4, true)).toBe('greet\0world\0'.length)

    wasi.args_get?.(64 as never, 128 as never)
    const bytes = new Uint8Array(memory.buffer)
    const readAt = (pointer: number) => {
      const end = bytes.indexOf(0, pointer)
      return new TextDecoder().decode(bytes.subarray(pointer, end))
    }
    expect(readAt(view.getUint32(64, true))).toBe('greet')
    expect(readAt(view.getUint32(68, true))).toBe('world')
  })

  it('exposes environment variables as KEY=VALUE pairs', () => {
    const memory = memoryOf()
    const state: WasiHostState = { stdout: '', stderr: '', exitCode: null }
    const wasi = importsFor(state, memory, { env: { LANG: 'ru' } })
    wasi.environ_sizes_get?.(0 as never, 4 as never)
    expect(new DataView(memory.buffer).getUint32(0, true)).toBe(1)
    wasi.environ_get?.(64 as never, 128 as never)
    const bytes = new Uint8Array(memory.buffer)
    const pointer = new DataView(memory.buffer).getUint32(64, true)
    expect(new TextDecoder().decode(bytes.subarray(pointer, bytes.indexOf(0, pointer)))).toBe('LANG=ru')
  })

  it('feeds stdin through fd_read and stops when exhausted', () => {
    const memory = memoryOf()
    const state: WasiHostState = { stdout: '', stderr: '', exitCode: null }
    const wasi = importsFor(state, memory, { stdin: 'piped input' })
    const view = new DataView(memory.buffer)
    view.setUint32(16, 1024, true)
    view.setUint32(20, 64, true)

    wasi.fd_read?.(0 as never, 16 as never, 1 as never, 8 as never)
    const read = view.getUint32(8, true)
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 1024, read))).toBe('piped input')

    wasi.fd_read?.(0 as never, 16 as never, 1 as never, 8 as never)
    expect(view.getUint32(8, true)).toBe(0)
  })

  it('turns proc_exit into a throwable signal carrying the code', () => {
    const memory = memoryOf()
    const state: WasiHostState = { stdout: '', stderr: '', exitCode: null }
    const wasi = importsFor(state, memory)
    expect(() => wasi.proc_exit?.(3 as never)).toThrow(ExitSignal)
    expect(state.exitCode).toBe(3)
  })
})

describe('buildWasiResult', () => {
  it('joins stdout and stderr and defaults to exit 0', () => {
    expect(buildWasiResult({ stdout: 'out\n', stderr: '', exitCode: null })).toEqual({
      output: 'out',
      exitCode: 0,
    })
  })

  it('uses the code carried by an exit signal', () => {
    expect(buildWasiResult({ stdout: 'partial\n', stderr: '', exitCode: 2 }, new ExitSignal(2))).toEqual(
      { output: 'partial', exitCode: 2 },
    )
  })

  it('reports a trap as exit 1 with the message appended', () => {
    const result = buildWasiResult(
      { stdout: '', stderr: '', exitCode: null },
      new WebAssembly.RuntimeError('unreachable'),
    )
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('unreachable')
  })
})

describe('createWasiBackend', () => {
  const fakeModule = (behaviour: (wasi: Preview1, memory: WebAssembly.Memory) => void) => {
    const memory = memoryOf()
    return async (imports: WebAssembly.Imports): Promise<WasiInstance> => {
      const wasi = imports.wasi_snapshot_preview1 as unknown as Preview1
      return {
        exports: {
          memory,
          _start: () => behaviour(wasi, memory),
        },
      }
    }
  }

  it('runs the module and returns what it printed', async () => {
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: fakeModule((wasi, memory) => {
        writeIovec(memory, 'hello from rust\n', 1024, 16)
        wasi.fd_write?.(1 as never, 16 as never, 1 as never, 8 as never)
      }),
    })
    await backend.init({ write: () => {} })
    await expect(backend.run('greet world')).resolves.toEqual({
      output: 'hello from rust',
      exitCode: 0,
    })
  })

  it('passes command line arguments into argv after the program name', async () => {
    let seen: string[] = []
    const backend = createWasiBackend({
      program: 'greet',
      args: ['--preset'],
      instantiate: fakeModule((wasi, memory) => {
        wasi.args_sizes_get?.(0 as never, 4 as never)
        wasi.args_get?.(64 as never, 256 as never)
        const view = new DataView(memory.buffer)
        const bytes = new Uint8Array(memory.buffer)
        const count = view.getUint32(0, true)
        seen = Array.from({ length: count }, (_, index) => {
          const pointer = view.getUint32(64 + index * 4, true)
          return new TextDecoder().decode(bytes.subarray(pointer, bytes.indexOf(0, pointer)))
        })
      }),
    })
    await backend.init({ write: () => {} })
    await backend.run('greet --loud world')
    expect(seen).toEqual(['greet', '--preset', '--loud', 'world'])
  })

  it('propagates a non-zero exit code so explain can use it', async () => {
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: fakeModule((wasi, memory) => {
        writeIovec(memory, 'missing argument\n', 1024, 16)
        wasi.fd_write?.(2 as never, 16 as never, 1 as never, 8 as never)
        wasi.proc_exit?.(2 as never)
      }),
    })
    await backend.init({ write: () => {} })
    await expect(backend.run('greet')).resolves.toEqual({
      output: 'missing argument',
      exitCode: 2,
    })
  })

  it('refuses commands other than the loaded program', async () => {
    const backend = createWasiBackend({ program: 'greet', instantiate: fakeModule(() => {}) })
    await backend.init({ write: () => {} })
    const result = await backend.run('ls -la')
    expect(result.exitCode).toBe(127)
    expect(result.output).toContain('this terminal runs greet')
  })

  it('reports a trapping module instead of throwing', async () => {
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: fakeModule(() => {
        throw new WebAssembly.RuntimeError('unreachable executed')
      }),
    })
    await backend.init({ write: () => {} })
    const result = await backend.run('greet')
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('unreachable executed')
  })

  it('gives each run a fresh instance so state does not leak between commands', async () => {
    let instances = 0
    const backend = createWasiBackend({
      program: 'greet',
      instantiate: async (imports) => {
        instances += 1
        const memory = memoryOf()
        const wasi = imports.wasi_snapshot_preview1 as unknown as Preview1
        return {
          exports: {
            memory,
            _start: () => {
              writeIovec(memory, `run ${instances}\n`, 1024, 16)
              wasi.fd_write?.(1 as never, 16 as never, 1 as never, 8 as never)
            },
          },
        }
      },
    })
    await backend.init({ write: () => {} })
    expect((await backend.run('greet')).output).toBe('run 1')
    expect((await backend.run('greet')).output).toBe('run 2')
  })
})
