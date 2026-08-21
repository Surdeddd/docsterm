import { describe, expect, it } from 'vitest'
import { createShellBackend } from '../src/shell/index.js'
import { completeShell, currentWord, isFirstWord } from '../src/shell/complete.js'
import { nextOffset, renderPage } from '../src/shell/pager.js'
import { ShellFileSystem } from '../src/shell/fs.js'
import { isInteractiveRun, type BackendRunResult, type RunContext } from '../src/types.js'

const files = {
  'README.md': Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'),
  'regions.csv': 'name,region\nalpha,eu\nbeta,us\n',
  src: { 'index.ts': 'export const answer = 42\n', 'util.ts': 'export const noop = () => {}\n' },
}

const context = (overrides: Partial<RunContext> = {}): RunContext & { written: string[] } => {
  const written: string[] = []
  return {
    write: (text) => written.push(text),
    signal: new AbortController().signal,
    columns: 80,
    rows: 10,
    written,
    ...overrides,
  }
}

describe('completion helpers', () => {
  it('finds the word under the cursor', () => {
    expect(currentWord('cat READ', 8)).toEqual({ word: 'READ', from: 4 })
    expect(currentWord('ls ', 3)).toEqual({ word: '', from: 3 })
  })

  it('knows when the word is a command position', () => {
    expect(isFirstWord('or', 0)).toBe(true)
    expect(isFirstWord('cat file', 4)).toBe(false)
    expect(isFirstWord('cat a | gr', 8)).toBe(true)
    expect(isFirstWord('true && ec', 8)).toBe(true)
  })

  it('completes command names in command position', () => {
    const reply = completeShell({
      line: 'gr',
      cursor: 2,
      cwd: '/',
      fs: new ShellFileSystem(files),
      commands: ['grep', 'groups', 'ls'],
    })
    expect(reply?.candidates).toEqual(['grep', 'groups'].sort())
    expect(reply?.from).toBe(0)
  })

  it('completes file names elsewhere and marks directories', () => {
    const reply = completeShell({
      line: 'cat s',
      cursor: 5,
      cwd: '/',
      fs: new ShellFileSystem(files),
      commands: ['cat'],
    })
    expect(reply?.candidates).toEqual(['src/'])
  })

  it('completes inside a subdirectory', () => {
    const reply = completeShell({
      line: 'cat src/i',
      cursor: 9,
      cwd: '/',
      fs: new ShellFileSystem(files),
      commands: ['cat'],
    })
    expect(reply?.candidates).toEqual(['src/index.ts'])
  })
})

describe('pager rendering', () => {
  const view = { lines: ['a', 'b', 'c', 'd'], offset: 0, height: 2, title: 'notes.txt' }

  it('shows a window of lines with a status bar', () => {
    const page = renderPage(view)
    expect(page).toContain('a')
    expect(page).toContain('b')
    expect(page).not.toContain('\r\nc')
    expect(page).toContain('notes.txt')
    expect(page).toContain('2/4')
  })

  it('maps keys to scrolling and quitting', () => {
    expect(nextOffset(view, ' ')).toBe(2)
    expect(nextOffset({ ...view, offset: 2 }, 'b')).toBe(0)
    expect(nextOffset(view, 'j')).toBe(1)
    expect(nextOffset({ ...view, offset: 1 }, 'k')).toBe(0)
    expect(nextOffset(view, 'G')).toBe(2)
    expect(nextOffset({ ...view, offset: 2 }, 'g')).toBe(0)
    expect(nextOffset(view, 'q')).toBe('quit')
    expect(nextOffset(view, '\x03')).toBe('quit')
    expect(nextOffset(view, 'x')).toBe(0)
  })

  it('never scrolls past the end', () => {
    expect(nextOffset({ ...view, offset: 2 }, ' ')).toBe(2)
  })
})

describe('shell interactive commands', () => {
  it('opens less as an interactive session and exits on q', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('less README.md', ctx)
    expect(isInteractiveRun(outcome)).toBe(true)
    if (!isInteractiveRun(outcome)) return

    expect(ctx.written.join('')).toContain('line 1')
    expect(ctx.written.join('')).toContain('README.md')

    outcome.onKey(' ')
    expect(ctx.written.join('')).toContain('line 9')

    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('pages piped input too', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('cat README.md | less', ctx)
    expect(isInteractiveRun(outcome)).toBe(true)
    if (isInteractiveRun(outcome)) outcome.onKey('q')
  })

  it('refuses to page a missing file', async () => {
    const shell = createShellBackend({ files })
    const result = (await shell.run('less nope.txt', context())) as BackendRunResult
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('no such file')
  })
})

describe('shell streaming and cancellation', () => {
  it('gives commands a live write channel', async () => {
    const shell = createShellBackend({
      commands: {
        build: async (ctx) => {
          ctx.write?.('step 1\n')
          ctx.write?.('step 2\n')
          return { exitCode: 0 }
        },
      },
    })
    const ctx = context()
    await shell.run('build', ctx)
    expect(ctx.written.join('')).toBe('step 1\nstep 2\n')
  })

  it('passes an abort signal that commands can observe', async () => {
    const aborter = new AbortController()
    const shell = createShellBackend({
      commands: {
        watch: async (ctx) => {
          aborter.abort()
          return { stdout: ctx.signal?.aborted ? 'saw abort\n' : 'missed abort\n' }
        },
      },
    })
    const result = (await shell.run('watch', context({ signal: aborter.signal }))) as BackendRunResult
    expect(result.output).toBe('saw abort')
  })

  it('stops a pipeline once the signal is aborted', async () => {
    const aborter = new AbortController()
    aborter.abort()
    const shell = createShellBackend({ files })
    const result = (await shell.run('ls; ls', context({ signal: aborter.signal }))) as BackendRunResult
    expect(result.exitCode).toBe(130)
  })
})

describe('shell completion through the backend', () => {
  it('exposes completion to the widget', async () => {
    const shell = createShellBackend({ files, cwd: '/' })
    const reply = await shell.complete?.({ line: 'cat REA', cursor: 7 })
    expect(reply?.candidates).toEqual(['README.md'])
  })

  it('offers builtins and custom commands by prefix', async () => {
    const shell = createShellBackend({ commands: { orbit: () => 'ok\n' } })
    const reply = await shell.complete?.({ line: 'or', cursor: 2 })
    expect(reply?.candidates).toContain('orbit')
  })
})

describe('shell colours', () => {
  it('paints directories in ls output when colours are on', async () => {
    const shell = createShellBackend({ files })
    const result = (await shell.run('ls', context())) as BackendRunResult
    expect(result.output).toContain('\x1b[34msrc\x1b[0m')
  })

  it('leaves output plain when colours are disabled', async () => {
    const shell = createShellBackend({ files, colors: false })
    const result = (await shell.run('ls', context())) as BackendRunResult
    expect(result.output).not.toContain('\x1b[')
  })
})
