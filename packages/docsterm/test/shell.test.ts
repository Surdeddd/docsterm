import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { getMessages } from '../src/messages.js'
import { builtins } from '../src/shell/builtins.js'
import { createShellBackend } from '../src/shell/index.js'
import { ShellFileSystem, normalizePath } from '../src/shell/fs.js'
import {
  ShellSyntaxError,
  UnsupportedSyntaxError,
  isComplete,
  parse,
  tokenize,
  type Part,
  type Quoting,
  type Token,
} from '../src/shell/parse.js'
import type { Backend, BackendRunResult, RunOutcome } from '../src/types.js'

const files = {
  'README.md': 'docsterm\nembeddable terminal\n',
  'data.csv': 'name,region\nalpha,eu\nbeta,us\ngamma,eu\n',
  src: { 'index.ts': 'export const answer = 42\n', 'util.ts': 'export const noop = () => {}\n' },
}

let shell: Backend

beforeEach(() => {
  shell = createShellBackend({ files, cwd: '/', env: { PROJECT: 'orbit' }, colors: false })
})

const run = async (line: string) => plain(shell.run(line))
const plain = async (outcome: Promise<RunOutcome>): Promise<BackendRunResult> => {
  const result = await outcome
  if ('onKey' in result) throw new Error('expected a plain result, got an interactive session')
  return result
}

const literal = (value: string, quoting: Quoting = 'none'): Part => ({ type: 'literal', value, quoting })
const label = (token: Token): string => {
  if (token.type === 'word') return token.word.text
  if (token.type === 'operator') return token.value
  return `${token.fd ?? ''}${token.operator}`
}

const builtinNames = [...new Set([...Object.keys(builtins), 'clear', 'help', 'less', 'more'])].sort()

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
  it('keeps quoted strings whole and records how each part was quoted', () => {
    expect(tokenize('echo "hello world"')).toEqual([
      { type: 'word', word: { text: 'echo', parts: [literal('echo')] } },
      { type: 'word', word: { text: '"hello world"', parts: [literal('hello world', 'double')] } },
    ])
    expect(tokenize(`a"b"'c'\\d`)).toEqual([
      {
        type: 'word',
        word: {
          text: `a"b"'c'\\d`,
          parts: [literal('a'), literal('b', 'double'), literal('c', 'single'), literal('d', 'escaped')],
        },
      },
    ])
  })

  it('splits operators without spaces', () => {
    expect(tokenize('a|b').map(label)).toEqual(['a', '|', 'b'])
    expect(tokenize('a>>b').map(label)).toEqual(['a', '>>', 'b'])
    expect(tokenize('a;b&&c||d').map(label)).toEqual(['a', ';', 'b', '&&', 'c', '||', 'd'])
  })

  it('reads file descriptor redirects', () => {
    expect(tokenize('cmd 2>/dev/null 2>&1 &>f &>>g >&2 a2>x').map(label)).toEqual([
      'cmd',
      '2>',
      '/dev/null',
      '2>&',
      '1',
      '&>',
      'f',
      '&>>',
      'g',
      '>&',
      '2',
      'a2',
      '>',
      'x',
    ])
  })

  it('turns newlines into separators and drops comments', () => {
    expect(tokenize('echo a # note | ignored\necho b#c').map(label)).toEqual(['echo', 'a', '\n', 'echo', 'b#c'])
    expect(tokenize('echo a \\\nb').map(label)).toEqual(['echo', 'a', 'b'])
  })

  it('parses parameters and command substitutions into parts', () => {
    const [, plainParam, quotedParam, operator, substitution] = tokenize('echo $X "$Y" ${Z:-z} $(pwd)')
    expect(plainParam).toEqual({ type: 'word', word: { text: '$X', parts: [{ type: 'param', name: 'X', quoted: false }] } })
    expect(quotedParam).toEqual({
      type: 'word',
      word: { text: '"$Y"', parts: [{ type: 'param', name: 'Y', quoted: true }] },
    })
    expect(operator).toEqual({
      type: 'word',
      word: {
        text: '${Z:-z}',
        parts: [{ type: 'param', name: 'Z', operator: ':-', word: { text: 'z', parts: [literal('z')] }, quoted: false }],
      },
    })
    expect(substitution?.type === 'word' && substitution.word.parts[0]?.type).toBe('subst')
  })

  it('rejects unbalanced quotes as incomplete input', () => {
    expect(() => tokenize('echo "oops')).toThrow(ShellSyntaxError)
    let caught: unknown
    try {
      tokenize("echo 'oops")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ShellSyntaxError)
    expect((caught as ShellSyntaxError).incomplete).toBe(true)
  })
})

describe('parse', () => {
  it('builds pipelines and records redirects', () => {
    const [item] = parse('cat a.txt | grep x > out.txt')
    expect(item?.first.commands).toHaveLength(2)
    expect(item?.first.commands[1]?.redirects).toEqual([
      { fd: 1, mode: 'write', target: { text: 'out.txt', parts: [literal('out.txt')] } },
    ])
  })

  it('tracks conditional operators between pipelines', () => {
    const [item] = parse('false && echo yes || echo no')
    expect(item?.rest.map((link) => link.operator)).toEqual(['&&', '||'])
  })

  it('separates leading assignments from the command words', () => {
    const [item] = parse('A=1 B+="x y" env A=2')
    const command = item?.first.commands[0]
    expect(command?.assignments.map(({ name, append, value }) => [name, append, value.text])).toEqual([
      ['A', false, '1'],
      ['B', true, '"x y"'],
    ])
    expect(command?.words.map((word) => word.text)).toEqual(['env', 'A=2'])
  })

  it('expands &> and |& into explicit descriptor copies', () => {
    const [item] = parse('a &> log |& b')
    expect(item?.first.commands[0]?.redirects).toEqual([
      { fd: 1, mode: 'write', target: { text: 'log', parts: [literal('log')] } },
      { fd: 2, mode: 'dup', target: 1 },
      { fd: 2, mode: 'dup', target: 1 },
    ])
  })

  it('keeps the word of >& for run time unless it is a plain number, a dash or a file for both streams', () => {
    const redirects = (source: string) => parse(source)[0]?.first.commands[0]?.redirects
    expect(redirects('echo >&$FD')).toEqual([
      { fd: 1, mode: 'dup', target: { text: '$FD', parts: [{ type: 'param', name: 'FD', quoted: false }] } },
    ])
    expect(redirects('echo 2>&file')).toEqual([{ fd: 2, mode: 'dup', target: { text: 'file', parts: [literal('file')] } }])
    expect(redirects('echo >&"2"')).toEqual([{ fd: 1, mode: 'dup', target: { text: '"2"', parts: [literal('2', 'double')] } }])
    expect(redirects('echo >&2 3>&-')).toEqual([
      { fd: 1, mode: 'dup', target: 2 },
      { fd: 3, mode: 'dup', target: 'close' },
    ])
    expect(redirects('echo >&both.log')).toEqual([
      { fd: 1, mode: 'write', target: { text: 'both.log', parts: [literal('both.log')] } },
      { fd: 2, mode: 'dup', target: 1 },
    ])
  })

  it('names unsupported constructs through the message catalog', () => {
    const caught = (source: string): UnsupportedSyntaxError => {
      try {
        parse(source)
      } catch (error) {
        if (error instanceof UnsupportedSyntaxError) return error
        throw error
      }
      throw new Error(`${source}: parsed`)
    }
    const functions = caught('f() { echo hi; }')
    expect(functions.message).toBe('unsupported syntax: functions')
    expect(functions.localized(getMessages('ru'))).toBe('неподдерживаемый синтаксис: функции')
    expect(caught('sleep 1 &').localized(getMessages('en'))).toBe('unsupported syntax: background jobs (&)')
    expect(caught('while true; do :; done').localized(getMessages('ru'))).toBe('неподдерживаемый синтаксис: циклы (while)')
  })

  it.each(['echo $(ls |)', 'echo $(true &&)', 'echo "$(ls |)"', 'echo ${X:-$(ls |)}', 'echo `echo $(ls |)`', 'echo $(ls |\n)'])(
    'rejects %j at the closing paren as a complete line',
    (source) => {
      let caught: unknown
      try {
        parse(source)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ShellSyntaxError)
      const { message, incomplete } = caught as ShellSyntaxError
      expect({ message, incomplete }).toEqual({ message: "syntax error near unexpected token ')'", incomplete: false })
    },
  )
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
    expect(result.output).toContain('nowhere')
  })

  it('lists files and reads them', async () => {
    expect((await run('ls')).output).toBe('data.csv  README.md  src')
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
    expect(result.output).toContain('nope.txt')
  })

  it('keeps the exit status between lines', async () => {
    await run('false')
    expect(await run('echo $?')).toEqual({ output: '1', exitCode: 0 })
    await run('nope')
    expect(await run('echo $?')).toEqual({ output: '127', exitCode: 0 })
  })

  it('normalizes the starting directory', async () => {
    const trailing = createShellBackend({ files, cwd: '/src/' })
    expect(trailing.prompt).toBe('/src $ ')
    expect(await plain(trailing.run('pwd'))).toEqual({ output: '/src', exitCode: 0 })
    const relative = createShellBackend({ files, cwd: 'src' })
    expect(relative.prompt).toBe('/src $ ')
    expect(await plain(relative.run('echo $PWD'))).toEqual({ output: '/src', exitCode: 0 })
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

  it('runs every command of a multi-line suggestion', async () => {
    expect(await run('cd src\npwd')).toEqual({ output: '/src', exitCode: 0 })
    expect(await run('echo one\necho two')).toEqual({ output: 'one\ntwo', exitCode: 0 })
  })
})

describe('shell expansion', () => {
  it('expands environment variables inside double quotes but not single quotes', async () => {
    expect((await run('echo $PROJECT')).output).toBe('orbit')
    expect((await run('echo "${PROJECT}-cli"')).output).toBe('orbit-cli')
    expect((await run("echo '${PROJECT}-cli'")).output).toBe('${PROJECT}-cli')
    expect((await run('echo ${PROJECT}-cli')).output).toBe('orbit-cli')
  })

  it('expands every glob match', async () => {
    expect((await run('echo src/*.ts')).output).toBe('src/index.ts src/util.ts')
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
    expect((await run('echo *')).output).toBe('data.csv README.md src')
  })

  it('refuses to remove a directory without -r', async () => {
    const result = await run('rm src')
    expect(result.exitCode).toBe(1)
    expect((await run('echo src/*')).output).toBe('src/index.ts src/util.ts')
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

  it('finds files by a quoted name pattern', async () => {
    expect((await run('find / -name "*.ts"')).output.split('\n').sort()).toEqual(['/src/index.ts', '/src/util.ts'])
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
    expect(await plain(custom.run('orbit deploy'))).toEqual({ output: 'Deployed to https://demo.orbit.app', exitCode: 0 })
    expect(seen[0]).toEqual(['orbit', 'deploy'])
    expect((await plain(custom.run('cat orbit.lock'))).output).toBe('deployed')
    expect(await plain(custom.run('orbit fly'))).toEqual({ output: 'orbit: unknown command fly', exitCode: 2 })
  })

  it('supports async commands and piping into them', async () => {
    const custom = createShellBackend({
      commands: {
        upper: async (ctx) => ({ stdout: ctx.stdin.toUpperCase() }),
      },
    })
    expect((await plain(custom.run('echo hello | upper'))).output).toBe('HELLO')
  })

  it('turns a thrown error into a non-zero exit code', async () => {
    const custom = createShellBackend({
      commands: {
        boom: () => {
          throw new Error('exploded')
        },
      },
    })
    expect(await plain(custom.run('boom'))).toEqual({ output: 'boom: exploded', exitCode: 1 })
  })

  it('treats any non-result return value as success', async () => {
    const custom = createShellBackend({
      commands: {
        nothing: (() => undefined) as never,
        number: (() => 42) as never,
      },
    })
    expect(await plain(custom.run('echo ok; nothing; number; echo after'))).toEqual({ output: 'ok\nafter', exitCode: 0 })
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
    expect(await run('echo "unterminated')).toEqual({
      output: `docsterm: syntax error: unexpected end of file while looking for matching '"'`,
      exitCode: 2,
    })
  })
})

describe('continuation', () => {
  it('asks for a "> " continuation line', () => {
    expect(shell.continuationPrompt).toBe('> ')
  })

  it.each([
    ['echo a \\', false],
    ['echo "abc', false],
    ["echo 'abc", false],
    ['echo `pwd', false],
    ['echo $(pwd', false],
    ['echo $(ls |', false],
    ['echo $(ls |\n', false],
    ['echo ${X', false],
    ['ls |', false],
    ['ls | ', false],
    ['ls &&', false],
    ['ls ||\n', false],
    ['ls | # comment', false],
    ['echo "a\nb', false],
    ['echo a', true],
    ['echo "a b" \'c\'', true],
    ['echo a \\\\', true],
    ["echo 'a\\'", true],
    ['ls |\nwc -l', true],
    ['echo $(ls |\nwc -l)', true],
    ['echo $(ls |)', true],
    ['echo $(true &&)', true],
    ['echo $(ls |\n)', true],
    ['echo $(ls |)\nwc -l', true],
    ['echo "$(ls |)"', true],
    ['echo ${X:-$(ls |)}', true],
    ['echo $(echo $(ls ||))', true],
    ['echo `echo $(ls |)`', true],
    ['echo `ls |`', true],
    ['ls # trailing |', true],
    ['&& echo x', true],
    ['sleep 1 &', true],
    ['cat <<EOF', true],
    ['for i in 1 2; do', true],
  ])('isComplete(%j) is %s', (source, expected) => {
    expect(isComplete(source)).toBe(expected)
    expect(shell.isComplete?.(source)).toBe(expected)
  })

  it('drops a trailing backslash when the line is run as is', async () => {
    expect(await run('echo a \\')).toEqual({ output: 'a', exitCode: 0 })
  })
})

describe('help and describe', () => {
  it('lists builtins and page commands on one line', async () => {
    const custom = createShellBackend({ commands: { orbit: () => 'ok\n', build: () => 'ok\n' } })
    expect(await plain(custom.run('help'))).toEqual({
      output: `shell builtins: ${builtinNames.join(' ')}; page commands: build orbit`,
      exitCode: 0,
    })
    expect(await plain(shell.run('help'))).toEqual({ output: `shell builtins: ${builtinNames.join(' ')}`, exitCode: 0 })
  })

  it('answers help in the run locale', async () => {
    const custom = createShellBackend({ commands: { orbit: () => 'ok\n' } })
    const writes: string[] = []
    const result = await custom.run('help', {
      write: (text) => writes.push(text),
      signal: new AbortController().signal,
      columns: 80,
      rows: 24,
      locale: 'ru',
    })
    expect(result).toEqual({ output: '', exitCode: 0 })
    expect(writes.join('')).toBe(`встроенные команды оболочки: ${builtinNames.join(' ')}; команды страницы: orbit\n`)
  })

  it('describes the environment for the AI in plain text', async () => {
    const custom = createShellBackend({ commands: { orbit: () => 'ok\n' } })
    const expected = getMessages('en').shellDescription.replace('{builtins}', builtinNames.join(' '))
    expect(custom.describe?.()).toBe(`${expected} Page commands: orbit.`)
    expect(shell.describe?.()).toBe(expected)
    expect(expected).not.toMatch(/\x1b/)
    expect(expected.startsWith('POSIX-like shell')).toBe(true)
  })

  it('describes the environment in the locale the widget passed at init', async () => {
    const custom = createShellBackend()
    await custom.init({ write: () => {}, locale: 'ru' })
    expect(custom.describe?.()).toBe(getMessages('ru').shellDescription.replace('{builtins}', builtinNames.join(' ')))
  })
})

describe('repository hygiene', () => {
  it('keeps the shell sources free of raw NUL bytes', () => {
    for (const file of ['../src/shell/index.ts', '../src/shell/parse.ts']) {
      expect(readFileSync(new URL(file, import.meta.url)).includes(0)).toBe(false)
    }
  })
})
