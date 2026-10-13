export type CommandLineProblem = 'quote' | 'syntax'

export class CommandLineError extends Error {
  readonly problem: CommandLineProblem
  readonly token: string

  constructor(problem: CommandLineProblem, token: string) {
    super(problem === 'quote' ? `unmatched ${token}` : `unsupported shell syntax: ${token}`)
    this.name = 'CommandLineError'
    this.problem = problem
    this.token = token
  }
}

interface Scan {
  words: string[]
  open: '"' | "'" | '\\' | null
  syntax: string | null
}

const BLANK = /^[ \t\r]$/
const OPERATORS = new Set(['|', '&', ';', '<', '>', '`', '(', ')'])
const EXPANSION = /^[A-Za-z0-9_{(?#@*!$-]$/
const ESCAPABLE_IN_DOUBLE_QUOTES = new Set(['$', '`', '"', '\\'])

const startsExpansion = (char: string, next: string | undefined) =>
  char === '$' && next !== undefined && EXPANSION.test(next)

const continuationAt = (chars: readonly string[], index: number): number => {
  if (chars[index] !== '\\') return 0
  if (chars[index + 1] === '\n') return 1
  return chars[index + 1] === '\r' && chars[index + 2] === '\n' ? 2 : 0
}

function scan(line: string): Scan {
  const chars = Array.from(line)
  const words: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | null = null
  let dangling = false
  let separated = false
  let syntax: string | null = null
  const fail = (token: string) => {
    syntax ??= token
  }

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? ''
    const next = chars[index + 1]
    const joined = quote === "'" ? 0 : continuationAt(chars, index)
    if (joined > 0) {
      index += joined
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && next !== undefined && ESCAPABLE_IN_DOUBLE_QUOTES.has(next)) {
        word += next
        index += 1
      } else if (char === '`' || startsExpansion(char, next)) fail(char)
      else word += char
      continue
    }
    if (char === '\n') {
      if (started) words.push(word)
      if (words.length > 0) separated = true
      word = ''
      started = false
      continue
    }
    if (BLANK.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
      continue
    }
    if (char === '#' && !started) {
      const lineEnd = chars.indexOf('\n', index)
      index = lineEnd === -1 ? chars.length : lineEnd - 1
      continue
    }
    if (!started && separated) fail('\n')
    started = true
    if (char === '\\') {
      if (next === undefined) dangling = true
      word += next ?? char
      if (next !== undefined) index += 1
    } else if (char === '"' || char === "'") quote = char
    else if (OPERATORS.has(char) || startsExpansion(char, next)) fail(char)
    else word += char
  }

  if (started) words.push(word)
  return { words, open: quote ?? (dangling ? '\\' : null), syntax }
}

export function splitCommandLine(line: string): string[] {
  const { words, open, syntax } = scan(line)
  if (syntax !== null) throw new CommandLineError('syntax', syntax)
  if (open === '"' || open === "'") throw new CommandLineError('quote', open)
  return words
}

export function isCompleteCommandLine(line: string): boolean {
  const { open, syntax } = scan(line)
  return syntax !== null || open === null
}
