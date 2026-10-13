export interface InspectOptions {
  depth?: number
  breakLength?: number
  maxArrayLength?: number
  maxStringLength?: number
}

export interface Inspector {
  inspect(value: unknown, options?: InspectOptions): string
  format(args: readonly unknown[], options?: InspectOptions): string
  table(data: unknown, properties?: readonly unknown[], options?: InspectOptions): string | null
  width(text: string): number
  isError(value: unknown): boolean
}

export function createInspector(): Inspector {
  type Bag = Record<PropertyKey, unknown>

  interface Context {
    depth: number
    breakLength: number
    maxArrayLength: number
    maxStringLength: number
    indentationLvl: number
    currentDepth: number
    seen: unknown[]
    circular: Map<unknown, number>
  }

  const ReflectApply = Reflect.apply
  const uncurry =
    <A extends unknown[], R>(method: (...args: A) => R) =>
    (self: unknown, ...args: A): R =>
      ReflectApply(method, self, args) as R

  const ObjectKeys = Object.keys
  const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols
  const ObjectGetPrototypeOf = Object.getPrototypeOf
  const ObjectCreate = Object.create
  const ObjectAssign = Object.assign
  const ObjectIs = Object.is
  const ArrayIsArray = Array.isArray
  const JSONStringify = JSON.stringify
  const MathMin = Math.min
  const MathMax = Math.max
  const MathSqrt = Math.sqrt
  const MathRound = Math.round
  const MathFloor = Math.floor
  const NativeString = String
  const NativeNumber = Number
  const NativeParseInt = parseInt
  const NativeParseFloat = parseFloat
  const NativeError = Error
  const NativeTypeError = TypeError
  const NativeMap = Map
  const NativeUint8Array = Uint8Array
  const ErrorPrototype: object = NativeError.prototype
  const TypeErrorPrototype: object = NativeTypeError.prototype
  const PromisePrototype: object = Promise.prototype
  const nativeIsError = (NativeError as unknown as { isError?: unknown }).isError
  const errorIsError = typeof nativeIsError === 'function' ? (nativeIsError as (value: unknown) => boolean) : null
  const SymbolToStringTag = Symbol.toStringTag
  const RegExpPrototype = RegExp.prototype
  const hasOwn = uncurry(Object.prototype.hasOwnProperty)
  const isEnumerable = uncurry(Object.prototype.propertyIsEnumerable)
  const objectToString = uncurry(Object.prototype.toString)
  const functionToString = uncurry(Function.prototype.toString)
  const symbolToString = uncurry(Symbol.prototype.toString)
  const symbolValueOf = uncurry(Symbol.prototype.valueOf)
  const numberValueOf = uncurry(Number.prototype.valueOf)
  const stringValueOf = uncurry(String.prototype.valueOf)
  const booleanValueOf = uncurry(Boolean.prototype.valueOf)
  const bigIntValueOf = typeof BigInt === 'function' ? uncurry(BigInt.prototype.valueOf) : null
  const regExpToString = uncurry(RegExp.prototype.toString)
  const dateGetTime = uncurry(Date.prototype.getTime)
  const dateToISOString = uncurry(Date.prototype.toISOString)
  const setValues = uncurry(Set.prototype.values)
  const setForEach = uncurry(Set.prototype.forEach)
  const mapEntries = uncurry(Map.prototype.entries)
  const mapForEach = uncurry(Map.prototype.forEach)
  const weakMapHas = uncurry(WeakMap.prototype.has)
  const weakSetHas = uncurry(WeakSet.prototype.has)

  const OBJECT_TYPE = 0
  const ARRAY_TYPE = 1
  const ARRAY_EXTRAS_TYPE = 2
  const COMPACT = 3
  const MIN_LINE_WIDTH = 16
  const PROTOTYPE_LIMIT = 1000
  const KEY_SCAN_LIMIT = 10_000
  const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z_0-9]*$/
  const INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/
  const CLASS_PATTERN = /^class[\s{]/

  const getter = (target: object, key: PropertyKey): ((self: unknown) => unknown) | undefined => {
    const descriptor = ObjectGetOwnPropertyDescriptor(target, key)
    return descriptor === undefined || descriptor.get === undefined ? undefined : uncurry(descriptor.get)
  }
  const typedArrayTag = getter(ObjectGetPrototypeOf(Uint8Array.prototype) as object, SymbolToStringTag)
  const setSize = getter(Set.prototype, 'size')
  const mapSize = getter(Map.prototype, 'size')
  const regExpSource = getter(RegExp.prototype, 'source')
  const bufferLength = getter(ArrayBuffer.prototype, 'byteLength')

  const BUILT_INS: string[] = Object.getOwnPropertyNames(globalThis).filter((name) => /^[A-Z][a-zA-Z0-9]+$/.test(name))

  const META: string[] = []
  for (let code = 0; code < 160; code += 1) {
    if (code < 32 || code >= 127) META[code] = '\\x' + (code < 16 ? '0' : '') + code.toString(16).toUpperCase()
  }
  META[8] = '\\b'
  META[9] = '\\t'
  META[10] = '\\n'
  META[12] = '\\f'
  META[13] = '\\r'
  META[39] = "\\'"
  META[92] = '\\\\'

  const passes = (check: () => unknown): boolean => {
    try {
      check()
      return true
    } catch {
      return false
    }
  }

  const attempt = <T>(read: () => T, fallback: T): T => {
    try {
      return read()
    } catch {
      return fallback
    }
  }

  const quote = (text: string): string => {
    let quoteCode = 39
    if (text.indexOf("'") !== -1) {
      if (text.indexOf('"') === -1) quoteCode = -1
      else if (text.indexOf('`') === -1 && text.indexOf('${') === -1) quoteCode = -2
    }
    let result = ''
    let last = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code === quoteCode || code === 92 || code < 32 || (code > 126 && code < 160)) {
        result += text.slice(last, index) + META[code]
        last = index + 1
      } else if (code >= 0xd800 && code <= 0xdfff) {
        if (code <= 0xdbff && index + 1 < text.length) {
          const next = text.charCodeAt(index + 1)
          if (next >= 0xdc00 && next <= 0xdfff) {
            index += 1
            continue
          }
        }
        result += text.slice(last, index) + '\\u' + code.toString(16)
        last = index + 1
      }
    }
    result += text.slice(last)
    if (quoteCode === -1) return '"' + result + '"'
    if (quoteCode === -2) return '`' + result + '`'
    return "'" + result + "'"
  }

  const splitLines = (text: string): string[] => {
    const lines: string[] = []
    let start = 0
    let index = text.indexOf('\n')
    while (index !== -1) {
      lines.push(text.slice(start, index + 1))
      start = index + 1
      index = text.indexOf('\n', start)
    }
    if (start < text.length || lines.length === 0) lines.push(text.slice(start))
    return lines
  }

  const formatNumber = (value: number): string => (ObjectIs(value, -0) ? '-0' : NativeString(value))

  const formatPrimitive = (ctx: Context, value: unknown): string => {
    if (typeof value === 'string') {
      let text = value
      let trailer = ''
      if (text.length > ctx.maxStringLength) {
        const remaining = text.length - ctx.maxStringLength
        text = text.slice(0, ctx.maxStringLength)
        trailer = '... ' + remaining + ' more character' + (remaining > 1 ? 's' : '')
      }
      if (text.length > MIN_LINE_WIDTH && text.length > ctx.breakLength - ctx.indentationLvl - 4) {
        return splitLines(text).map(quote).join(' +\n' + ' '.repeat(ctx.indentationLvl + 2)) + trailer
      }
      return quote(text) + trailer
    }
    if (typeof value === 'number') return formatNumber(value)
    if (typeof value === 'bigint') return NativeString(value) + 'n'
    if (typeof value === 'boolean') return NativeString(value)
    if (typeof value === 'undefined') return 'undefined'
    return symbolToString(value)
  }

  const remainingText = (remaining: number): string => '... ' + remaining + ' more item' + (remaining > 1 ? 's' : '')

  const includes = (list: readonly unknown[], item: unknown): boolean => {
    for (let index = 0; index < list.length; index += 1) if (list[index] === item) return true
    return false
  }

  const prototypeOf = (value: object): object | null => attempt(() => ObjectGetPrototypeOf(value) as object | null, null)

  const prototypes = (value: object): object[] => {
    const chain: object[] = []
    let current = prototypeOf(value)
    while (current !== null && chain.length < PROTOTYPE_LIMIT && current !== value && !includes(chain, current)) {
      chain[chain.length] = current
      current = prototypeOf(current)
    }
    return chain
  }

  const inherits = (chain: readonly object[], constructor: Function): boolean => {
    try {
      const prototype: unknown = constructor.prototype
      return prototype !== null && (typeof prototype === 'object' || typeof prototype === 'function') && includes(chain, prototype)
    } catch {
      return false
    }
  }

  const constructorName = (value: object, chain: readonly object[]): string | null => {
    for (let index = -1; index < chain.length; index += 1) {
      const current = index === -1 ? value : (chain[index] as object)
      try {
        const descriptor = ObjectGetOwnPropertyDescriptor(current, 'constructor')
        const candidate: unknown = descriptor === undefined ? undefined : descriptor.value
        if (typeof candidate !== 'function') continue
        const name: unknown = candidate.name
        if (name !== '' && inherits(chain, candidate)) return NativeString(name)
      } catch {
        continue
      }
    }
    return null
  }

  const prefixFor = (constructor: string | null, tag: string, fallback: string, size?: string): string => {
    const sized = size === undefined ? '' : size
    if (constructor === null) {
      if (tag !== '' && fallback !== tag) return '[' + fallback + sized + ': null prototype] [' + tag + '] '
      return '[' + fallback + sized + ': null prototype] '
    }
    if (tag !== '' && constructor !== tag) return constructor + sized + ' [' + tag + '] '
    return constructor + sized + ' '
  }

  const ownKeys = (value: object): PropertyKey[] => {
    const keys: PropertyKey[] = ObjectKeys(value)
    const symbols = ObjectGetOwnPropertySymbols(value)
    for (let index = 0; index < symbols.length; index += 1) {
      if (isEnumerable(value, symbols[index] as symbol)) keys.push(symbols[index] as symbol)
    }
    return keys
  }

  const isIndex = (key: PropertyKey): boolean => typeof key === 'string' && INDEX_PATTERN.test(key) && NativeNumber(key) < 4294967295

  const nonIndexKeys = (value: object, length: number): PropertyKey[] => {
    if (length > KEY_SCAN_LIMIT) return []
    const keys = ownKeys(value)
    let first = keys.length
    while (first > 0 && !isIndex(keys[first - 1] as PropertyKey)) first -= 1
    return keys.slice(first)
  }

  const isError = (value: object, chain: readonly object[]): boolean =>
    (errorIsError !== null && attempt(() => errorIsError(value), false)) ||
    attempt(() => objectToString(value) === '[object Error]', false) ||
    includes(chain, ErrorPrototype)

  const isRevokedProxy = (value: object): boolean => !passes(() => ArrayIsArray(value))

  const errorText = (value: object, constructor: string | null, tag: string, nested: boolean): string => {
    let name = 'Error'
    let message = ''
    try {
      name = NativeString((value as Bag).name)
    } catch {
      name = 'Error'
    }
    try {
      const raw = (value as Bag).message
      message = raw === undefined ? '' : NativeString(raw)
    } catch {
      message = ''
    }
    let text = message === '' ? name : name + ': ' + message
    if (constructor === null || name.slice(-5) === 'Error') {
      const prefix = prefixFor(constructor, tag, 'Error').slice(0, -1)
      if (name !== prefix) {
        text = prefix.indexOf(name) !== -1 ? prefix + text.slice(name.length) : prefix + ' [' + name + ']' + text.slice(name.length)
      }
    }
    return nested ? '[' + text + ']' : text
  }

  const functionBase = (value: Function, constructor: string | null, tag: string): string => {
    let source = ''
    try {
      source = functionToString(value)
    } catch {
      source = ''
    }
    if (CLASS_PATTERN.test(source)) {
      const name = hasOwn(value, 'name') && value.name ? value.name : '(anonymous)'
      let base = 'class ' + name
      if (constructor !== 'Function' && constructor !== null) base += ' [' + constructor + ']'
      if (tag !== '' && constructor !== tag) base += ' [' + tag + ']'
      if (constructor !== null) {
        const parent = ObjectGetPrototypeOf(value) as { name?: unknown } | null
        if (parent !== null && typeof parent.name === 'string' && parent.name !== '') base += ' extends ' + parent.name
      } else {
        base += ' extends [null prototype]'
      }
      return '[' + base + ']'
    }
    let type = 'Function'
    const kind = objectToString(value)
    if (kind === '[object GeneratorFunction]') type = 'GeneratorFunction'
    else if (kind === '[object AsyncFunction]') type = 'AsyncFunction'
    else if (kind === '[object AsyncGeneratorFunction]') type = 'AsyncGeneratorFunction'
    let base = '[' + type
    if (constructor === null) base += ' (null prototype)'
    base += value.name === '' ? ' (anonymous)' : ': ' + NativeString(value.name)
    base += ']'
    if (constructor !== type && constructor !== null) base += ' ' + constructor
    if (tag !== '' && constructor !== tag) base += ' [' + tag + ']'
    return base
  }

  const boxedBase = (ctx: Context, value: object): [string, string] | null => {
    if (passes(() => numberValueOf(value))) return ['Number', formatNumber(numberValueOf(value))]
    if (passes(() => stringValueOf(value))) return ['String', formatPrimitive(ctx, stringValueOf(value))]
    if (passes(() => booleanValueOf(value))) return ['Boolean', NativeString(booleanValueOf(value))]
    if (bigIntValueOf !== null && passes(() => bigIntValueOf(value))) {
      return ['BigInt', NativeString(bigIntValueOf(value)) + 'n']
    }
    if (passes(() => symbolValueOf(value))) {
      return ['Symbol', symbolToString(symbolValueOf(value))]
    }
    return null
  }

  const formatProperty = (ctx: Context, value: object, recurseTimes: number, key: PropertyKey, type: number): string => {
    let descriptor = ObjectGetOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) descriptor = { value: (value as Bag)[key], enumerable: true }
    let text: string
    if (descriptor.value !== undefined) {
      ctx.indentationLvl += 2
      text = formatValue(ctx, descriptor.value, recurseTimes)
      ctx.indentationLvl -= 2
    } else if (descriptor.get !== undefined) {
      text = descriptor.set !== undefined ? '[Getter/Setter]' : '[Getter]'
    } else if (descriptor.set !== undefined) {
      text = '[Setter]'
    } else {
      text = 'undefined'
    }
    if (type === ARRAY_TYPE) return text
    let name: string
    if (typeof key === 'symbol') name = symbolToString(key)
    else if (key === '__proto__') name = "['__proto__']"
    else if (descriptor.enumerable === false) name = '[' + NativeString(key) + ']'
    else if (KEY_PATTERN.test(NativeString(key))) name = NativeString(key)
    else name = quote(NativeString(key))
    return name + ': ' + text
  }

  const formatSparseArray = (ctx: Context, value: unknown[], recurseTimes: number, limit: number, output: string[], start: number): string[] => {
    const keys = ObjectKeys(value)
    let index = start
    for (let position = start; position < keys.length && output.length < limit; position += 1) {
      const key = keys[position] as string
      const numeric = NativeNumber(key)
      if (numeric > 4294967294 || !INDEX_PATTERN.test(key)) break
      if (NativeString(index) !== key) {
        const empty = numeric - index
        output.push('<' + empty + ' empty item' + (empty > 1 ? 's' : '') + '>')
        index = numeric
        if (output.length === limit) break
      }
      output.push(formatProperty(ctx, value, recurseTimes, key, ARRAY_TYPE))
      index += 1
    }
    const remaining = value.length - index
    if (output.length !== limit) {
      if (remaining > 0) output.push('<' + remaining + ' empty item' + (remaining > 1 ? 's' : '') + '>')
    } else if (remaining > 0) {
      output.push(remainingText(remaining))
    }
    return output
  }

  const formatArray = (ctx: Context, value: unknown[], recurseTimes: number): string[] => {
    const length = value.length
    const limit = MathMin(MathMax(0, ctx.maxArrayLength), length)
    const output: string[] = []
    for (let index = 0; index < limit; index += 1) {
      if (!hasOwn(value, index)) return formatSparseArray(ctx, value, recurseTimes, limit, output, index)
      output.push(formatProperty(ctx, value, recurseTimes, index, ARRAY_TYPE))
    }
    if (length > limit) output.push(remainingText(length - limit))
    return output
  }

  const formatTypedArray = (ctx: Context, value: ArrayLike<number | bigint>): string[] => {
    const length = value.length
    const limit = MathMin(MathMax(0, ctx.maxArrayLength), length)
    const output: string[] = []
    for (let index = 0; index < limit; index += 1) {
      const item = value[index]
      output.push(typeof item === 'bigint' ? NativeString(item) + 'n' : formatNumber(item as number))
    }
    if (length > limit) output.push(remainingText(length - limit))
    return output
  }

  const formatCollection = (
    ctx: Context,
    iterator: Iterator<unknown>,
    size: number,
    entry: (item: unknown) => string,
  ): string[] => {
    const limit = MathMin(MathMax(0, ctx.maxArrayLength), size)
    const output: string[] = []
    ctx.indentationLvl += 2
    let step = iterator.next()
    while (!step.done && output.length < limit) {
      output.push(entry(step.value))
      step = iterator.next()
    }
    if (size > limit) output.push(remainingText(size - limit))
    ctx.indentationLvl -= 2
    return output
  }

  const formatArrayBuffer = (ctx: Context, value: ArrayBuffer): string[] => {
    const bytes = new NativeUint8Array(value)
    const limit = MathMin(MathMax(0, ctx.maxArrayLength), bytes.length)
    const hex: string[] = []
    for (let index = 0; index < limit; index += 1) hex.push((bytes[index] as number).toString(16).padStart(2, '0'))
    let contents = hex.join(' ')
    const remaining = bytes.length - limit
    if (remaining > 0) contents += ' ... ' + remaining + ' more byte' + (remaining > 1 ? 's' : '')
    return ['[Uint8Contents]: <' + contents + '>', '[byteLength]: ' + formatNumber(bytes.length)]
  }

  const groupArrayElements = (ctx: Context, output: string[], value: unknown): string[] => {
    let totalLength = 0
    let maxLength = 0
    let outputLength = output.length
    if (ctx.maxArrayLength < output.length) outputLength -= 1
    const separatorSpace = 2
    const dataLength: number[] = []
    for (let index = 0; index < outputLength; index += 1) {
      const length = (output[index] as string).length
      dataLength.push(length)
      totalLength += length + separatorSpace
      if (maxLength < length) maxLength = length
    }
    const actualMax = maxLength + separatorSpace
    if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
      const averageBias = MathSqrt(actualMax - totalLength / output.length)
      const biasedMax = MathMax(actualMax - 3 - averageBias, 1)
      const columns = MathMin(
        MathRound(MathSqrt(2.5 * biasedMax * outputLength) / biasedMax),
        MathFloor((ctx.breakLength - ctx.indentationLvl) / actualMax),
        COMPACT * 4,
        15,
      )
      if (columns <= 1) return output
      const maxLineLength: number[] = []
      for (let column = 0; column < columns; column += 1) {
        let lineLength = 0
        for (let index = column; index < output.length; index += columns) {
          if ((dataLength[index] as number) > lineLength) lineLength = dataLength[index] as number
        }
        maxLineLength.push(lineLength + separatorSpace)
      }
      let padStart = value !== undefined
      if (padStart) {
        const items = value as ArrayLike<unknown>
        for (let index = 0; index < output.length; index += 1) {
          if (typeof items[index] !== 'number' && typeof items[index] !== 'bigint') {
            padStart = false
            break
          }
        }
      }
      const grouped: string[] = []
      for (let index = 0; index < outputLength; index += columns) {
        const max = MathMin(index + columns, outputLength)
        let line = ''
        let position = index
        for (; position < max - 1; position += 1) {
          const cell = (output[position] as string) + ', '
          const width = maxLineLength[position - index] as number
          line += padStart ? cell.padStart(width, ' ') : cell.padEnd(width, ' ')
        }
        if (padStart) {
          line += (output[position] as string).padStart((maxLineLength[position - index] as number) - separatorSpace, ' ')
        } else {
          line += output[position] as string
        }
        grouped.push(line)
      }
      if (ctx.maxArrayLength < output.length) grouped.push(output[outputLength] as string)
      return grouped
    }
    return output
  }

  const isBelowBreakLength = (ctx: Context, output: string[], start: number, base: string): boolean => {
    let totalLength = output.length + start
    if (totalLength + output.length > ctx.breakLength) return false
    for (let index = 0; index < output.length; index += 1) {
      totalLength += (output[index] as string).length
      if (totalLength > ctx.breakLength) return false
    }
    return base === '' || base.indexOf('\n') === -1
  }

  const reduceToSingleString = (
    ctx: Context,
    output: string[],
    base: string,
    braces: [string, string],
    extrasType: number,
    recurseTimes: number,
    value: unknown,
  ): string => {
    const entries = output.length
    let lines = output
    if (extrasType === ARRAY_EXTRAS_TYPE && entries > 6) lines = groupArrayElements(ctx, output, value)
    if (ctx.currentDepth - recurseTimes < COMPACT && entries === lines.length) {
      const start = lines.length + ctx.indentationLvl + braces[0].length + base.length + 10
      if (isBelowBreakLength(ctx, lines, start, base)) {
        const joined = lines.join(', ')
        if (joined.indexOf('\n') === -1) return (base === '' ? '' : base + ' ') + braces[0] + ' ' + joined + ' ' + braces[1]
      }
    }
    const indentation = '\n' + ' '.repeat(ctx.indentationLvl)
    return (base === '' ? '' : base + ' ') + braces[0] + indentation + '  ' + lines.join(',' + indentation + '  ') + indentation + braces[1]
  }

  const formatRaw = (ctx: Context, value: object, recurseTimes: number): string => {
    const chain = prototypes(value)
    const constructor = constructorName(value, chain)
    let tag: unknown = ''
    try {
      tag = (value as Bag)[SymbolToStringTag]
    } catch {
      tag = ''
    }
    if (typeof tag !== 'string' || (tag !== '' && isEnumerable(value, SymbolToStringTag))) tag = ''
    const label = tag as string
    let base = ''
    let braces: [string, string] = ['{', '}']
    let extrasType = OBJECT_TYPE
    let keys: PropertyKey[]
    let formatter: (depth: number) => string[] = () => []
    const typedName = typedArrayTag === undefined ? undefined : typedArrayTag(value)

    if (ArrayIsArray(value)) {
      const items = value as unknown[]
      const prefix = constructor !== 'Array' || label !== '' ? prefixFor(constructor, label, 'Array', '(' + items.length + ')') : ''
      keys = nonIndexKeys(items, items.length)
      braces = [prefix + '[', ']']
      if (items.length === 0 && keys.length === 0) return braces[0] + ']'
      extrasType = ARRAY_EXTRAS_TYPE
      formatter = (depth) => formatArray(ctx, items, depth)
    } else if (setSize !== undefined && passes(() => setSize(value))) {
      const size = setSize(value) as number
      const prefix = prefixFor(constructor, label, 'Set', '(' + size + ')')
      keys = ownKeys(value)
      if (size === 0 && keys.length === 0) return prefix + '{}'
      braces = [prefix + '{', '}']
      formatter = (depth) => formatCollection(ctx, setValues(value), size, (item) => formatValue(ctx, item, depth))
    } else if (mapSize !== undefined && passes(() => mapSize(value))) {
      const size = mapSize(value) as number
      const prefix = prefixFor(constructor, label, 'Map', '(' + size + ')')
      keys = ownKeys(value)
      if (size === 0 && keys.length === 0) return prefix + '{}'
      braces = [prefix + '{', '}']
      formatter = (depth) =>
        formatCollection(ctx, mapEntries(value), size, (item) => {
          const pair = item as [unknown, unknown]
          return formatValue(ctx, pair[0], depth) + ' => ' + formatValue(ctx, pair[1], depth)
        })
    } else if (typeof typedName === 'string') {
      const items = value as ArrayLike<number | bigint>
      keys = nonIndexKeys(value, items.length)
      const prefix = prefixFor(constructor, label, typedName, '(' + items.length + ')')
      braces = [prefix + '[', ']']
      if (items.length === 0 && keys.length === 0) return braces[0] + ']'
      extrasType = ARRAY_EXTRAS_TYPE
      formatter = () => formatTypedArray(ctx, items)
    } else {
      const textLength = attempt(() => stringValueOf(value).length, -1)
      keys = textLength > KEY_SCAN_LIMIT ? [] : ownKeys(value)
      if (typeof value === 'function') {
        base = functionBase(value as Function, constructor, label)
        if (keys.length === 0) return base
      } else if (constructor === 'Object') {
        if (label !== '') braces[0] = prefixFor(constructor, label, 'Object') + '{'
        if (keys.length === 0) return braces[0] + '}'
      } else if (regExpSource !== undefined && value !== RegExpPrototype && passes(() => regExpSource(value))) {
        base = regExpToString(value)
        const prefix = prefixFor(constructor, label, 'RegExp')
        if (prefix !== 'RegExp ') base = prefix + base
        if (keys.length === 0 || recurseTimes > ctx.depth) return base
      } else if (passes(() => dateGetTime(value))) {
        const time = dateGetTime(value)
        base = time === time ? dateToISOString(value) : 'Invalid Date'
        const prefix = prefixFor(constructor, label, 'Date')
        if (prefix !== 'Date ') base = prefix + base
        if (keys.length === 0) return base
      } else if (isError(value, chain)) {
        base = errorText(value, constructor, label, recurseTimes > 0)
        if (keys.length === 0) return base
      } else if (bufferLength !== undefined && passes(() => bufferLength(value))) {
        braces[0] = prefixFor(constructor, label, 'ArrayBuffer') + '{'
        formatter = () => formatArrayBuffer(ctx, value as ArrayBuffer)
      } else if (passes(() => weakMapHas(value, {}))) {
        braces[0] = prefixFor(constructor, label, 'WeakMap') + '{'
        formatter = () => ['<items unknown>']
      } else if (passes(() => weakSetHas(value, {}))) {
        braces[0] = prefixFor(constructor, label, 'WeakSet') + '{'
        formatter = () => ['<items unknown>']
      } else if (includes(chain, PromisePrototype)) {
        braces[0] = prefixFor(constructor, label, 'Promise') + '{'
        if (keys.length === 0) return braces[0] + '}'
      } else {
        const boxed = boxedBase(ctx, value)
        if (boxed !== null) {
          const type = boxed[0]
          base = '[' + type + (constructor !== type && constructor !== null ? ' (' + constructor + ')' : '') + ': ' + boxed[1] + ']'
          if (label !== '' && label !== constructor) base += ' [' + label + ']'
          if (type === 'String') keys = nonIndexKeys(value, textLength)
          if (keys.length === 0) return base
        } else {
          if (keys.length === 0) return prefixFor(constructor, label, 'Object') + '{}'
          braces[0] = prefixFor(constructor, label, 'Object') + '{'
        }
      }
    }

    if (recurseTimes > ctx.depth) {
      const name = prefixFor(constructor, label, 'Object').slice(0, -1)
      return constructor === null ? name : '[' + name + ']'
    }
    const depth = recurseTimes + 1
    ctx.seen.push(value)
    ctx.currentDepth = depth
    const output = formatter(depth)
    for (let index = 0; index < keys.length; index += 1) {
      output.push(formatProperty(ctx, value, depth, keys[index] as PropertyKey, extrasType))
    }
    const reference = ctx.circular.get(value)
    if (reference !== undefined) {
      const marker = '<ref *' + reference + '>'
      base = base === '' ? marker : marker + ' ' + base
    }
    ctx.seen.pop()
    return reduceToSingleString(ctx, output, base, braces, extrasType, depth, value)
  }

  const formatValue = (ctx: Context, value: unknown, recurseTimes: number): string => {
    if (typeof value !== 'object' && typeof value !== 'function') return formatPrimitive(ctx, value)
    if (value === null) return 'null'
    if (isRevokedProxy(value)) return '<Revoked Proxy>'
    if (ctx.seen.indexOf(value) !== -1) {
      let index = ctx.circular.get(value)
      if (index === undefined) {
        index = ctx.circular.size + 1
        ctx.circular.set(value, index)
      }
      return '[Circular *' + index + ']'
    }
    return formatRaw(ctx, value as object, recurseTimes)
  }

  const contextFor = (options: InspectOptions | undefined): Context => {
    const settings = options || {}
    return {
      depth: typeof settings.depth === 'number' ? settings.depth : 2,
      breakLength: typeof settings.breakLength === 'number' ? settings.breakLength : 80,
      maxArrayLength: typeof settings.maxArrayLength === 'number' ? settings.maxArrayLength : 100,
      maxStringLength: typeof settings.maxStringLength === 'number' ? settings.maxStringLength : 10000,
      indentationLvl: 0,
      currentDepth: 0,
      seen: [],
      circular: new NativeMap<unknown, number>(),
    }
  }

  const inspect = (value: unknown, options?: InspectOptions): string => formatValue(contextFor(options), value, 0)

  const withOptions = (options: InspectOptions | undefined, extra: InspectOptions): InspectOptions =>
    ObjectAssign({}, options || {}, extra)

  const hasCustomToString = (value: object): boolean => {
    try {
      if (hasOwn(value, 'toString')) return true
      const chain = prototypes(value)
      for (let index = 0; index < chain.length; index += 1) {
        const owner = chain[index] as object
        if (!hasOwn(owner, 'toString')) continue
        const descriptor = ObjectGetOwnPropertyDescriptor(owner, 'constructor')
        return !(descriptor !== undefined && typeof descriptor.value === 'function' && BUILT_INS.indexOf(descriptor.value.name) !== -1)
      }
      return false
    } catch {
      return false
    }
  }

  const isCircularError = (error: unknown): boolean => {
    if (error === null || typeof error !== 'object') return false
    const chain = prototypes(error)
    return (
      isError(error, chain) &&
      includes(chain, TypeErrorPrototype) &&
      attempt(() => /circular/i.test(NativeString((error as Bag).message)), false)
    )
  }

  const stringify = (value: unknown): string => {
    try {
      return NativeString(JSONStringify(value))
    } catch (error) {
      if (isCircularError(error)) return '[Circular]'
      throw error
    }
  }

  const placeholder = (code: number, argument: unknown, options: InspectOptions | undefined): string => {
    if (code === 115) {
      if (typeof argument === 'number') return formatNumber(argument)
      if (typeof argument === 'bigint') return NativeString(argument) + 'n'
      if (typeof argument !== 'object' || argument === null || hasCustomToString(argument)) return NativeString(argument)
      return inspect(argument, withOptions(options, { depth: 0 }))
    }
    if (code === 106) return stringify(argument)
    if (code === 100) {
      if (typeof argument === 'bigint') return NativeString(argument) + 'n'
      if (typeof argument === 'symbol') return 'NaN'
      return formatNumber(NativeNumber(argument))
    }
    if (code === 79) return inspect(argument, options)
    if (code === 111) return inspect(argument, withOptions(options, { depth: 4 }))
    if (code === 105) {
      if (typeof argument === 'bigint') return NativeString(argument) + 'n'
      if (typeof argument === 'symbol') return 'NaN'
      return formatNumber(NativeParseInt(NativeString(argument), 10))
    }
    if (typeof argument === 'symbol') return 'NaN'
    return formatNumber(NativeParseFloat(NativeString(argument)))
  }

  const format = (args: readonly unknown[], options?: InspectOptions): string => {
    const first = args[0]
    let next = 0
    let text = ''
    let join = ''
    if (typeof first === 'string') {
      if (args.length === 1) return first
      let lastPos = 0
      for (let index = 0; index < first.length - 1; index += 1) {
        if (first.charCodeAt(index) !== 37) continue
        index += 1
        const code = first.charCodeAt(index)
        if (next + 1 !== args.length) {
          let replacement: string
          if (code === 115 || code === 106 || code === 100 || code === 79 || code === 111 || code === 105 || code === 102) {
            next += 1
            replacement = placeholder(code, args[next], options)
          } else if (code === 99) {
            next += 1
            replacement = ''
          } else if (code === 37) {
            text += first.slice(lastPos, index)
            lastPos = index + 1
            continue
          } else {
            continue
          }
          if (lastPos !== index - 1) text += first.slice(lastPos, index - 1)
          text += replacement
          lastPos = index + 1
        } else if (code === 37) {
          text += first.slice(lastPos, index)
          lastPos = index + 1
        }
      }
      if (lastPos !== 0) {
        next += 1
        join = ' '
        if (lastPos < first.length) text += first.slice(lastPos)
      }
    }
    while (next < args.length) {
      const value = args[next]
      text += join + (typeof value === 'string' ? value : inspect(value, options))
      join = ' '
      next += 1
    }
    return text
  }

  const charWidth = (code: number): number => {
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return 0
    if (
      (code >= 0x300 && code <= 0x36f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    ) {
      return 0
    }
    if (code < 0x1100) return 1
    if (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
      (code >= 0x3250 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4c6) ||
      (code >= 0xa960 && code <= 0xa97c) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6b) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b001) ||
      (code >= 0x1f200 && code <= 0x1f251) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      return 2
    }
    return 1
  }

  const width = (text: string): number => {
    let total = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.codePointAt(index) as number
      if (code > 0xffff) index += 1
      total += charWidth(code)
    }
    return total
  }

  const renderTable = (head: string[], columns: string[][]): string => {
    const widths = head.map(width)
    let longest = 0
    for (let index = 0; index < columns.length; index += 1) {
      longest = MathMax(longest, (columns[index] as string[]).length)
    }
    const rows: string[][] = []
    for (let column = 0; column < head.length; column += 1) {
      const cells = columns[column] as string[]
      for (let row = 0; row < longest; row += 1) {
        if (rows[row] === undefined) rows[row] = []
        const cell = hasOwn(cells, row) ? (cells[row] as string) : ''
        ;(rows[row] as string[])[column] = cell
        widths[column] = MathMax(widths[column] as number, width(cell))
      }
    }
    const renderRow = (row: string[]): string => {
      let line = '│ '
      for (let index = 0; index < row.length; index += 1) {
        const cell = row[index] as string
        line += cell + ' '.repeat((widths[index] as number) - width(cell))
        if (index !== row.length - 1) line += ' │ '
      }
      return line + ' │'
    }
    const divider = widths.map((size) => '─'.repeat(size + 2))
    let result = '┌' + divider.join('┬') + '┐\n' + renderRow(head) + '\n├' + divider.join('┼') + '┤\n'
    for (let index = 0; index < rows.length; index += 1) result += renderRow(rows[index] as string[]) + '\n'
    return result + '└' + divider.join('┴') + '┘'
  }

  const table = (data: unknown, properties?: readonly unknown[], options?: InspectOptions): string | null => {
    if (data === null || typeof data !== 'object') return null
    const cell = (value: unknown): string => {
      const depth = value !== null && typeof value === 'object' && !ArrayIsArray(value) && ObjectKeys(value).length > 2 ? -1 : 0
      return inspect(value, withOptions(options, { depth, maxArrayLength: 3, breakLength: Infinity }))
    }
    const indexes = (length: number): string[] => {
      const result: string[] = []
      for (let index = 0; index < length; index += 1) result.push(cell(index))
      return result
    }
    if (mapSize !== undefined && passes(() => mapSize(data))) {
      const keys: string[] = []
      const values: string[] = []
      mapForEach(data, (value: unknown, key: unknown) => {
        keys.push(cell(key))
        values.push(cell(value))
      })
      return renderTable(['(iteration index)', 'Key', 'Values'], [indexes(keys.length), keys, values])
    }
    if (setSize !== undefined && passes(() => setSize(data))) {
      const values: string[] = []
      setForEach(data, (value: unknown) => {
        values.push(cell(value))
      })
      return renderTable(['(iteration index)', 'Values'], [indexes(values.length), values])
    }
    const map: Record<string, string[]> = ObjectCreate(null) as Record<string, string[]>
    const order: string[] = []
    let hasPrimitives = false
    const primitives: string[] = []
    const rowKeys = ObjectKeys(data)
    for (let row = 0; row < rowKeys.length; row += 1) {
      const item = (data as Bag)[rowKeys[row] as string]
      const primitive = item === null || (typeof item !== 'function' && typeof item !== 'object')
      if (properties === undefined && primitive) {
        hasPrimitives = true
        primitives[row] = cell(item)
      } else {
        const columns = properties === undefined ? ObjectKeys(item as object) : properties.map((key) => NativeString(key))
        for (let index = 0; index < columns.length; index += 1) {
          const key = columns[index] as string
          if (map[key] === undefined) {
            map[key] = []
            order.push(key)
          }
          ;(map[key] as string[])[row] = primitive || !hasOwn(item, key) ? '' : cell((item as Bag)[key])
        }
      }
    }
    const head = ['(index)'].concat(order)
    const columns = [rowKeys].concat(order.map((key) => map[key] as string[]))
    if (hasPrimitives) {
      head.push('Values')
      columns.push(primitives)
    }
    return renderTable(head, columns)
  }

  const isErrorValue = (value: unknown): boolean =>
    value !== null && (typeof value === 'object' || typeof value === 'function') && isError(value, prototypes(value))

  return { inspect, format, table, width, isError: isErrorValue }
}
