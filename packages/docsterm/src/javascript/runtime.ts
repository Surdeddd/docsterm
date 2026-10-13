import type { InspectOptions, Inspector } from './inspect.js'

export interface InitMessage {
  type: 'init'
  globals: Record<string, unknown>
  baseURL: string | null
}

export interface RunMessage {
  type: 'run'
  id: number
  code: string
  declarations: string
  columns: number
  outputLimit?: number | null
}

export type HostMessage = InitMessage | RunMessage

export type WorkerMessage =
  | { type: 'ready'; evalBlocked: boolean }
  | { type: 'log'; id: number | null; text: string }
  | { type: 'result'; id: number; value?: string; error?: string }

export interface WorkerEventLike {
  data?: unknown
  error?: unknown
  message?: unknown
  reason?: unknown
  preventDefault?: () => void
}

type Callable = (...args: unknown[]) => unknown

export interface WorkerScope {
  postMessage(message: WorkerMessage): void
  addEventListener(type: string, listener: (event: WorkerEventLike) => void): void
  eval(code: string): unknown
  console: Record<string, unknown>
  URL: typeof URL
  Request?: typeof Request
  fetch?: Callable
  importScripts?: Callable
  XMLHttpRequest?: { prototype: { open: Callable } }
  [name: string]: unknown
}

export function workerRuntime(scope: WorkerScope, createInspector: () => Inspector): void {
  const ReflectApply = Reflect.apply
  const ReflectConstruct = Reflect.construct
  const ReflectGet = Reflect.get
  const NativePromise = Promise
  const PromiseThen = Promise.prototype.then
  const PromiseReject = Promise.reject
  const NativeProxy = Proxy
  const NativeString = String
  const NativeNumber = Number
  const ArrayIsArray = Array.isArray
  const ArraySlice = Array.prototype.slice
  const RegExpExec = RegExp.prototype.exec
  const ObjectKeys = Object.keys
  const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  const ObjectToString = Object.prototype.toString
  const MathMin = Math.min
  const MathMax = Math.max
  const MathFloor = Math.floor
  const DateNow = Date.now
  const clockOwner = typeof performance === 'object' && performance !== null && typeof performance.now === 'function' ? performance : null
  const clockNow = clockOwner === null ? null : clockOwner.now
  const send = scope.postMessage
  const evaluate = scope.eval
  const inspector = createInspector()
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  const timers: Record<string, number> = Object.create(null) as Record<string, number>
  const resolved: Promise<void> = NativePromise.resolve()
  let current: number | null = null
  let breakLength = 80
  let indent = ''
  let queue = resolved
  let sent = 0
  let budget = Infinity

  const listOf = (args: ArrayLike<unknown>): unknown[] => ReflectApply(ArraySlice, args, []) as unknown[]

  const defer = (callback: () => void): void => {
    ReflectApply(PromiseThen, resolved, [callback])
  }

  const post = (message: WorkerMessage): void => {
    try {
      ReflectApply(send, scope, [message])
    } catch {
      return
    }
  }

  const options = (): InspectOptions => ({ breakLength })

  const clock = (): number => (clockNow === null ? DateNow() : (ReflectApply(clockNow, clockOwner, []) as number))

  const emit = (text: string): void => {
    const line = indent === '' ? text : indent + text.split('\n').join('\n' + indent)
    if (current !== null) {
      if (sent > budget) return
      sent += line.length + 1
    }
    post({ type: 'log', id: current, text: line })
  }

  const show = (value: unknown): string => {
    try {
      return inspector.inspect(value, options())
    } catch {
      try {
        return ReflectApply(ObjectToString, value, []) as string
      } catch {
        return '[object Unknown]'
      }
    }
  }

  const isErrorLike = (value: unknown): boolean => {
    try {
      return inspector.isError(value)
    } catch {
      return false
    }
  }

  const describeThrown = (error: unknown): string => (isErrorLike(error) ? show(error) : 'Uncaught ' + show(error))

  const format = (args: unknown[]): string => {
    try {
      return inspector.format(args, options())
    } catch {
      let text = ''
      for (let index = 0; index < args.length; index += 1) {
        const value = args[index]
        text += (index === 0 ? '' : ' ') + (typeof value === 'string' ? value : show(value))
      }
      return text
    }
  }

  const labelOf = (label: unknown): string => (label === undefined ? 'default' : NativeString(label))

  const pad = (value: number | string): string => NativeString(value).padStart(2, '0')

  const formatTime = (elapsed: number): string => {
    let ms = elapsed
    let hours = 0
    let minutes = 0
    let seconds = 0
    if (ms >= 1000) {
      if (ms >= 60000) {
        if (ms >= 3600000) {
          hours = MathFloor(ms / 3600000)
          ms = ms % 3600000
        }
        minutes = MathFloor(ms / 60000)
        ms = ms % 60000
      }
      seconds = ms / 1000
    }
    if (hours !== 0 || minutes !== 0) {
      const parts = seconds.toFixed(3).split('.')
      const head = hours !== 0 ? hours + ':' + pad(minutes) : NativeString(minutes)
      return head + ':' + pad(parts[0] as string) + '.' + parts[1] + ' (' + (hours !== 0 ? 'h:m' : '') + 'm:ss.mmm)'
    }
    if (seconds !== 0) return seconds.toFixed(3) + 's'
    return NativeNumber(ms.toFixed(3)) + 'ms'
  }

  const log = (...args: unknown[]): void => emit(format(args))

  const methods: Record<string, Callable> = {
    log,
    info: log,
    debug: log,
    warn: log,
    error: log,
    dirxml: log,
    trace: (...args: unknown[]) => emit(args.length === 0 ? 'Trace' : 'Trace: ' + format(args)),
    dir: (value: unknown) => emit(show(value)),
    table: (data: unknown, properties: unknown) => {
      let rendered: string | null = null
      try {
        rendered = inspector.table(data, ArrayIsArray(properties) ? properties : undefined, options())
      } catch {
        rendered = null
      }
      emit(rendered === null ? format([data]) : rendered)
    },
    assert: (condition: unknown, ...rest: unknown[]) => {
      if (condition) return
      const joined = rest.length > 0 && typeof rest[0] === 'string'
      const args: unknown[] = [joined ? 'Assertion failed: ' + rest[0] : 'Assertion failed']
      for (let index = joined ? 1 : 0; index < rest.length; index += 1) args[args.length] = rest[index]
      emit(format(args))
    },
    count: (label: unknown) => {
      const key = labelOf(label)
      counts[key] = (counts[key] || 0) + 1
      emit(key + ': ' + counts[key])
    },
    countReset: (label: unknown) => {
      const key = labelOf(label)
      if (counts[key] === undefined) emit("Count for '" + key + "' does not exist")
      else delete counts[key]
    },
    time: (label: unknown) => {
      const key = labelOf(label)
      if (timers[key] !== undefined) emit("Label '" + key + "' already exists for console.time()")
      else timers[key] = clock()
    },
    timeEnd: (label: unknown) => {
      const key = labelOf(label)
      const started = timers[key]
      if (started === undefined) {
        emit("No such label '" + key + "' for console.timeEnd()")
        return
      }
      delete timers[key]
      emit(key + ': ' + formatTime(clock() - started))
    },
    timeLog: (label: unknown, ...data: unknown[]) => {
      const key = labelOf(label)
      const started = timers[key]
      if (started === undefined) emit("No such label '" + key + "' for console.timeLog()")
      else emit(format(([] as unknown[]).concat('%s: %s', key, formatTime(clock() - started), data)))
    },
    group: (...label: unknown[]) => {
      if (label.length > 0) emit(format(label))
      indent += '  '
    },
    groupCollapsed: (...label: unknown[]) => {
      if (label.length > 0) emit(format(label))
      indent += '  '
    },
    groupEnd: () => {
      indent = indent.slice(0, -2)
    },
    clear: () => {},
  }
  Object.keys(methods).forEach((name) => {
    scope.console[name] = methods[name]
  })

  const installBase = (base: string): void => {
    const NativeURL = scope.URL
    const nativeCanParse = NativeURL.canParse
    const nativeParse = NativeURL.parse
    const NativeRequest = scope.Request
    const nativeFetch = scope.fetch
    const nativeImportScripts = scope.importScripts
    const NativeXHR = scope.XMLHttpRequest
    const relative = /^(?:\/|\.\.?(?:\/|$)|[?#])/
    const isRelative = (input: unknown): boolean => typeof input === 'string' && ReflectApply(RegExpExec, relative, [input]) !== null
    const withBase = (args: ArrayLike<unknown>): unknown[] => {
      const list = listOf(args)
      if (list.length > 0 && (list.length < 2 || list[1] === undefined) && isRelative(list[0])) list[1] = base
      return list
    }
    const resolve = (input: unknown): unknown => {
      if (typeof input === 'symbol') return input
      try {
        return new NativeURL(NativeString(input), base).href
      } catch {
        return input
      }
    }
    const requestDescriptor = typeof NativeRequest === 'function' ? ObjectGetOwnPropertyDescriptor(NativeRequest.prototype, 'url') : undefined
    const requestURL = requestDescriptor === undefined ? undefined : requestDescriptor.get
    const isRequest = (input: unknown): boolean => {
      if (requestURL === undefined || input === null || typeof input !== 'object') return false
      try {
        ReflectApply(requestURL, input, [])
        return true
      } catch {
        return false
      }
    }
    if (typeof NativeRequest === 'function') {
      scope.Request = new NativeProxy(NativeRequest, {
        construct(target, args, newTarget) {
          const list = listOf(args)
          if (list.length > 0 && !isRequest(list[0])) list[0] = resolve(list[0])
          return ReflectConstruct(target, list, newTarget) as object
        },
      })
    }
    if (typeof nativeFetch === 'function') {
      scope.fetch = function fetch(input: unknown): unknown {
        try {
          const list = listOf(arguments)
          if (list.length > 0 && !isRequest(input)) list[0] = resolve(input)
          return ReflectApply(nativeFetch, scope, list)
        } catch (error) {
          return ReflectApply(PromiseReject, NativePromise, [error])
        }
      }
    }
    const canParse = function canParse(_input: unknown): unknown {
      return ReflectApply(nativeCanParse, NativeURL, withBase(arguments))
    }
    const parse = function parse(_input: unknown): unknown {
      return ReflectApply(nativeParse, NativeURL, withBase(arguments))
    }
    scope.URL = new NativeProxy(NativeURL, {
      construct(target, args, newTarget) {
        return ReflectConstruct(target, withBase(args), newTarget) as object
      },
      get(target, key) {
        if (key === 'canParse' && typeof nativeCanParse === 'function') return canParse
        if (key === 'parse' && typeof nativeParse === 'function') return parse
        return ReflectGet(target, key)
      },
    })
    if (typeof nativeImportScripts === 'function') {
      scope.importScripts = function importScripts(): unknown {
        const urls = listOf(arguments)
        for (let index = 0; index < urls.length; index += 1) urls[index] = resolve(urls[index])
        return ReflectApply(nativeImportScripts, scope, urls)
      }
    }
    if (NativeXHR && typeof NativeXHR.prototype.open === 'function') {
      const nativeOpen = NativeXHR.prototype.open
      NativeXHR.prototype.open = function open(this: unknown, _method: unknown, url: unknown): unknown {
        const args = listOf(arguments)
        if (args.length > 1) args[1] = resolve(url)
        return ReflectApply(nativeOpen, this, args)
      }
    }
  }

  const initialize = (message: InitMessage): void => {
    const globals = message.globals !== null && typeof message.globals === 'object' ? message.globals : {}
    const names = ObjectKeys(globals)
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] as string
      scope[name] = globals[name]
    }
    if (typeof message.baseURL === 'string' && message.baseURL !== '') installBase(message.baseURL)
    let evalBlocked = false
    try {
      ReflectApply(evaluate, scope, ['0'])
    } catch {
      evalBlocked = true
    }
    post({ type: 'ready', evalBlocked })
  }

  const subscribe = (value: unknown, succeed: (value: unknown) => void, fail: (error: unknown) => void): boolean => {
    try {
      ReflectApply(PromiseThen, value, [succeed, fail])
      return true
    } catch {
      return false
    }
  }

  const settle = (value: unknown, succeed: (value: unknown) => void, fail: (error: unknown) => void): void => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      succeed(value)
      return
    }
    if (subscribe(value, succeed, fail)) return
    let then: unknown
    try {
      then = (value as { then?: unknown }).then
    } catch {
      then = undefined
    }
    if (typeof then !== 'function') {
      succeed(value)
      return
    }
    const adopted = new NativePromise<unknown>((resolve, reject) => {
      ReflectApply(then as Callable, value, [resolve, reject])
    })
    ReflectApply(PromiseThen, adopted, [succeed, fail])
  }

  const execute = (message: RunMessage): Promise<void> =>
    new NativePromise<void>((done) => {
      const id = message.id
      let replied = false
      const reply = (result: WorkerMessage): void => {
        if (replied) return
        replied = true
        defer(() =>
          defer(() => {
            current = null
            post(result)
            done()
          }),
        )
      }
      const succeed = (value: unknown): void =>
        reply(value === undefined ? { type: 'result', id } : { type: 'result', id, value: show(value) })
      const fail = (error: unknown): void => reply({ type: 'result', id, error: describeThrown(error) })
      try {
        current = id
        sent = 0
        budget = typeof message.outputLimit === 'number' && message.outputLimit > 0 ? message.outputLimit : Infinity
        breakLength = MathMin(80, MathMax(40, message.columns > 0 ? message.columns : 80))
        if (message.declarations) ReflectApply(evaluate, scope, [message.declarations])
        settle(ReflectApply(evaluate, scope, [message.code]), succeed, fail)
      } catch (error) {
        fail(error)
      }
    })

  scope.addEventListener('message', (event) => {
    const message = event ? (event.data as HostMessage | undefined) : undefined
    if (!message || typeof message !== 'object') return
    if (message.type === 'init') initialize(message)
    else if (message.type === 'run') {
      const next = (): Promise<void> => execute(message)
      queue = ReflectApply(PromiseThen, queue, [next, next]) as Promise<void>
    }
  })

  scope.addEventListener('error', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (event && event.error !== undefined && event.error !== null) emit('Uncaught ' + show(event.error))
    else emit(event && typeof event.message === 'string' && event.message !== '' ? event.message : 'Uncaught error')
  })

  scope.addEventListener('unhandledrejection', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    emit('Uncaught (in promise) ' + show(event ? event.reason : undefined))
  })
}
