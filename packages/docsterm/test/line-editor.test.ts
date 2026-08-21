import { beforeEach, describe, expect, it } from 'vitest'
import { LineEditor } from '../src/line-editor.js'

let renders: string[]
let submits: string[]
let interrupts: number
let editor: LineEditor

beforeEach(() => {
  renders = []
  submits = []
  interrupts = 0
  editor = new LineEditor({
    onRender: (buffer) => renders.push(buffer),
    onSubmit: (line) => submits.push(line),
    onInterrupt: () => {
      interrupts += 1
    },
  })
})

const type = (text: string) => {
  for (const ch of text) editor.handleKey(ch)
}

describe('LineEditor', () => {
  it('accumulates printable input and submits on enter', () => {
    type('ab')
    expect(renders).toEqual(['a', 'ab'])
    editor.handleKey('\r')
    expect(submits).toEqual(['ab'])
    editor.handleKey('\r')
    expect(submits).toEqual(['ab', ''])
  })

  it('handles pasted multi-character data', () => {
    editor.handleKey('orbit deploy')
    editor.handleKey('\r')
    expect(submits).toEqual(['orbit deploy'])
  })

  it('removes the last character on backspace', () => {
    type('ab')
    editor.handleKey('\x7f')
    expect(renders.at(-1)).toBe('a')
    editor.handleKey('\x7f')
    editor.handleKey('\x7f')
    expect(renders.at(-1)).toBe('')
  })

  it('clears the buffer and reports interrupt on ctrl+c', () => {
    type('abc')
    editor.handleKey('\x03')
    expect(interrupts).toBe(1)
    editor.handleKey('\r')
    expect(submits).toEqual([''])
  })

  it('ignores unknown escape sequences', () => {
    editor.handleKey('\x1b[C')
    editor.handleKey('\x1b[D')
    expect(renders).toEqual([])
  })

  it('navigates history with arrows and restores the draft', () => {
    editor.pushHistory('one')
    editor.pushHistory('two')
    type('dr')
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('two')
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('one')
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('one')
    editor.handleKey('\x1b[B')
    expect(renders.at(-1)).toBe('two')
    editor.handleKey('\x1b[B')
    expect(renders.at(-1)).toBe('dr')
  })

  it('skips empty and duplicate history entries', () => {
    editor.pushHistory('  ')
    editor.pushHistory('same')
    editor.pushHistory('same')
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('same')
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('same')
  })
})
