import { formatMessage, getMessages, type Messages } from '../messages.js'
import { POSIX_CLASSES } from './locale.js'

export type Quoting = 'none' | 'single' | 'double' | 'escaped'

export type ParamOperator = '-' | ':-' | '=' | ':=' | '?' | ':?' | '+' | ':+' | '#' | '##' | '%' | '%%'

export type Part =
  | { type: 'literal'; value: string; quoting: Quoting }
  | { type: 'param'; name: string; length?: boolean; operator?: ParamOperator; word?: Word; quoted: boolean }
  | { type: 'subst'; script: Script; quoted: boolean }

export interface Word {
  text: string
  parts: Part[]
}

export type Redirect =
  | { fd: number; mode: 'read' | 'write' | 'append'; target: Word }
  | { fd: number; mode: 'dup'; target: number | 'close' | Word }

export interface Assignment {
  name: string
  append: boolean
  value: Word
}

export interface SimpleCommand {
  assignments: Assignment[]
  words: Word[]
  redirects: Redirect[]
}

export interface Pipeline {
  commands: SimpleCommand[]
  negated?: boolean
}

export interface AndOr {
  first: Pipeline
  rest: Array<{ operator: '&&' | '||'; pipeline: Pipeline }>
}

export type Script = AndOr[]

export type ListOperator = '&&' | '||' | '|' | '|&' | ';' | ';;' | '\n'
export type RedirectOperator = '<' | '>' | '>>' | '>|' | '>&' | '&>' | '&>>'

export type Token =
  | { type: 'word'; word: Word }
  | { type: 'operator'; value: ListOperator }
  | { type: 'redirect'; fd: number | null; operator: RedirectOperator }

export class ShellSyntaxError extends Error {
  readonly incomplete: boolean

  constructor(message: string, incomplete = false) {
    super(message)
    this.name = 'ShellSyntaxError'
    this.incomplete = incomplete
  }
}

export type SyntaxLabel = Extract<keyof Messages, `shellSyntax${string}`>

const unsupportedText = (messages: Messages, label: SyntaxLabel, token: string): string =>
  formatMessage(messages.shellUnsupported, { construct: formatMessage(messages[label], { token }) })

export class UnsupportedSyntaxError extends Error {
  readonly label: SyntaxLabel
  readonly token: string

  constructor(label: SyntaxLabel, token = '') {
    super(unsupportedText(getMessages('en'), label, token))
    this.name = 'UnsupportedSyntaxError'
    this.label = label
    this.token = token
  }

  localized(messages: Messages): string {
    return unsupportedText(messages, this.label, this.token)
  }
}

export type ExpansionLabel = 'shellBraceLimit'

export class ExpansionError extends Error {
  readonly label: ExpansionLabel | undefined

  constructor(message: string, label?: ExpansionLabel) {
    super(message)
    this.name = 'ExpansionError'
    this.label = label
  }

  localized(messages: Messages): string {
    return this.label ? messages[this.label] : this.message
  }
}

const braceLimit = (): ExpansionError => new ExpansionError(getMessages('en').shellBraceLimit, 'shellBraceLimit')

const OPERATORS = [
  '&&',
  '&>>',
  '&>',
  '&',
  '||',
  '|&',
  '|',
  ';;',
  ';',
  '<<<',
  '<<-',
  '<<',
  '<&',
  '<>',
  '<(',
  '<',
  '>>',
  '>&',
  '>|',
  '>(',
  '>',
  '(',
  ')',
] as const

type Construct = readonly [label: SyntaxLabel, token: string]

const UNSUPPORTED_OPERATORS: Partial<Record<(typeof OPERATORS)[number], Construct>> = {
  '&': ['shellSyntaxBackground', '&'],
  '<<<': ['shellSyntaxHereString', '<<<'],
  '<<-': ['shellSyntaxHereDocument', '<<'],
  '<<': ['shellSyntaxHereDocument', '<<'],
  '<&': ['shellSyntaxInputDuplication', '<&'],
  '<>': ['shellSyntaxReadWrite', '<>'],
  '<(': ['shellSyntaxProcessSubstitution', '<( )'],
  '>(': ['shellSyntaxProcessSubstitution', '>( )'],
  '(': ['shellSyntaxSubshell', '( )'],
  ')': ['shellSyntaxSubshell', '( )'],
}

const FUNCTION_PARENS = /^\([ \t]*\)/

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const wordOf = (token: Token | undefined): Word | undefined => (token?.type === 'word' ? token.word : undefined)

const plainText = (word: Word | undefined): string | undefined => {
  const [only, extra] = word?.parts ?? []
  return !extra && only?.type === 'literal' && only.quoting === 'none' ? only.value : undefined
}

const reservedGroup = (label: SyntaxLabel, words: readonly string[]): Array<[string, Construct]> =>
  words.map((word) => [word, [label, word]])

const RESERVED_WORDS = new Map<string, Construct>([
  ...reservedGroup('shellSyntaxConditional', ['if', 'then', 'elif', 'else', 'fi', '[[', ']]']),
  ...reservedGroup('shellSyntaxLoop', ['for', 'while', 'until', 'select', 'do', 'done']),
  ...reservedGroup('shellSyntaxCase', ['case', 'esac']),
  ['function', ['shellSyntaxFunction', '']],
  ['{', ['shellSyntaxGroup', '{ }']],
  ['}', ['shellSyntaxGroup', '{ }']],
])

const PARAM_OPERATORS: readonly ParamOperator[] = ['##', '#', '%%', '%', ':-', ':=', ':?', ':+', '-', '=', '?', '+']

const SPECIAL_PARAMS = '?$#@*!-0'

const incomplete = (closing: string): ShellSyntaxError =>
  new ShellSyntaxError(`syntax error: unexpected end of file while looking for matching '${closing}'`, true)

const danglingOperator = (): ShellSyntaxError => new ShellSyntaxError('syntax error: unexpected end of file', true)

const tokenLabel = (token: Token | undefined): string => {
  if (!token) return 'newline'
  if (token.type === 'word') return token.word.text
  if (token.type === 'redirect') return token.operator
  return token.value === '\n' ? 'newline' : token.value
}

const nearToken = (label: string): ShellSyntaxError => new ShellSyntaxError(`syntax error near unexpected token '${label}'`)

const unexpected = (token: Token | undefined): ShellSyntaxError => nearToken(tokenLabel(token))

const pushLiteral = (parts: Part[], value: string, quoting: Quoting): void => {
  const last = parts[parts.length - 1]
  if (last?.type === 'literal' && last.quoting === quoting) last.value += value
  else parts.push({ type: 'literal', value, quoting })
}

interface WordInProgress {
  start: number
  parts: Part[]
}

class Lexer {
  private pos = 0
  private readonly src: string
  private readonly strict: boolean

  constructor(src: string, strict: boolean) {
    this.src = src
    this.strict = strict
  }

  lex(closing: ')' | null): Token[] {
    const tokens: Token[] = []
    let word: WordInProgress | null = null
    for (;;) {
      if (this.pos >= this.src.length) {
        if (closing) throw incomplete(closing)
        this.finishWord(tokens, word)
        return tokens
      }
      const char = this.src[this.pos] as string
      if (char === '\\' && this.src[this.pos + 1] === '\n') {
        this.pos += 2
        continue
      }
      if (char === ' ' || char === '\t' || char === '\n') {
        this.finishWord(tokens, word)
        word = null
        if (char === '\n') tokens.push({ type: 'operator', value: '\n' })
        this.pos += 1
        continue
      }
      if (char === '#' && !word) {
        this.skipComment()
        continue
      }
      if (closing && char === ')') {
        this.finishWord(tokens, word)
        this.pos += 1
        return tokens
      }
      const operator = OPERATORS.find((candidate) => this.src.startsWith(candidate, this.pos))
      if (operator) {
        if (operator === '(' && this.definesFunction(tokens, word)) throw new UnsupportedSyntaxError('shellSyntaxFunction')
        const unsupported = UNSUPPORTED_OPERATORS[operator]
        if (unsupported) throw new UnsupportedSyntaxError(...unsupported)
        const fd = this.descriptor(operator, word)
        if (fd === null) this.finishWord(tokens, word)
        word = null
        this.pos += operator.length
        tokens.push(this.operatorToken(operator, fd))
        continue
      }
      word ??= { start: this.pos, parts: [] }
      this.readPiece(word.parts)
    }
  }

  private definesFunction(tokens: readonly Token[], word: WordInProgress | null): boolean {
    if (!FUNCTION_PARENS.test(this.src.slice(this.pos))) return false
    const name = word ? { text: this.src.slice(word.start, this.pos), parts: word.parts } : wordOf(tokens.at(-1))
    if (!name || !NAME.test(plainText(name) ?? '')) return false
    const before = tokens.at(word ? -1 : -2)
    if (before === undefined || before.type === 'operator') return true
    const keyword = tokens.at(word ? -2 : -3)
    return plainText(wordOf(before)) === 'function' && (keyword === undefined || keyword.type === 'operator')
  }

  private finishWord(tokens: Token[], word: WordInProgress | null): void {
    if (word) tokens.push({ type: 'word', word: { text: this.src.slice(word.start, this.pos), parts: word.parts } })
  }

  private skipComment(): void {
    const end = this.src.indexOf('\n', this.pos)
    this.pos = end === -1 ? this.src.length : end
  }

  private descriptor(operator: string, word: WordInProgress | null): number | null {
    if (!word || !(operator.startsWith('<') || operator.startsWith('>'))) return null
    const [only, extra] = word.parts
    if (extra || only?.type !== 'literal' || only.quoting !== 'none' || !/^\d+$/.test(only.value)) return null
    return Number(only.value)
  }

  private operatorToken(operator: string, fd: number | null): Token {
    if (operator === '&&' || operator === '||' || operator === '|' || operator === '|&' || operator === ';' || operator === ';;') {
      return { type: 'operator', value: operator }
    }
    return { type: 'redirect', fd, operator: operator as RedirectOperator }
  }

  private readPiece(parts: Part[]): void {
    const char = this.src[this.pos] as string
    if (char === "'") return this.readSingle(parts)
    if (char === '"') return this.readDouble(parts)
    if (char === '$') return this.readDollar(parts, false)
    if (char === '`') return this.readBacktick(parts, false)
    if (char === '\\') {
      const next = this.src[this.pos + 1]
      if (next === undefined) {
        if (this.strict) throw danglingOperator()
        this.pos += 1
        return
      }
      pushLiteral(parts, next, 'escaped')
      this.pos += 2
      return
    }
    pushLiteral(parts, char, 'none')
    this.pos += 1
  }

  private readSingle(parts: Part[]): void {
    const close = this.src.indexOf("'", this.pos + 1)
    if (close === -1) throw incomplete("'")
    pushLiteral(parts, this.src.slice(this.pos + 1, close), 'single')
    this.pos = close + 1
  }

  private readDouble(parts: Part[]): void {
    this.pos += 1
    const first = parts.length
    let buffer = ''
    const flush = () => {
      if (buffer !== '') pushLiteral(parts, buffer, 'double')
      buffer = ''
    }
    for (;;) {
      if (this.pos >= this.src.length) throw incomplete('"')
      const char = this.src[this.pos] as string
      if (char === '"') {
        this.pos += 1
        break
      }
      if (char === '\\') {
        const next = this.src[this.pos + 1]
        if (next === undefined) throw incomplete('"')
        if (next === '\n') this.pos += 2
        else if ('$`"\\'.includes(next)) {
          buffer += next
          this.pos += 2
        } else {
          buffer += char
          this.pos += 1
        }
        continue
      }
      if (char === '$' || char === '`') {
        flush()
        if (char === '$') this.readDollar(parts, true)
        else this.readBacktick(parts, true)
        continue
      }
      buffer += char
      this.pos += 1
    }
    flush()
    if (parts.length === first) parts.push({ type: 'literal', value: '', quoting: 'double' })
  }

  private readDollar(parts: Part[], quoted: boolean): void {
    const next = this.src[this.pos + 1]
    if (next === '(') {
      if (this.src[this.pos + 2] === '(') throw new UnsupportedSyntaxError('shellSyntaxArithmetic', '$(( ))')
      this.pos += 2
      parts.push({ type: 'subst', script: parseSubstitution(this.lex(')')), quoted })
      return
    }
    if (next === '[') throw new UnsupportedSyntaxError('shellSyntaxArithmetic', '$[ ]')
    if (next === '{') return this.readBraced(parts, quoted)
    if (!quoted && next === "'") throw new UnsupportedSyntaxError('shellSyntaxAnsiC', "$'...'")
    if (!quoted && next === '"') {
      this.pos += 1
      return this.readDouble(parts)
    }
    const name = next === undefined ? '' : /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos + 1))?.[0] ?? ''
    if (name !== '') {
      parts.push({ type: 'param', name, quoted })
      this.pos += 1 + name.length
      return
    }
    if (next !== undefined && (/[0-9]/.test(next) || SPECIAL_PARAMS.includes(next))) {
      parts.push({ type: 'param', name: next, quoted })
      this.pos += 2
      return
    }
    pushLiteral(parts, '$', quoted ? 'double' : 'none')
    this.pos += 1
  }

  private readBraced(parts: Part[], quoted: boolean): void {
    const start = this.pos
    this.pos += 2
    if (this.src[this.pos] === '}') throw new ShellSyntaxError('${}: bad substitution')
    const length = this.src[this.pos] === '#' && this.src[this.pos + 1] !== '}'
    if (length) this.pos += 1
    const name = this.readParamName()
    if (name === '') return this.unsupportedBraced(start)
    if (this.src[this.pos] === '}') {
      this.pos += 1
      parts.push(length ? { type: 'param', name, length: true, quoted } : { type: 'param', name, quoted })
      return
    }
    const operator = length ? undefined : PARAM_OPERATORS.find((candidate) => this.src.startsWith(candidate, this.pos))
    if (!operator) return this.unsupportedBraced(start)
    this.pos += operator.length
    parts.push({ type: 'param', name, operator, word: this.readParamWord(), quoted })
  }

  private readParamName(): string {
    const rest = this.src.slice(this.pos)
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)/.exec(rest)?.[0] ?? (SPECIAL_PARAMS.includes(rest[0] ?? '') ? (rest[0] as string) : '')
    this.pos += name.length
    return name
  }

  private readParamWord(): Word {
    const start = this.pos
    const parts: Part[] = []
    for (;;) {
      if (this.pos >= this.src.length) throw incomplete('}')
      const char = this.src[this.pos] as string
      if (char === '}') {
        const text = this.src.slice(start, this.pos)
        this.pos += 1
        return { text, parts }
      }
      if (char === '\\' && this.src[this.pos + 1] === '\n') {
        this.pos += 2
        continue
      }
      if ("'\"\\$`".includes(char)) {
        this.readPiece(parts)
        continue
      }
      pushLiteral(parts, char, 'none')
      this.pos += 1
    }
  }

  private unsupportedBraced(start: number): never {
    let depth = 0
    for (let index = start + 2; index < this.src.length; index += 1) {
      const char = this.src[index]
      if (char === '{') depth += 1
      if (char !== '}') continue
      if (depth === 0) throw new UnsupportedSyntaxError('shellSyntaxParameter', this.src.slice(start, index + 1))
      depth -= 1
    }
    throw incomplete('}')
  }

  private readBacktick(parts: Part[], quoted: boolean): void {
    this.pos += 1
    let body = ''
    for (;;) {
      if (this.pos >= this.src.length) throw incomplete('`')
      const char = this.src[this.pos] as string
      if (char === '`') {
        this.pos += 1
        break
      }
      if (char === '\\') {
        const next = this.src[this.pos + 1]
        if (next === undefined) throw incomplete('`')
        if (next === '$' || next === '`' || next === '\\' || (quoted && next === '"')) body += next
        else if (next !== '\n') body += `\\${next}`
        this.pos += 2
        continue
      }
      body += char
      this.pos += 1
    }
    parts.push({ type: 'subst', script: parseNested(body), quoted })
  }
}

class Parser {
  private index = 0
  private readonly tokens: Token[]

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  script(): Script {
    const script: Script = []
    this.skipNewlines()
    while (this.index < this.tokens.length) {
      script.push(this.andOr())
      const token = this.tokens[this.index]
      if (!token) break
      if (token.type !== 'operator' || (token.value !== ';' && token.value !== '\n')) throw unexpected(token)
      this.index += 1
      this.skipNewlines()
    }
    return script
  }

  private skipNewlines(): void {
    while (this.peekOperator() === '\n') this.index += 1
  }

  private peekOperator(): ListOperator | null {
    const token = this.tokens[this.index]
    return token?.type === 'operator' ? token.value : null
  }

  private continuation(): void {
    this.skipNewlines()
    if (this.index >= this.tokens.length) throw danglingOperator()
  }

  private andOr(): AndOr {
    const item: AndOr = { first: this.pipeline(), rest: [] }
    for (;;) {
      const operator = this.peekOperator()
      if (operator !== '&&' && operator !== '||') return item
      this.index += 1
      this.continuation()
      item.rest.push({ operator, pipeline: this.pipeline() })
    }
  }

  private peekWord(text: string): boolean {
    return plainText(wordOf(this.tokens[this.index])) === text
  }

  private pipeline(): Pipeline {
    let negated = false
    while (this.peekWord('!')) {
      this.index += 1
      negated = !negated
    }
    if (this.peekWord('time')) throw new UnsupportedSyntaxError('shellSyntaxTime', 'time')
    const close = this.peekOperator()
    if (negated && (this.index >= this.tokens.length || close === ';' || close === '\n')) return { commands: [], negated }
    const commands = [this.command()]
    for (;;) {
      const operator = this.peekOperator()
      if (operator !== '|' && operator !== '|&') return negated ? { commands, negated } : { commands }
      this.index += 1
      if (operator === '|&') commands[commands.length - 1]?.redirects.push({ fd: 2, mode: 'dup', target: 1 })
      this.continuation()
      if (this.peekWord('!')) throw nearToken('!')
      commands.push(this.command())
    }
  }

  private command(): SimpleCommand {
    const command: SimpleCommand = { assignments: [], words: [], redirects: [] }
    for (;;) {
      const token = this.tokens[this.index]
      if (!token || token.type === 'operator') break
      this.index += 1
      if (token.type === 'redirect') {
        command.redirects.push(...this.redirect(token))
        continue
      }
      if (command.words.length === 0) {
        const assignment = assignmentOf(token.word)
        if (assignment) {
          command.assignments.push(assignment)
          continue
        }
        const reserved = command.assignments.length === 0 ? reservedWord(token.word) : undefined
        if (reserved) throw new UnsupportedSyntaxError(...reserved)
      }
      command.words.push(token.word)
    }
    if (command.words.length + command.assignments.length + command.redirects.length === 0) {
      throw unexpected(this.tokens[this.index])
    }
    return command
  }

  private redirect(token: Extract<Token, { type: 'redirect' }>): Redirect[] {
    const next = this.tokens[this.index]
    if (next?.type !== 'word') throw unexpected(next)
    this.index += 1
    const target = next.word
    const { fd, operator } = token
    if (operator === '<') return [{ fd: fd ?? 0, mode: 'read', target }]
    if (operator === '>>') return [{ fd: fd ?? 1, mode: 'append', target }]
    if (operator === '>' || operator === '>|') return [{ fd: fd ?? 1, mode: 'write', target }]
    if (operator === '>&') {
      const plain = target.parts.length === 1 && target.parts[0]?.type === 'literal' && target.parts[0].quoting === 'none'
      if (plain && /^\d+$/.test(target.text)) return [{ fd: fd ?? 1, mode: 'dup', target: Number(target.text) }]
      if (plain && target.text === '-') return [{ fd: fd ?? 1, mode: 'dup', target: 'close' }]
      if (!plain || (fd !== null && fd !== 1)) return [{ fd: fd ?? 1, mode: 'dup', target }]
    }
    return [
      { fd: 1, mode: operator === '&>>' ? 'append' : 'write', target },
      { fd: 2, mode: 'dup', target: 1 },
    ]
  }
}

const reservedWord = (word: Word): Construct | undefined => {
  const [only, extra] = word.parts
  if (extra || only?.type !== 'literal' || only.quoting !== 'none') return undefined
  return RESERVED_WORDS.get(only.value)
}

export function assignmentOf(word: Word): Assignment | null {
  const [head, ...rest] = word.parts
  if (head?.type !== 'literal' || head.quoting !== 'none') return null
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(head.value)
  if (!match) return null
  const remainder = head.value.slice(match[0].length)
  const parts: Part[] = remainder === '' ? rest : [{ type: 'literal', value: remainder, quoting: 'none' }, ...rest]
  return {
    name: match[1] as string,
    append: match[2] === '+',
    value: { text: word.text.slice(match[0].length), parts },
  }
}

const parseNested = (source: string): Script => {
  try {
    return parse(source)
  } catch (error) {
    if (error instanceof ShellSyntaxError && error.incomplete) throw new ShellSyntaxError(error.message)
    throw error
  }
}

const parseSubstitution = (tokens: Token[]): Script => {
  try {
    return new Parser(tokens).script()
  } catch (error) {
    if (error instanceof ShellSyntaxError && error.incomplete) throw nearToken(')')
    throw error
  }
}

export function tokenize(source: string, strict = false): Token[] {
  return new Lexer(source, strict).lex(null)
}

export function parse(source: string, strict = false): Script {
  return new Parser(tokenize(source, strict)).script()
}

export function isComplete(source: string): boolean {
  try {
    parse(source, true)
    return true
  } catch (error) {
    return !(error instanceof ShellSyntaxError && error.incomplete)
  }
}

type Atom = { char: string } | { part: Part }

const BRACE_SEQUENCE = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/

const isChar = (atom: Atom | undefined, char: string): boolean => atom !== undefined && 'char' in atom && atom.char === char

const toAtoms = (parts: Part[]): Atom[] =>
  parts.flatMap((part): Atom[] =>
    part.type === 'literal' && part.quoting === 'none' ? [...part.value].map((char) => ({ char })) : [{ part }],
  )

const fromAtoms = (atoms: Atom[]): Part[] => {
  const parts: Part[] = []
  for (const atom of atoms) {
    if ('char' in atom) pushLiteral(parts, atom.char, 'none')
    else parts.push(atom.part.type === 'literal' ? { ...atom.part } : atom.part)
  }
  return parts
}

const sequence = (body: Atom[], limit: number): Atom[][] | null => {
  if (!body.every((atom) => 'char' in atom)) return null
  const text = body.map((atom) => ('char' in atom ? atom.char : '')).join('')
  const match = BRACE_SEQUENCE.exec(text)
  if (!match) return null
  const step = Math.abs(Number(match[5] ?? 1)) || 1
  const numeric = match[1] !== undefined
  const from = numeric ? Number(match[1]) : (match[3] as string).charCodeAt(0)
  const to = numeric ? Number(match[2]) : (match[4] as string).charCodeAt(0)
  const count = Math.floor(Math.abs(to - from) / step) + 1
  if (count > limit) throw braceLimit()
  const padded = numeric && [match[1], match[2]].some((value) => /^-?0\d/.test(value as string))
  const width = Math.max((match[1] ?? '').length, (match[2] ?? '').length)
  const format = (value: number): string => {
    if (!numeric) return String.fromCharCode(value)
    if (!padded) return String(value)
    return value < 0 ? `-${String(-value).padStart(width - 1, '0')}` : String(value).padStart(width, '0')
  }
  const direction = to >= from ? 1 : -1
  return Array.from({ length: count }, (_, index) => [...format(from + direction * step * index)].map((char) => ({ char })))
}

interface BracePair {
  close: number
  commas: number[]
}

const MAX_BRACE_DEPTH = 256

const bracePairs = (atoms: readonly Atom[]): Map<number, BracePair> => {
  const pairs = new Map<number, BracePair>()
  const open: Array<{ at: number; commas: number[] }> = []
  atoms.forEach((atom, index) => {
    if (isChar(atom, '{')) open.push({ at: index, commas: [] })
    else if (isChar(atom, ',')) open.at(-1)?.commas.push(index)
    else if (isChar(atom, '}')) {
      const start = open.pop()
      if (start) pairs.set(start.at, { close: index, commas: start.commas })
    }
  })
  return pairs
}

const alternativesOf = (atoms: Atom[], open: number, pair: BracePair, limit: number): Atom[][] | null => {
  if (pair.commas.length === 0) return sequence(atoms.slice(open + 1, pair.close), limit)
  const bounds = [open, ...pair.commas, pair.close]
  return bounds.slice(1).map((end, at) => atoms.slice((bounds[at] as number) + 1, end))
}

const expandAtoms = (atoms: Atom[], limit: number, depth = 0): Atom[][] => {
  if (depth > MAX_BRACE_DEPTH) throw braceLimit()
  const pairs = bracePairs(atoms)
  let words: Atom[][] = [[]]
  let start = 0
  for (let open = 0; open < atoms.length; open += 1) {
    const pair = pairs.get(open)
    const alternatives = pair ? alternativesOf(atoms, open, pair, limit) : null
    if (!pair || !alternatives) continue
    const literal = atoms.slice(start, open)
    const middles = alternatives.flatMap((alternative) => expandAtoms(alternative, limit, depth + 1))
    const next: Atom[][] = []
    for (const word of words) {
      for (const middle of middles) {
        next.push([...word, ...literal, ...middle])
        if (next.length > limit) throw braceLimit()
      }
    }
    words = next
    start = pair.close + 1
    open = pair.close
  }
  const tail = atoms.slice(start)
  return words.map((word) => [...word, ...tail])
}

export function expandBraces(word: Word, limit = 10_000): Word[] {
  const hasBrace = word.parts.some((part) => part.type === 'literal' && part.quoting === 'none' && part.value.includes('{'))
  if (!hasBrace) return [word]
  return expandAtoms(toAtoms(word.parts), limit).map((atoms) => ({ text: word.text, parts: fromAtoms(atoms) }))
}

export interface PatternChar {
  char: string
  active: boolean
}

type PatternToken = { star: true } | { star: false; matches(char: string): boolean }

const STAR: PatternToken = { star: true }
const ANY: PatternToken = { star: false, matches: () => true }

const escapeClassChar = (char: string): string => (/[\\^$.*+?()[\]{}|/-]/.test(char) ? `\\${char}` : char)

const bracketToken = (chars: readonly PatternChar[], open: number): { token: PatternToken; end: number } | null => {
  let index = open + 1
  let negate = false
  const first = chars[index]
  if (first?.active && (first.char === '!' || first.char === '^')) {
    negate = true
    index += 1
  }
  let body = ''
  for (let start = index; index < chars.length; index += 1) {
    const current = chars[index] as PatternChar
    if (current.char === ']' && current.active && index > start) {
      try {
        const test = new RegExp(`^[${negate ? '^' : ''}${body}]$`, 'u')
        return { token: { star: false, matches: (char) => test.test(char) }, end: index }
      } catch {
        return null
      }
    }
    if (current.char === '[' && current.active && chars[index + 1]?.char === ':') {
      const rest = chars
        .slice(index + 2)
        .map((entry) => entry.char)
        .join('')
      const named = /^([a-z]+):\]/.exec(rest)
      const range = named && Object.hasOwn(POSIX_CLASSES, named[1] as string) ? POSIX_CLASSES[named[1] as string] : undefined
      if (named && range) {
        body += range
        index += (named[0] as string).length + 1
        continue
      }
    }
    const isRange = current.char === '-' && current.active && body !== '' && chars[index + 1]?.char !== ']'
    body += isRange ? '-' : escapeClassChar(current.char)
  }
  return null
}

const matchTokens = (tokens: readonly PatternToken[], text: readonly string[]): boolean => {
  let at = 0
  let position = 0
  let star = -1
  let resume = 0
  while (position < text.length) {
    const token = tokens[at]
    if (token && !token.star && token.matches(text[position] as string)) {
      at += 1
      position += 1
    } else if (token?.star) {
      star = at
      at += 1
      resume = position
    } else if (star !== -1) {
      at = star + 1
      resume += 1
      position = resume
    } else return false
  }
  while (tokens[at]?.star) at += 1
  return at === tokens.length
}

const compileTokens = (chars: readonly PatternChar[]): PatternToken[] => {
  const tokens: PatternToken[] = []
  for (let index = 0; index < chars.length; index += 1) {
    const { char, active } = chars[index] as PatternChar
    if (active && char === '*') {
      if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR)
      continue
    }
    if (active && char === '?') {
      tokens.push(ANY)
      continue
    }
    const bracket = active && char === '[' ? bracketToken(chars, index) : null
    if (bracket) {
      tokens.push(bracket.token)
      index = bracket.end
      continue
    }
    tokens.push({ star: false, matches: (candidate) => candidate === char })
  }
  return tokens
}

export function compilePattern(chars: readonly PatternChar[]): (text: readonly string[]) => boolean {
  const tokens = compileTokens(chars)
  return (text) => matchTokens(tokens, text)
}

type Segment = ReadonlyArray<(char: string) => boolean>

const segmentsOf = (tokens: readonly PatternToken[]): Segment[] => {
  const segments: Array<Array<(char: string) => boolean>> = [[]]
  for (const token of tokens) {
    if (token.star) segments.push([])
    else segments[segments.length - 1]?.push(token.matches)
  }
  return segments
}

const segmentAt = (segment: Segment, text: readonly string[], at: number): boolean => {
  if (at < 0 || at + segment.length > text.length) return false
  return segment.every((matches, offset) => matches(text[at + offset] as string))
}

const firstAt = (segment: Segment, text: readonly string[], from: number, end: number): number => {
  for (let at = from; at + segment.length <= end; at += 1) if (segmentAt(segment, text, at)) return at
  return -1
}

const lastAt = (segment: Segment, text: readonly string[], end: number, from: number): number => {
  for (let at = end - segment.length; at >= from; at -= 1) if (segmentAt(segment, text, at)) return at
  return -1
}

const prefixEnd = (segments: readonly Segment[], text: readonly string[], longest: boolean): number => {
  const first = segments[0] as Segment
  if (!segmentAt(first, text, 0)) return -1
  if (segments.length === 1) return first.length
  let position = first.length
  for (const segment of segments.slice(1, -1)) {
    const at = firstAt(segment, text, position, text.length)
    if (at === -1) return -1
    position = at + segment.length
  }
  const last = segments[segments.length - 1] as Segment
  const at = longest ? lastAt(last, text, text.length, position) : firstAt(last, text, position, text.length)
  return at === -1 ? -1 : at + last.length
}

const suffixStart = (segments: readonly Segment[], text: readonly string[], longest: boolean): number => {
  const last = segments[segments.length - 1] as Segment
  const tail = text.length - last.length
  if (!segmentAt(last, text, tail)) return -1
  if (segments.length === 1) return tail
  let position = tail
  for (const segment of segments.slice(1, -1).reverse()) {
    const at = lastAt(segment, text, position, 0)
    if (at === -1) return -1
    position = at
  }
  const first = segments[0] as Segment
  return longest ? firstAt(first, text, 0, position) : lastAt(first, text, position, 0)
}

export type AffixOperator = '#' | '##' | '%' | '%%'

export function removeAffix(value: string, chars: readonly PatternChar[], operator: AffixOperator): string {
  const text = [...value]
  const segments = segmentsOf(compileTokens(chars))
  if (operator.startsWith('#')) {
    const end = prefixEnd(segments, text, operator === '##')
    return end === -1 ? value : text.slice(end).join('')
  }
  const start = suffixStart(segments, text, operator === '%%')
  return start === -1 ? value : text.slice(0, start).join('')
}

export function hasGlob(chars: readonly PatternChar[]): boolean {
  return chars.some(({ char, active }) => active && (char === '*' || char === '?' || char === '['))
}
