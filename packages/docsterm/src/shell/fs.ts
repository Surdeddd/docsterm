export type FileTree = { [name: string]: string | FileTree }

export type FsErrorCode = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY' | 'EINVAL'

const DESCRIPTIONS: Record<FsErrorCode, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
}

export class FsError extends Error {
  readonly code: FsErrorCode
  readonly path: string

  constructor(code: FsErrorCode, path: string) {
    super(DESCRIPTIONS[code])
    this.name = 'FsError'
    this.code = code
    this.path = path
  }
}

export const DEV_NULL = '/dev/null'

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

const isWithin = (path: string, ancestor: string): boolean =>
  ancestor === '/' ? path.startsWith('/') : path === ancestor || path.startsWith(`${ancestor}/`)

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
    return target === DEV_NULL || this.files.has(target) || this.dirs.has(target)
  }

  isDir(path: string): boolean {
    return this.dirs.has(normalizePath(path))
  }

  isFile(path: string): boolean {
    const target = normalizePath(path)
    return target === DEV_NULL || this.files.has(target)
  }

  read(path: string): string | null {
    const target = normalizePath(path)
    if (target === DEV_NULL) return ''
    return this.files.get(target) ?? null
  }

  private assertWritable(target: string): void {
    if (this.dirs.has(target)) throw new FsError('EISDIR', target)
    const parent = dirnameOf(target)
    if (this.files.has(parent)) throw new FsError('ENOTDIR', target)
    if (!this.dirs.has(parent)) {
      let ancestor = dirnameOf(parent)
      while (ancestor !== '/' && !this.dirs.has(ancestor) && !this.files.has(ancestor)) {
        ancestor = dirnameOf(ancestor)
      }
      throw new FsError(this.files.has(ancestor) ? 'ENOTDIR' : 'ENOENT', target)
    }
  }

  write(path: string, content: string): void {
    const target = normalizePath(path)
    if (target === DEV_NULL) return
    this.assertWritable(target)
    this.files.set(target, content)
  }

  append(path: string, content: string): void {
    const target = normalizePath(path)
    if (target === DEV_NULL) return
    this.assertWritable(target)
    this.files.set(target, (this.files.get(target) ?? '') + content)
  }

  mkdir(path: string, recursive = false): void {
    const target = normalizePath(path)
    if (target === '/') {
      if (!recursive) throw new FsError('EEXIST', target)
      return
    }
    if (this.files.has(target) || target === DEV_NULL) throw new FsError('EEXIST', target)
    if (this.dirs.has(target)) {
      if (recursive) return
      throw new FsError('EEXIST', target)
    }
    const parent = dirnameOf(target)
    if (this.files.has(parent)) throw new FsError('ENOTDIR', target)
    if (!this.dirs.has(parent)) {
      if (!recursive) throw new FsError('ENOENT', target)
      this.mkdir(parent, true)
    }
    this.dirs.add(target)
  }

  remove(path: string, recursive = false): void {
    const target = normalizePath(path)
    if (target === '/') throw new FsError('EINVAL', target)
    if (this.files.delete(target)) return
    if (!this.dirs.has(target)) throw new FsError('ENOENT', target)
    const children = this.list(target) ?? []
    if (children.length > 0 && !recursive) throw new FsError('ENOTEMPTY', target)
    const doomedFiles = Array.from(this.files.keys()).filter((candidate) => isWithin(candidate, target))
    const doomedDirs = Array.from(this.dirs).filter((candidate) => isWithin(candidate, target))
    for (const candidate of doomedFiles) this.files.delete(candidate)
    for (const candidate of doomedDirs) this.dirs.delete(candidate)
  }

  rename(from: string, to: string): void {
    const source = normalizePath(from)
    const destination = normalizePath(to)
    if (source === '/' || destination === '/') throw new FsError('EINVAL', source)
    if (!this.exists(source) || source === DEV_NULL) throw new FsError('ENOENT', source)
    if (source === destination) return
    if (this.dirs.has(source)) {
      if (isWithin(destination, source)) throw new FsError('EINVAL', destination)
      if (this.files.has(destination)) throw new FsError('ENOTDIR', destination)
      if (this.dirs.has(destination) && (this.list(destination) ?? []).length > 0) {
        throw new FsError('ENOTEMPTY', destination)
      }
      this.assertParentDirectory(destination)
      const moved: Array<[string, string]> = []
      for (const [path, content] of this.files) {
        if (isWithin(path, source)) moved.push([path, content])
      }
      const movedDirs = [...this.dirs].filter((path) => isWithin(path, source))
      for (const [path] of moved) this.files.delete(path)
      for (const path of movedDirs) this.dirs.delete(path)
      for (const path of movedDirs) this.dirs.add(destination + path.slice(source.length))
      for (const [path, content] of moved) this.files.set(destination + path.slice(source.length), content)
      return
    }
    if (this.dirs.has(destination)) throw new FsError('EISDIR', destination)
    this.assertWritable(destination)
    const content = this.files.get(source) ?? ''
    this.files.delete(source)
    this.files.set(destination, content)
  }

  copy(from: string, to: string, recursive = false): void {
    const source = normalizePath(from)
    const destination = normalizePath(to)
    if (!this.exists(source)) throw new FsError('ENOENT', source)
    if (!this.dirs.has(source)) {
      this.write(destination, this.read(source) ?? '')
      return
    }
    if (!recursive) throw new FsError('EISDIR', source)
    if (isWithin(destination, source)) throw new FsError('EINVAL', destination)
    if (this.files.has(destination)) throw new FsError('ENOTDIR', destination)
    if (!this.dirs.has(destination)) this.assertParentDirectory(destination)
    const target = (path: string): string => destination + path.slice(source.length)
    const copiedDirs = Array.from(this.dirs).filter((path) => path !== source && isWithin(path, source))
    const copiedFiles = Array.from(this.files).filter(([path]) => isWithin(path, source))
    const fileClash = copiedDirs.find((path) => this.files.has(target(path)))
    if (fileClash) throw new FsError('ENOTDIR', target(fileClash))
    const dirClash = copiedFiles.find(([path]) => this.dirs.has(target(path)))
    if (dirClash) throw new FsError('EISDIR', target(dirClash[0]))
    this.dirs.add(destination)
    for (const path of copiedDirs) this.dirs.add(target(path))
    for (const [path, content] of copiedFiles) this.files.set(target(path), content)
  }

  private assertParentDirectory(path: string): void {
    const parent = dirnameOf(path)
    if (this.files.has(parent)) throw new FsError('ENOTDIR', path)
    if (!this.dirs.has(parent)) throw new FsError('ENOENT', path)
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
