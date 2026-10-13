import type { CompletionReply } from '../types.js'
import type { ShellFileSystem } from './fs.js'

export interface CompletionContext {
  line: string
  cursor: number
  cwd: string
  fs: ShellFileSystem
  commands: readonly string[]
  lineCommands?: readonly string[]
  env?: Readonly<Record<string, string>>
}

type Quote = '' | "'" | '"'

interface WordScan {
  from: number
  value: string
  quote: Quote
  tilde: boolean
  command: boolean
  comment: boolean
  words: string[]
}

const OPERATORS = ['&>>', '&>', '&&', '||', ';;', '|&', '>>', '>&', '>|', '<<<', '<<', '<&', '<>', ';', '|', '&', '(', ')', '>', '<']
const REDIRECTS = new Set(['&>>', '&>', '>>', '>&', '>|', '<<<', '<<', '<&', '<>', '>', '<'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SPECIAL = new Set(' \t\n\\\'"`$*?[]{}()<>|&;!#')

function scanWord(line: string, cursor: number): WordScan {
  const text = line.slice(0, cursor)
  let words: string[] = []
  let command = true
  let redirect = false
  let quote: Quote = ''
  let word: { from: number; value: string } | null = null

  const finish = (): void => {
    if (!word) return
    const prefix = command && (ASSIGNMENT.test(word.value) || word.value === '!')
    if (redirect) {
      redirect = false
    } else if (!prefix) {
      words.push(word.value)
      command = false
    }
    word = null
  }

  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (quote === "'" && word) {
      if (char === "'") quote = ''
      else word.value += char
      index += 1
      continue
    }
    if (quote === '"' && word) {
      const next = text[index + 1]
      if (char === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        word.value += next
        index += 2
        continue
      }
      if (char === '"') quote = ''
      else word.value += char
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      finish()
      index += 1
      continue
    }
    if (char === '#' && !word) {
      return { from: cursor, value: '', quote: '', tilde: false, command: false, comment: true, words }
    }
    if (!word && /[0-9]/.test(char)) {
      const descriptor = /^\d+(?=[<>])/.exec(text.slice(index))
      if (descriptor) {
        index += descriptor[0].length
        continue
      }
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index))
    if (operator) {
      finish()
      if (REDIRECTS.has(operator)) {
        redirect = true
      } else {
        words = []
        command = true
        redirect = false
      }
      index += operator.length
      continue
    }
    if (!word) word = { from: index, value: '' }
    if (char === '\\') {
      const next = text[index + 1]
      if (next !== undefined) word.value += next
      index += next === undefined ? 1 : 2
      continue
    }
    if (char === "'" || char === '"') quote = char
    else word.value += char
    index += 1
  }

  const current = word as { from: number; value: string } | null
  const from = current?.from ?? cursor
  return {
    from,
    value: current?.value ?? '',
    quote,
    tilde: line[from] === '~',
    command: command && !redirect,
    comment: false,
    words,
  }
}

export function currentWord(line: string, cursor: number): { word: string; from: number } {
  const { from } = scanWord(line, cursor)
  return { word: line.slice(from, cursor), from }
}

export function isFirstWord(line: string, from: number): boolean {
  return scanWord(line, from).command
}

const escapeBare = (value: string, keepTilde: boolean): string =>
  [...value].map((char, index) => (SPECIAL.has(char) || (char === '~' && index === 0 && !keepTilde) ? `\\${char}` : char)).join('')

const render = (value: string, scan: WordScan, isDir: boolean): string => {
  if (scan.quote === '"') return `"${value.replace(/["\\$`]/g, '\\$&')}${isDir ? '' : '"'}`
  if (scan.quote === "'" && !value.includes("'")) return `'${value}${isDir ? '' : "'"}`
  return escapeBare(value, scan.tilde && scan.quote === '')
}

const joinPath = (base: string, name: string): string => (base === '/' ? `/${name}` : `${base}/${name}`)

const commandCandidates = (context: CompletionContext, scan: WordScan): string[] => {
  const whole = context.line.slice(0, scan.from).trim() === '' && context.line.slice(context.cursor).trim() === ''
  return [...new Set(whole ? [...context.commands, ...(context.lineCommands ?? [])] : context.commands)]
    .filter((name) => name.startsWith(scan.value))
    .map((name) => render(name, scan, false))
}

const pathCandidates = (context: CompletionContext, scan: WordScan): string[] => {
  const home = context.env?.HOME
  const expand = scan.tilde && scan.quote === '' && home !== undefined && (scan.value === '~' || scan.value.startsWith('~/'))
  if (expand && scan.value === '~') return context.fs.isDir(home) ? [render('~/', scan, true)] : []
  const lookup = expand ? `${home}${scan.value.slice(1)}` : scan.value
  const slash = lookup.lastIndexOf('/')
  const namePart = lookup.slice(slash + 1)
  const directory = context.fs.resolve(context.cwd, slash === -1 ? '.' : lookup.slice(0, slash + 1))
  const entries = context.fs.list(directory)
  if (!entries) return []
  const typedDirectory = scan.value.slice(0, scan.value.length - namePart.length)
  const names = namePart.startsWith('.') ? ['.', '..', ...entries] : entries.filter((name) => !name.startsWith('.'))
  const directoriesOnly = scan.words[0] === 'cd'
  return names
    .filter((name) => name.startsWith(namePart))
    .map((name) => ({ name, isDir: name === '.' || name === '..' || context.fs.isDir(joinPath(directory, name)) }))
    .filter((entry) => !directoriesOnly || entry.isDir)
    .map((entry) => render(`${typedDirectory}${entry.name}${entry.isDir ? '/' : ''}`, scan, entry.isDir))
}

export function completeShell(context: CompletionContext): CompletionReply | null {
  const scan = scanWord(context.line, context.cursor)
  if (scan.comment) return null
  const candidates = (
    scan.command && !scan.value.includes('/') ? commandCandidates(context, scan) : pathCandidates(context, scan)
  ).sort()
  return candidates.length > 0 ? { from: scan.from, to: context.cursor, candidates } : null
}
