import { describe, expect, it, vi } from 'vitest'
import { getMessages } from '../src/messages.js'
import { builtins } from '../src/shell/builtins.js'
import { completeShell, currentWord, isFirstWord } from '../src/shell/complete.js'
import type { CommandContext, ShellCommand } from '../src/shell/context.js'
import { ShellFileSystem } from '../src/shell/fs.js'
import { createShellBackend, type ShellBackendOptions } from '../src/shell/index.js'
import { nextOffset, renderPage } from '../src/shell/pager.js'
import { isInteractiveRun, type BackendRunResult, type InteractiveRun, type RunContext } from '../src/types.js'

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const PIPED = 'less: interactive commands cannot be piped\n'

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
    const screen = (page: string) => {
      const [clear, rest] = [page.slice(0, 7), page.slice(7)]
      return { clear, rows: rest.split('\r\n') }
    }
    const status = (text: string) => `\x1b[7m ${text} - ${getMessages('en').pagerHint} \x1b[0m`
    expect(screen(renderPage(view))).toEqual({ clear: '\x1b[H\x1b[2J', rows: ['a', 'b', status('notes.txt 2/4 (50%)')] })
    expect(screen(renderPage({ ...view, offset: 2 }))).toEqual({
      clear: '\x1b[H\x1b[2J',
      rows: ['c', 'd', status('notes.txt 4/4 (100%)')],
    })
    expect(screen(renderPage({ ...view, height: 5 })).rows).toEqual(['a', 'b', 'c', 'd', '', status('notes.txt 4/4 (100%)')])
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
    const drawn = ctx.written.length
    outcome.onKey(' ')
    expect(ctx.written.slice(drawn).join('')).toContain('line 10')

    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('pages piped input too', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('cat regions.csv | less', ctx)
    expect(isInteractiveRun(outcome)).toBe(true)
    if (!isInteractiveRun(outcome)) return
    expect(ctx.written.join('')).toContain('alpha,eu')
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('refuses to page a missing file', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const result = (await shell.run('less nope.txt', ctx)) as BackendRunResult
    expect(result).toEqual({ output: '', exitCode: 1 })
    expect(ctx.written.join('')).toMatch(/^less: nope\.txt: no such file or directory\n$/i)
  })

  it('prints what ran before the pager first', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('echo before; less README.md', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    expect(ctx.written[0]).toBe('before\n')
    expect(ctx.written.length).toBeGreaterThan(1)
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('runs the rest of the line after the pager quits', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('less README.md; echo after && echo and > done.txt', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    await flush()
    expect(ctx.written).not.toContain('after\n')
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
    expect(ctx.written.at(-1)).toBe('after\n')
    const check = context()
    await shell.run('cat done.txt', check)
    expect(check.written).toEqual(['and\n'])
  })

  it('refuses a pager in the middle of a pipeline before drawing anything', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const result = await shell.run('less README.md | wc -l', ctx)
    expect(result).toEqual({ output: '', exitCode: 1 })
    expect(ctx.written).toEqual([PIPED])
  })

  it('refuses a pager whose output is captured by a substitution', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const result = await shell.run('echo $(less README.md)', ctx)
    expect(isInteractiveRun(result)).toBe(false)
    expect(ctx.written.join('')).toBe(`${PIPED}\n`)
  })

  it('copies files through like less on a non-terminal when stdout is redirected to a file', async () => {
    const shell = createShellBackend({ files })
    const lines = async (line: string): Promise<{ result: unknown; written: string[] }> => {
      const ctx = context()
      return { result: await shell.run(line, ctx), written: ctx.written }
    }
    expect(await lines('less README.md > page.txt')).toEqual({ result: { output: '', exitCode: 0 }, written: [] })
    expect(await lines('cat page.txt | wc -l')).toEqual({ result: { output: '', exitCode: 0 }, written: ['39\n'] })
    expect(await lines('cat regions.csv | less > piped.txt; cat piped.txt')).toEqual({
      result: { output: '', exitCode: 0 },
      written: ['name,region\nalpha,eu\nbeta,us\n'],
    })
    expect(await lines('more regions.csv src/index.ts > both.txt; cat both.txt')).toEqual({
      result: { output: '', exitCode: 0 },
      written: [
        '::::::::::::::\nregions.csv\n::::::::::::::\nname,region\nalpha,eu\nbeta,us\n' +
          '::::::::::::::\nsrc/index.ts\n::::::::::::::\nexport const answer = 42\n',
      ],
    })
    expect(await lines('less nope.txt regions.csv > out.txt; cat out.txt')).toEqual({
      result: { output: '', exitCode: 0 },
      written: ['less: nope.txt: No such file or directory\n', 'name,region\nalpha,eu\nbeta,us\n'],
    })
    expect(await lines('less src > out.txt')).toEqual({
      result: { output: '', exitCode: 1 },
      written: ['less: src: Is a directory\n'],
    })
    expect(await lines('less > out.txt')).toEqual({
      result: { output: '', exitCode: 1 },
      written: ['less: missing filename\n'],
    })
  })

  it('pages piped stdin even when it is empty, but wants a file name when stdin is the terminal', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('true | less', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager for an empty pipe')
    expect(ctx.written.join('')).toContain(' stdin 1/1 (100%)')
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
    const redirected = context()
    const fromFile = await shell.run('less < regions.csv', redirected)
    if (!isInteractiveRun(fromFile)) throw new Error('expected the pager for a redirected stdin')
    expect(redirected.written.join('')).toContain('alpha,eu')
    fromFile.onKey('q')
    await fromFile.done
    const bare = context()
    expect(await shell.run('less', bare)).toEqual({ output: '', exitCode: 1 })
    expect(bare.written).toEqual(['less: missing filename\n'])
  })

  it('opens at the end for +G and at a line for +NUMBER', async () => {
    const shell = createShellBackend({ files })
    const firstRow = async (line: string): Promise<string> => {
      const ctx = context()
      const outcome = await shell.run(line, ctx)
      if (!isInteractiveRun(outcome)) throw new Error(`expected the pager for ${line}`)
      const frame = ctx.written.join('')
      outcome.onKey('q')
      await outcome.done
      return frame.slice(frame.indexOf('\x1b[H\x1b[2J') + 7).split('\r\n')[0] ?? ''
    }
    expect(await firstRow('less +G README.md')).toBe('line 32')
    expect(await firstRow('less +5 README.md')).toBe('line 5')
    expect(await firstRow('less +g README.md')).toBe('line 1')
    expect(await firstRow('cat README.md | less +G')).toBe('line 32')
  })

  it('keeps a resize made during the first pager for the second one on the line', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('less README.md; less regions.csv', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    outcome.resize?.(40, 6)
    outcome.onKey('q')
    await flush()
    const frames = ctx.written.join('').split('\x1b[H\x1b[2J')
    const last = frames.at(-1) ?? ''
    expect(last.split('\r\n')).toHaveLength(6)
    expect(last).toContain('alpha,eu')
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('hands keys typed between two programs to the next one', async () => {
    let release = () => {}
    const shell = createShellBackend({
      files,
      commands: {
        block: () =>
          new Promise((resolve) => {
            release = () => resolve({})
          }),
      },
    })
    const ctx = context()
    const outcome = await shell.run('less regions.csv; block; less README.md', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    outcome.onKey('q')
    await flush()
    outcome.onKey('G')
    const before = ctx.written.length
    release()
    await flush()
    expect(ctx.written.slice(before).join('')).toContain('line 40')
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('hands keys to the next pager on the same line', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('less README.md; less regions.csv', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    outcome.onKey('q')
    await flush()
    const drawn = ctx.written.length
    expect(ctx.written.join('')).toContain('alpha,eu')
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
    expect(ctx.written.length).toBeGreaterThan(drawn)
  })

  it('forwards resizes to the running pager', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('echo before; less README.md', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    const drawn = ctx.written.length
    outcome.resize?.(40, 6)
    expect(ctx.written.length).toBeGreaterThan(drawn)
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('cancel abandons the rest of the line', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('less README.md; echo after', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    outcome.cancel?.()
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
    expect(ctx.written).not.toContain('after\n')
  })

  it('stops waiting for the pager when the run is aborted', async () => {
    const shell = createShellBackend({ files })
    const aborter = new AbortController()
    const ctx = context({ signal: aborter.signal })
    const outcome = await shell.run('less README.md; echo after', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    aborter.abort()
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
    expect(ctx.written).not.toContain('after\n')
  })

  it('leaves the alternate screen when the host aborts the run while a pager is open', async () => {
    const shell = createShellBackend({ files })
    const aborter = new AbortController()
    const ctx = context({ signal: aborter.signal })
    const outcome = await shell.run('less README.md; echo after', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    const drawn = ctx.written.length
    aborter.abort()
    expect(ctx.written.slice(drawn)).toEqual(['\x1b[?1049l'])
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
    await flush()
    expect(ctx.written.slice(drawn)).toEqual(['\x1b[?1049l'])
  })

  it('Ctrl+C in the pager closes it and drops the rest of the line', async () => {
    const shell = createShellBackend({ files: { ...files, 'notes.md': 'n1\nn2\n' } })
    const ctx = context()
    const outcome = await shell.run('less notes.md; touch after.txt', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    const drawn = ctx.written.length
    outcome.onKey('\x03')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
    await flush()
    expect(ctx.written.slice(drawn)).toEqual(['\x1b[?1049l', '^C\n'])
    const check = context()
    await shell.run('echo $?; echo *', check)
    expect(check.written).toEqual(['130\n', 'notes.md README.md regions.csv src\n'])
  })

  it('Ctrl+C after the pager quit aborts the running command and the rest of the line', async () => {
    const signals: AbortSignal[] = []
    const shell = createShellBackend({
      files,
      commands: {
        block: (ctx) =>
          new Promise((resolve) => {
            if (ctx.signal) signals.push(ctx.signal)
            ctx.signal?.addEventListener('abort', () => resolve({ stdout: 'too late\n' }))
          }),
      },
    })
    const ctx = context()
    const outcome = await shell.run('less README.md; block; touch after.txt', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    outcome.onKey('q')
    await flush()
    expect(signals.map((signal) => signal.aborted)).toEqual([false])
    const before = ctx.written.length
    outcome.onKey('\x03')
    expect(signals.map((signal) => signal.aborted)).toEqual([true])
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
    await flush()
    expect(ctx.written.slice(before)).toEqual(['^C\n'])
    const check = context()
    await shell.run('echo $?; echo *', check)
    expect(check.written).toEqual(['130\n', 'README.md regions.csv src\n'])
  })
})

describe('custom interactive commands', () => {
  const program =
    (log: string[]): ShellCommand =>
    (ctx: CommandContext) => {
      ctx.write?.('opened\n')
      let finish: (result: BackendRunResult) => void = () => {}
      const done = new Promise<BackendRunResult>((resolve) => {
        finish = resolve
      })
      const run: InteractiveRun = {
        onKey: (data) => {
          log.push(data)
          if (data === 'q') finish({ output: 'closed\n', exitCode: 0 })
        },
        resize: (columns, rows) => {
          log.push(`${columns}x${rows}`)
        },
        cancel: () => {
          log.push('cancel')
          ctx.write?.('restored\n')
          finish({ output: '', exitCode: 130 })
        },
        done,
      }
      return run
    }

  it('drives a custom program like the pager and runs the rest of the line after it', async () => {
    const log: string[] = []
    const shell = createShellBackend({ commands: { prog: program(log) } })
    const ctx = context()
    const outcome = await shell.run('echo before; prog; echo after', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the program')
    await flush()
    expect(ctx.written).toEqual(['before\n', 'opened\n'])
    outcome.onKey('x')
    outcome.resize?.(40, 6)
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
    expect(log).toEqual(['x', '40x6', 'q'])
    expect(ctx.written).toEqual(['before\n', 'opened\n', 'closed\n', 'after\n'])
  })

  it('Ctrl+C cancels a custom program and drops the rest of the line', async () => {
    const log: string[] = []
    const shell = createShellBackend({ commands: { prog: program(log) } })
    const ctx = context()
    const outcome = await shell.run('prog; echo after', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the program')
    outcome.onKey('\x03')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
    await flush()
    expect(log).toEqual(['cancel'])
    expect(ctx.written).toEqual(['opened\n', 'restored\n', '^C\n'])
  })

  it('hands Ctrl+C to a program without cancel() before stopping the line', async () => {
    const log: string[] = []
    const plain: ShellCommand = (ctx) => {
      ctx.write?.('opened\n')
      let finish: (result: BackendRunResult) => void = () => {}
      const done = new Promise<BackendRunResult>((resolve) => {
        finish = resolve
      })
      return {
        onKey: (data: string) => {
          log.push(data)
          if (data === '\x03') {
            ctx.write?.('bye\n')
            finish({ output: '', exitCode: 130 })
          }
        },
        done,
      }
    }
    const shell = createShellBackend({ commands: { plain } })
    const ctx = context()
    const outcome = await shell.run('plain; echo after', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the program')
    outcome.onKey('ab\x03cd')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
    await flush()
    expect(log).toEqual(['ab', '\x03'])
    expect(ctx.written).toEqual(['opened\n', 'bye\n', '^C\n'])
  })

  it('wraps the exit status a custom program reports when it finishes', async () => {
    const shell = createShellBackend({
      commands: {
        prog: () => ({
          onKey: () => {},
          done: Promise.resolve({ output: '', exitCode: 300 }),
        }),
      },
    })
    const ctx = context()
    const outcome = await shell.run('prog', ctx)
    const result = isInteractiveRun(outcome) ? await outcome.done : outcome
    expect(result).toEqual({ output: '', exitCode: 44 })
    const check = context()
    await shell.run('echo $?', check)
    expect(check.written).toEqual(['44\n'])
  })

  it('cancels a custom program when the host aborts the run or the shell is disposed', async () => {
    const log: string[] = []
    const shell = createShellBackend({ commands: { prog: program(log) } })
    const aborter = new AbortController()
    const aborted = context({ signal: aborter.signal })
    const first = await shell.run('prog; echo after', aborted)
    if (!isInteractiveRun(first)) throw new Error('expected the program')
    aborter.abort()
    expect(log).toEqual(['cancel'])
    await expect(first.done).resolves.toEqual({ output: '', exitCode: 130 })
    const disposed = context()
    const second = await shell.run('prog; echo after', disposed)
    if (!isInteractiveRun(second)) throw new Error('expected the program')
    shell.dispose()
    expect(log).toEqual(['cancel', 'cancel'])
    await expect(second.done).resolves.toEqual({ output: '', exitCode: 130 })
    await flush()
    expect([aborted.written, disposed.written]).toEqual([
      ['opened\n', 'restored\n'],
      ['opened\n', 'restored\n'],
    ])
  })

  it('refuses and cancels a custom program whose output does not reach the terminal', async () => {
    const log: string[] = []
    const shell = createShellBackend({ commands: { prog: program(log) } })
    const refusal = 'prog: interactive commands cannot be piped\n'
    const piped = context()
    expect(await shell.run('prog | cat', piped)).toEqual({ output: '', exitCode: 1 })
    expect(piped.written).toEqual([refusal])
    const captured = context()
    expect(await shell.run('echo "[$(prog)]"', captured)).toEqual({ output: '', exitCode: 0 })
    expect(captured.written).toEqual([refusal, '[opened\nrestored]\n'])
    expect(log).toEqual(['cancel', 'cancel'])
  })
})

describe('shell run lifecycle', () => {
  it('dispose aborts every in-flight command and nothing reaches the screen afterwards', async () => {
    const started: Array<{ signal: AbortSignal | undefined; finish(): void }> = []
    const shell = createShellBackend({
      commands: {
        long: (ctx) => {
          ctx.write?.('working\n')
          return new Promise((resolve) => {
            started.push({
              signal: ctx.signal,
              finish: () => {
                ctx.write?.('late write\n')
                resolve({ stdout: 'late result\n' })
              },
            })
          })
        },
      },
    })
    const first = context()
    const second = context()
    const third = context()
    const runs = [shell.run('long; echo after', first), shell.run('long', second), shell.run('long > log.txt', third)]
    await flush()
    expect(started.map((entry) => entry.signal?.aborted)).toEqual([false, false, false])
    shell.dispose()
    expect(started.map((entry) => entry.signal?.aborted)).toEqual([true, true, true])
    await expect(Promise.all(runs)).resolves.toEqual([
      { output: '', exitCode: 130 },
      { output: '', exitCode: 130 },
      { output: '', exitCode: 130 },
    ])
    for (const entry of started) entry.finish()
    await flush()
    expect([first.written, second.written, third.written]).toEqual([['working\n'], ['working\n'], []])
    expect([first.signal.aborted, second.signal.aborted, third.signal.aborted]).toEqual([false, false, false])
    const check = context()
    await shell.run('cat log.txt', check)
    expect(check.written).toEqual(['working\n'])
  })

  it.each(['X=$(stopper) probe', 'probe > "$(stopper)"', 'X=$(stopper) nosuch'])(
    'never starts a command or reports on it once the run was stopped while expanding %j',
    async (line) => {
      const aborter = new AbortController()
      const calls: string[] = []
      const shell = createShellBackend({
        commands: {
          stopper: () => {
            aborter.abort()
            return 'value\n'
          },
          probe: () => {
            calls.push('probe')
            return 'ran\n'
          },
        },
      })
      const ctx = context({ signal: aborter.signal })
      expect(await shell.run(line, ctx)).toEqual({ output: '', exitCode: 130 })
      await flush()
      await flush()
      expect(calls).toEqual([])
      expect(ctx.written).toEqual([])
    },
  )

  it('ignores cancel and Ctrl+C once the line has finished', async () => {
    const shell = createShellBackend({ files })
    const ctx = context()
    const outcome = await shell.run('less README.md; false', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 1 })
    const finished = ctx.written.length
    outcome.cancel?.()
    outcome.onKey('\x03')
    expect(ctx.written.length).toBe(finished)
    const check = context()
    await shell.run('echo $?', check)
    expect(check.written).toEqual(['1\n'])
  })

  it('removes its abort listener when a run settles, so a later abort leaves $? alone', async () => {
    const aborter = new AbortController()
    const added = vi.spyOn(aborter.signal, 'addEventListener')
    const removed = vi.spyOn(aborter.signal, 'removeEventListener')
    const shell = createShellBackend({ files })
    const ctx = context({ signal: aborter.signal })
    await shell.run('true', ctx)
    const outcome = await shell.run('less README.md; false', ctx)
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    outcome.onKey('q')
    await outcome.done
    const listeners = (calls: ReadonlyArray<readonly unknown[]>): unknown[] => calls.map((call) => call[1])
    expect(added.mock.calls.length).toBeGreaterThan(0)
    expect(removed.mock.calls.length).toBe(added.mock.calls.length)
    for (const listener of listeners(added.mock.calls)) expect(listeners(removed.mock.calls)).toContain(listener)
    aborter.abort()
    const check = context()
    await shell.run('echo $?', check)
    expect(check.written).toEqual(['1\n'])
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
    await expect(shell.run('build', ctx)).resolves.toEqual({ output: '', exitCode: 0 })
    expect(ctx.written).toEqual(['step 1\n', 'step 2\n'])
  })

  it('passes an abort signal that commands can observe', async () => {
    const aborter = new AbortController()
    let observed: boolean | undefined
    const shell = createShellBackend({
      commands: {
        watch: async (ctx) => {
          ctx.write?.('before the abort\n')
          aborter.abort()
          observed = ctx.signal?.aborted
          ctx.write?.('after the abort\n')
          return { stdout: 'result after the abort\n' }
        },
      },
    })
    const ctx = context({ signal: aborter.signal })
    const result = await shell.run('watch; echo never', ctx)
    expect(result).toEqual({ output: '', exitCode: 130 })
    expect(observed).toBe(true)
    expect(ctx.written).toEqual(['before the abort\n'])
  })

  it('reports 130 after an interrupt and never lets a late run overwrite a newer $?', async () => {
    let release = () => {}
    const shell = createShellBackend({
      commands: {
        slow: () =>
          new Promise((resolve) => {
            release = () => resolve({})
          }),
      },
    })
    const aborter = new AbortController()
    const abandoned = shell.run('slow; echo late', context({ signal: aborter.signal }))
    await flush()
    aborter.abort()
    const afterInterrupt = context()
    await shell.run('echo $?', afterInterrupt)
    expect(afterInterrupt.written).toEqual(['130\n'])
    await shell.run('true', context())
    release()
    await expect(abandoned).resolves.toEqual({ output: '', exitCode: 130 })
    const latest = context()
    await shell.run('echo $?', latest)
    expect(latest.written).toEqual(['0\n'])
  })

  it('dispose stops in-flight runs and init brings the shell back', async () => {
    let release = () => {}
    const shell = createShellBackend({
      commands: {
        slow: () =>
          new Promise((resolve) => {
            release = () => resolve({})
          }),
      },
    })
    const ctx = context()
    const pending = shell.run('slow; echo after', ctx)
    await flush()
    shell.dispose()
    release()
    await expect(pending).resolves.toEqual({ output: '', exitCode: 130 })
    expect(ctx.written).toEqual([])
    await shell.init({ write: () => {} })
    const next = context()
    await expect(shell.run('echo again', next)).resolves.toEqual({ output: '', exitCode: 0 })
    expect(next.written).toEqual(['again\n'])
  })

  it('stops a pipeline once the signal is aborted', async () => {
    const aborter = new AbortController()
    aborter.abort()
    const shell = createShellBackend({ files })
    const ctx = context({ signal: aborter.signal })
    const result = (await shell.run('ls; ls', ctx)) as BackendRunResult
    expect(result.exitCode).toBe(130)
    expect(ctx.written).toEqual([])
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
    expect(reply?.candidates).toEqual(['orbit'])
  })

  it('completes paths under ~ from the shell HOME', async () => {
    const shell = createShellBackend({ files: { home: { reader: { 'notes.txt': 'x\n' } } }, env: { HOME: '/home/reader' } })
    const reply = await shell.complete?.({ line: 'cat ~/no', cursor: 8 })
    expect(reply?.candidates).toEqual(['~/notes.txt'])
  })

  it('offers the shell commands and the widget builtins', async () => {
    const shell = createShellBackend()
    const candidates = async (line: string) => (await shell.complete?.({ line, cursor: line.length }))?.candidates
    expect(await candidates('cl')).toEqual(['clear'])
    expect(await candidates('hel')).toEqual(['help'])
    expect(await candidates('hi')).toEqual(['history'])
    expect(await candidates('expl')).toEqual(['explain'])
    expect(await candidates('mo')).toEqual(['more'])
  })

  it('offers the widget builtins only where the widget runs them: as the whole line', async () => {
    const shell = createShellBackend()
    const reply = async (line: string, cursor = line.length) => (await shell.complete?.({ line, cursor }))?.candidates
    expect(await reply('  hi')).toEqual(['history'])
    expect(await reply('ls | hi')).toBeUndefined()
    expect(await reply('true; expl')).toBeUndefined()
    expect(await reply('FOO=1 hi')).toBeUndefined()
    expect(await reply('hi | grep x', 2)).toBeUndefined()
    expect(await reply('hel | cat', 3)).toEqual(['help'])
  })
})

describe('command context', () => {
  const probeShell = (options: ShellBackendOptions = {}) => {
    const seen: CommandContext[] = []
    const shell = createShellBackend({
      files,
      cwd: '/',
      ...options,
      commands: {
        probe: (ctx) => {
          seen.push(ctx)
          return {}
        },
        ...options.commands,
      },
    })
    return { shell, seen }
  }

  it('describes a terminal-bound command', async () => {
    const { shell, seen } = probeShell()
    const ctx = context({ columns: 57, locale: 'ru' })
    await shell.run('false; probe one', ctx)
    const [probe] = seen
    expect(probe?.argv).toEqual(['probe', 'one'])
    expect([probe?.isTTY, probe?.colors, probe?.columns, probe?.locale, probe?.lastStatus]).toEqual([
      true,
      true,
      57,
      'ru',
      1,
    ])
    expect(probe?.signal).toBeInstanceOf(AbortSignal)
    expect(probe?.signal?.aborted).toBe(false)
    expect(probe?.commands).toEqual(
      [...new Set([...Object.keys(builtins), 'clear', 'help', 'less', 'more', 'probe'])].sort(),
    )
  })

  it('turns the terminal flags off when output is piped, redirected or captured', async () => {
    const { shell, seen } = probeShell()
    await shell.run('probe | cat; probe > out.txt; echo $(probe); probe 2>/dev/null', context())
    expect(seen.map((ctx) => [ctx.isTTY, ctx.colors])).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [true, true],
    ])
  })

  it('never asks for colours when the option is off', async () => {
    const { shell, seen } = probeShell({ colors: false })
    await shell.run('probe', context())
    expect([seen[0]?.isTTY, seen[0]?.colors]).toEqual([true, false])
  })

  it('gives prefix assignments a private environment', async () => {
    const { shell, seen } = probeShell()
    await shell.run('GREETING=hi probe; probe', context())
    expect(seen[0]?.env.GREETING).toBe('hi')
    expect(seen[1]?.env.GREETING).toBeUndefined()
  })

  it('keeps PWD and OLDPWD in step with setCwd', async () => {
    const { shell, seen } = probeShell({
      commands: {
        jump: (ctx) => {
          ctx.setCwd('/src/')
          return {}
        },
      },
    })
    await shell.run('jump; probe', context())
    expect(shell.prompt).toBe('/src $ ')
    expect([seen[0]?.cwd, seen[0]?.env.PWD, seen[0]?.env.OLDPWD]).toEqual(['/src', '/src', '/'])
  })
})
