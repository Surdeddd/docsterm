import { beforeEach, describe, expect, it } from 'vitest'
import { commonPrefix, LineEditor, type CompletionResult } from '../src/line-editor.js'

let renders: Array<{ buffer: string; cursor: number }>
let submits: string[]
let candidateLists: string[][]
let completion: CompletionResult | null
let editor: LineEditor

beforeEach(() => {
  renders = []
  submits = []
  candidateLists = []
  completion = null
  editor = new LineEditor({
    onRender: (buffer, cursor) => renders.push({ buffer, cursor }),
    onSubmit: (line) => submits.push(line),
    onInterrupt: () => {},
    onComplete: async () => completion,
    onCandidates: (candidates) => candidateLists.push(candidates),
  })
})

const type = (text: string) => {
  for (const char of text) editor.handleKey(char)
}

const KEY = {
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  del: '\x1b[3~',
  ctrlA: '\x01',
  ctrlE: '\x05',
  ctrlU: '\x15',
  ctrlK: '\x0b',
  ctrlW: '\x17',
  altLeft: '\x1bb',
  altRight: '\x1bf',
  backspace: '\x7f',
  tab: '\t',
}

describe('commonPrefix', () => {
  it('finds the shared start of candidates', () => {
    expect(commonPrefix(['deploy', 'destroy'])).toBe('de')
    expect(commonPrefix(['same', 'same'])).toBe('same')
    expect(commonPrefix(['abc', 'xyz'])).toBe('')
    expect(commonPrefix([])).toBe('')
  })
})

describe('cursor movement', () => {
  it('inserts text at the cursor rather than at the end', () => {
    type('helo')
    editor.handleKey(KEY.left)
    editor.handleKey('l')
    expect(editor.value).toBe('hello')
    expect(editor.position).toBe(4)
  })

  it('moves with arrows and clamps at both edges', () => {
    type('ab')
    editor.handleKey(KEY.left)
    editor.handleKey(KEY.left)
    editor.handleKey(KEY.left)
    expect(editor.position).toBe(0)
    editor.handleKey(KEY.right)
    editor.handleKey(KEY.right)
    editor.handleKey(KEY.right)
    expect(editor.position).toBe(2)
  })

  it('jumps to the start and end with Home, End, Ctrl+A and Ctrl+E', () => {
    type('command')
    editor.handleKey(KEY.home)
    expect(editor.position).toBe(0)
    editor.handleKey(KEY.end)
    expect(editor.position).toBe(7)
    editor.handleKey(KEY.ctrlA)
    expect(editor.position).toBe(0)
    editor.handleKey(KEY.ctrlE)
    expect(editor.position).toBe(7)
  })

  it('deletes forward with Delete and backward with Backspace', () => {
    type('abc')
    editor.handleKey(KEY.home)
    editor.handleKey(KEY.del)
    expect(editor.value).toBe('bc')
    editor.handleKey(KEY.end)
    editor.handleKey(KEY.backspace)
    expect(editor.value).toBe('b')
  })

  it('kills to the start with Ctrl+U and to the end with Ctrl+K', () => {
    type('orbit deploy now')
    editor.handleKey(KEY.ctrlA)
    editor.handleKey(KEY.right)
    editor.handleKey(KEY.right)
    editor.handleKey(KEY.right)
    editor.handleKey(KEY.right)
    editor.handleKey(KEY.right)
    editor.handleKey(KEY.ctrlU)
    expect(editor.value).toBe(' deploy now')
    editor.handleKey(KEY.ctrlK)
    expect(editor.value).toBe('')
  })

  it('deletes the previous word with Ctrl+W', () => {
    type('orbit deploy production')
    editor.handleKey(KEY.ctrlW)
    expect(editor.value).toBe('orbit deploy ')
    editor.handleKey(KEY.ctrlW)
    expect(editor.value).toBe('orbit ')
  })

  it('walks words with Alt+Left and Alt+Right', () => {
    type('orbit deploy now')
    editor.handleKey(KEY.altLeft)
    expect(editor.position).toBe(13)
    editor.handleKey(KEY.altLeft)
    expect(editor.position).toBe(6)
    editor.handleKey(KEY.altRight)
    expect(editor.position).toBe(12)
  })

  it('reports the cursor position on every render', () => {
    type('ab')
    editor.handleKey(KEY.left)
    expect(renders.at(-1)).toEqual({ buffer: 'ab', cursor: 1 })
  })

  it('submits the whole line regardless of cursor position', () => {
    type('deploy')
    editor.handleKey(KEY.home)
    editor.handleKey('\r')
    expect(submits).toEqual(['deploy'])
    expect(editor.position).toBe(0)
  })
})

describe('tab completion', () => {
  it('inserts the only candidate and adds a trailing space', async () => {
    type('orb')
    completion = { from: 0, to: 3, candidates: ['orbit'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('orbit ')
    expect(editor.position).toBe(6)
  })

  it('keeps the trailing slash for directories instead of a space', async () => {
    type('cat sr')
    completion = { from: 4, to: 6, candidates: ['src/'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('cat src/')
  })

  it('extends to the common prefix when several candidates match', async () => {
    type('orbit de')
    completion = { from: 6, to: 8, candidates: ['deploy', 'destroy'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('orbit de')
    expect(candidateLists).toEqual([['deploy', 'destroy']])
  })

  it('grows the word to the shared prefix without listing anything', async () => {
    type('d')
    completion = { from: 0, to: 1, candidates: ['deploy', 'destroy'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('de')
    expect(candidateLists).toEqual([])
  })

  it('does nothing when there is no completion', async () => {
    type('zzz')
    completion = null
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('zzz')
    expect(candidateLists).toEqual([])
  })
})
