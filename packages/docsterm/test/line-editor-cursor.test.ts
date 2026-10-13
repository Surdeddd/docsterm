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

  it('compares whole code points, so it never ends in half a surrogate pair', () => {
    expect(commonPrefix(['😀a', '😃b'])).toBe('')
    expect(commonPrefix(['x😀a', 'x😃b'])).toBe('x')
    expect(commonPrefix(['x😀a', 'x😀b'])).toBe('x😀')
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

describe('keys as xterm 6 encodes them', () => {
  it.each([
    ['Alt+Left', '\x1b[1;3D'],
    ['Ctrl+Left', '\x1b[1;5D'],
    ['Meta+Left', '\x1b[1;9D'],
  ])('jumps a word left with %s', (_name, key) => {
    type('orbit deploy now')
    editor.handleKey(key)
    expect(editor.position).toBe(13)
    editor.handleKey(key)
    expect(editor.position).toBe(6)
  })

  it.each([
    ['Alt+Right', '\x1b[1;3C'],
    ['Ctrl+Right', '\x1b[1;5C'],
    ['Meta+Right', '\x1b[1;9C'],
  ])('jumps a word right with %s', (_name, key) => {
    type('orbit deploy now')
    editor.handleKey(KEY.home)
    editor.handleKey(key)
    expect(editor.position).toBe(5)
    editor.handleKey(key)
    expect(editor.position).toBe(12)
  })

  it.each([
    ['SS3 Home', '\x1bOH', 0],
    ['VT Home', '\x1b[1~', 0],
    ['SS3 End', '\x1bOF', 7],
    ['VT End', '\x1b[4~', 7],
  ])('handles %s', (_name, key, position) => {
    type('command')
    editor.handleKey(position === 0 ? KEY.end : KEY.home)
    editor.handleKey(key)
    expect(editor.position).toBe(position)
  })

  it('moves with arrows in application cursor mode', () => {
    editor.pushHistory('older')
    type('ab')
    editor.handleKey('\x1bOD')
    expect(editor.position).toBe(1)
    editor.handleKey('\x1bOC')
    expect(editor.position).toBe(2)
    editor.handleKey('\x1bOA')
    expect(editor.value).toBe('older')
    editor.handleKey('\x1bOB')
    expect(editor.value).toBe('ab')
  })

  it.each([
    ['Ctrl+Backspace', '\x08'],
    ['Alt+Backspace', '\x1b\x7f'],
  ])('deletes the previous word with %s', (_name, key) => {
    type('orbit deploy production')
    editor.handleKey(key)
    expect(editor.value).toBe('orbit deploy ')
  })

  it.each([
    ['Alt+D', '\x1bd'],
    ['Ctrl+Delete', '\x1b[3;5~'],
  ])('deletes the next word with %s', (_name, key) => {
    type('orbit deploy production')
    editor.handleKey(KEY.home)
    editor.handleKey(key)
    expect(editor.value).toBe(' deploy production')
    editor.handleKey(key)
    expect(editor.value).toBe(' production')
    expect(editor.position).toBe(0)
  })

  it('moves by one character with Ctrl+B and Ctrl+F', () => {
    type('abc')
    editor.handleKey('\x02')
    editor.handleKey('\x02')
    expect(editor.position).toBe(1)
    editor.handleKey('\x06')
    expect(editor.position).toBe(2)
  })

  it('deletes the character under the cursor with Ctrl+D', () => {
    type('abc')
    editor.handleKey(KEY.home)
    editor.handleKey('\x04')
    expect(editor.value).toBe('bc')
    editor.handleKey(KEY.end)
    editor.handleKey('\x04')
    expect(editor.value).toBe('bc')
  })

  it('transposes characters with Ctrl+T like readline', () => {
    type('abc')
    editor.handleKey('\x14')
    expect([editor.value, editor.position]).toEqual(['acb', 3])
    editor.handleKey(KEY.home)
    editor.handleKey(KEY.right)
    editor.handleKey('\x14')
    expect([editor.value, editor.position]).toEqual(['cab', 2])
    editor.handleKey(KEY.home)
    editor.handleKey('\x14')
    expect([editor.value, editor.position]).toEqual(['cab', 0])
  })

  it('yanks the last killed text back with Ctrl+Y', () => {
    type('orbit deploy now')
    editor.handleKey(KEY.ctrlW)
    expect(editor.value).toBe('orbit deploy ')
    editor.handleKey(KEY.home)
    editor.handleKey('\x19')
    expect(editor.value).toBe('noworbit deploy ')
    editor.handleKey(KEY.ctrlK)
    editor.handleKey(KEY.end)
    editor.handleKey('\x19')
    expect(editor.value).toBe('noworbit deploy ')
    editor.handleKey(KEY.ctrlU)
    editor.handleKey('\x19')
    editor.handleKey('\x19')
    expect(editor.value).toBe('noworbit deploy noworbit deploy ')
  })

  it('asks for a clear screen with Ctrl+L and keeps the line', () => {
    let clears = 0
    const local = new LineEditor({
      onRender: () => {},
      onSubmit: () => {},
      onInterrupt: () => {},
      onClearScreen: () => {
        clears += 1
      },
    })
    local.handleKey('l')
    local.handleKey('s')
    local.handleKey('\x0c')
    expect(clears).toBe(1)
    expect(local.value).toBe('ls')
  })

  it('ignores a lone Escape, Shift+Tab and unknown function keys', () => {
    type('ab')
    const before = renders.length
    editor.handleKey('\x1b')
    editor.handleKey('\x1b[Z')
    editor.handleKey('\x1b[24~')
    expect(editor.value).toBe('ab')
    expect(renders.length).toBe(before)
  })
})

describe('grapheme-aware editing', () => {
  it('deletes a whole emoji with Backspace instead of half a surrogate pair', () => {
    type('echo 😀')
    editor.handleKey(KEY.backspace)
    expect(editor.value).toBe('echo ')
  })

  it('steps over an emoji with Left so typing never splits it', () => {
    type('echo 😀')
    editor.handleKey(KEY.left)
    editor.handleKey('X')
    expect(editor.value).toBe('echo X😀')
  })

  it('treats an emoji with a skin-tone modifier and a ZWJ family as one character', () => {
    editor.handleKey('a👍🏽b👨‍👩‍👧')
    editor.handleKey(KEY.left)
    expect(editor.position).toBe(6)
    editor.handleKey(KEY.left)
    editor.handleKey(KEY.left)
    expect(editor.position).toBe(1)
    editor.handleKey(KEY.del)
    expect(editor.value).toBe('ab👨‍👩‍👧')
  })

  it('treats a letter with a combining accent as one character', () => {
    editor.handleKey('café')
    editor.handleKey(KEY.backspace)
    expect(editor.value).toBe('caf')
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

  it('lists the candidates when they share nothing beyond the typed word', async () => {
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

  it('strips colours and control characters from candidates', async () => {
    type('cat sr')
    completion = { from: 4, to: 6, candidates: ['\x1b[34msrc/\x1b[0m'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('cat src/')
    type('x')
    completion = { from: 4, to: 9, candidates: ['src/x\x07.ts', 'src/x\r.md'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('cat src/x.')
    completion = { from: 4, to: 10, candidates: ['\x1b[1msrc/x.ts\x1b[0m', 'src/x.md'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(candidateLists).toEqual([['src/x.ts', 'src/x.md']])
  })

  it('never leaves a lone backslash from escaped candidates at the end of the line', async () => {
    type('cat ')
    completion = { from: 4, to: 4, candidates: ['my\\ notes.txt', 'my\\!draft.txt'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect([editor.value, editor.position]).toEqual(['cat my', 6])
    completion = { from: 4, to: 6, candidates: ['my\\ notes.txt', 'my\\!draft.txt'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('cat my')
    expect(candidateLists).toEqual([['my\\ notes.txt', 'my\\!draft.txt']])
  })

  it('keeps an escaped backslash at the end of the shared prefix', async () => {
    type('cat ')
    completion = { from: 4, to: 4, candidates: ['a\\\\b', 'a\\\\c'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('cat a\\\\')
  })

  it('lists emoji candidates instead of inserting the half they share', async () => {
    type('echo ')
    completion = { from: 5, to: 5, candidates: ['😀.txt', '😃.txt'] }
    editor.handleKey(KEY.tab)
    await Promise.resolve()
    expect(editor.value).toBe('echo ')
    expect(candidateLists).toEqual([['😀.txt', '😃.txt']])
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

describe('slow tab completion', () => {
  let resolveCompletion: (result: CompletionResult | null) => void
  let slow: LineEditor
  let slowSubmits: string[]

  beforeEach(() => {
    slowSubmits = []
    slow = new LineEditor({
      onRender: () => {},
      onSubmit: (line) => slowSubmits.push(line),
      onInterrupt: () => {},
      onComplete: () =>
        new Promise((resolve) => {
          resolveCompletion = resolve
        }),
    })
  })

  const slowType = (text: string) => {
    for (const char of text) slow.handleKey(char)
  }

  it('drops a result that arrives after more typing', async () => {
    slowType('ech')
    slow.handleKey(KEY.tab)
    slowType('o hi')
    resolveCompletion({ from: 0, to: 3, candidates: ['echo'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    slow.handleKey('\r')
    expect(slowSubmits).toEqual(['echo hi'])
  })

  it('drops a result that arrives after the line was submitted', async () => {
    slowType('ech')
    slow.handleKey(KEY.tab)
    slow.handleKey('\r')
    resolveCompletion({ from: 0, to: 3, candidates: ['echo'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(slowSubmits).toEqual(['ech'])
    expect(slow.value).toBe('')
  })

  it('still applies a result when nothing changed meanwhile', async () => {
    slowType('ech')
    slow.handleKey(KEY.tab)
    resolveCompletion({ from: 0, to: 3, candidates: ['echo'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(slow.value).toBe('echo ')
  })
})
