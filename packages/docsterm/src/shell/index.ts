import type { Backend, BackendHost, BackendRunResult } from '../types.js'
import { builtins, type CommandContext, type CommandResult, type ShellCommand } from './builtins.js'
import { ShellFileSystem, type FileTree } from './fs.js'
import { parse, type ParsedCommand, type Word } from './parse.js'

export { ShellFileSystem, normalizePath, basenameOf, dirnameOf } from './fs.js'
export type { FileTree } from './fs.js'
export type { CommandContext, CommandResult, ShellCommand } from './builtins.js'

export interface ShellBackendOptions {
  files?: FileTree
  cwd?: string
  env?: Record<string, string>
  commands?: Record<string, ShellCommand>
  prompt?: string | ((cwd: string) => string)
  banner?: string
}

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')}$`,
  )

const asResult = (value: CommandResult | string): CommandResult =>
  typeof value === 'string' ? { stdout: value } : value

export function createShellBackend(options: ShellBackendOptions = {}): Backend {
  const fs = new ShellFileSystem(options.files ?? {})
  const env: Record<string, string> = { HOME: '/', SHELL: 'docsterm', ...options.env }
  let cwd = options.cwd ?? '/'
  if (!fs.isDir(cwd)) fs.mkdir(cwd, true)
  const commands: Record<string, ShellCommand> = { ...builtins, ...options.commands }

  const expand = (word: Word): string[] => {
    if (word.quoted) return [word.value]
    let value = word.value
    if (value.startsWith('~')) value = `${env.HOME ?? '/'}${value.slice(1)}`
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) =>
      env[(a ?? b) as string] ?? '',
    )
    if (!/[*?]/.test(value)) return [value]
    const absolute = fs.resolve(cwd, value)
    const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/'
    const pattern = absolute.slice(absolute.lastIndexOf('/') + 1)
    const entries = fs.list(parent)
    if (!entries) return [value]
    const matcher = globToRegExp(pattern)
    const matches = entries.filter((name) => matcher.test(name))
    if (matches.length === 0) return [value]
    const prefix = value.includes('/') ? value.slice(0, value.lastIndexOf('/') + 1) : ''
    return matches.map((name) => `${prefix}${name}`)
  }

  const runCommand = async (parsed: ParsedCommand, stdin: string): Promise<CommandResult> => {
    const argv = parsed.words.flatMap(expand)
    let input = stdin
    for (const redirect of parsed.redirects) {
      if (redirect.type !== 'read') continue
      const content = fs.read(fs.resolve(cwd, redirect.target))
      if (content === null) {
        return { stderr: `${redirect.target}: no such file or directory\n`, exitCode: 1 }
      }
      input = content
    }

    const name = argv[0]
    if (!name) return { exitCode: 0 }
    const handler = commands[name]
    if (!handler) return { stderr: `${name}: command not found\n`, exitCode: 127 }

    const context: CommandContext = {
      argv,
      stdin: input,
      cwd,
      env,
      fs,
      setCwd: (path) => {
        cwd = path
      },
    }

    let result: CommandResult
    try {
      result = asResult(await handler(context))
    } catch (error) {
      return { stderr: `${name}: ${(error as Error).message}\n`, exitCode: 1 }
    }

    let stdout = result.stdout ?? ''
    for (const redirect of parsed.redirects) {
      if (redirect.type === 'read') continue
      const target = fs.resolve(cwd, redirect.target)
      if (redirect.type === 'write') fs.write(target, stdout)
      else fs.append(target, stdout)
      stdout = ''
    }
    return { ...result, stdout }
  }

  const runLine = async (line: string): Promise<BackendRunResult> => {
    let segments
    try {
      segments = parse(line)
    } catch (error) {
      return { output: `syntax error: ${(error as Error).message}`, exitCode: 2 }
    }

    const output: string[] = []
    let exitCode = 0
    for (const segment of segments) {
      if (segment.operator === 'and' && exitCode !== 0) continue
      if (segment.operator === 'or' && exitCode === 0) continue
      let piped = ''
      for (const [index, parsed] of segment.pipeline.commands.entries()) {
        const isLast = index === segment.pipeline.commands.length - 1
        const result = await runCommand(parsed, piped)
        exitCode = result.exitCode ?? 0
        if (result.stderr) output.push(result.stderr)
        if (isLast) {
          if (result.stdout) output.push(result.stdout)
        } else {
          piped = result.stdout ?? ''
        }
      }
    }
    return { output: output.join('').replace(/\n$/, ''), exitCode }
  }

  return {
    id: 'shell',
    get prompt() {
      const prompt = options.prompt ?? ((path: string) => `${path} $ `)
      return typeof prompt === 'function' ? prompt(cwd) : prompt
    },
    async init(host: BackendHost): Promise<void> {
      if (options.banner) host.write(`${options.banner}\n`)
    },
    run: runLine,
    dispose(): void {},
  }
}
