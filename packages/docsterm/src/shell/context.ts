import type { InteractiveRun, Locale } from '../types.js'
import type { ShellFileSystem } from './fs.js'

export interface CommandContext {
  argv: string[]
  stdin: string
  cwd: string
  env: Record<string, string>
  fs: ShellFileSystem
  setCwd(path: string): void
  write?: (text: string) => void
  writeError?: (text: string) => void
  signal?: AbortSignal
  isTTY?: boolean
  colors?: boolean
  columns?: number
  commands?: readonly string[]
  lastStatus?: number
  locale?: Locale
}

export interface CommandResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export type ShellCommandOutcome = CommandResult | string | InteractiveRun

export type ShellCommand = (ctx: CommandContext) => ShellCommandOutcome | Promise<ShellCommandOutcome>
