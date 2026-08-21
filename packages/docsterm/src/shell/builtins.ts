import type { ShellFileSystem } from './fs.js'
import { basenameOf } from './fs.js'

export interface CommandContext {
  argv: string[]
  stdin: string
  cwd: string
  env: Record<string, string>
  fs: ShellFileSystem
  setCwd(path: string): void
  write?: (text: string) => void
  signal?: AbortSignal
}

export interface CommandResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export type ShellCommand = (
  ctx: CommandContext,
) => CommandResult | string | Promise<CommandResult | string>

const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

const withNewline = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`)

const flagsOf = (argv: string[]): { flags: Set<string>; operands: string[]; values: Map<string, string> } => {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const operands: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token.startsWith('-') && token.length > 1) {
      if (token === '-n' || token === '-c') {
        const next = argv[index + 1]
        if (next && /^\d+$/.test(next)) {
          values.set(token, next)
          index += 1
          continue
        }
      }
      if (token.startsWith('--')) flags.add(token.slice(2))
      else for (const letter of token.slice(1)) flags.add(letter)
      continue
    }
    operands.push(token)
  }
  return { flags, operands, values }
}

const readInputs = (ctx: CommandContext, operands: string[]): { text: string; errors: string[] } => {
  if (operands.length === 0) return { text: ctx.stdin, errors: [] }
  const chunks: string[] = []
  const errors: string[] = []
  for (const operand of operands) {
    const path = ctx.fs.resolve(ctx.cwd, operand)
    if (ctx.fs.isDir(path)) {
      errors.push(`${operand}: is a directory`)
      continue
    }
    const content = ctx.fs.read(path)
    if (content === null) errors.push(`${operand}: no such file or directory`)
    else chunks.push(content)
  }
  return { text: chunks.join(''), errors }
}

export const builtins: Record<string, ShellCommand> = {
  pwd: (ctx) => `${ctx.cwd}\n`,

  cd: (ctx) => {
    const target = ctx.argv[1] ?? ctx.env.HOME ?? '/'
    const path = ctx.fs.resolve(ctx.cwd, target)
    if (!ctx.fs.exists(path)) return { stderr: `cd: ${target}: no such file or directory\n`, exitCode: 1 }
    if (!ctx.fs.isDir(path)) return { stderr: `cd: ${target}: not a directory\n`, exitCode: 1 }
    ctx.setCwd(path)
    return {}
  },

  ls: (ctx) => {
    const { flags, operands } = flagsOf(ctx.argv)
    const target = ctx.fs.resolve(ctx.cwd, operands[0] ?? '.')
    if (ctx.fs.isFile(target)) return `${operands[0] ?? target}\n`
    const entries = ctx.fs.list(target)
    if (entries === null) {
      return { stderr: `ls: ${operands[0] ?? target}: no such file or directory\n`, exitCode: 1 }
    }
    const visible = flags.has('a') ? entries : entries.filter((name) => !name.startsWith('.'))
    if (!flags.has('l')) return visible.length === 0 ? '' : `${visible.join('  ')}\n`
    const rows = visible.map((name) => {
      const path = `${target === '/' ? '' : target}/${name}`
      const isDir = ctx.fs.isDir(path)
      const size = isDir ? 0 : (ctx.fs.read(path) ?? '').length
      return `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} ${String(size).padStart(6)} ${name}`
    })
    return rows.length === 0 ? '' : `${rows.join('\n')}\n`
  },

  cat: (ctx) => {
    const { operands } = flagsOf(ctx.argv)
    const { text, errors } = readInputs(ctx, operands)
    return {
      stdout: text,
      stderr: errors.map((message) => `cat: ${message}\n`).join(''),
      exitCode: errors.length > 0 ? 1 : 0,
    }
  },

  echo: (ctx) => {
    const { flags, operands } = flagsOf(ctx.argv)
    const text = operands.join(' ')
    return flags.has('n') ? text : `${text}\n`
  },

  touch: (ctx) => {
    const { operands } = flagsOf(ctx.argv)
    for (const operand of operands) {
      const path = ctx.fs.resolve(ctx.cwd, operand)
      if (!ctx.fs.exists(path)) ctx.fs.write(path, '')
    }
    return {}
  },

  mkdir: (ctx) => {
    const { flags, operands } = flagsOf(ctx.argv)
    for (const operand of operands) {
      try {
        ctx.fs.mkdir(ctx.fs.resolve(ctx.cwd, operand), flags.has('p'))
      } catch (error) {
        return { stderr: `mkdir: ${(error as Error).message}\n`, exitCode: 1 }
      }
    }
    return {}
  },

  rm: (ctx) => {
    const { flags, operands } = flagsOf(ctx.argv)
    for (const operand of operands) {
      const path = ctx.fs.resolve(ctx.cwd, operand)
      if (!ctx.fs.exists(path)) {
        if (flags.has('f')) continue
        return { stderr: `rm: ${operand}: no such file or directory\n`, exitCode: 1 }
      }
      if (ctx.fs.isDir(path) && !(flags.has('r') || flags.has('R'))) {
        return { stderr: `rm: ${operand}: is a directory\n`, exitCode: 1 }
      }
      ctx.fs.remove(path, flags.has('r') || flags.has('R'))
    }
    return {}
  },

  cp: (ctx) => {
    const { operands } = flagsOf(ctx.argv)
    const [from, to] = operands
    if (!from || !to) return { stderr: 'cp: missing operand\n', exitCode: 1 }
    const source = ctx.fs.resolve(ctx.cwd, from)
    const content = ctx.fs.read(source)
    if (content === null) return { stderr: `cp: ${from}: no such file or directory\n`, exitCode: 1 }
    const destination = ctx.fs.resolve(ctx.cwd, to)
    const target = ctx.fs.isDir(destination) ? `${destination}/${basenameOf(source)}` : destination
    ctx.fs.write(target, content)
    return {}
  },

  mv: (ctx) => {
    const { operands } = flagsOf(ctx.argv)
    const [from, to] = operands
    if (!from || !to) return { stderr: 'mv: missing operand\n', exitCode: 1 }
    const source = ctx.fs.resolve(ctx.cwd, from)
    const content = ctx.fs.read(source)
    if (content === null) return { stderr: `mv: ${from}: no such file or directory\n`, exitCode: 1 }
    const destination = ctx.fs.resolve(ctx.cwd, to)
    const target = ctx.fs.isDir(destination) ? `${destination}/${basenameOf(source)}` : destination
    ctx.fs.write(target, content)
    ctx.fs.remove(source)
    return {}
  },

  head: (ctx) => {
    const { operands, values } = flagsOf(ctx.argv)
    const count = Number(values.get('-n') ?? 10)
    const { text, errors } = readInputs(ctx, operands)
    return {
      stdout: withNewline(lines(text).slice(0, count).join('\n')),
      stderr: errors.map((message) => `head: ${message}\n`).join(''),
      exitCode: errors.length > 0 ? 1 : 0,
    }
  },

  tail: (ctx) => {
    const { operands, values } = flagsOf(ctx.argv)
    const count = Number(values.get('-n') ?? 10)
    const { text, errors } = readInputs(ctx, operands)
    return {
      stdout: withNewline(lines(text).slice(-count).join('\n')),
      stderr: errors.map((message) => `tail: ${message}\n`).join(''),
      exitCode: errors.length > 0 ? 1 : 0,
    }
  },

  wc: (ctx) => {
    const { flags, operands } = flagsOf(ctx.argv)
    const { text, errors } = readInputs(ctx, operands)
    const lineCount = lines(text).length
    const wordCount = text.split(/\s+/).filter(Boolean).length
    const charCount = text.length
    const parts: number[] = []
    if (flags.has('l')) parts.push(lineCount)
    if (flags.has('w')) parts.push(wordCount)
    if (flags.has('c')) parts.push(charCount)
    const numbers = parts.length > 0 ? parts : [lineCount, wordCount, charCount]
    return {
      stdout: `${numbers.map((value) => String(value).padStart(4)).join(' ')}\n`,
      stderr: errors.map((message) => `wc: ${message}\n`).join(''),
      exitCode: errors.length > 0 ? 1 : 0,
    }
  },

  grep: (ctx) => {
    const { flags, operands } = flagsOf(ctx.argv)
    const [pattern, ...files] = operands
    if (pattern === undefined) return { stderr: 'grep: missing pattern\n', exitCode: 2 }
    const { text, errors } = readInputs(ctx, files)
    let regex: RegExp
    try {
      regex = new RegExp(pattern, flags.has('i') ? 'i' : '')
    } catch {
      return { stderr: `grep: invalid pattern: ${pattern}\n`, exitCode: 2 }
    }
    const matched = lines(text)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => (flags.has('v') ? !regex.test(line) : regex.test(line)))
      .map(({ line, index }) => (flags.has('n') ? `${index + 1}:${line}` : line))
    return {
      stdout: withNewline(matched.join('\n')),
      stderr: errors.map((message) => `grep: ${message}\n`).join(''),
      exitCode: matched.length > 0 ? 0 : 1,
    }
  },

  sort: (ctx) => {
    const { flags, operands } = flagsOf(ctx.argv)
    const { text } = readInputs(ctx, operands)
    const sorted = lines(text).sort((a, b) => a.localeCompare(b))
    if (flags.has('r')) sorted.reverse()
    return withNewline(sorted.join('\n'))
  },

  uniq: (ctx) => {
    const { operands } = flagsOf(ctx.argv)
    const { text } = readInputs(ctx, operands)
    const result = lines(text).filter((line, index, all) => index === 0 || line !== all[index - 1])
    return withNewline(result.join('\n'))
  },

  find: (ctx) => {
    const { operands, flags } = flagsOf(ctx.argv)
    const nameIndex = ctx.argv.indexOf('-name')
    const pattern = nameIndex === -1 ? null : ctx.argv[nameIndex + 1]
    const base = ctx.fs.resolve(ctx.cwd, operands[0] ?? '.')
    const matcher = pattern
      ? new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
      : null
    const results = ctx.fs
      .entries()
      .filter((path) => path === base || path.startsWith(base === '/' ? '/' : `${base}/`))
      .filter((path) => (matcher ? matcher.test(basenameOf(path)) : true))
      .filter((path) => (flags.has('f') ? ctx.fs.isFile(path) : true))
    return withNewline(results.join('\n'))
  },

  env: (ctx) =>
    withNewline(
      Object.entries(ctx.env)
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n'),
    ),

  export: (ctx) => {
    for (const assignment of ctx.argv.slice(1)) {
      const index = assignment.indexOf('=')
      if (index === -1) continue
      ctx.env[assignment.slice(0, index)] = assignment.slice(index + 1)
    }
    return {}
  },

  which: (ctx) => {
    const name = ctx.argv[1]
    if (!name) return { stderr: 'which: missing operand\n', exitCode: 1 }
    return { stdout: `${name}\n` }
  },

  sleep: async (ctx) => {
    const seconds = Number(ctx.argv[1] ?? 0)
    await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 5) * 1000))
    return {}
  },

  true: () => ({ exitCode: 0 }),
  false: () => ({ exitCode: 1 }),
}
