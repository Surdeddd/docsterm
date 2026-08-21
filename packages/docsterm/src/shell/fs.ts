export type FileTree = { [name: string]: string | FileTree }

export function normalizePath(path: string): string {
  const absolute = path.startsWith('/') ? path : `/${path}`
  const parts: string[] = []
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `/${parts.join('/')}`.replace(/\/$/, '') || '/'
}

export function dirnameOf(path: string): string {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

export function basenameOf(path: string): string {
  const normalized = normalizePath(path)
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1)
}

export class ShellFileSystem {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>(['/'])

  constructor(tree: FileTree = {}) {
    this.seed('/', tree)
  }

  private seed(base: string, tree: FileTree): void {
    for (const [name, value] of Object.entries(tree)) {
      const path = normalizePath(`${base}/${name}`)
      if (typeof value === 'string') {
        this.mkdir(dirnameOf(path), true)
        this.files.set(path, value)
      } else {
        this.mkdir(path, true)
        this.seed(path, value)
      }
    }
  }

  resolve(cwd: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path)
    return normalizePath(`${cwd}/${path}`)
  }

  exists(path: string): boolean {
    const target = normalizePath(path)
    return this.files.has(target) || this.dirs.has(target)
  }

  isDir(path: string): boolean {
    return this.dirs.has(normalizePath(path))
  }

  isFile(path: string): boolean {
    return this.files.has(normalizePath(path))
  }

  read(path: string): string | null {
    return this.files.get(normalizePath(path)) ?? null
  }

  write(path: string, content: string): void {
    const target = normalizePath(path)
    this.files.set(target, content)
  }

  append(path: string, content: string): void {
    const target = normalizePath(path)
    this.files.set(target, (this.files.get(target) ?? '') + content)
  }

  mkdir(path: string, recursive = false): void {
    const target = normalizePath(path)
    if (target === '/') return
    const parent = dirnameOf(target)
    if (!this.dirs.has(parent)) {
      if (!recursive) throw new Error(`no such file or directory: ${parent}`)
      this.mkdir(parent, true)
    }
    this.dirs.add(target)
  }

  remove(path: string, recursive = false): void {
    const target = normalizePath(path)
    if (this.files.delete(target)) return
    if (!this.dirs.has(target)) throw new Error(`no such file or directory: ${target}`)
    const children = this.list(target) ?? []
    if (children.length > 0 && !recursive) throw new Error(`directory not empty: ${target}`)
    for (const child of children) this.remove(`${target}/${child}`, true)
    this.dirs.delete(target)
  }

  list(path: string): string[] | null {
    const target = normalizePath(path)
    if (!this.dirs.has(target)) return null
    const prefix = target === '/' ? '/' : `${target}/`
    const names = new Set<string>()
    for (const candidate of [...this.files.keys(), ...this.dirs]) {
      if (candidate === target || !candidate.startsWith(prefix)) continue
      const rest = candidate.slice(prefix.length)
      const name = rest.split('/')[0]
      if (name) names.add(name)
    }
    return [...names].sort()
  }

  entries(): string[] {
    return [...this.files.keys(), ...this.dirs].sort()
  }
}
