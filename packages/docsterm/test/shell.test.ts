import { beforeEach, describe, expect, it } from 'vitest'
import { createShellBackend } from '../src/shell/index.js'
import { ShellFileSystem, normalizePath } from '../src/shell/fs.js'
import { parse, tokenize } from '../src/shell/parse.js'
import type { Backend } from '../src/types.js'

const files = {
  'README.md': 'docsterm\nembeddable terminal\n',
  'data.csv': 'name,region\nalpha,eu\nbeta,us\ngamma,eu\n',
  src: { 'index.ts': 'export const answer = 42\n', 'util.ts': 'export const noop = () => {}\n' },
}

let shell: Backend

beforeEach(() => {
  shell = createShellBackend({ files, cwd: '/', env: { PROJECT: 'orbit' } })
})

const run = async (line: string) => shell.run(line)

describe('normalizePath', () => {
  it('collapses dots and duplicate slashes', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c')
    expect(normalizePath('a//b/./c/')).toBe('/a/b/c')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('/a/../..')).toBe('/')
  })
})

describe('ShellFileSystem', () => {
  it('seeds nested trees and lists direct children only', () => {
    const fs = new ShellFileSystem(files)
    expect(fs.list('/')).toEqual(['README.md', 'data.csv', 'src'])
    expect(fs.list('/src')).toEqual(['index.ts', 'util.ts'])
    expect(fs.isDir('/src')).toBe(true)
    expect(fs.isFile('/src/index.ts')).toBe(true)
  })

  it('refuses to delete a non-empty directory without recursion', () => {
    const fs = new ShellFileSystem(files)
    expect(() => fs.remove('/src')).toThrow('not empty')
    fs.remove('/src', true)
    expect(fs.exists('/src')).toBe(false)
  })
})

describe('tokenize', () => {
  it('keeps quoted strings whole', () => {
    expect(tokenize('echo "hello world"')).toEqual([
      { type: 'word', value: 'echo', quoted: false },
      { type: 'word', value: 'hello world', quoted: true },
    ])
  })

  it('splits operators without spaces', () => {
    expect(tokenize('a|b').map((token) => token.value)).toEqual(['a', '|', 'b'])
    expect(tokenize('a>>b').map((token) => token.value)).toEqual(['a', '>>', 'b'])
  })

  it('rejects unbalanced quotes', () => {
    expect(() => tokenize('echo "oops')).toThrow('unbalanced')
  })
})

describe('parse', () => {
  it('builds pipelines and records redirects', () => {
    const segments = parse('cat a.txt | grep x > out.txt')
    expect(segments).toHaveLength(1)
    expect(segments[0]?.pipeline.commands).toHaveLength(2)
    expect(segments[0]?.pipeline.commands[1]?.redirects[0]).toEqual({
      type: 'write',
      target: 'out.txt',
    })
  })

  it('tracks conditional operators between segments', () => {
    const segments = parse('false && echo yes || echo no')
    expect(segments.map((segment) => segment.operator)).toEqual(['always', 'and', 'or'])
  })
})

describe('shell backend basics', () => {
  it('reports the working directory and navigates', async () => {
    expect(await run('pwd')).toEqual({ output: '/', exitCode: 0 })
    expect(await run('cd src')).toEqual({ output: '', exitCode: 0 })
    expect(await run('pwd')).toEqual({ output: '/src', exitCode: 0 })
    expect(shell.prompt).toBe('/src $ ')
    expect(await run('cd ..')).toEqual({ output: '', exitCode: 0 })
    expect(await run('pwd')).toEqual({ output: '/', exitCode: 0 })
  })

  it('fails cd into a missing directory with exit 1', async () => {
    const result = await run('cd nowhere')
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('no such file or directory')
  })

  it('lists files and reads them', async () => {
    expect((await run('ls')).output).toBe('README.md  data.csv  src')
    expect((await run('cat README.md')).output).toBe('docsterm\nembeddable terminal')
  })

  it('returns 127 for an unknown command', async () => {
    expect(await run('teleport now')).toEqual({
      output: 'teleport: command not found',
      exitCode: 127,
    })
  })

  it('reports a missing file through cat with exit 1', async () => {
    const result = await run('cat nope.txt')
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('no such file or directory')
  })
})

describe('shell pipelines and redirects', () => {
  it('pipes output between commands', async () => {
    expect((await run('cat data.csv | grep eu | wc -l')).output.trim()).toBe('2')
  })

  it('writes and appends to files', async () => {
    await run('echo first > notes.txt')
    await run('echo second >> notes.txt')
    expect((await run('cat notes.txt')).output).toBe('first\nsecond')
  })

  it('reads stdin from a file redirect', async () => {
    expect((await run('grep alpha < data.csv')).output).toBe('alpha,eu')
  })

  it('honours && and || by exit code', async () => {
    expect((await run('true && echo reached')).output).toBe('reached')
    expect((await run('false && echo skipped')).output).toBe('')
    expect((await run('false || echo fallback')).output).toBe('fallback')
    expect((await run('true || echo skipped')).output).toBe('')
  })

  it('runs sequences separated by semicolons', async () => {
    expect((await run('echo one; echo two')).output).toBe('one\ntwo')
  })
})

describe('shell expansion', () => {
  it('expands environment variables and keeps quoted text literal', async () => {
    expect((await run('echo $PROJECT')).output).toBe('orbit')
    expect((await run('echo "${PROJECT}-cli"')).output).toBe('${PROJECT}-cli')
    expect((await run('echo ${PROJECT}-cli')).output).toBe('orbit-cli')
  })

  it('expands globs against the filesystem', async () => {
    expect((await run('ls src/*.ts')).output).toContain('index.ts')
    expect((await run('echo *.md')).output).toBe('README.md')
  })

  it('picks up variables set with export', async () => {
    await run('export GREETING=hi')
    expect((await run('echo $GREETING')).output).toBe('hi')
  })
})

describe('shell file manipulation', () => {
  it('creates, copies, moves and removes files', async () => {
    await run('mkdir -p build/out')
    await run('echo hello > build/out/a.txt')
    expect((await run('cat build/out/a.txt')).output).toBe('hello')
    await run('cp build/out/a.txt build/out/b.txt')
    expect((await run('ls build/out')).output).toBe('a.txt  b.txt')
    await run('mv build/out/b.txt build/out/c.txt')
    expect((await run('ls build/out')).output).toBe('a.txt  c.txt')
    await run('rm -r build')
    expect((await run('ls')).output).not.toContain('build')
  })

  it('refuses to remove a directory without -r', async () => {
    const result = await run('rm src')
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('is a directory')
  })

  it('slices files with head and tail', async () => {
    expect((await run('head -n 1 data.csv')).output).toBe('name,region')
    expect((await run('tail -n 1 data.csv')).output).toBe('gamma,eu')
  })

  it('sorts and dedupes piped text', async () => {
    await run('echo b > list.txt')
    await run('echo a >> list.txt')
    await run('echo a >> list.txt')
    expect((await run('cat list.txt | sort | uniq')).output).toBe('a\nb')
  })

  it('finds files by name', async () => {
    expect((await run('find / -name *.ts')).output.split('\n').sort()).toEqual([
      '/src/index.ts',
      '/src/util.ts',
    ])
  })
})

describe('custom commands', () => {
  it('receives argv, stdin, cwd and the filesystem', async () => {
    const seen: string[][] = []
    const custom = createShellBackend({
      files,
      commands: {
        orbit: (ctx) => {
          seen.push(ctx.argv)
          if (ctx.argv[1] === 'deploy') {
            ctx.fs.write(ctx.fs.resolve(ctx.cwd, 'orbit.lock'), 'deployed')
            return 'Deployed to https://demo.orbit.app\n'
          }
          return { stderr: `orbit: unknown command ${ctx.argv[1] ?? ''}\n`, exitCode: 2 }
        },
      },
    })
    expect((await custom.run('orbit deploy')).output).toContain('Deployed')
    expect(seen[0]).toEqual(['orbit', 'deploy'])
    expect((await custom.run('cat orbit.lock')).output).toBe('deployed')
    const failure = await custom.run('orbit fly')
    expect(failure.exitCode).toBe(2)
  })

  it('supports async commands and piping into them', async () => {
    const custom = createShellBackend({
      commands: {
        upper: async (ctx) => ({ stdout: ctx.stdin.toUpperCase() }),
      },
    })
    expect((await custom.run('echo hello | upper')).output).toBe('HELLO')
  })

  it('turns a thrown error into a non-zero exit code', async () => {
    const custom = createShellBackend({
      commands: {
        boom: () => {
          throw new Error('exploded')
        },
      },
    })
    const result = await custom.run('boom')
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('exploded')
  })
})

describe('shell startup', () => {
  it('writes the banner during init', async () => {
    const custom = createShellBackend({ banner: 'docsterm shell 1.0' })
    const writes: string[] = []
    await custom.init({ write: (text) => writes.push(text) })
    expect(writes).toEqual(['docsterm shell 1.0\n'])
  })

  it('reports syntax errors instead of throwing', async () => {
    const result = await run('echo "unterminated')
    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('syntax error')
  })
})
