import { beforeEach, describe, expect, it } from 'vitest'
import { FsError, ShellFileSystem } from '../src/shell/fs.js'

const codeOf = (action: () => void): string | null => {
  try {
    action()
    return null
  } catch (error) {
    return error instanceof FsError ? error.code : 'other'
  }
}

describe('ShellFileSystem invariants', () => {
  let fs: ShellFileSystem

  beforeEach(() => {
    fs = new ShellFileSystem({
      project: {
        'README.md': '# demo\n',
        src: { 'index.ts': 'export {}\n', 'config.ts': 'export const a = 1\n' },
      },
    })
  })

  it('refuses to write into a missing directory instead of creating an orphan', () => {
    expect(codeOf(() => fs.write('/project/nodir/x.txt', 'hi'))).toBe('ENOENT')
    expect(fs.list('/project')).toEqual(['README.md', 'src'])
    expect(fs.read('/project/nodir/x.txt')).toBeNull()
  })

  it('refuses to write beneath a file', () => {
    expect(codeOf(() => fs.write('/project/README.md/x', 'hi'))).toBe('ENOTDIR')
    expect(codeOf(() => fs.write('/project/README.md/deeper/x', 'hi'))).toBe('ENOTDIR')
  })

  it('refuses to turn a directory into a file and a file into a directory', () => {
    expect(codeOf(() => fs.write('/project/src', 'clobber'))).toBe('EISDIR')
    expect(codeOf(() => fs.append('/project/src', 'clobber'))).toBe('EISDIR')
    expect(codeOf(() => fs.mkdir('/project/README.md'))).toBe('EEXIST')
    expect(fs.isFile('/project/README.md')).toBe(true)
    expect(fs.list('/project/src')).toEqual(['config.ts', 'index.ts'])
  })

  it('reports an existing directory unless recursive', () => {
    expect(codeOf(() => fs.mkdir('/project/src'))).toBe('EEXIST')
    expect(codeOf(() => fs.mkdir('/project/src', true))).toBeNull()
    expect(codeOf(() => fs.mkdir('/project/a/b'))).toBe('ENOENT')
    expect(codeOf(() => fs.mkdir('/project/a/b', true))).toBeNull()
    expect(fs.isDir('/project/a/b')).toBe(true)
  })

  it('never removes the root', () => {
    expect(codeOf(() => fs.remove('/', true))).toBe('EINVAL')
    expect(fs.list('/')).toEqual(['project'])
    expect(codeOf(() => fs.mkdir('/', true))).toBeNull()
  })

  it('removes a directory tree completely or refuses when not recursive', () => {
    expect(codeOf(() => fs.remove('/project/src'))).toBe('ENOTEMPTY')
    fs.remove('/project/src', true)
    expect(fs.exists('/project/src')).toBe(false)
    expect(fs.read('/project/src/index.ts')).toBeNull()
    expect(fs.entries().some((path) => path.startsWith('/project/src'))).toBe(false)
  })

  it('treats /dev/null as a sink without creating /dev', () => {
    fs.write('/dev/null', 'swallowed')
    fs.append('/dev/null', 'swallowed')
    expect(fs.read('/dev/null')).toBe('')
    expect(fs.exists('/dev/null')).toBe(true)
    expect(fs.list('/')).toEqual(['project'])
  })

  it('renames files and whole directory trees', () => {
    fs.rename('/project/README.md', '/project/NOTES.md')
    expect(fs.read('/project/NOTES.md')).toBe('# demo\n')
    expect(fs.exists('/project/README.md')).toBe(false)
    fs.rename('/project/src', '/project/lib')
    expect(fs.list('/project/lib')).toEqual(['config.ts', 'index.ts'])
    expect(fs.read('/project/lib/index.ts')).toBe('export {}\n')
    expect(fs.exists('/project/src')).toBe(false)
    expect(codeOf(() => fs.rename('/project/lib', '/project/lib/inner'))).toBe('EINVAL')
    expect(codeOf(() => fs.rename('/project/missing', '/project/x'))).toBe('ENOENT')
  })

  it('copies files and, when recursive, directory trees', () => {
    fs.copy('/project/README.md', '/project/COPY.md')
    expect(fs.read('/project/COPY.md')).toBe('# demo\n')
    expect(codeOf(() => fs.copy('/project/src', '/project/lib'))).toBe('EISDIR')
    fs.copy('/project/src', '/project/lib', true)
    expect(fs.list('/project/lib')).toEqual(['config.ts', 'index.ts'])
    expect(fs.list('/project/src')).toEqual(['config.ts', 'index.ts'])
    expect(codeOf(() => fs.copy('/project/src', '/project/src/nested', true))).toBe('EINVAL')
  })

  it('refuses a recursive merge that would turn a file into a directory or the reverse, changing nothing', () => {
    fs.mkdir('/project/lib')
    fs.write('/project/lib/index.ts', 'kept\n')
    fs.mkdir('/project/other')
    fs.mkdir('/project/other/index.ts')
    expect(codeOf(() => fs.copy('/project/other', '/project/lib', true))).toBe('ENOTDIR')
    expect(fs.read('/project/lib/index.ts')).toBe('kept\n')
    fs.mkdir('/project/dirs')
    fs.mkdir('/project/dirs/README.md')
    fs.mkdir('/project/files')
    fs.write('/project/files/README.md', 'a file\n')
    expect(codeOf(() => fs.copy('/project/files', '/project/dirs', true))).toBe('EISDIR')
    expect(fs.isDir('/project/dirs/README.md')).toBe(true)
    expect(fs.isFile('/project/dirs/README.md')).toBe(false)
    fs.mkdir('/project/plain')
    fs.write('/project/plain/sub', 'a file named sub\n')
    fs.mkdir('/project/tree')
    fs.mkdir('/project/tree/sub')
    fs.write('/project/tree/sub/inner.txt', 'x\n')
    expect(codeOf(() => fs.copy('/project/tree', '/project/plain', true))).toBe('ENOTDIR')
    expect(fs.isFile('/project/plain/sub')).toBe(true)
    expect(fs.isDir('/project/plain/sub')).toBe(false)
    expect(fs.read('/project/plain/sub/inner.txt')).toBeNull()
  })
})
