import { displayWidth } from '../width.js'
import type { CommandContext, CommandResult, ShellCommand } from './context.js'
import { DEV_NULL, basenameOf, dirnameOf } from './fs.js'
import { POSIX_CLASSES, WORD_CHARS, codeOrder, collate, compareNames } from './locale.js'
import { isOptionError, lastOf, lastValue, parseOptions, type OptionSpec, type ParsedOptions } from './options.js'

export type { CommandContext, CommandResult, ShellCommand } from './context.js'

const BLUE = '\x1b[34m'
const RESET = '\x1b[0m'
const MATCH_START = '\x1b[01;31m\x1b[K'
const MATCH_END = '\x1b[m\x1b[K'
const ENOENT = 'No such file or directory'
const ENOTDIR = 'Not a directory'
const EISDIR = 'Is a directory'
const DIRECTORY_SIZE = 4096
const MAX_TIMER = 2 ** 31 - 1
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class Streams {
  status = 0
  private stdout = ''
  private stderr = ''
  private readonly ctx: CommandContext

  constructor(ctx: CommandContext) {
    this.ctx = ctx
  }

  out(text: string): void {
    if (text === '') return
    if (this.ctx.write) this.ctx.write(text)
    else this.stdout += text
  }

  err(text: string, status = 1): void {
    this.status = status
    this.note(text)
  }

  note(text: string): void {
    if (this.ctx.writeError) this.ctx.writeError(text)
    else this.stderr += text
  }

  result(exitCode = this.status): CommandResult {
    return { stdout: this.stdout, stderr: this.stderr, exitCode }
  }
}

type Body = (ctx: CommandContext, options: ParsedOptions, io: Streams) => CommandResult | Promise<CommandResult>

const withOptions =
  (spec: OptionSpec, body: Body): ShellCommand =>
  (ctx) => {
    const io = new Streams(ctx)
    const options = parseOptions(ctx.argv, spec)
    if (isOptionError(options)) {
      io.err(`${options.error}\n`, 2)
      return io.result()
    }
    return body(ctx, options, io)
  }

const byteLength = (text: string): number => encoder.encode(text).length
const lineChunks = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))
const joinLines = (items: readonly string[]): string => items.map((item) => `${item}\n`).join('')
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const resolve = (ctx: CommandContext, operand: string): string => ctx.fs.resolve(ctx.cwd, operand)
const joinPath = (base: string, name: string): string => (base === '/' ? `/${name}` : `${base}/${name}`)
const joinDisplay = (base: string, name: string): string =>
  base === '' ? name : base.endsWith('/') ? `${base}${name}` : `${base}/${name}`

const missingReason = (ctx: CommandContext, path: string): string => {
  let ancestor = dirnameOf(path)
  while (ancestor !== '/' && !ctx.fs.exists(ancestor)) ancestor = dirnameOf(ancestor)
  return ctx.fs.isFile(ancestor) ? ENOTDIR : ENOENT
}

type Input = { text: string } | { error: string }

const readOperand = (ctx: CommandContext, operand: string): Input => {
  if (operand === '-') return { text: ctx.stdin }
  const path = resolve(ctx, operand)
  if (ctx.fs.isDir(path)) return { error: EISDIR }
  if (operand.endsWith('/') && ctx.fs.isFile(path)) return { error: ENOTDIR }
  const text = ctx.fs.read(path)
  return text === null ? { error: missingReason(ctx, path) } : { text }
}

const delay = (milliseconds: number, signal?: AbortSignal): Promise<boolean> =>
  new Promise((settle) => {
    if (signal?.aborted) {
      settle(true)
      return
    }
    let remaining = milliseconds
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      settle(true)
    }
    const tick = (): void => {
      if (remaining <= 0) {
        signal?.removeEventListener('abort', onAbort)
        settle(false)
        return
      }
      const step = Math.min(remaining, MAX_TIMER)
      remaining -= step
      timer = setTimeout(tick, step)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    tick()
  })

const COLOR_WHEN: Readonly<Record<string, 'always' | 'never' | 'auto'>> = {
  always: 'always',
  yes: 'always',
  force: 'always',
  never: 'never',
  no: 'never',
  none: 'never',
  auto: 'auto',
  tty: 'auto',
  'if-tty': 'auto',
}

const colorEnabled = (ctx: CommandContext, when: string | undefined, bare: 'always' | 'auto'): boolean | null => {
  const mode = when === undefined ? 'auto' : when === '' ? bare : Object.hasOwn(COLOR_WHEN, when) ? COLOR_WHEN[when] : null
  if (!mode) return null
  return mode === 'always' || (mode === 'auto' && ctx.colors === true && ctx.isTTY === true)
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const WORD = WORD_CHARS
const IS_WORD = `[${WORD}]`
const WORD_START = `(?<!${IS_WORD})(?=${IS_WORD})`
const WORD_END = `(?<=${IS_WORD})(?!${IS_WORD})`

const GNU_ESCAPES: Readonly<Record<string, string>> = {
  '<': WORD_START,
  '>': WORD_END,
  b: `(?:${WORD_START}|${WORD_END})`,
  B: `(?:(?<=${IS_WORD})(?=${IS_WORD})|(?<!${IS_WORD})(?!${IS_WORD}))`,
  w: IS_WORD,
  W: `[^${WORD}]`,
}
const JS_ESCAPES = 'dDsStnrfv123456789'
const INTERVAL = /^(\d*)(,\d*)?$/

const bracketEnd = (pattern: string, start: number, negators: string): number => {
  let index = start + 1
  if (negators.includes(pattern[index] ?? '\0')) index += 1
  if (pattern[index] === ']') index += 1
  while (index < pattern.length) {
    if (pattern.startsWith('[:', index)) {
      const close = pattern.indexOf(':]', index + 2)
      if (close !== -1) {
        index = close + 2
        continue
      }
    }
    if (pattern[index] === ']') return index
    index += 1
  }
  return -1
}

const translateBracket = (body: string, negators: string): string => {
  const negate = body !== '' && negators.includes(body[0] as string)
  const rest = negate ? body.slice(1) : body
  let out = ''
  for (let index = 0; index < rest.length; index += 1) {
    if (rest.startsWith('[:', index)) {
      const close = rest.indexOf(':]', index + 2)
      const name = close === -1 ? '' : rest.slice(index + 2, close)
      if (Object.hasOwn(POSIX_CLASSES, name)) {
        out += POSIX_CLASSES[name]
        index = close + 1
        if (rest[index + 1] === '-') {
          out += '\\-'
          index += 1
        }
        continue
      }
    }
    const char = rest[index] as string
    out += '\\]['.includes(char) || char === '^' ? `\\${char}` : char
  }
  return `[${negate ? '^' : ''}${out}]`
}

const BRE_SPECIAL = '(){}|+?'

const readInterval = (pattern: string, from: number, close: string): { text: string; end: number } | null => {
  const end = pattern.indexOf(close, from)
  const match = end === -1 ? null : INTERVAL.exec(pattern.slice(from, end))
  if (!match || (match[1] === '' && match[2] === undefined)) return null
  return { text: `{${match[1] || '0'}${match[2] ?? ''}}`, end: end + close.length - 1 }
}

const UNMATCHED_BRACKET = 'Unmatched [, [^, [:, [., or [='
const CLASS_SYNTAX = 'character class syntax is [[:space:]], not [:space:]'

const confusingClass = (body: string): boolean => {
  const rest = body.startsWith('^') ? body.slice(1) : body
  const inner = rest.slice(1, -1)
  return rest.length > 2 && rest.startsWith(':') && rest.endsWith(':') && /[^:]/.test(inner) && !/[-[]/.test(inner)
}

type Translation = { source: string; warnings: string[] } | { error: string }

const translateRegex = (pattern: string, extended: boolean): Translation => {
  let out = ''
  let start = true
  const warnings: string[] = []
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string
    const atStart = start
    start = false
    if (char === '[') {
      const close = bracketEnd(pattern, index, '^')
      if (close === -1) return { error: UNMATCHED_BRACKET }
      const body = pattern.slice(index + 1, close)
      if (confusingClass(body)) return { error: CLASS_SYNTAX }
      out += translateBracket(body, '^')
      index = close
      continue
    }
    if (atStart && (char === '*' || (extended && (char === '+' || char === '?')))) {
      if (extended) warnings.push(`${char} at start of expression`)
      else out += '\\*'
      start = extended
      continue
    }
    if (atStart && char === '^') {
      out += char
      start = true
      continue
    }
    if (extended && (char === '(' || char === '|')) {
      out += char
      start = true
      continue
    }
    if (extended ? char === '{' : char === '\\' && pattern[index + 1] === '{') {
      const interval = readInterval(pattern, index + (extended ? 1 : 2), extended ? '}' : '\\}')
      if (interval) {
        out += interval.text
        index = interval.end
      } else {
        out += extended ? '\\{' : '{'
        if (!extended) index += 1
      }
      continue
    }
    if (char === '\\' && index + 1 < pattern.length) {
      index += 1
      const next = pattern[index] as string
      if (!extended && atStart && (next === '+' || next === '?')) out += `\\${next}`
      else if (!extended && BRE_SPECIAL.includes(next)) out += next === '}' ? '\\}' : next
      else if (Object.hasOwn(GNU_ESCAPES, next)) out += GNU_ESCAPES[next]
      else if (JS_ESCAPES.includes(next)) out += `\\${next}`
      else out += escapeRegExp(next)
      start = !extended && (next === '(' || next === '|')
      continue
    }
    if (!extended && BRE_SPECIAL.includes(char)) out += `\\${char}`
    else if (char === ']' || char === '}') out += `\\${char}`
    else out += char
  }
  return { source: out, warnings }
}

const globToRegExp = (pattern: string, ignoreCase = false): RegExp | null => {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string
    if (char === '*') {
      source += '[\\s\\S]*'
    } else if (char === '?') {
      source += '[\\s\\S]'
    } else if (char === '[') {
      const close = bracketEnd(pattern, index, '!^')
      if (close === -1) {
        source += '\\['
      } else {
        source += translateBracket(pattern.slice(index + 1, close), '!^')
        index = close
      }
    } else if (char === '\\' && index + 1 < pattern.length) {
      index += 1
      source += escapeRegExp(pattern[index] as string)
    } else {
      source += escapeRegExp(char)
    }
  }
  try {
    return new RegExp(`^${source}$`, ignoreCase ? 'iu' : 'u')
  } catch {
    return null
  }
}

interface WalkEntry {
  path: string
  display: string
  depth: number
}

const walk = (
  ctx: CommandContext,
  entry: WalkEntry,
  maxDepth: number,
  visit: (entry: WalkEntry) => void,
  enter: (entry: WalkEntry) => boolean = () => true,
): void => {
  visit(entry)
  if (entry.depth >= maxDepth || !ctx.fs.isDir(entry.path)) return
  for (const name of ctx.fs.list(entry.path) ?? []) {
    const child = { path: joinPath(entry.path, name), display: joinDisplay(entry.display, name), depth: entry.depth + 1 }
    if (!ctx.fs.isDir(child.path) || enter(child)) walk(ctx, child, maxDepth, visit, enter)
  }
}

const pwd = withOptions({ flags: 'LP' }, (ctx, _options, io) => {
  io.out(`${ctx.cwd}\n`)
  return io.result()
})

const cd = withOptions({ flags: 'LP' }, (ctx, options, io) => {
  if (options.operands.length > 1) {
    io.err('cd: too many arguments\n')
    return io.result()
  }
  const operand = options.operands[0]
  const target = operand === undefined ? ctx.env.HOME : operand === '-' ? ctx.env.OLDPWD : operand
  if (target === undefined || (operand !== target && target === '')) {
    io.err(`cd: ${operand === '-' ? 'OLDPWD' : 'HOME'} not set\n`)
    return io.result()
  }
  const path = resolve(ctx, target)
  if (!ctx.fs.exists(path)) io.err(`cd: ${target}: ${missingReason(ctx, path)}\n`)
  else if (!ctx.fs.isDir(path)) io.err(`cd: ${target}: ${ENOTDIR}\n`)
  else {
    ctx.setCwd(path)
    if (operand === '-') io.out(`${path}\n`)
  }
  return io.result()
})

interface Listed {
  name: string
  path: string
  isDir: boolean
}

interface ListLayout {
  paint: boolean
  long: boolean
  human: boolean
  classify: boolean
  columns: boolean
}

const LS_SPEC: OptionSpec = {
  flags: '1aACdFGhlpRrSt',
  long: {
    all: 'a',
    'almost-all': 'A',
    classify: 'F',
    color: { key: 'color', argument: 'optional' },
    directory: 'd',
    'human-readable': 'h',
    'no-group': 'G',
    recursive: 'R',
    reverse: 'r',
  },
}

const MIN_COLUMN_WIDTH = 3

const columnSizes = (widths: readonly number[], count: number, lineWidth: number): number[] | null => {
  const rows = Math.ceil(widths.length / count)
  const sizes = Array.from({ length: count }, () => MIN_COLUMN_WIDTH)
  let total = count * MIN_COLUMN_WIDTH
  for (const [index, width] of widths.entries()) {
    const column = Math.floor(index / rows)
    const needed = width + (column === count - 1 ? 0 : 2)
    const size = sizes[column] as number
    if (needed <= size) continue
    total += needed - size
    sizes[column] = needed
    if (total >= lineWidth) return null
  }
  return sizes
}

const gridLines = (labels: readonly string[], lineWidth: number): string => {
  const widths = labels.map((label) => displayWidth(label))
  for (let count = Math.min(Math.ceil(lineWidth / MIN_COLUMN_WIDTH), labels.length); count > 1; count -= 1) {
    const sizes = columnSizes(widths, count, lineWidth)
    if (!sizes) continue
    const rows = Math.ceil(labels.length / count)
    let text = ''
    for (let row = 0; row < rows; row += 1) {
      for (let index = row; index < labels.length; index += rows) {
        text += labels[index]
        if (index + rows < labels.length) {
          text += ' '.repeat((sizes[Math.floor(index / rows)] as number) - (widths[index] as number))
        }
      }
      text += '\n'
    }
    return text
  }
  return joinLines(labels)
}

const sizeOf = (ctx: CommandContext, entry: Listed): number =>
  entry.isDir ? DIRECTORY_SIZE : byteLength(ctx.fs.read(entry.path) ?? '')

const humanSize = (size: number): string => {
  if (size < 1024) return String(size)
  let value = size
  let unit = ''
  for (const next of ['K', 'M', 'G', 'T']) {
    value /= 1024
    unit = next
    if (value < 1024) break
  }
  if (value < 10) {
    const tenths = Math.ceil(value * 10) / 10
    return tenths < 10 ? `${tenths.toFixed(1)}${unit}` : `10${unit}`
  }
  return `${Math.ceil(value)}${unit}`
}

const formatListing = (ctx: CommandContext, entries: readonly Listed[], layout: ListLayout): string => {
  if (entries.length === 0) return ''
  const label = (entry: Listed): string => {
    const name = layout.paint && entry.isDir ? `${BLUE}${entry.name}${RESET}` : entry.name
    return layout.classify && entry.isDir ? `${name}/` : name
  }
  if (layout.long) {
    const sizes = entries.map((entry) => (layout.human ? humanSize(sizeOf(ctx, entry)) : String(sizeOf(ctx, entry))))
    const width = sizes.reduce((widest, size) => Math.max(widest, size.length), 0)
    return entries
      .map((entry, index) => {
        const mode = entry.isDir ? 'drwxr-xr-x' : '-rw-r--r--'
        return `${mode} ${(sizes[index] as string).padStart(width)} ${label(entry)}\n`
      })
      .join('')
  }
  const labels = entries.map(label)
  if (!layout.columns) return joinLines(labels)
  return ctx.columns !== undefined && ctx.columns > 0 ? gridLines(labels, ctx.columns) : `${labels.join('  ')}\n`
}

const ls = withOptions(LS_SPEC, (ctx, options, io) => {
  const has = (flag: string): boolean => options.flags.has(flag)
  const when = lastValue(options, 'color')
  const paint = colorEnabled(ctx, when, 'always')
  if (paint === null) {
    io.err(`ls: invalid argument '${when}' for '--color'\n`, 2)
    return io.result()
  }
  const format = lastOf(options, ['l', '1', 'C']) ?? (ctx.isTTY ? 'C' : '1')
  const layout: ListLayout = {
    paint,
    long: format === 'l',
    human: has('h'),
    classify: has('F') || has('p'),
    columns: format === 'C',
  }
  const order = (entries: readonly Listed[]): Listed[] => {
    const keyed = entries.map((entry) => ({ entry, size: has('S') ? sizeOf(ctx, entry) : 0 }))
    keyed.sort((a, b) => b.size - a.size || compareNames(a.entry.name, b.entry.name))
    const sorted = keyed.map(({ entry }) => entry)
    return has('r') ? sorted.reverse() : sorted
  }

  const operands = options.operands.length > 0 ? options.operands : ['.']
  const files: Listed[] = []
  const dirs: Listed[] = []
  for (const operand of operands) {
    const path = resolve(ctx, operand)
    if (!ctx.fs.exists(path)) {
      io.err(`ls: cannot access '${operand}': ${missingReason(ctx, path)}\n`)
      continue
    }
    if (operand.endsWith('/') && ctx.fs.isFile(path)) {
      io.err(`ls: cannot access '${operand}': ${ENOTDIR}\n`)
      continue
    }
    const entry = { name: operand, path, isDir: ctx.fs.isDir(path) }
    if (entry.isDir && !has('d')) dirs.push(entry)
    else files.push(entry)
  }

  const blocks: string[] = []
  if (files.length > 0) blocks.push(formatListing(ctx, order(files), layout))
  const headers = operands.length > 1 || has('R')
  const visit = (dir: Listed): void => {
    const names = ctx.fs.list(dir.path) ?? []
    const shown = has('a') ? ['.', '..', ...names] : has('A') ? names : names.filter((name) => !name.startsWith('.'))
    const entries = order(
      shown.map((name) => {
        const path = name === '.' ? dir.path : name === '..' ? dirnameOf(dir.path) : joinPath(dir.path, name)
        return { name, path, isDir: ctx.fs.isDir(path) }
      }),
    )
    const body = formatListing(ctx, entries, layout)
    if (headers) blocks.push(`${dir.name}:\n${body}`)
    else if (body !== '') blocks.push(body)
    if (!has('R')) return
    for (const entry of entries) {
      if (entry.isDir && entry.name !== '.' && entry.name !== '..') {
        visit({ ...entry, name: joinDisplay(dir.name, entry.name) })
      }
    }
  }
  for (const dir of order(dirs)) visit(dir)
  io.out(blocks.join('\n'))
  return io.result()
})

const caretNotation = (text: string): string =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (char) =>
    char === '\x7f' ? '^?' : `^${String.fromCharCode(char.charCodeAt(0) + 64)}`,
  )

const catTransform = (given: ReadonlySet<string>): ((text: string) => string) | null => {
  if (!['A', 'b', 'E', 'e', 'n', 's', 'T', 't', 'v'].some((flag) => given.has(flag))) return null
  const flags = new Set(given)
  if (given.has('A')) for (const flag of 'vET') flags.add(flag)
  if (given.has('e')) for (const flag of 'vE') flags.add(flag)
  if (given.has('t')) for (const flag of 'vT') flags.add(flag)
  let lineNumber = 0
  let atLineStart = true
  let blankRun = 0
  return (text) => {
    let result = ''
    for (const chunk of lineChunks(text)) {
      const ended = chunk.endsWith('\n')
      const body = ended ? chunk.slice(0, -1) : chunk
      if (atLineStart) {
        const blank = body === ''
        blankRun = blank ? blankRun + 1 : 0
        if (flags.has('s') && blankRun > 1) continue
        if (flags.has('b') ? !blank : flags.has('n')) {
          lineNumber += 1
          result += `${String(lineNumber).padStart(6)}\t`
        }
      }
      const visible = flags.has('v') ? caretNotation(body) : body
      result += flags.has('T') ? visible.replaceAll('\t', '^I') : visible
      if (ended) result += flags.has('E') ? '$\n' : '\n'
      atLineStart = ended
    }
    return result
  }
}

const CAT_SPEC: OptionSpec = {
  flags: 'AbEenstTuv',
  long: {
    number: 'n',
    'number-nonblank': 'b',
    'show-all': 'A',
    'show-ends': 'E',
    'show-nonprinting': 'v',
    'show-tabs': 'T',
    'squeeze-blank': 's',
  },
}

const cat = withOptions(CAT_SPEC, (ctx, options, io) => {
  const transform = catTransform(options.flags)
  for (const operand of options.operands.length > 0 ? options.operands : ['-']) {
    const input = readOperand(ctx, operand)
    if ('error' in input) io.err(`cat: ${operand}: ${input.error}\n`)
    else io.out(transform ? transform(input.text) : input.text)
  }
  return io.result()
})

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
}

interface Escape {
  text: string
  length: number
  stop: boolean
}

const readEscape = (text: string, index: number, mode: 'echo' | 'format'): Escape => {
  const next = text[index + 1]
  if (next === undefined) return { text: '\\', length: 1, stop: false }
  if (Object.hasOwn(SIMPLE_ESCAPES, next)) return { text: SIMPLE_ESCAPES[next] as string, length: 2, stop: false }
  if (next === 'c') return { text: '', length: 2, stop: true }
  if (mode === 'format' && (next === '"' || next === "'")) return { text: next, length: 2, stop: false }
  const ahead = text.slice(index + 1, index + 10)
  const octal = (mode === 'echo' ? /^0([0-7]{0,3})/ : /^([0-7]{1,3})/).exec(ahead)
  if (octal) {
    return { text: String.fromCharCode(parseInt(octal[1] || '0', 8) & 0xff), length: 1 + octal[0].length, stop: false }
  }
  const hex = /^x([0-9a-fA-F]{1,2})/.exec(ahead)
  if (hex) return { text: String.fromCharCode(parseInt(hex[1] as string, 16)), length: 1 + hex[0].length, stop: false }
  const unicode = /^(?:u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/.exec(ahead)
  const code = unicode ? parseInt((unicode[1] ?? unicode[2]) as string, 16) : NaN
  if (unicode && code <= 0x10ffff) return { text: String.fromCodePoint(code), length: 1 + unicode[0].length, stop: false }
  return { text: `\\${next}`, length: 2, stop: false }
}

const expandEscapes = (text: string, mode: 'echo' | 'format'): { text: string; stop: boolean } => {
  let out = ''
  let index = 0
  while (index < text.length) {
    if (text[index] !== '\\') {
      out += text[index]
      index += 1
      continue
    }
    const escape = readEscape(text, index, mode)
    if (escape.stop) return { text: out, stop: true }
    out += escape.text
    index += escape.length
  }
  return { text: out, stop: false }
}

const echo: ShellCommand = (ctx) => {
  const io = new Streams(ctx)
  let index = 1
  let newline = true
  let escapes = false
  while (index < ctx.argv.length && /^-[neE]+$/.test(ctx.argv[index] as string)) {
    for (const letter of (ctx.argv[index] as string).slice(1)) {
      if (letter === 'n') newline = false
      else escapes = letter === 'e'
    }
    index += 1
  }
  const text = ctx.argv.slice(index).join(' ')
  const expanded = escapes ? expandEscapes(text, 'echo') : { text, stop: false }
  io.out(newline && !expanded.stop ? `${expanded.text}\n` : expanded.text)
  return io.result()
}

interface PrintfState {
  args: readonly string[]
  index: number
  stop: boolean
  output: string
  io: Streams
}

const printfError = (state: PrintfState, message: string): void => {
  state.io.out(state.output)
  state.output = ''
  state.io.err(message)
}

const CONVERSION = /%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%])?/y

const parseInteger = (text: string): number => {
  const match = /^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)$/.exec(text)
  if (!match) return NaN
  const digits = match[2] as string
  const value = /^0[xX]/.test(digits)
    ? parseInt(digits.slice(2), 16)
    : digits.length > 1 && digits.startsWith('0')
      ? parseInt(digits, 8)
      : Number(digits)
  return match[1] === '-' ? -value : value
}

const toNumber = (arg: string | undefined, state: PrintfState, integer: boolean): number => {
  if (arg === undefined || arg === '') return 0
  if (arg.startsWith("'") || arg.startsWith('"')) return arg.length > 1 ? (arg.codePointAt(1) as number) : 0
  const text = arg.trim()
  const value = integer ? parseInteger(text) : Number(text)
  if (!Number.isNaN(value)) return value
  printfError(state, `printf: '${arg}': expected a numeric value\n`)
  return 0
}

const ALTERNATE_PREFIX: Readonly<Partial<Record<string, string>>> = { o: '0', x: '0x', X: '0X' }
const INTMAX = (1n << 63n) - 1n
const INTMIN = -(1n << 63n)
const UINTMAX = (1n << 64n) - 1n

const parseBigInteger = (text: string): bigint | null => {
  const match = /^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)$/.exec(text)
  if (!match) return null
  const digits = match[2] as string
  const octal = digits.length > 1 && /^0[0-7]/.test(digits)
  const magnitude = BigInt(octal ? `0o${digits.slice(1)}` : digits)
  return match[1] === '-' ? -magnitude : magnitude
}

const toInteger = (arg: string | undefined, state: PrintfState, unsigned: boolean): bigint => {
  if (arg === undefined || arg === '') return 0n
  if (arg.startsWith("'") || arg.startsWith('"')) return BigInt(arg.length > 1 ? (arg.codePointAt(1) as number) : 0)
  const value = parseBigInteger(arg.trim())
  if (value === null) {
    printfError(state, `printf: '${arg}': expected a numeric value\n`)
    return 0n
  }
  const outOfRange = (clamped: bigint): bigint => {
    printfError(state, `printf: '${arg}': Numerical result out of range\n`)
    return clamped
  }
  if (unsigned) {
    if (value > UINTMAX || -value > UINTMAX) return outOfRange(UINTMAX)
    return value < 0n ? UINTMAX + 1n + value : value
  }
  if (value > INTMAX) return outOfRange(INTMAX)
  if (value < INTMIN) return outOfRange(INTMIN)
  return value
}

const exponential = (value: number, digits: number): string =>
  value.toExponential(digits).replace(/e([+-])(\d)$/, 'e$10$2')

const stripZeros = (text: string): string =>
  text.includes('e') ? text.replace(/\.?0+e/, 'e') : text.includes('.') ? text.replace(/\.?0+$/, '') : text

const formatFloat = (value: number, conversion: string, precision: number, alternate: boolean): string => {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : 'inf'
  const kind = conversion.toLowerCase()
  if (kind === 'f') return value.toFixed(precision)
  if (kind === 'e') return exponential(value, precision)
  const significant = precision === 0 ? 1 : precision
  const exponent = value === 0 ? 0 : Number(value.toExponential(significant - 1).split('e')[1])
  const text =
    exponent < -4 || exponent >= significant
      ? exponential(value, significant - 1)
      : value.toFixed(Math.max(significant - 1 - exponent, 0))
  return alternate ? text : stripZeros(text)
}

const pad = (text: string, width: number | undefined, left: boolean): string =>
  width === undefined ? text : left ? text.padEnd(width) : text.padStart(width)

const padNumber = (sign: string, prefix: string, body: string, flags: string, width: number | undefined, zeroAllowed: boolean): string => {
  const left = flags.includes('-')
  if (zeroAllowed && flags.includes('0') && !left && width !== undefined) {
    return `${sign}${prefix}${body.padStart(width - sign.length - prefix.length, '0')}`
  }
  return pad(`${sign}${prefix}${body}`, width, left)
}

const signOf = (negative: boolean, flags: string): string =>
  negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''

const formatConversion = (
  conversion: string,
  flags: string,
  width: number | undefined,
  precision: number | undefined,
  state: PrintfState,
): string => {
  const left = flags.includes('-')
  const arg = state.args[state.index]
  state.index += 1
  if (conversion === 's') {
    const text = arg ?? ''
    return pad(precision === undefined ? text : [...text].slice(0, precision).join(''), width, left)
  }
  if (conversion === 'b') {
    const expanded = expandEscapes(arg ?? '', 'echo')
    if (expanded.stop) state.stop = true
    return pad(expanded.text, width, left)
  }
  if (conversion === 'c') return pad(arg ? String.fromCodePoint(arg.codePointAt(0) as number) : '', width, left)

  if ('diouxX'.includes(conversion)) {
    const signed = 'di'.includes(conversion)
    const value = toInteger(arg, state, !signed)
    const magnitude = value < 0n ? -value : value
    let body = magnitude.toString(conversion === 'o' ? 8 : 'xX'.includes(conversion) ? 16 : 10)
    if (conversion === 'X') body = body.toUpperCase()
    if (precision !== undefined) body = body.padStart(precision, '0')
    const prefix = flags.includes('#') && magnitude !== 0n ? (ALTERNATE_PREFIX[conversion] ?? '') : ''
    const sign = signed ? signOf(value < 0n, flags) : ''
    return padNumber(sign, prefix, body, flags, width, precision === undefined)
  }
  const value = toNumber(arg, state, false)
  let body = formatFloat(Math.abs(value), conversion, precision ?? 6, flags.includes('#'))
  if (conversion === conversion.toUpperCase()) body = body.toUpperCase()
  return padNumber(signOf(value < 0 || Object.is(value, -0), flags), '', body, flags, width, true)
}

const formatOnce = (format: string, state: PrintfState): void => {
  let index = 0
  while (index < format.length && !state.stop) {
    const char = format[index] as string
    if (char === '\\') {
      const escape = readEscape(format, index, 'format')
      if (escape.stop) {
        state.stop = true
        break
      }
      state.output += escape.text
      index += escape.length
      continue
    }
    if (char !== '%') {
      state.output += char
      index += 1
      continue
    }
    CONVERSION.lastIndex = index
    const match = CONVERSION.exec(format) as RegExpExecArray
    const [whole, flags = '', widthRaw, precisionRaw, conversion] = match
    index += whole.length
    if (conversion === '%') {
      state.output += '%'
      continue
    }
    if (conversion === undefined || !'diouxXfFeEgGcsb'.includes(conversion)) {
      printfError(state, `printf: ${whole}: invalid conversion specification\n`)
      state.stop = true
      break
    }
    const starValue = (): number => {
      const value = Math.trunc(toNumber(state.args[state.index], state, true))
      state.index += 1
      return value
    }
    const width = widthRaw === '*' ? starValue() : widthRaw === undefined ? undefined : Number(widthRaw)
    const precision =
      precisionRaw === undefined ? undefined : precisionRaw === '*' ? starValue() : Number(precisionRaw || 0)
    const leftFromWidth = width !== undefined && width < 0
    const text = formatConversion(
      conversion,
      leftFromWidth ? `${flags}-` : flags,
      width === undefined ? undefined : Math.abs(width),
      precision,
      state,
    )
    state.output += text
  }
}

const printf: ShellCommand = (ctx) => {
  const io = new Streams(ctx)
  const args = ctx.argv.slice(1)
  if (args[0] === '--') args.shift()
  const format = args.shift()
  if (format === undefined) {
    io.err('printf: missing operand\n')
    return io.result()
  }
  const state: PrintfState = { args, index: 0, stop: false, output: '', io }
  for (;;) {
    const before = state.index
    formatOnce(format, state)
    if (state.stop || state.index >= args.length || state.index === before) break
  }
  io.out(state.output)
  return io.result()
}

const TOUCH_SPEC: OptionSpec = {
  flags: 'acfhm',
  values: 'drt',
  long: { date: 'd', 'no-create': 'c', reference: 'r' },
}

const touch = withOptions(TOUCH_SPEC, (ctx, options, io) => {
  if (options.operands.length === 0) {
    io.err('touch: missing file operand\n')
    return io.result()
  }
  for (const operand of options.operands) {
    const path = resolve(ctx, operand)
    if (operand.endsWith('/') && !ctx.fs.isDir(path)) {
      io.err(`touch: setting times of '${operand}': ${ctx.fs.isFile(path) ? ENOTDIR : missingReason(ctx, path)}\n`)
      continue
    }
    if (ctx.fs.exists(path) || options.flags.has('c')) continue
    try {
      ctx.fs.write(path, '')
    } catch (error) {
      io.err(`touch: cannot touch '${operand}': ${errorMessage(error)}\n`)
    }
  }
  return io.result()
})

const MKDIR_SPEC: OptionSpec = { flags: 'pv', values: 'm', long: { mode: 'm', parents: 'p', verbose: 'v' } }

const mkdir = withOptions(MKDIR_SPEC, (ctx, options, io) => {
  if (options.operands.length === 0) {
    io.err('mkdir: missing operand\n')
    return io.result()
  }
  for (const operand of options.operands) {
    const path = resolve(ctx, operand)
    const existed = ctx.fs.exists(path)
    try {
      ctx.fs.mkdir(path, options.flags.has('p'))
      if (options.flags.has('v') && !existed) io.out(`mkdir: created directory '${operand}'\n`)
    } catch (error) {
      io.err(`mkdir: cannot create directory '${operand}': ${errorMessage(error)}\n`)
    }
  }
  return io.result()
})

const RM_SPEC: OptionSpec = {
  flags: 'dfrRv',
  long: {
    dir: 'd',
    force: 'f',
    'no-preserve-root': { key: 'no-preserve-root' },
    'preserve-root': { key: 'preserve-root' },
    recursive: 'r',
    verbose: 'v',
  },
}

const isDotOperand = (operand: string): boolean => {
  const trimmed = operand.replace(/\/+$/, '')
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return last === '.' || last === '..'
}

const rm = withOptions(RM_SPEC, (ctx, options, io) => {
  const has = (flag: string): boolean => options.flags.has(flag)
  const recursive = has('r') || has('R')
  if (options.operands.length === 0) {
    if (!has('f')) io.err('rm: missing operand\n')
    return io.result()
  }
  for (const operand of options.operands) {
    const path = resolve(ctx, operand)
    if (!ctx.fs.exists(path)) {
      if (!has('f')) io.err(`rm: cannot remove '${operand}': ${missingReason(ctx, path)}\n`)
      continue
    }
    if (operand.endsWith('/') && ctx.fs.isFile(path)) {
      if (!has('f')) io.err(`rm: cannot remove '${operand}': ${ENOTDIR}\n`)
      continue
    }
    const isDir = ctx.fs.isDir(path)
    if (isDir && !recursive) {
      if (!has('d')) {
        io.err(`rm: cannot remove '${operand}': ${EISDIR}\n`)
        continue
      }
      if ((ctx.fs.list(path) ?? []).length > 0) {
        io.err(`rm: cannot remove '${operand}': Directory not empty\n`)
        continue
      }
    }
    if (isDir && isDotOperand(operand)) {
      io.err(`rm: refusing to remove '.' or '..' directory: skipping '${operand}'\n`)
      continue
    }
    if (path === '/' && !has('no-preserve-root')) {
      const same = operand === '/' ? "'/'" : `'${operand}' (same as '/')`
      io.err(`rm: it is dangerous to operate recursively on ${same}\nrm: use --no-preserve-root to override this failsafe\n`)
      continue
    }
    try {
      if (path === '/') for (const name of ctx.fs.list('/') ?? []) ctx.fs.remove(joinPath('/', name), true)
      else ctx.fs.remove(path, recursive)
      if (has('v')) io.out(isDir ? `removed directory '${operand}'\n` : `removed '${operand}'\n`)
    } catch (error) {
      io.err(`rm: cannot remove '${operand}': ${errorMessage(error)}\n`)
    }
  }
  return io.result()
})

interface Transfer {
  source: string
  sourcePath: string
  target: string
  targetPath: string
}

const planTransfers = (ctx: CommandContext, command: string, operands: readonly string[], io: Streams): Transfer[] => {
  if (operands.length === 0) {
    io.err(`${command}: missing file operand\n`)
    return []
  }
  if (operands.length === 1) {
    io.err(`${command}: missing destination file operand after '${operands[0]}'\n`)
    return []
  }
  const destination = operands[operands.length - 1] as string
  const destinationPath = resolve(ctx, destination)
  const intoDirectory = ctx.fs.isDir(destinationPath)
  const sources = operands.slice(0, -1)
  if (sources.length > 1 && !intoDirectory) {
    io.err(`${command}: target '${destination}' is not a directory\n`)
    return []
  }
  return sources.map((source) => {
    const sourcePath = resolve(ctx, source)
    if (!intoDirectory) return { source, sourcePath, target: destination, targetPath: destinationPath }
    const name = basenameOf(sourcePath)
    return { source, sourcePath, target: joinDisplay(destination, name), targetPath: joinPath(destinationPath, name) }
  })
}

const sourceMissing = (ctx: CommandContext, transfer: Transfer): string | null => {
  if (!ctx.fs.exists(transfer.sourcePath)) return missingReason(ctx, transfer.sourcePath)
  return transfer.source.endsWith('/') && ctx.fs.isFile(transfer.sourcePath) ? ENOTDIR : null
}

const isInside = (path: string, ancestor: string): boolean =>
  ancestor === '/' || path === ancestor || path.startsWith(`${ancestor}/`)

const copyOne = (ctx: CommandContext, transfer: Transfer, options: ParsedOptions, io: Streams): void => {
  const { source, sourcePath, target, targetPath } = transfer
  const missing = sourceMissing(ctx, transfer)
  if (missing) {
    io.err(`cp: cannot stat '${source}': ${missing}\n`)
    return
  }
  if (ctx.fs.isDir(sourcePath)) {
    if (!['r', 'R', 'a'].some((flag) => options.flags.has(flag))) {
      io.err(`cp: -r not specified; omitting directory '${source}'\n`)
      return
    }
    if (isInside(targetPath, sourcePath)) {
      io.err(`cp: cannot copy a directory, '${source}', into itself, '${target}'\n`)
      return
    }
    if (ctx.fs.isFile(targetPath)) {
      io.err(`cp: cannot overwrite non-directory '${target}' with directory '${source}'\n`)
      return
    }
    try {
      ctx.fs.copy(sourcePath, targetPath, true)
    } catch (error) {
      io.err(`cp: cannot create directory '${target}': ${errorMessage(error)}\n`)
      return
    }
  } else {
    if (targetPath === sourcePath) {
      io.err(`cp: '${source}' and '${target}' are the same file\n`)
      return
    }
    if (ctx.fs.isDir(targetPath)) {
      io.err(`cp: cannot overwrite directory '${target}' with non-directory\n`)
      return
    }
    if (target.endsWith('/')) {
      io.err(`cp: cannot create regular file '${target}': ${ENOTDIR}\n`)
      return
    }
    if (options.flags.has('n') && ctx.fs.exists(targetPath)) return
    try {
      ctx.fs.copy(sourcePath, targetPath)
    } catch (error) {
      io.err(`cp: cannot create regular file '${target}': ${errorMessage(error)}\n`)
      return
    }
  }
  if (options.flags.has('v')) io.out(`'${source}' -> '${target}'\n`)
}

const moveOne = (ctx: CommandContext, transfer: Transfer, options: ParsedOptions, io: Streams): void => {
  const { source, sourcePath, target, targetPath } = transfer
  const missing = sourceMissing(ctx, transfer)
  if (missing) {
    io.err(`mv: cannot stat '${source}': ${missing}\n`)
    return
  }
  const sourceIsDir = ctx.fs.isDir(sourcePath)
  if (targetPath === sourcePath) {
    io.err(`mv: '${source}' and '${target}' are the same file\n`)
    return
  }
  if (sourceIsDir && isInside(targetPath, sourcePath)) {
    io.err(`mv: cannot move '${source}' to a subdirectory of itself, '${target}'\n`)
    return
  }
  if (sourceIsDir && ctx.fs.isFile(targetPath)) {
    io.err(`mv: cannot overwrite non-directory '${target}' with directory '${source}'\n`)
    return
  }
  if (!sourceIsDir && ctx.fs.isDir(targetPath)) {
    io.err(`mv: cannot overwrite directory '${target}' with non-directory\n`)
    return
  }
  if (!sourceIsDir && target.endsWith('/')) {
    io.err(`mv: cannot move '${source}' to '${target}': ${ENOTDIR}\n`)
    return
  }
  if (options.flags.has('n') && ctx.fs.exists(targetPath)) return
  try {
    ctx.fs.rename(sourcePath, targetPath)
  } catch (error) {
    io.err(`mv: cannot move '${source}' to '${target}': ${errorMessage(error)}\n`)
    return
  }
  if (options.flags.has('v')) io.out(`renamed '${source}' -> '${target}'\n`)
}

const CP_SPEC: OptionSpec = {
  flags: 'afnprRv',
  long: { archive: 'a', force: 'f', 'no-clobber': 'n', recursive: 'r', verbose: 'v' },
}

const cp = withOptions(CP_SPEC, (ctx, options, io) => {
  for (const transfer of planTransfers(ctx, 'cp', options.operands, io)) copyOne(ctx, transfer, options, io)
  return io.result()
})

const mv = withOptions({ flags: 'fnv', long: { force: 'f', 'no-clobber': 'n', verbose: 'v' } }, (ctx, options, io) => {
  for (const transfer of planTransfers(ctx, 'mv', options.operands, io)) moveOne(ctx, transfer, options, io)
  return io.result()
})

interface Count {
  value: number
  fromStart: boolean
  negative: boolean
}

type Range = (length: number, count: Count) => [number, number]

const parseCount = (raw: string): Count | null => {
  const match = /^([+-]?)(\d+)$/.exec(raw)
  return match ? { value: Number(match[2]), fromStart: match[1] === '+', negative: match[1] === '-' } : null
}

const headRange: Range = (length, count) => [
  0,
  count.negative ? Math.max(length - count.value, 0) : Math.min(count.value, length),
]

const tailRange: Range = (length, count) => [
  count.fromStart ? Math.min(Math.max(count.value - 1, 0), length) : Math.max(length - count.value, 0),
  length,
]

const sliceText = (text: string, count: Count, range: Range, bytes: boolean): string => {
  if (bytes) {
    const encoded = encoder.encode(text)
    return decoder.decode(encoded.subarray(...range(encoded.length, count)))
  }
  const chunks = lineChunks(text)
  return chunks.slice(...range(chunks.length, count)).join('')
}

const sliceSpec = (follow: boolean): OptionSpec => ({
  flags: follow ? 'fFqv' : 'qv',
  values: 'cn',
  numeric: 'n',
  long: { bytes: 'c', lines: 'n', quiet: 'q', silent: 'q', verbose: 'v', ...(follow ? { follow: 'f' } : {}) },
})

const sliceFiles = (command: 'head' | 'tail'): ShellCommand =>
  withOptions(sliceSpec(command === 'tail'), async (ctx, options, io) => {
    const mode = lastOf(options, ['c', 'n']) === 'c' ? 'c' : 'n'
    const raw = lastValue(options, mode) ?? '10'
    const count = parseCount(raw)
    if (!count) {
      io.err(`${command}: invalid number of ${mode === 'c' ? 'bytes' : 'lines'}: '${raw}'\n`)
      return io.result()
    }
    const operands = options.operands.length > 0 ? options.operands : ['-']
    const headers = options.flags.has('v') || (operands.length > 1 && !options.flags.has('q'))
    const range = command === 'head' ? headRange : tailRange
    let first = true
    for (const operand of operands) {
      const input = readOperand(ctx, operand)
      if ('error' in input && input.error !== EISDIR) {
        io.err(`${command}: cannot open '${operand}' for reading: ${input.error}\n`)
        continue
      }
      if (headers) io.out(`${first ? '' : '\n'}==> ${operand === '-' ? 'standard input' : operand} <==\n`)
      first = false
      if ('error' in input) io.err(`${command}: error reading '${operand}': ${EISDIR}\n`)
      else io.out(sliceText(input.text, count, range, mode === 'c'))
    }
    const follow = options.flags.has('f') || options.flags.has('F')
    if (follow && ctx.signal && operands.some((operand) => operand !== '-') && (await delay(Infinity, ctx.signal))) {
      return io.result(130)
    }
    return io.result()
  })

const obsoleteTail = (argv: readonly string[]): string[] => {
  const first = argv[1]
  return first !== undefined && /^\+\d+$/.test(first) && argv.length <= 3
    ? [argv[0] as string, '-n', first, ...argv.slice(2)]
    : [...argv]
}

const head = sliceFiles('head')
const tailFiles = sliceFiles('tail')
const tail: ShellCommand = (ctx) => tailFiles({ ...ctx, argv: obsoleteTail(ctx.argv) })

const WC_FIELDS = ['l', 'w', 'm', 'c'] as const
type WcField = (typeof WC_FIELDS)[number]

interface WcInput {
  name: string
  input: Input
  regular: boolean
}

const countText = (text: string): Record<WcField, number> => ({
  l: (text.match(/\n/g) ?? []).length,
  w: text.split(/\s+/).filter(Boolean).length,
  m: [...text].length,
  c: byteLength(text),
})

const unreadable = (input: Input): boolean => 'error' in input && input.error !== EISDIR

const wcWidth = (inputs: readonly WcInput[], fieldCount: number): number => {
  const first = inputs[0]
  if (!first || (inputs.length === 1 && fieldCount === 1) || unreadable(first.input)) return 1
  let minimum = 1
  let total = 0
  for (const { input, regular } of inputs) {
    if (unreadable(input)) continue
    if (regular && 'text' in input) total += byteLength(input.text)
    else minimum = 7
  }
  return Math.max(String(total).length, minimum)
}

const wcRow = (values: readonly number[], width: number, name: string): string =>
  `${values.map((value) => String(value).padStart(width)).join(' ')}${name === '' ? '' : ` ${name}`}\n`

const wc = withOptions({ flags: 'clmw', long: { bytes: 'c', chars: 'm', lines: 'l', words: 'w' } }, (ctx, options, io) => {
  const selected = WC_FIELDS.filter((field) => options.flags.has(field))
  const fields: readonly WcField[] = selected.length > 0 ? selected : ['l', 'w', 'c']
  const inputs: WcInput[] =
    options.operands.length > 0
      ? options.operands.map((name) => {
          const path = resolve(ctx, name)
          return { name, input: readOperand(ctx, name), regular: name !== '-' && path !== DEV_NULL && ctx.fs.isFile(path) }
        })
      : [{ name: '', input: { text: ctx.stdin }, regular: false }]
  const width = wcWidth(inputs, fields.length)
  const totals: Record<WcField, number> = { l: 0, w: 0, m: 0, c: 0 }
  for (const { name, input } of inputs) {
    if ('error' in input) io.err(`wc: ${name}: ${input.error}\n`)
    if (unreadable(input)) continue
    const counts = countText('text' in input ? input.text : '')
    for (const field of WC_FIELDS) totals[field] += counts[field]
    io.out(wcRow(fields.map((field) => counts[field]), width, name))
  }
  if (inputs.length > 1) io.out(wcRow(fields.map((field) => totals[field]), width, 'total'))
  return io.result()
})

const GREP_SPEC: OptionSpec = {
  flags: 'cEFGHhIiLlnoPqRrsvwxy',
  values: 'ABCem',
  numeric: 'C',
  long: {
    'after-context': 'A',
    'basic-regexp': 'G',
    'before-context': 'B',
    color: { key: 'color', argument: 'optional' },
    colour: { key: 'color', argument: 'optional' },
    context: 'C',
    count: 'c',
    'dereference-recursive': 'R',
    exclude: { key: 'exclude', argument: 'required' },
    'exclude-dir': { key: 'exclude-dir', argument: 'required' },
    'extended-regexp': 'E',
    'files-with-matches': 'l',
    'files-without-match': 'L',
    'fixed-strings': 'F',
    'ignore-case': 'i',
    include: { key: 'include', argument: 'required' },
    'invert-match': 'v',
    'line-number': 'n',
    'line-regexp': 'x',
    'max-count': 'm',
    'no-filename': 'h',
    'no-messages': 's',
    'only-matching': 'o',
    'perl-regexp': 'P',
    quiet: 'q',
    recursive: 'r',
    regexp: 'e',
    silent: 'q',
    'with-filename': 'H',
    'word-regexp': 'w',
  },
}

interface GrepTarget {
  name: string
  input: Input
}

type Compiled = { matcher: RegExp | null; warnings: string[] } | { error: string }

const buildMatcher = (patterns: readonly string[], has: (flag: string) => boolean): Compiled => {
  const sources: string[] = []
  const warnings: string[] = []
  for (const part of patterns.flatMap((pattern) => pattern.split('\n'))) {
    if (has('F') || has('P')) {
      sources.push(has('F') ? escapeRegExp(part) : part)
      continue
    }
    const translated = translateRegex(part, has('E'))
    if ('error' in translated) return translated
    sources.push(translated.source)
    for (const warning of translated.warnings) warnings.push(warning)
  }
  const compile = (unicode: boolean): RegExp | null => {
    const word = unicode ? IS_WORD : '[A-Za-z0-9_]'
    let source = sources.map((part) => `(?:${part})`).join('|')
    if (has('x')) source = `^(?:${source})$`
    else if (has('w')) source = `(?<!${word})(?:${source})(?!${word})`
    try {
      return new RegExp(source, `g${has('i') || has('y') ? 'i' : ''}${unicode ? 'u' : ''}`)
    } catch {
      return null
    }
  }
  return { matcher: compile(true) ?? (has('P') ? compile(false) : null), warnings }
}

interface NameRule {
  include: boolean
  glob: RegExp | null
}

const nameRules = (options: ParsedOptions): NameRule[] => {
  const used = new Map<string, number>()
  const rules: NameRule[] = []
  for (const key of options.order) {
    if (key !== 'include' && key !== 'exclude') continue
    const index = used.get(key) ?? 0
    used.set(key, index + 1)
    const glob = options.values.get(key)?.[index]
    if (glob !== undefined) rules.push({ include: key === 'include', glob: globToRegExp(glob) })
  }
  return rules
}

const skipsName = (rules: readonly NameRule[], names: readonly string[]): boolean => {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index] as NameRule
    if (names.some((name) => rule.glob?.test(name) === true)) return !rule.include
  }
  return rules[0]?.include === true
}

const nameSuffixes = (operand: string): string[] => {
  const names = [operand]
  for (let index = 0; index < operand.length; index += 1) {
    if (operand[index] === '/' && operand[index + 1] !== '/') names.push(operand.slice(index + 1))
  }
  return names
}

const grepTargets = (
  ctx: CommandContext,
  operands: readonly string[],
  recursive: boolean,
  filter: (names: readonly string[]) => boolean,
  enter: (name: string) => boolean,
): GrepTarget[] => {
  const collect = (root: string, display: string): GrepTarget[] => {
    const found: GrepTarget[] = []
    const visit = (entry: WalkEntry): void => {
      if (entry.depth > 0 && ctx.fs.isFile(entry.path) && filter([basenameOf(entry.path)])) {
        found.push({ name: entry.display, input: { text: ctx.fs.read(entry.path) ?? '' } })
      }
    }
    walk(ctx, { path: root, display, depth: 0 }, Infinity, visit, (entry) => enter(basenameOf(entry.path)))
    return found
  }
  if (operands.length === 0) {
    return recursive ? collect(ctx.cwd, '') : [{ name: '(standard input)', input: { text: ctx.stdin } }]
  }
  return operands.flatMap((operand) => {
    if (operand === '-') return [{ name: '(standard input)', input: { text: ctx.stdin } }]
    const path = resolve(ctx, operand)
    const directory = ctx.fs.isDir(path)
    if (recursive && directory) {
      return isDotOperand(operand) || enter(displayBase(operand)) ? collect(path, operand) : []
    }
    if (!directory && ctx.fs.exists(path) && !filter(nameSuffixes(operand))) return []
    return [{ name: operand, input: readOperand(ctx, operand) }]
  })
}

const contextLength = (options: ParsedOptions): { before: number; after: number } | { invalid: string } => {
  const read = (key: string): number | string | undefined => {
    const raw = lastValue(options, key)
    if (raw === undefined) return undefined
    return /^\d+$/.test(raw) ? Number(raw) : raw
  }
  const after = read('A')
  const before = read('B')
  const around = read('C')
  for (const value of [after, before, around]) if (typeof value === 'string') return { invalid: value }
  return {
    after: (after ?? around ?? 0) as number,
    before: (before ?? around ?? 0) as number,
  }
}

const grep = withOptions(GREP_SPEC, (ctx, options, io) => {
  const has = (flag: string): boolean => options.flags.has(flag)
  const operands = [...options.operands]
  const patterns = options.values.get('e') ?? (operands.length > 0 ? [operands.shift() as string] : null)
  if (!patterns) {
    io.err('Usage: grep [OPTION]... PATTERNS [FILE]...\n', 2)
    return io.result()
  }
  const context = contextLength(options)
  if ('invalid' in context) {
    io.err(`grep: ${context.invalid}: invalid context length argument\n`, 2)
    return io.result()
  }
  const maxRaw = lastValue(options, 'm')
  if (maxRaw !== undefined && !/^\d+$/.test(maxRaw)) {
    io.err('grep: invalid max count\n', 2)
    return io.result()
  }
  const max = maxRaw === undefined ? Infinity : Number(maxRaw)
  const compiled = buildMatcher(patterns, has)
  if ('error' in compiled) {
    io.err(`grep: ${compiled.error}\n`, 2)
    return io.result()
  }
  for (const warning of compiled.warnings) io.note(`grep: warning: ${warning}\n`)
  const { matcher } = compiled
  if (!matcher) {
    io.err(`grep: invalid pattern: ${patterns.join('\n')}\n`, 2)
    return io.result()
  }
  const when = lastValue(options, 'color')
  const highlight = colorEnabled(ctx, when, 'auto')
  if (highlight === null) {
    io.err(`grep: invalid argument '${when}' for '--color'\n`, 2)
    return io.result()
  }

  const rules = nameRules(options)
  const prunes = (options.values.get('exclude-dir') ?? []).map((glob) => globToRegExp(glob.replace(/(.)\/+$/, '$1')))
  const filter = (names: readonly string[]): boolean => !skipsName(rules, names)
  const enter = (name: string): boolean => !prunes.some((glob) => glob?.test(name))
  const recursive = has('r') || has('R')
  const targets = grepTargets(ctx, operands, recursive, filter, enter)
  const withNames = has('H')
    ? true
    : has('h')
      ? false
      : operands.length > 1 || (recursive && (operands.length === 0 || ctx.fs.isDir(resolve(ctx, operands[0] as string))))
  const invert = has('v')
  const printing = !has('c') && !has('l') && !has('L') && !has('q')
  const contextual = printing && !has('o') && (context.before > 0 || context.after > 0)
  const selects = (line: string): boolean => {
    matcher.lastIndex = 0
    return matcher.test(line) !== invert
  }
  const paint = (line: string): string =>
    highlight && !invert
      ? line.replace(matcher, (found) => (found === '' ? found : `${MATCH_START}${found}${MATCH_END}`))
      : line

  let errored = false
  let succeeded = false
  let printedGroup = false
  for (const target of targets) {
    if ('error' in target.input) {
      errored = true
      if (!has('s')) io.err(`grep: ${target.name}: ${target.input.error}\n`, 2)
      continue
    }
    const fileLines = has('I') && target.input.text.includes('\0') ? [] : lines(target.input.text)
    const output: string[] = []
    const prefix = (index: number, separator: string): string =>
      `${withNames ? `${target.name}${separator}` : ''}${has('n') ? `${index + 1}${separator}` : ''}`
    let count = 0
    let lastPrinted = -1
    let afterLeft = 0
    for (let index = 0; index < fileLines.length; index += 1) {
      const line = fileLines[index] as string
      if (count >= max) {
        if (!contextual || afterLeft === 0) break
        output.push(prefix(index, '-') + line)
        lastPrinted = index
        afterLeft -= 1
        continue
      }
      if (!selects(line)) {
        if (contextual && afterLeft > 0) {
          output.push(prefix(index, '-') + line)
          lastPrinted = index
          afterLeft -= 1
        }
        continue
      }
      count += 1
      if (has('q')) break
      if (!printing) continue
      if (contextual) {
        const start = Math.max(index - context.before, lastPrinted + 1)
        if (printedGroup && (lastPrinted === -1 || start > lastPrinted + 1)) output.push('--')
        for (let before = start; before < index; before += 1) output.push(prefix(before, '-') + fileLines[before])
      }
      if (has('o')) {
        matcher.lastIndex = 0
        if (!invert) {
          for (const found of line.matchAll(matcher)) {
            if (found[0] !== '') output.push(prefix(index, ':') + paint(found[0]))
          }
        }
      } else {
        output.push(prefix(index, ':') + paint(line))
      }
      lastPrinted = index
      afterLeft = context.after
      printedGroup = true
    }
    if (has('q') && count > 0) return io.result(0)
    if (has('c')) io.out(`${withNames ? `${target.name}:` : ''}${count}\n`)
    else if (has('l') && count > 0) io.out(`${target.name}\n`)
    else if (has('L') && count === 0) io.out(`${target.name}\n`)
    else io.out(joinLines(output))
    if (has('L') ? count === 0 : count > 0) succeeded = true
  }
  return io.result(errored ? 2 : succeeded ? 0 : 1)
})

interface SortKey {
  startField: number
  startChar: number
  endField: number
  endChar: number
  numeric: boolean
  fold: boolean
  reverse: boolean
  blanks: boolean
  custom: boolean
}

const KEY_PATTERN = /^(\d+)(?:\.(\d+))?([bfnr]*)(?:,(\d+)(?:\.(\d+))?([bfnr]*))?$/

const parseKey = (raw: string): SortKey | string => {
  const match = KEY_PATTERN.exec(raw)
  if (!match) {
    return /^\d/.test(raw)
      ? `sort: stray character in field spec: invalid field specification '${raw}'`
      : `sort: invalid number at field start: invalid count at start of '${raw}'`
  }
  const startField = Number(match[1])
  if (startField === 0) return `sort: field number is zero: invalid field specification '${raw}'`
  const letters = `${match[3] ?? ''}${match[6] ?? ''}`
  return {
    startField,
    startChar: Number(match[2] ?? 0),
    endField: Number(match[4] ?? 0),
    endChar: Number(match[5] ?? 0),
    numeric: letters.includes('n'),
    fold: letters.includes('f'),
    reverse: letters.includes('r'),
    blanks: letters.includes('b'),
    custom: letters !== '',
  }
}

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t'

const fieldBounds = (line: string, separator: string | undefined): Array<[number, number]> => {
  const fields: Array<[number, number]> = []
  if (separator !== undefined) {
    let start = 0
    for (;;) {
      const at = line.indexOf(separator, start)
      if (at === -1) {
        fields.push([start, line.length])
        return fields
      }
      fields.push([start, at])
      start = at + separator.length
    }
  }
  let index = 0
  while (index < line.length) {
    const start = index
    while (index < line.length && isBlank(line[index])) index += 1
    while (index < line.length && !isBlank(line[index])) index += 1
    fields.push([start, index])
  }
  return fields
}

const keyText = (line: string, key: SortKey, separator: string | undefined): string => {
  const fields = fieldBounds(line, separator)
  const first = fields[key.startField - 1]
  if (!first) return ''
  const skipBlanks = (from: number, to: number): number => {
    let index = from
    while (key.blanks && index < to && isBlank(line[index])) index += 1
    return index
  }
  const start = Math.min(skipBlanks(first[0], first[1]) + Math.max(key.startChar - 1, 0), first[1])
  let end = line.length
  const last = key.endField > 0 ? fields[key.endField - 1] : undefined
  if (last) end = key.endChar > 0 ? Math.min(skipBlanks(last[0], last[1]) + key.endChar, last[1]) : last[1]
  return line.slice(start, Math.max(start, end))
}

const numericValue = (text: string): number => {
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+))/.exec(text)
  return match ? Number(match[1]) : 0
}

const keyValue = (line: string, key: SortKey, separator: string | undefined): string | number => {
  const text = keyText(line, key, separator)
  return key.numeric ? numericValue(text) : key.fold ? text.toUpperCase() : text
}

const compareValues = (left: string | number, right: string | number, key: SortKey): number => {
  const result =
    typeof left === 'number' && typeof right === 'number' ? Math.sign(left - right) : collate(String(left), String(right))
  return key.reverse ? -result : result
}

interface SortRow {
  line: string
  keys: Array<string | number>
}

const SORT_SPEC: OptionSpec = {
  flags: 'bfnrsu',
  values: 'kot',
  long: {
    'field-separator': 't',
    'ignore-case': 'f',
    'ignore-leading-blanks': 'b',
    key: 'k',
    'numeric-sort': 'n',
    output: 'o',
    reverse: 'r',
    stable: 's',
    unique: 'u',
  },
}

const sort = withOptions(SORT_SPEC, (ctx, options, io) => {
  const has = (flag: string): boolean => options.flags.has(flag)
  const separator = lastValue(options, 't')
  if (separator === '') {
    io.err('sort: empty tab\n', 2)
    return io.result()
  }
  if (separator !== undefined && [...separator].length > 1) {
    io.err(`sort: multi-character tab '${separator}'\n`, 2)
    return io.result()
  }
  const global = { numeric: has('n'), fold: has('f'), reverse: has('r'), blanks: has('b') }
  const keys: SortKey[] = []
  for (const raw of options.values.get('k') ?? []) {
    const key = parseKey(raw)
    if (typeof key === 'string') {
      io.err(`${key}\n`, 2)
      return io.result()
    }
    keys.push(key.custom ? key : { ...key, ...global })
  }
  if (keys.length === 0) keys.push({ startField: 1, startChar: 0, endField: 0, endChar: 0, custom: true, ...global })

  const collected: string[] = []
  for (const operand of options.operands.length > 0 ? options.operands : ['-']) {
    const input = readOperand(ctx, operand)
    if ('error' in input) {
      const reason = input.error === EISDIR ? `read failed: ${operand}` : `cannot read: ${operand}`
      io.err(`sort: ${reason}: ${input.error}\n`, 2)
      return io.result()
    }
    for (const line of lines(input.text)) collected.push(line)
  }

  const rows: SortRow[] = collected.map((line) => ({ line, keys: keys.map((key) => keyValue(line, key, separator)) }))
  const compareKeys = (a: SortRow, b: SortRow): number => {
    for (const [index, key] of keys.entries()) {
      const result = compareValues(a.keys[index] as string | number, b.keys[index] as string | number, key)
      if (result !== 0) return result
    }
    return 0
  }
  const lastResort = (a: string, b: string): number =>
    has('s') || has('u') ? 0 : (collate(a, b) || codeOrder(a, b)) * (global.reverse ? -1 : 1)
  rows.sort((a, b) => compareKeys(a, b) || lastResort(a.line, b.line))
  const kept = has('u') ? rows.filter((row, index) => index === 0 || compareKeys(rows[index - 1] as SortRow, row) !== 0) : rows
  const text = joinLines(kept.map((row) => row.line))
  const output = lastValue(options, 'o')
  if (output === undefined) {
    io.out(text)
    return io.result()
  }
  try {
    ctx.fs.write(resolve(ctx, output), text)
  } catch (error) {
    io.err(`sort: open failed: ${output}: ${errorMessage(error)}\n`, 2)
  }
  return io.result()
})

const UNIQ_SPEC: OptionSpec = {
  flags: 'cdiu',
  long: { count: 'c', 'ignore-case': 'i', repeated: 'd', unique: 'u' },
}

const uniq = withOptions(UNIQ_SPEC, (ctx, options, io) => {
  const has = (flag: string): boolean => options.flags.has(flag)
  const [inputName = '-', outputName, extra] = options.operands
  if (extra !== undefined) {
    io.err(`uniq: extra operand '${extra}'\n`)
    return io.result()
  }
  const input = readOperand(ctx, inputName)
  if ('error' in input) {
    io.err(`uniq: ${inputName}: ${input.error}\n`)
    return io.result()
  }
  const key = (line: string): string => (has('i') ? line.toLowerCase() : line)
  const groups: Array<{ line: string; count: number }> = []
  for (const line of lines(input.text)) {
    const last = groups[groups.length - 1]
    if (last && key(last.line) === key(line)) last.count += 1
    else groups.push({ line, count: 1 })
  }
  const text = groups
    .filter((group) => (!has('d') || group.count > 1) && (!has('u') || group.count === 1))
    .map((group) => (has('c') ? `${String(group.count).padStart(7)} ${group.line}\n` : `${group.line}\n`))
    .join('')
  if (outputName === undefined || outputName === '-') {
    io.out(text)
    return io.result()
  }
  try {
    ctx.fs.write(resolve(ctx, outputName), text)
  } catch (error) {
    io.err(`uniq: ${outputName}: ${errorMessage(error)}\n`)
  }
  return io.result()
})

type FindTest = (entry: WalkEntry) => boolean

type FindStep = FindTest | { print: true; result: boolean }

interface FindPlan {
  roots: string[]
  alternatives: FindStep[][]
  minDepth: number
  maxDepth: number
  prints: boolean
}

const FIND_VALUES = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-type', '-maxdepth', '-mindepth'])
const FIND_TYPES = new Set(['b', 'c', 'd', 'p', 'f', 'l', 's', 'D'])

const displayBase = (display: string): string => {
  const trimmed = display.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

const findTest = (ctx: CommandContext, token: string, value: string): FindTest | string => {
  if (token === '-empty') {
    return (entry) =>
      ctx.fs.isDir(entry.path) ? (ctx.fs.list(entry.path) ?? []).length === 0 : ctx.fs.read(entry.path) === ''
  }
  if (token === '-type') {
    if (!FIND_TYPES.has(value)) return `find: Unknown argument to -type: ${value}`
    return (entry) => (value === 'd' ? ctx.fs.isDir(entry.path) : value === 'f' && ctx.fs.isFile(entry.path))
  }
  const matcher = globToRegExp(value, token === '-iname' || token === '-ipath')
  const byName = token === '-name' || token === '-iname'
  return (entry) => matcher !== null && matcher.test(byName ? displayBase(entry.display) : entry.display)
}

const parseFind = (ctx: CommandContext, args: readonly string[]): FindPlan | string => {
  let index = 0
  const roots: string[] = []
  while (index < args.length && !(args[index] as string).startsWith('-') && args[index] !== '!' && args[index] !== '(') {
    roots.push(args[index] as string)
    index += 1
  }
  const plan: FindPlan = {
    roots: roots.length > 0 ? roots : ['.'],
    alternatives: [[]],
    minDepth: 0,
    maxDepth: Infinity,
    prints: false,
  }
  let negate = false
  while (index < args.length) {
    const token = args[index] as string
    index += 1
    if (token === '!' || token === '-not') {
      negate = !negate
      continue
    }
    if (token === '-a' || token === '-and') continue
    if (token === '-print') {
      plan.alternatives[plan.alternatives.length - 1]?.push({ print: true, result: !negate })
      plan.prints = true
      negate = false
      continue
    }
    if (token === '-o' || token === '-or') {
      plan.alternatives.push([])
      continue
    }
    if (!FIND_VALUES.has(token) && token !== '-empty') return `find: unknown predicate '${token}'`
    let value = ''
    if (FIND_VALUES.has(token)) {
      const next = args[index]
      if (next === undefined) return `find: missing argument to '${token}'`
      value = next
      index += 1
    }
    if (token === '-maxdepth' || token === '-mindepth') {
      if (!/^\d+$/.test(value)) return `find: Expected a positive decimal integer argument to ${token}, but got '${value}'`
      if (token === '-maxdepth') plan.maxDepth = Number(value)
      else plan.minDepth = Number(value)
      continue
    }
    const test = findTest(ctx, token, value)
    if (typeof test === 'string') return test
    const negated = negate
    negate = false
    plan.alternatives[plan.alternatives.length - 1]?.push(negated ? (entry) => !test(entry) : test)
  }
  return plan
}

const find: ShellCommand = (ctx) => {
  const io = new Streams(ctx)
  const plan = parseFind(ctx, ctx.argv.slice(1))
  if (typeof plan === 'string') {
    io.err(`${plan}\n`)
    return io.result()
  }
  const passes = (group: readonly FindStep[], entry: WalkEntry): boolean =>
    group.every((step) => {
      if (typeof step === 'function') return step(entry)
      io.out(`${entry.display}\n`)
      return step.result
    })
  const evaluate = (entry: WalkEntry): void => {
    if (plan.alternatives.some((group) => passes(group, entry)) && !plan.prints) io.out(`${entry.display}\n`)
  }
  for (const root of plan.roots) {
    const path = resolve(ctx, root)
    if (!ctx.fs.exists(path)) {
      io.err(`find: '${root}': ${missingReason(ctx, path)}\n`)
      continue
    }
    walk(ctx, { path, display: root, depth: 0 }, plan.maxDepth, (entry) => {
      if (entry.depth >= plan.minDepth) evaluate(entry)
    })
  }
  return io.result()
}

const env = withOptions({ flags: 'i', values: 'u', long: { 'ignore-environment': 'i', unset: 'u' } }, (ctx, options, io) => {
  const listed: Record<string, string> = options.flags.has('i') ? {} : { ...ctx.env }
  for (const name of options.values.get('u') ?? []) delete listed[name]
  for (const operand of options.operands) {
    const equals = operand.indexOf('=')
    if (equals <= 0) {
      io.err(`env: '${operand}': ${ENOENT}\n`, 127)
      return io.result()
    }
    listed[operand.slice(0, equals)] = operand.slice(equals + 1)
  }
  io.out(joinLines(Object.keys(listed).sort().map((name) => `${name}=${listed[name]}`)))
  return io.result()
})

const exportCommand = withOptions({ flags: 'p' }, (ctx, options, io) => {
  if (options.operands.length === 0 || options.flags.has('p')) {
    const quoted = (value: string): string => value.replace(/["\\$`]/g, '\\$&')
    io.out(joinLines(Object.keys(ctx.env).sort().map((name) => `export ${name}="${quoted(ctx.env[name] ?? '')}"`)))
  }
  for (const operand of options.operands) {
    const equals = operand.indexOf('=')
    const name = equals === -1 ? operand : operand.slice(0, equals)
    if (!IDENTIFIER.test(name)) io.err(`export: '${operand}': not a valid identifier\n`)
    else if (equals !== -1) ctx.env[name] = operand.slice(equals + 1)
  }
  return io.result()
})

const unset = withOptions({ flags: 'fv' }, (ctx, options, io) => {
  if (options.flags.has('f')) return io.result()
  for (const name of options.operands) {
    if (!IDENTIFIER.test(name)) io.err(`unset: '${name}': not a valid identifier\n`)
    else delete ctx.env[name]
  }
  return io.result()
})

const commandKind = (ctx: CommandContext, name: string): 'builtin' | 'file' | null => {
  const known = ctx.commands ?? Object.keys(builtins)
  if (!known.includes(name)) return null
  return Object.hasOwn(builtins, name) || name === 'help' ? 'builtin' : 'file'
}

const which = withOptions({ flags: 'a' }, (ctx, options, io) => {
  if (options.operands.length === 0) io.err('which: missing operand\n')
  for (const name of options.operands) {
    const kind = commandKind(ctx, name)
    if (kind === null) io.err(`${name} not found\n`)
    else io.out(kind === 'builtin' ? `${name}: shell builtin\n` : `/usr/bin/${name}\n`)
  }
  return io.result()
})

const type = withOptions({ flags: 'at' }, (ctx, options, io) => {
  const terse = options.flags.has('t')
  for (const name of options.operands) {
    const kind = commandKind(ctx, name)
    if (kind === null) {
      if (terse) io.status = 1
      else io.err(`type: ${name}: not found\n`)
    } else if (terse) {
      io.out(`${kind}\n`)
    } else {
      io.out(kind === 'builtin' ? `${name} is a shell builtin\n` : `${name} is /usr/bin/${name}\n`)
    }
  }
  return io.result()
})

const SLEEP_UNITS: Readonly<Record<string, number>> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }

const parseInterval = (text: string): number | null => {
  if (/^inf(inity)?$/i.test(text)) return Infinity
  const match = /^((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([smhd]?)$/.exec(text)
  return match ? Number(match[1]) * (SLEEP_UNITS[match[2] as string] as number) : null
}

const sleep = withOptions({}, async (ctx, options, io) => {
  if (options.operands.length === 0) {
    io.err('sleep: missing operand\n')
    return io.result()
  }
  let seconds = 0
  for (const operand of options.operands) {
    const value = parseInterval(operand)
    if (value === null) io.err(`sleep: invalid time interval '${operand}'\n`)
    else seconds += value
  }
  if (io.status !== 0) return io.result()
  return io.result((await delay(seconds * 1000, ctx.signal)) ? 130 : 0)
})

const tee = withOptions({ flags: 'ai', long: { append: 'a', 'ignore-interrupts': 'i' } }, (ctx, options, io) => {
  for (const operand of options.operands) {
    const path = resolve(ctx, operand)
    try {
      if (options.flags.has('a')) ctx.fs.append(path, ctx.stdin)
      else ctx.fs.write(path, ctx.stdin)
    } catch (error) {
      io.err(`tee: ${operand}: ${errorMessage(error)}\n`)
    }
  }
  io.out(ctx.stdin)
  return io.result()
})

const stripName = (name: string, suffix: string | undefined): string => {
  if (name === '') return ''
  const trimmed = name.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return suffix && base !== suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base
}

const basename = withOptions({ flags: 'a', values: 's', long: { multiple: 'a', suffix: 's' } }, (_ctx, options, io) => {
  const suffix = lastValue(options, 's')
  const multiple = options.flags.has('a') || suffix !== undefined
  const [name, second, extra] = options.operands
  if (name === undefined) io.err('basename: missing operand\n')
  else if (!multiple && extra !== undefined) io.err(`basename: extra operand '${extra}'\n`)
  else if (multiple) io.out(joinLines(options.operands.map((operand) => stripName(operand, suffix))))
  else io.out(`${stripName(name, second)}\n`)
  return io.result()
})

const parentOf = (name: string): string => {
  if (/^\/+$/.test(name)) return '/'
  const trimmed = name.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash === -1) return '.'
  return trimmed.slice(0, slash).replace(/\/+$/, '') || '/'
}

const dirname = withOptions({}, (_ctx, options, io) => {
  if (options.operands.length === 0) io.err('dirname: missing operand\n')
  else io.out(joinLines(options.operands.map(parentOf)))
  return io.result()
})

export const builtins: Record<string, ShellCommand> = {
  pwd,
  cd,
  ls,
  cat,
  echo,
  touch,
  mkdir,
  rm,
  cp,
  mv,
  head,
  tail,
  wc,
  grep,
  sort,
  uniq,
  find,
  env,
  export: exportCommand,
  which,
  sleep,
  true: () => ({ exitCode: 0 }),
  false: () => ({ exitCode: 1 }),
  printf,
  tee,
  basename,
  dirname,
  type,
  unset,
}
