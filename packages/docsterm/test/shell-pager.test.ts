import { getEventListeners } from 'node:events'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import type { CommandContext } from '../src/shell/context.js'
import { ShellFileSystem } from '../src/shell/fs.js'
import { createShellBackend } from '../src/shell/index.js'
import { createPager, lessCommand, nextOffset, renderPage } from '../src/shell/pager.js'
import { normalizeOutput } from '../src/text.js'
import { isInteractiveRun, type InteractiveRun, type Locale, type RunContext } from '../src/types.js'

const WIDE = ['A', 'B', 'C', 'D'].map((letter) => letter + letter.toLowerCase().repeat(39)).join('\n')

class Screen {
  readonly term: Terminal
  private readonly pending: string[] = []

  constructor(columns: number, rows: number) {
    this.term = new Terminal({ cols: columns, rows, allowProposedApi: true })
  }

  context(locale?: Locale): RunContext {
    return {
      write: (text) => this.pending.push(text),
      signal: new AbortController().signal,
      columns: this.term.cols,
      rows: this.term.rows,
      locale,
    }
  }

  async flush(extra = ''): Promise<string[]> {
    const data = this.pending.splice(0).join('') + extra
    await new Promise<void>((resolve) => this.term.write(data, resolve))
    return this.rows()
  }

  rows(): string[] {
    const buffer = this.term.buffer.active
    return Array.from({ length: this.term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  }

  get alternate(): boolean {
    return this.term.buffer.active.type === 'alternate'
  }
}

const press = async (screen: Screen, run: InteractiveRun, ...keys: string[]): Promise<string[]> => {
  for (const key of keys) await run.onKey(key)
  return screen.flush()
}

describe('alternate screen [pager-wipes-screen]', () => {
  it('draws on the alternate buffer and restores the shell output on quit', async () => {
    const screen = new Screen(20, 6)
    await screen.flush('before 1\r\nbefore 2\r\n')
    const run = createPager('a\nb\nc\n', 'notes.txt', screen.context())
    expect((await screen.flush()).slice(0, 5)).toEqual(['a', 'b', 'c', '', ''])
    expect(screen.alternate).toBe(true)
    await press(screen, run, 'q')
    expect(screen.alternate).toBe(false)
    expect(screen.rows().slice(0, 3)).toEqual(['before 1', 'before 2', ''])
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('keeps the output before less on screen and prints the rest of the line after it [shell-interactive-in-sequence]', async () => {
    const screen = new Screen(24, 5)
    const terminal = screen.context()
    const shell = createShellBackend({ files: { 'notes.txt': 'n1\nn2\n' } })
    const outcome = await shell.run('echo before; less notes.txt; echo after', {
      ...terminal,
      write: (text) => terminal.write(normalizeOutput(text)),
    })
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    expect(await screen.flush()).toEqual(['n1', 'n2', '', '', ' notes.txt 2/2 (100%) - '])
    expect(screen.alternate).toBe(true)
    await outcome.onKey('q')
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 0 })
    expect(await screen.flush()).toEqual(['before', 'after', '', '', ''])
    expect(screen.alternate).toBe(false)
  })
})

describe('visual rows [sb-20]', () => {
  it('pages by wrapped rows so a frame never scrolls the screen', async () => {
    const screen = new Screen(20, 6)
    const run = createPager(WIDE, 'wide.txt', screen.context())
    expect(await screen.flush()).toEqual([
      'Aaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaa',
      'Bbbbbbbbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbbbbbbbb',
      'Cccccccccccccccccccc',
      ' wide.txt 3/4 (63%) ',
    ])
    expect(await press(screen, run, 'G')).toEqual([
      'bbbbbbbbbbbbbbbbbbbb',
      'Cccccccccccccccccccc',
      'cccccccccccccccccccc',
      'Dddddddddddddddddddd',
      'dddddddddddddddddddd',
      ' wide.txt 4/4 (100%)',
    ])
    expect((await press(screen, run, 'g'))[0]).toBe('Aaaaaaaaaaaaaaaaaaaa')
    expect((await press(screen, run, 'j'))[0]).toBe('aaaaaaaaaaaaaaaaaaaa')
  })

  it('re-wraps and redraws on resize', async () => {
    const screen = new Screen(20, 6)
    const run = createPager(WIDE, 'wide.txt', screen.context())
    await screen.flush()
    screen.term.resize(40, 6)
    run.resize?.(40, 6)
    expect(await screen.flush()).toEqual([
      'A'.padEnd(40, 'a'),
      'B'.padEnd(40, 'b'),
      'C'.padEnd(40, 'c'),
      'D'.padEnd(40, 'd'),
      '',
      ' wide.txt 4/4 (100%) - space/b/j/k/g/G, ',
    ])
  })

  it('drops nF escapes such as tput sgr0 without leaving a visible byte', async () => {
    const screen = new Screen(4, 4)
    createPager('ab\x1b(B\x1b[mcdef\n\x1b)0\x1b#8gh\n', 'x', screen.context())
    expect((await screen.flush()).slice(0, 3)).toEqual(['abcd', 'ef', 'gh'])
  })

  it('wraps wide characters whole, expands tabs and keeps colours per row', async () => {
    const screen = new Screen(20, 8)
    createPager(`x${'日'.repeat(10)}\na\tb\n\x1b[31m${'r'.repeat(30)}\x1b[0m\nz\x1b[2J\x07\r`, 'mix.txt', screen.context())
    const rows = await screen.flush()
    expect(rows.slice(0, 7)).toEqual([`x${'日'.repeat(9)}`, '日', 'a       b', 'r'.repeat(20), 'r'.repeat(10), 'z', ''])
    const buffer = screen.term.buffer.active
    expect(buffer.getLine(4)?.getCell(0)?.getFgColor()).toBe(1)
    expect(buffer.getLine(4)?.getCell(12)?.isFgDefault()).toBe(true)
  })
})

describe('status line and keys [sb-23]', () => {
  it('cuts the status line to the terminal width and localizes the hint', async () => {
    const narrow = new Screen(40, 4)
    createPager('one\ntwo\n', 'notes.txt', narrow.context('ru'))
    expect(await narrow.flush()).toEqual(['one', 'two', '', ' notes.txt 2/2 (100%) - пробел/b/j/k/g/G'])
    const wide = new Screen(80, 4)
    createPager('one\ntwo\n', 'notes.txt', wide.context('ru'))
    expect((await wide.flush())[3]).toBe(' notes.txt 2/2 (100%) - пробел/b/j/k/g/G, q - выход ')
  })

  it('maps the less key set to movements', () => {
    const view = { lines: Array.from({ length: 10 }, (_, index) => `line ${index}`), offset: 0, height: 4, title: 't' }
    const at = (offset: number) => ({ ...view, offset })
    expect(nextOffset(view, 'd')).toBe(2)
    expect(nextOffset(view, '\x04')).toBe(2)
    expect(nextOffset(at(4), 'u')).toBe(2)
    expect(nextOffset(view, '\x1b[6~')).toBe(4)
    expect(nextOffset(at(4), '\x1b[5~')).toBe(0)
    expect(nextOffset(view, '\x1b[B')).toBe(1)
    expect(nextOffset(view, '\x1bOB')).toBe(1)
    expect(nextOffset(view, '\r')).toBe(1)
    expect(nextOffset(at(1), '\x1b[A')).toBe(0)
    expect(nextOffset(at(4), '\x1b[H')).toBe(0)
    expect(nextOffset(view, '\x1b[F')).toBe(6)
    expect(nextOffset(view, '\x1b[4~')).toBe(6)
    expect(nextOffset(view, 'Q')).toBe('quit')
    expect(nextOffset(view, 'ZZ')).toBe('quit')
    expect(nextOffset(view, 'Z')).toBe(0)
  })

  it('quits on Q, on ZZ typed as two keys or one chunk, and on Ctrl+C', async () => {
    for (const keys of [['Q'], ['Z', 'Z'], ['ZZ'], ['\x03']]) {
      const screen = new Screen(20, 6)
      const run = createPager('a\nb\n', 'x', screen.context())
      await screen.flush()
      await press(screen, run, ...keys)
      expect(screen.alternate, keys.join('+')).toBe(false)
      await expect(run.done).resolves.toEqual({ output: '', exitCode: 0 })
    }
  })

  it('ignores a single Z, also two Z keys with another key between them, and leaves the alternate screen on cancel', async () => {
    const screen = new Screen(20, 6)
    const run = createPager('a\nb\n', 'x', screen.context())
    await press(screen, run, 'Z', 'j', 'Z')
    expect(screen.alternate).toBe(true)
    run.cancel?.()
    await screen.flush()
    expect(screen.alternate).toBe(false)
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 130 })
  })

  it('leaves the alternate screen and settles with 130 when the run signal aborts', async () => {
    const screen = new Screen(20, 6)
    const controller = new AbortController()
    const run = createPager('a\nb\n', 'x', { ...screen.context(), signal: controller.signal })
    await screen.flush()
    expect(screen.alternate).toBe(true)
    controller.abort()
    await screen.flush()
    expect(screen.alternate).toBe(false)
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 130 })
  })

  it('never opens for an aborted signal and stops listening once it has quit', async () => {
    const writes: string[] = []
    const aborted = new AbortController()
    aborted.abort()
    const context = { write: (text: string) => writes.push(text), columns: 20, rows: 6 }
    const skipped = createPager('a\n', 'x', { ...context, signal: aborted.signal })
    expect(writes).toEqual([])
    await expect(skipped.done).resolves.toEqual({ output: '', exitCode: 130 })
    const live = new AbortController()
    const run = createPager('a\n', 'x', { ...context, signal: live.signal })
    expect(getEventListeners(live.signal, 'abort')).toHaveLength(1)
    await run.onKey('q')
    expect(getEventListeners(live.signal, 'abort')).toHaveLength(0)
    await expect(run.done).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('leaves the alternate screen when the shell run that opened it is aborted', async () => {
    const screen = new Screen(24, 5)
    const controller = new AbortController()
    const terminal = { ...screen.context(), signal: controller.signal }
    const shell = createShellBackend({ files: { 'notes.txt': 'n1\nn2\n' } })
    const outcome = await shell.run('less notes.txt', { ...terminal, write: (text) => terminal.write(normalizeOutput(text)) })
    if (!isInteractiveRun(outcome)) throw new Error('expected the pager')
    await screen.flush()
    expect(screen.alternate).toBe(true)
    controller.abort()
    await screen.flush()
    expect(screen.alternate).toBe(false)
    await expect(outcome.done).resolves.toEqual({ output: '', exitCode: 130 })
  })

  it('keeps the plain renderPage contract', () => {
    const page = renderPage({ lines: ['a', 'b', 'c'], offset: 0, height: 2, title: '\x1b[31mevil\x07' })
    expect(page).toBe('\x1b[H\x1b[2Ja\r\nb\r\n\x1b[7m evil 2/3 (67%) - space/b/j/k/g/G, q to quit \x1b[0m')
  })
})

describe('less and more arguments [sb-22]', () => {
  const fs = new ShellFileSystem({
    project: { 'README.md': '# demo\nline two\n', src: { 'index.ts': 'export {}\n' } },
  })
  const command = (argv: string[], stdin = '', errors?: string[]): CommandContext => ({
    argv,
    stdin,
    cwd: '/project',
    env: {},
    fs,
    setCwd: () => {},
    ...(errors ? { writeError: (text: string) => errors.push(text) } : {}),
  })
  const open = async (argv: string[], stdin = '', errors?: string[]): Promise<{ rows: string[]; writes: string[] }> => {
    const screen = new Screen(30, 5)
    const writes: string[] = []
    const context = screen.context()
    const outcome = lessCommand(command(argv, stdin, errors), {
      ...context,
      write: (text) => {
        writes.push(text)
        context.write(text)
      },
    })
    if (!isInteractiveRun(outcome as InteractiveRun)) throw new Error(`expected a pager for ${argv.join(' ')}`)
    return { rows: await screen.flush(), writes }
  }

  it('accepts and ignores the common options', async () => {
    for (const argv of [['less', '-N', 'README.md'], ['less', '-S', '-R', '+G', 'README.md'], ['more', '-d', 'README.md']]) {
      expect((await open(argv)).rows.slice(0, 2), argv.join(' ')).toEqual(['# demo', 'line two'])
    }
  })

  it('pages piped input and the first readable file', async () => {
    expect((await open(['less'], 'piped\n')).rows[0]).toBe('piped')
    const errors: string[] = []
    const skipped = await open(['less', 'nope.txt', 'README.md'], '', errors)
    expect(errors).toEqual(['less: nope.txt: No such file or directory\n'])
    expect(skipped.writes[0]).toBe('\x1b[?1049h')
    expect(skipped.rows.slice(0, 2)).toEqual(['# demo', 'line two'])
    const bare = await open(['less', 'nope.txt', 'README.md'])
    expect(bare.writes[0]).toBe('less: nope.txt: No such file or directory\r\n')
  })

  it('reports skipped operands on stderr so redirections apply', async () => {
    const page = async (line: string): Promise<{ rows: string[]; errors: string }> => {
      const screen = new Screen(60, 4)
      const terminal = screen.context()
      const shell = createShellBackend({ files: { 'notes.txt': 'n1\n' } })
      const outcome = await shell.run(line, { ...terminal, write: (text) => terminal.write(normalizeOutput(text)) })
      if (!isInteractiveRun(outcome)) throw new Error(`expected the pager for ${line}`)
      await outcome.onKey('q')
      await outcome.done
      const saved = await shell.run('cat err.txt 2>/dev/null')
      return { rows: await screen.flush(), errors: isInteractiveRun(saved) ? '' : saved.output }
    }
    expect(await page('less nope.txt notes.txt')).toEqual({
      rows: ['less: nope.txt: No such file or directory', '', '', ''],
      errors: '',
    })
    expect(await page('less nope.txt notes.txt 2>/dev/null')).toEqual({ rows: ['', '', '', ''], errors: '' })
    expect(await page('less nope.txt notes.txt 2>err.txt')).toEqual({
      rows: ['', '', '', ''],
      errors: 'less: nope.txt: No such file or directory',
    })
  })

  it('reports directories, missing names, bad options and a missing terminal', () => {
    const run = new Screen(30, 5).context()
    expect(lessCommand(command(['less', 'src']), run)).toEqual({ stderr: 'less: src: Is a directory\n', exitCode: 1 })
    expect(lessCommand(command(['less']), run)).toEqual({ stderr: 'less: missing filename\n', exitCode: 1 })
    expect(lessCommand(command(['more', 'nope.txt']), run)).toEqual({
      stderr: 'more: nope.txt: No such file or directory\n',
      exitCode: 1,
    })
    expect(lessCommand(command(['less', '-Z', 'README.md']), run)).toEqual({
      stderr: "less: invalid option -- 'Z'\n",
      exitCode: 2,
    })
    expect(lessCommand(command(['less', 'README.md']), undefined)).toEqual({
      stderr: 'less: needs an interactive terminal\n',
      exitCode: 1,
    })
    expect(lessCommand({ ...command(['more', 'README.md']), locale: 'ru' }, undefined)).toEqual({
      stderr: 'more: нужен интерактивный терминал\n',
      exitCode: 1,
    })
  })

  it('opens +G at the last page and +NUMBER at that line', async () => {
    const long = Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join('\n')
    const screen = new Screen(30, 5)
    const pager = createPager(long, 'long.txt', screen.context(), 'end')
    expect((await screen.flush()).slice(0, 4)).toEqual(['row 9', 'row 10', 'row 11', 'row 12'])
    await press(screen, pager, 'q')
    const numbered = createPager(long, 'long.txt', screen.context(), 3)
    expect((await screen.flush()).slice(0, 4)).toEqual(['row 3', 'row 4', 'row 5', 'row 6'])
    await press(screen, numbered, 'q')
  })
})
