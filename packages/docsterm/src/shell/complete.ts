import type { CompletionReply } from '../types.js'
import { ShellFileSystem } from './fs.js'

export interface CompletionContext {
  line: string
  cursor: number
  cwd: string
  fs: ShellFileSystem
  commands: string[]
}

export function currentWord(line: string, cursor: number): { word: string; from: number } {
  const head = line.slice(0, cursor)
  const match = /(\S*)$/.exec(head)
  const word = match?.[1] ?? ''
  return { word, from: cursor - word.length }
}

export function isFirstWord(line: string, from: number): boolean {
  const before = line.slice(0, from)
  return /(^|[|;&]\s*)$/.test(before)
}

export function completeShell(context: CompletionContext): CompletionReply | null {
  const { word, from } = currentWord(context.line, context.cursor)

  if (isFirstWord(context.line, from)) {
    const candidates = context.commands.filter((name) => name.startsWith(word)).sort()
    return candidates.length > 0 ? { from, to: context.cursor, candidates } : null
  }

  const slash = word.lastIndexOf('/')
  const dirPart = slash === -1 ? '' : word.slice(0, slash + 1)
  const namePart = slash === -1 ? word : word.slice(slash + 1)
  const directory = context.fs.resolve(context.cwd, dirPart === '' ? '.' : dirPart)
  const entries = context.fs.list(directory)
  if (!entries) return null

  const candidates = entries
    .filter((name) => name.startsWith(namePart))
    .map((name) => {
      const full = `${directory === '/' ? '' : directory}/${name}`
      return `${dirPart}${name}${context.fs.isDir(full) ? '/' : ''}`
    })
    .sort()

  return candidates.length > 0 ? { from, to: context.cursor, candidates } : null
}
