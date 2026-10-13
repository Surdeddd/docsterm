import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { beforeAll, describe, expect, it } from 'vitest'
import { moveToBlockEnd, renderLine, wrapText } from '../src/line-render.js'
import { loadXtermCodePointWidth, type CodePointWidth } from '../src/width.js'

let xtermWidth: CodePointWidth

beforeAll(async () => {
  xtermWidth = await loadXtermCodePointWidth()
})

describe('wrapText', () => {
  it('breaks between words and splits only a word longer than the line', () => {
    expect(wrapText('one two three four', 9)).toBe('one two\nthree\nfour')
    expect(wrapText('see https://example.test/long/path ok', 10)).toBe('see\nhttps://ex\nample.test\n/long/path\nok')
    expect(wrapText('exactly ten', 11)).toBe('exactly ten')
    expect(wrapText('first line\n\nnext line', 8)).toBe('first\nline\n\nnext\nline')
  })

  it('counts wide characters by the cells the terminal gives them and never splits a grapheme', () => {
    expect(wrapText('漢字 漢字漢字 x', 6, xtermWidth)).toBe('漢字\n漢字漢\n字 x')
    expect(wrapText('👍🏽👍🏽👍🏽', 8, xtermWidth)).toBe('👍🏽👍🏽\n👍🏽')
    expect(wrapText('👍🏽👍🏽👍🏽', 4, xtermWidth)).toBe('👍🏽\n👍🏽\n👍🏽')
    expect(wrapText('ééé éééé', 3)).toBe('ééé\nééé\né')
  })

  it('leaves the text alone for an unusable width or a huge text', () => {
    expect(wrapText('a b', 0)).toBe('a b')
    expect(wrapText('a b', Number.NaN)).toBe('a b')
    const huge = 'word '.repeat(2001)
    expect(wrapText(huge, 20)).toBe(huge)
  })
})

const render = (buffer: string, cursor: number, columns: number, previousRow = 0) =>
  renderLine({ prompt: '$ ', buffer, cursor, columns, previousRow })

const createTerminal = (cols: number, rows: number) => {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  return term
}

const flush = (term: Terminal) => new Promise<void>((resolve) => term.write('', resolve))

const screen = (term: Terminal) => {
  const buffer = term.buffer.active
  const rows: string[] = []
  for (let index = 0; index < buffer.length; index += 1) rows.push(buffer.getLine(index)?.translateToString(true) ?? '')
  while (rows.length > 0 && rows.at(-1) === '') rows.pop()
  return rows
}

const cursorOf = (term: Terminal) => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY })

const editorOn = (term: Terminal, prompt: string) => {
  let geometry = { row: 0, top: term.buffer.active.cursorY }
  return (buffer: string, cursor = buffer.length) => {
    const frame = renderLine({
      prompt,
      buffer,
      cursor,
      columns: term.cols,
      height: term.rows,
      previousRow: geometry.row,
      top: geometry.top,
      width: xtermWidth,
    })
    geometry = { row: frame.row, top: frame.top }
    term.write(frame.text)
    return frame
  }
}

describe('renderLine', () => {
  it('redraws a short line from a reset colour state and parks the cursor at the end', () => {
    const { text, row } = render('ls', 2, 80)
    expect(text).toBe('\r\x1b[0m\x1b[0J$ ls\x1b[5G')
    expect(row).toBe(0)
  })

  it('places the cursor by absolute column when it sits inside the line', () => {
    const { text } = render('hello', 1, 80)
    expect(text).toBe('\r\x1b[0m\x1b[0J$ hello\x1b[4G')
  })

  it('climbs back to the first row of the block before redrawing', () => {
    const { text } = render('abc', 3, 10, 2)
    expect(text).toBe('\x1b[2A\r\x1b[0m\x1b[0J$ abc\x1b[6G')
  })

  it('reports the row the cursor ended on so the next redraw can climb back', () => {
    const { row } = render('x'.repeat(30), 30, 10)
    expect(row).toBe(3)
  })

  it('moves up to the cursor row when the cursor is above the end of a wrapped line', () => {
    const { text, row } = render('x'.repeat(30), 5, 10)
    expect(text.endsWith('\x1b[8G\x1b[3A')).toBe(true)
    expect(row).toBe(0)
  })

  it('forces the wrap with a trailing space when the line exactly fills the row', () => {
    const { text, row } = render('x'.repeat(8), 8, 10)
    expect(text).toBe(`\r\x1b[0m\x1b[0J$ ${'x'.repeat(8)} \x1b[1G`)
    expect(row).toBe(1)
  })

  it('survives a zero-width terminal', () => {
    expect(() => render('ls', 2, 0)).not.toThrow()
  })

  it('reports how many rows the whole line occupies', () => {
    expect(render('x'.repeat(30), 0, 10).rows).toBe(3)
    expect(render('ls', 2, 80).rows).toBe(0)
  })

  it('measures a coloured prompt by its visible width', () => {
    const plain = renderLine({ prompt: '~/project $ ', buffer: 'ls', cursor: 2, columns: 80, previousRow: 0 })
    const coloured = renderLine({
      prompt: '\x1b[32m~/project\x1b[0m $ ',
      buffer: 'ls',
      cursor: 2,
      columns: 80,
      previousRow: 0,
    })
    expect(plain.text.endsWith('\x1b[15G')).toBe(true)
    expect(coloured.text.endsWith('\x1b[15G')).toBe(true)
    const narrow = renderLine({
      prompt: '\x1b[32m~/project\x1b[0m $ ',
      buffer: 'ls',
      cursor: 2,
      columns: 30,
      previousRow: 0,
    })
    expect([narrow.row, narrow.rows]).toEqual([0, 0])
  })

  it('resets colours after a coloured prompt so typed text never inherits them', () => {
    const { text } = renderLine({ prompt: '\x1b[32m$\x1b[39m ', buffer: 'ls', cursor: 2, columns: 80, previousRow: 0 })
    expect(text).toBe('\r\x1b[0m\x1b[0J\x1b[32m$\x1b[39m \x1b[0mls\x1b[5G')
  })

  it('skips a charset designation in a tput-style prompt', () => {
    const { text } = renderLine({ prompt: '\x1b[1m$\x1b(B\x1b[m ', buffer: 'ls', cursor: 2, columns: 80, previousRow: 0 })
    expect(text).toBe('\r\x1b[0m\x1b[0J\x1b[1m$\x1b(B\x1b[m \x1b[0mls\x1b[5G')
  })

  it('resets attributes after a prompt that uses 8-bit control sequences', () => {
    const { text } = renderLine({ prompt: '\x9b32m$ ', buffer: 'ls', cursor: 2, columns: 80, previousRow: 0 })
    expect(text).toBe('\r\x1b[0m\x1b[0J\x9b32m$ \x1b[0mls\x1b[5G')
  })

  it('counts double-width characters as two cells', () => {
    const { text } = renderLine({
      prompt: '$ ',
      buffer: 'echo 日本語',
      cursor: 8,
      columns: 45,
      previousRow: 0,
      width: xtermWidth,
    })
    expect(text.endsWith('\x1b[14G')).toBe(true)
  })

  it('moves a wide character that does not fit to the next row like xterm does', () => {
    const frame = renderLine({ prompt: '$ ', buffer: 'abcdefg日', cursor: 8, columns: 10, previousRow: 0, width: xtermWidth })
    expect([frame.row, frame.rows]).toEqual([1, 1])
    expect(frame.text.endsWith('\x1b[3G')).toBe(true)
  })

  it('leaves the cursor after the last character without a wrap guard on a final frame', () => {
    const frame = renderLine({
      prompt: '$ ',
      buffer: 'x'.repeat(8),
      cursor: 0,
      columns: 10,
      previousRow: 1,
      final: true,
    })
    expect(frame.text).toBe(`\x1b[1A\r\x1b[0m\x1b[0J$ ${'x'.repeat(8)}`)
    expect(frame.rows).toBe(0)
  })
})

describe('renderLine on a real terminal', () => {
  it('puts the cursor right after the text with a coloured prompt', async () => {
    const term = createTerminal(45, 10)
    const type = editorOn(term, '\x1b[32m/p\x1b[0m $ ')
    type('echo abc')
    await flush(term)
    expect(screen(term)).toEqual(['/p $ echo abc'])
    expect(cursorOf(term)).toEqual({ x: 13, y: 0 })
  })

  it('measures prompts with escape sequences the way xterm draws them', async () => {
    const prompts = [
      '\x1b[1m$\x1b(B\x1b[m ',
      '\x1b)0$ ',
      '\x1b]0;docs\x07$ ',
      '\x1b]8;;https://example.test\x1b\\$\x1b]8;;\x1b\\ ',
      '\x1bP$qm\x1b\\$ ',
      '\x9b1m$\x9b0m ',
      '\x1b7$ ',
      '\x1bOx$ ',
    ]
    const drawn: Array<[string, number]> = []
    for (const prompt of prompts) {
      const term = createTerminal(40, 4)
      editorOn(term, prompt)('ls')
      await flush(term)
      drawn.push([screen(term)[0] ?? '', cursorOf(term).x])
    }
    expect(drawn).toEqual([
      ['$ ls', 4],
      ['$ ls', 4],
      ['$ ls', 4],
      ['$ ls', 4],
      ['$ ls', 4],
      ['$ ls', 4],
      ['$ ls', 4],
      ['x$ ls', 5],
    ])
  })

  it('places the cursor exactly after a prompt with a charset designation and an SS3 escape', async () => {
    const prompt = '\x1b(Bdocs\x1bOx> '
    const wide = createTerminal(40, 4)
    editorOn(wide, prompt)('ls')
    await flush(wide)
    expect(screen(wide)).toEqual(['docsx> ls'])
    expect(cursorOf(wide)).toEqual({ x: 9, y: 0 })
    const narrow = createTerminal(10, 4)
    editorOn(narrow, prompt)('abc')
    await flush(narrow)
    expect(screen(narrow)).toEqual(['docsx> abc', ' '])
    expect(cursorOf(narrow)).toEqual({ x: 0, y: 1 })
  })

  it('does not let a prompt with 8-bit control sequences colour the typed text', async () => {
    const term = createTerminal(40, 4)
    editorOn(term, '\x9b32m$ ')('ls')
    await flush(term)
    const row = term.buffer.active.getLine(0)
    expect([2, 3].map((index) => row?.getCell(index)?.isFgDefault())).toEqual([true, true])
  })

  it('puts the cursor right after CJK text', async () => {
    const term = createTerminal(45, 10)
    editorOn(term, '$ ')('echo 日本語')
    await flush(term)
    expect(cursorOf(term)).toEqual({ x: 13, y: 0 })
  })

  it('redraws a wrapped CJK line in place instead of stacking copies', async () => {
    const term = createTerminal(45, 10)
    const type = editorOn(term, '$ ')
    const base = `echo ${'漢'.repeat(30)}`
    type(base)
    type(`${base}a`)
    type(`${base}ab`)
    type(`${base}abc`)
    await flush(term)
    expect(screen(term)).toEqual([`$ echo ${'漢'.repeat(19)}`, `${'漢'.repeat(11)}abc`])
    expect(cursorOf(term)).toEqual({ x: 25, y: 1 })
  })

  it('keeps emoji with a skin-tone modifier on one row with the right cursor', async () => {
    const term = createTerminal(20, 5)
    editorOn(term, '$ ')('echo 👍🏽 ok')
    await flush(term)
    expect(screen(term)).toEqual(['$ echo 👍🏽 ok'])
    expect(cursorOf(term)).toEqual({ x: 14, y: 0 })
  })

  it('keeps a single copy of a line taller than the viewport while typing', async () => {
    const term = createTerminal(34, 6)
    const type = editorOn(term, '$ ')
    const base = `echo ${'z'.repeat(204)}`
    type(base)
    type(`${base}1`)
    type(`${base}12`)
    type(`${base}123`)
    await flush(term)
    expect(screen(term).join('')).toBe(`$ ${base}123`)
    expect(cursorOf(term)).toEqual({ x: (2 + base.length + 3) % 34, y: 5 })
  })

  it('keeps a single copy when the cursor of a tall line is moved into the hidden rows', async () => {
    const term = createTerminal(34, 6)
    const type = editorOn(term, '$ ')
    const base = `echo ${'z'.repeat(204)}`
    type(base)
    type(base, 0)
    type(`X${base}`, 1)
    await flush(term)
    expect(screen(term).join('')).toBe(`$ ${base}`.slice(0, 34) + `$ X${base}`.slice(34))
  })

  it('does not inherit colours left open by earlier output', async () => {
    const term = createTerminal(40, 5)
    term.write('\x1b[31mERROR without reset\r\n')
    await flush(term)
    editorOn(term, '$ ')('ls')
    await flush(term)
    const row = term.buffer.active.getLine(1)
    const cells = [0, 1, 2, 3].map((index) => row?.getCell(index)?.isFgDefault())
    expect(cells).toEqual([true, true, true, true])
  })

  it('wraps a prompt wider than the terminal without duplicating its first row', async () => {
    const term = createTerminal(41, 10)
    const prompt = '/project/a/very-long-directory-name/with-more/nested $ '
    const type = editorOn(term, prompt)
    type('')
    type('l')
    type('ls')
    await flush(term)
    expect(screen(term)).toEqual([prompt.slice(0, 41), `${prompt.slice(41)}ls`])
  })

  it('ends an exact-width command without a blank row before the output', async () => {
    const term = createTerminal(57, 10)
    const type = editorOn(term, '$ ')
    const command = 'x'.repeat(55)
    const frame = type(command)
    const final = renderLine({
      prompt: '$ ',
      buffer: command,
      cursor: command.length,
      columns: 57,
      height: 10,
      previousRow: frame.row,
      top: frame.top,
      final: true,
    })
    term.write(`${final.text}\r\nout:55\r\n`)
    await flush(term)
    expect(screen(term)).toEqual([`$ ${command}`, 'out:55'])
  })
})

describe('moveToBlockEnd', () => {
  it('walks down to the last row before the terminal leaves the line', () => {
    expect(moveToBlockEnd(0, 3)).toBe('\x1b[3B\r')
  })

  it('only returns to column zero when the cursor is already on the last row', () => {
    expect(moveToBlockEnd(2, 2)).toBe('\r')
  })
})
