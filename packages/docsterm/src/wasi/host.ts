export interface WasiInstance {
  exports: {
    memory: WebAssembly.Memory
    _start?: () => void
    [name: string]: unknown
  }
}

export interface WasiHostOptions {
  argv: readonly string[]
  env: readonly string[]
  stdin: Uint8Array
  imports?: readonly WebAssembly.ModuleImportDescriptor[]
  deadline?: number
  outputLimit?: number
  write(text: string): void
  truncated?(): void
}

export interface WasiExit {
  code: number
  error?: string
  timedOut?: boolean
}

export interface WasiHost {
  readonly imports: WebAssembly.Imports
  run(instance: WasiInstance): WasiExit
  fail(error: unknown): WasiExit
}

export function createWasiHost(options: WasiHostOptions): WasiHost {
  const SUCCESS = 0
  const BADF = 8
  const INVAL = 28
  const NOSYS = 52
  const SPIPE = 70
  const CHARACTER_DEVICE = 2
  const STDIN_RIGHTS = 136314890n
  const STDOUT_RIGHTS = 136314952n
  const RANDOM_CHUNK = 65536
  const KNOWN = (
    'args_get args_sizes_get environ_get environ_sizes_get clock_res_get clock_time_get fd_advise ' +
    'fd_allocate fd_close fd_datasync fd_fdstat_get fd_fdstat_set_flags fd_fdstat_set_rights ' +
    'fd_filestat_get fd_filestat_set_size fd_filestat_set_times fd_pread fd_prestat_get ' +
    'fd_prestat_dir_name fd_pwrite fd_read fd_readdir fd_renumber fd_seek fd_sync fd_tell fd_write ' +
    'path_create_directory path_filestat_get path_filestat_set_times path_link path_open ' +
    'path_readlink path_remove_directory path_rename path_symlink path_unlink_file poll_oneoff ' +
    'proc_exit proc_raise sched_yield random_get sock_accept sock_recv sock_send sock_shutdown'
  ).split(' ')
  const exitSignal = { code: 0 }
  const timeoutSignal = { timedOut: true }
  const encoder = new TextEncoder()
  const stdoutDecoder = new TextDecoder()
  const stderrDecoder = new TextDecoder()
  const limit = options.outputLimit !== undefined && options.outputLimit > 0 ? options.outputLimit : Infinity
  const origin = BigInt(Math.round(performance.timeOrigin * 1000)) * 1000n
  const started = performance.now()
  const argv = options.argv.map((value) => encoder.encode(`${value}\0`))
  const env = options.env.map((value) => encoder.encode(`${value}\0`))
  let memory: WebAssembly.Memory | null = null
  let waiter: Int32Array | null | undefined
  let stdinOffset = 0
  let emitted = 0
  let truncated = false
  let lastFd = 0
  let lineOpen = false

  const check = () => {
    if (options.deadline !== undefined && performance.now() > options.deadline) throw timeoutSignal
  }
  const buffer = () => {
    if (memory === null) throw new Error('wasm memory is not bound')
    return memory.buffer
  }
  const view = () => new DataView(buffer())
  const bytes = () => new Uint8Array(buffer())
  const isStdio = (fd: number) => fd === 0 || fd === 1 || fd === 2

  const emit = (fd: number, text: string) => {
    if (text === '' || truncated) return
    let chunk = lineOpen && lastFd !== fd ? `\n${text}` : text
    if (emitted + chunk.length > limit) {
      chunk = chunk.slice(0, Math.max(0, limit - emitted))
      if (/[\ud800-\udbff]$/.test(chunk)) chunk = chunk.slice(0, -1)
      truncated = true
    }
    if (chunk !== '') {
      emitted += chunk.length
      lastFd = fd
      lineOpen = !chunk.endsWith('\n')
      options.write(chunk)
    }
    if (truncated && options.truncated) options.truncated()
  }

  const listSizes = (list: Uint8Array[], countPtr: number, sizePtr: number) => {
    check()
    let total = 0
    for (let index = 0; index < list.length; index += 1) total += list[index]?.length ?? 0
    const data = view()
    data.setUint32(countPtr, list.length, true)
    data.setUint32(sizePtr, total, true)
    return SUCCESS
  }

  const listFill = (list: Uint8Array[], pointers: number, target: number) => {
    check()
    const data = view()
    const memoryBytes = bytes()
    let cursor = target
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index] ?? new Uint8Array()
      data.setUint32(pointers + index * 4, cursor, true)
      memoryBytes.set(entry, cursor)
      cursor += entry.length
    }
    return SUCCESS
  }

  const clockNow = (id: number): bigint | null => {
    if (id === 0) return BigInt(Date.now()) * 1_000_000n
    if (id === 1) return origin + BigInt(Math.round(performance.now() * 1e6))
    if (id === 2 || id === 3) return BigInt(Math.round((performance.now() - started) * 1e6))
    return null
  }

  const sleep = (milliseconds: number) => {
    const target = performance.now() + milliseconds
    const until = options.deadline === undefined ? target : Math.min(target, options.deadline)
    if (waiter === undefined) {
      waiter = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null
    }
    let current = performance.now()
    if (waiter !== null && current < until) {
      try {
        Atomics.wait(waiter, 0, 0, until - current)
      } catch {
        waiter = null
      }
      current = performance.now()
    }
    while (current < until) current = performance.now()
    if (until < target) throw timeoutSignal
  }

  const implemented: Record<string, WebAssembly.ImportValue> = {
    args_sizes_get: (countPtr: number, sizePtr: number) => listSizes(argv, countPtr, sizePtr),
    args_get: (pointers: number, target: number) => listFill(argv, pointers, target),
    environ_sizes_get: (countPtr: number, sizePtr: number) => listSizes(env, countPtr, sizePtr),
    environ_get: (pointers: number, target: number) => listFill(env, pointers, target),

    fd_write: (fd: number, iovs: number, count: number, writtenPtr: number) => {
      check()
      if (fd !== 1 && fd !== 2) return BADF
      const data = view()
      const memoryBytes = bytes()
      const decoder = fd === 1 ? stdoutDecoder : stderrDecoder
      let written = 0
      let text = ''
      for (let index = 0; index < count; index += 1) {
        const base = data.getUint32(iovs + index * 8, true)
        const length = data.getUint32(iovs + index * 8 + 4, true)
        if (!truncated) text += decoder.decode(memoryBytes.subarray(base, base + length), { stream: true })
        written += length
      }
      emit(fd, text)
      data.setUint32(writtenPtr, written, true)
      return SUCCESS
    },

    fd_read: (fd: number, iovs: number, count: number, readPtr: number) => {
      check()
      if (fd !== 0) return BADF
      const data = view()
      const memoryBytes = bytes()
      let read = 0
      for (let index = 0; index < count && stdinOffset < options.stdin.length; index += 1) {
        const base = data.getUint32(iovs + index * 8, true)
        const length = data.getUint32(iovs + index * 8 + 4, true)
        const chunk = options.stdin.subarray(stdinOffset, stdinOffset + length)
        memoryBytes.set(chunk, base)
        stdinOffset += chunk.length
        read += chunk.length
      }
      data.setUint32(readPtr, read, true)
      return SUCCESS
    },

    fd_fdstat_get: (fd: number, statPtr: number) => {
      check()
      if (!isStdio(fd)) return BADF
      const data = view()
      data.setBigUint64(statPtr, 0n, true)
      data.setUint8(statPtr, CHARACTER_DEVICE)
      data.setBigUint64(statPtr + 8, fd === 0 ? STDIN_RIGHTS : STDOUT_RIGHTS, true)
      data.setBigUint64(statPtr + 16, 0n, true)
      return SUCCESS
    },

    fd_filestat_get: (fd: number, statPtr: number) => {
      check()
      if (!isStdio(fd)) return BADF
      const data = view()
      for (let offset = 0; offset < 64; offset += 8) data.setBigUint64(statPtr + offset, 0n, true)
      data.setUint8(statPtr + 16, CHARACTER_DEVICE)
      data.setBigUint64(statPtr + 24, 1n, true)
      return SUCCESS
    },

    fd_fdstat_set_flags: (fd: number) => {
      check()
      return isStdio(fd) ? SUCCESS : BADF
    },
    fd_close: (fd: number) => {
      check()
      return isStdio(fd) ? SUCCESS : BADF
    },
    fd_seek: (fd: number) => {
      check()
      return isStdio(fd) ? SPIPE : BADF
    },
    fd_tell: (fd: number) => {
      check()
      return isStdio(fd) ? SPIPE : BADF
    },
    fd_prestat_get: () => {
      check()
      return BADF
    },
    fd_prestat_dir_name: () => {
      check()
      return BADF
    },

    clock_time_get: (id: number, _precision: bigint, timePtr: number) => {
      check()
      const value = clockNow(id)
      if (value === null) return INVAL
      view().setBigUint64(timePtr, value, true)
      return SUCCESS
    },

    clock_res_get: (id: number, resolutionPtr: number) => {
      check()
      if (clockNow(id) === null) return INVAL
      view().setBigUint64(resolutionPtr, id === 0 ? 1_000_000n : 1000n, true)
      return SUCCESS
    },

    random_get: (pointer: number, length: number) => {
      check()
      const memoryBytes = bytes()
      for (let offset = 0; offset < length; offset += RANDOM_CHUNK) {
        crypto.getRandomValues(memoryBytes.subarray(pointer + offset, pointer + Math.min(length, offset + RANDOM_CHUNK)))
      }
      return SUCCESS
    },

    poll_oneoff: (subscriptions: number, eventsPtr: number, count: number, countPtr: number) => {
      check()
      if (count === 0) return INVAL
      const data = view()
      const clocks: Array<{ userdata: bigint; wait: number }> = []
      let events = 0
      let soonest = Infinity
      const record = (userdata: bigint, error: number, type: number, available: bigint, flags: number) => {
        const at = eventsPtr + events * 32
        const out = view()
        out.setBigUint64(at, userdata, true)
        out.setUint16(at + 8, error, true)
        out.setUint8(at + 10, type)
        out.setBigUint64(at + 16, available, true)
        out.setUint16(at + 24, flags, true)
        events += 1
      }
      for (let index = 0; index < count; index += 1) {
        const at = subscriptions + index * 48
        const userdata = data.getBigUint64(at, true)
        const tag = data.getUint8(at + 8)
        const fd = data.getUint32(at + 16, true)
        if (tag === 0) {
          const clockId = fd
          const current = clockNow(clockId)
          if (current === null) {
            record(userdata, INVAL, tag, 0n, 0)
            continue
          }
          const timeout = data.getBigUint64(at + 24, true)
          const absolute = (data.getUint16(at + 40, true) & 1) === 1
          const wait = Number(absolute ? timeout - current : timeout) / 1e6
          clocks.push({ userdata, wait })
          soonest = Math.min(soonest, wait)
        } else if (tag === 1 && fd === 0) {
          const left = options.stdin.length - stdinOffset
          record(userdata, SUCCESS, tag, BigInt(left), left === 0 ? 1 : 0)
        } else if (tag === 2 && (fd === 1 || fd === 2)) {
          record(userdata, SUCCESS, tag, 0n, 0)
        } else {
          record(userdata, tag === 1 || tag === 2 ? BADF : INVAL, tag, 0n, 0)
        }
      }
      let threshold = 0
      if (events === 0) {
        threshold = Math.max(soonest, 0)
        if (threshold > 0) sleep(threshold)
      }
      for (let index = 0; index < clocks.length; index += 1) {
        const clock = clocks[index]
        if (clock && clock.wait <= threshold) record(clock.userdata, SUCCESS, 0, 0n, 0)
      }
      view().setUint32(countPtr, events, true)
      return SUCCESS
    },

    sched_yield: () => {
      check()
      return SUCCESS
    },

    proc_exit: (code: number) => {
      exitSignal.code = code & 255
      throw exitSignal
    },
  }

  const unsupported = () => {
    check()
    return NOSYS
  }

  const namespace = (name: string, layoutSensitive: readonly string[]) => {
    const table: Record<string, WebAssembly.ImportValue> = Object.create(null)
    const provide = (field: string) => {
      const own = Object.prototype.hasOwnProperty.call(implemented, field) && layoutSensitive.indexOf(field) === -1
      table[field] = own ? implemented[field] ?? unsupported : unsupported
    }
    for (let index = 0; index < KNOWN.length; index += 1) provide(KNOWN[index] ?? '')
    const declared = options.imports ?? []
    for (let index = 0; index < declared.length; index += 1) {
      const entry = declared[index]
      if (entry && entry.module === name && entry.kind === 'function') provide(entry.name)
    }
    return table
  }

  const imports: WebAssembly.Imports = {
    wasi_snapshot_preview1: namespace('wasi_snapshot_preview1', []),
    wasi_unstable: namespace('wasi_unstable', ['fd_filestat_get', 'poll_oneoff']),
  }

  const finish = (thrown: unknown, failed: boolean): WasiExit => {
    if (!truncated) {
      emit(1, stdoutDecoder.decode())
      emit(2, stderrDecoder.decode())
    }
    if (!failed) return { code: 0 }
    if (thrown === exitSignal) return { code: exitSignal.code }
    if (thrown === timeoutSignal) return { code: 124, timedOut: true }
    if (thrown instanceof Error) return { code: 1, error: `${thrown.name}: ${thrown.message}` }
    return { code: 1, error: String(thrown) }
  }

  return {
    imports,
    run(instance: WasiInstance): WasiExit {
      memory = instance.exports.memory
      try {
        const start = instance.exports._start
        if (typeof start !== 'function') throw new Error('wasm module exports no _start')
        start()
      } catch (error) {
        return finish(error, true)
      }
      return finish(undefined, false)
    },
    fail(error: unknown): WasiExit {
      return finish(error, true)
    },
  }
}
