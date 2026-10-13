import { describe, expect, it } from 'vitest'
import { completeShell, currentWord, isFirstWord, type CompletionContext } from '../src/shell/complete.js'
import { ShellFileSystem } from '../src/shell/fs.js'
import { createShellBackend } from '../src/shell/index.js'
import type { CompletionReply } from '../src/types.js'

const tree = {
  project: {
    'README.md': '# demo\n',
    'regions.csv': 'name,region\n',
    'my notes.txt': 'notes\n',
    'a&b.txt': 'x\n',
    '.env': 'TOKEN=x\n',
    '.config': { 'settings.json': '{}\n' },
    src: { 'index.ts': 'export {}\n', 'config.ts': 'export {}\n' },
    'docs dir': { 'guide.md': '# guide\n' },
  },
  home: { reader: { 'profile.txt': 'me\n', projects: { 'orbit.md': '# orbit\n' } } },
}

const fs = new ShellFileSystem(tree)
const commands = ['cat', 'cd', 'echo', 'grep', 'groups', 'ls', 'true']

const complete = (line: string, cursor = line.length, extra: Partial<CompletionContext> = {}): CompletionReply | null =>
  completeShell({ line, cursor, cwd: '/project', fs, commands, env: { HOME: '/home/reader' }, ...extra })

const reply = (from: number, to: number, candidates: string[]): CompletionReply => ({ from, to, candidates })

describe('command position [sb-25]', () => {
  it('ignores leading spaces', () => {
    expect(complete('  gr')).toEqual(reply(2, 4, ['grep', 'groups']))
  })

  it('starts a new command after operators written without spaces', () => {
    expect(complete('ls;gr')).toEqual(reply(3, 5, ['grep', 'groups']))
    expect(complete('cat README.md|gr')).toEqual(reply(14, 16, ['grep', 'groups']))
    expect(complete('true&&ec')).toEqual(reply(6, 8, ['echo']))
    expect(complete('true||ec')).toEqual(reply(6, 8, ['echo']))
    expect(complete('(ec')).toEqual(reply(1, 3, ['echo']))
  })

  it('skips leading variable assignments', () => {
    expect(complete('FOO=bar ec')).toEqual(reply(8, 10, ['echo']))
  })

  it('completes paths when the command word contains a slash', () => {
    expect(complete('./sr')).toEqual(reply(0, 4, ['./src/']))
  })
})

describe('arguments and redirections [sb-25]', () => {
  it('completes redirect targets as paths even without a space', () => {
    expect(complete('echo hi >RE')).toEqual(reply(9, 11, ['README.md']))
    expect(complete('cat <reg')).toEqual(reply(5, 8, ['regions.csv']))
    expect(complete('ls 2>RE')).toEqual(reply(5, 7, ['README.md']))
  })

  it('uses the text before the cursor only', () => {
    expect(complete('cat RE more', 6)).toEqual(reply(4, 6, ['README.md']))
  })

  it('offers nothing inside a comment', () => {
    expect(complete('echo hi #RE')).toBeNull()
  })
})

describe('quoting and escaping [sb-24, sb-25]', () => {
  it('escapes shell-special characters in bare words', () => {
    expect(complete('cat my')).toEqual(reply(4, 6, ['my\\ notes.txt']))
    expect(complete('cat a')).toEqual(reply(4, 5, ['a\\&b.txt']))
    expect(complete('cat my\\ n')).toEqual(reply(4, 9, ['my\\ notes.txt']))
    expect(complete('cd do')).toEqual(reply(3, 5, ['docs\\ dir/']))
  })

  it('completes inside quotes and closes them for files only', () => {
    expect(complete('cat "my')).toEqual(reply(4, 7, ['"my notes.txt"']))
    expect(complete("cat 'my")).toEqual(reply(4, 7, ["'my notes.txt'"]))
    expect(complete('cat "docs')).toEqual(reply(4, 9, ['"docs dir/']))
    expect(complete('cat "docs dir/g')).toEqual(reply(4, 15, ['"docs dir/guide.md"']))
  })
})

describe('home, dot entries and directories [sb-25]', () => {
  it('expands an unquoted tilde and keeps it in the candidate', () => {
    expect(complete('cat ~/pro')).toEqual(reply(4, 9, ['~/profile.txt', '~/projects/']))
    expect(complete('cat ~/projects/')).toEqual(reply(4, 15, ['~/projects/orbit.md']))
    expect(complete('cd ~')).toEqual(reply(3, 4, ['~/']))
    expect(complete('cat "~/pro')).toBeNull()
  })

  it('hides dotfiles unless the typed name starts with a dot', () => {
    expect(complete('cat ')?.candidates).toEqual([
      'README.md',
      'a\\&b.txt',
      'docs\\ dir/',
      'my\\ notes.txt',
      'regions.csv',
      'src/',
    ])
    expect(complete('cat .')?.candidates).toEqual(['../', './', '.config/', '.env'])
  })

  it('offers only directories after cd, and completes ..', () => {
    expect(complete('cd ')).toEqual(reply(3, 3, ['docs\\ dir/', 'src/']))
    expect(complete('cd .')?.candidates).toEqual(['../', './', '.config/'])
    expect(complete('cd ..')).toEqual(reply(3, 5, ['../']))
    expect(complete('cd ../')).toEqual(reply(3, 6, ['../home/', '../project/']))
  })
})

describe('legacy helpers', () => {
  it('report the current word and command position through the tokenizer', () => {
    expect(currentWord('cat "my n', 9)).toEqual({ word: '"my n', from: 4 })
    expect(currentWord('ls;gr', 5)).toEqual({ word: 'gr', from: 3 })
    expect(isFirstWord('  gr', 2)).toBe(true)
    expect(isFirstWord('ls;gr', 3)).toBe(true)
    expect(isFirstWord('echo hi >', 9)).toBe(false)
  })
})

describe('through the shell backend', () => {
  it('completes commands after leading spaces and operators', async () => {
    const shell = createShellBackend({ files: tree, cwd: '/project' })
    expect(await shell.complete?.({ line: '  ech', cursor: 5 })).toEqual(reply(2, 5, ['echo']))
    expect(await shell.complete?.({ line: 'ls|ech', cursor: 6 })).toEqual(reply(3, 6, ['echo']))
    expect(await shell.complete?.({ line: 'cat my', cursor: 6 })).toEqual(reply(4, 6, ['my\\ notes.txt']))
    expect(await shell.complete?.({ line: 'cd ', cursor: 3 })).toEqual(reply(3, 3, ['docs\\ dir/', 'src/']))
  })
})
