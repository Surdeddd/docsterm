import { describe, expect, it } from 'vitest'
import { moveToBlockEnd, renderLine } from '../src/line-render.js'

const render = (buffer: string, cursor: number, columns: number, previousRow = 0) =>
  renderLine({ prompt: '$ ', buffer, cursor, columns, previousRow })

describe('renderLine', () => {
  it('redraws a short line and parks the cursor at the end', () => {
    const { text, row } = render('ls', 2, 80)
    expect(text).toBe('\r\x1b[0J$ ls\x1b[5G')
    expect(row).toBe(0)
  })

  it('places the cursor by absolute column when it sits inside the line', () => {
    const { text } = render('hello', 1, 80)
    expect(text).toContain('\x1b[4G')
  })

  it('climbs back to the first row of the block before redrawing', () => {
    const { text } = render('abc', 3, 10, 2)
    expect(text.startsWith('\x1b[2A\r\x1b[0J')).toBe(true)
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
    expect(text).toContain('$ ' + 'x'.repeat(8) + ' ')
    expect(row).toBe(1)
  })

  it('clears the whole block, not just one row', () => {
    expect(render('x'.repeat(30), 30, 10).text).toContain('\x1b[0J')
  })

  it('survives a zero-width terminal', () => {
    expect(() => render('ls', 2, 0)).not.toThrow()
  })

  it('reports how many rows the whole line occupies', () => {
    expect(render('x'.repeat(30), 0, 10).rows).toBe(3)
    expect(render('ls', 2, 80).rows).toBe(0)
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
