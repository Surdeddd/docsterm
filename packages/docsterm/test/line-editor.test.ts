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
    type('ab')
    editor.handleKey('\x1b[15~')
    editor.handleKey('\x1b[1;2P')
    editor.handleKey('\x1bOS')
    editor.handleKey('\x1b[Z')
    expect([editor.value, editor.position, renders]).toEqual(['ab', 2, ['a', 'ab']])
  })

  it('does not redraw when the arrows cannot move the cursor', () => {
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

  it('keeps edits to recalled history entries until the line is submitted', () => {
    editor.pushHistory('git status')
    editor.pushHistory('git commit')
    editor.handleKey('\x1b[A')
    type(' -m fix')
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('git status')
    editor.handleKey('\x1b[B')
    expect(renders.at(-1)).toBe('git commit -m fix')
    editor.handleKey('\r')
    expect(submits).toEqual(['git commit -m fix'])
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('git commit')
  })

  it('drops history edits on Ctrl+C', () => {
    editor.pushHistory('git commit')
    editor.handleKey('\x1b[A')
    type(' -m wip')
    editor.handleKey('\x03')
    editor.handleKey('\x1b[A')
    expect(renders.at(-1)).toBe('git commit')
  })

  it('inserts pasted text at the cursor without control characters', () => {
    type('echo ')
    editor.insert('a\x07b\x1b\x9bc')
    expect(editor.value).toBe('echo abc')
    expect(editor.position).toBe(8)
  })

  it('reports where the first word of the submitted line came from', () => {
    const sources: string[] = []
    const tracked = new LineEditor({
      onRender: () => {},
      onSubmit: (line, source) => sources.push(`${source}:${line}`),
      onInterrupt: () => {},
    })
    for (const char of '#deploy') tracked.handleKey(char)
    tracked.handleKey('\r')
    tracked.insert('# install deps', 'paste')
    tracked.handleKey('\r')
    tracked.handleKey('#')
    tracked.insert(' deploy the app', 'paste')
    tracked.handleKey('\r')
    tracked.handleKey(' ')
    tracked.insert('#x', 'api')
    tracked.handleKey('\r')
    tracked.insert('# from a run button', 'api')
    tracked.handleKey('\x01')
    tracked.handleKey('\x1b[3~')
    tracked.handleKey('#')
    tracked.handleKey('\r')
    tracked.handleKey('\r')
    expect(sources).toEqual([
      'typed:#deploy',
      'paste:# install deps',
      'typed:# deploy the app',
      'api: #x',
      'typed:# from a run button',
      'typed:',
    ])
  })

  it('counts a line recalled from history as typed and keeps the origin of the draft', () => {
    const sources: string[] = []
    const tracked = new LineEditor({
      onRender: () => {},
      onSubmit: (_line, source) => sources.push(source),
      onInterrupt: () => {},
    })
    tracked.insert('#pasted', 'paste')
    tracked.handleKey('\r')
    tracked.pushHistory('#pasted')
    tracked.handleKey('\x1b[A')
    tracked.handleKey('\r')
    tracked.insert('#draft', 'paste')
    tracked.handleKey('\x1b[A')
    tracked.handleKey('\x1b[B')
    tracked.handleKey('\r')
    expect(sources).toEqual(['paste', 'typed', 'paste'])
  })

  it('skips empty and duplicate history entries', () => {
    editor.pushHistory('  ')
    editor.pushHistory('same')
    editor.pushHistory('same')
    editor.pushHistory('other')
    editor.pushHistory('same')
    expect(editor.entries()).toEqual(['same', 'other', 'same'])
  })
})
