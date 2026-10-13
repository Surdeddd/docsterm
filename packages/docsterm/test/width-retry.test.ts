import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@xterm/addon-unicode11')
  vi.unstubAllGlobals()
  vi.resetModules()
})

interface Terminal {
  unicode: { register(provider: { wcwidth(codePoint: number): number }): void }
}

class Unicode11Addon {
  activate(terminal: Terminal) {
    terminal.unicode.register({ wcwidth: (codePoint) => (codePoint === 0x1f600 ? 2 : 1) })
  }
}

const freshWidth = async (addon: () => Record<string, unknown>) => {
  vi.doMock('@xterm/addon-unicode11', addon)
  vi.resetModules()
  return await import('../src/width.js')
}

it('loads the Unicode 11 widths again after a failed chunk load', async () => {
  let attempts = 0
  const { loadXtermCodePointWidth } = await freshWidth(() => {
    attempts += 1
    if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module')
    return { Unicode11Addon }
  })
  await expect(loadXtermCodePointWidth()).rejects.toThrow()
  const width = await loadXtermCodePointWidth()
  expect(width(0x1f600)).toBe(2)
  expect(attempts).toBe(2)
})

it('finds the addon behind a default export', async () => {
  const { loadXtermCodePointWidth } = await freshWidth(() => ({ Unicode11Addon: undefined, default: { Unicode11Addon } }))
  const width = await loadXtermCodePointWidth()
  expect([width(0x1f600), width(0x41)]).toEqual([2, 1])
})

it('names the problem when the addon module has no addon or the addon registers no provider', async () => {
  const empty = await freshWidth(() => ({ Unicode11Addon: undefined, default: undefined }))
  await expect(empty.loadXtermCodePointWidth()).rejects.toThrow(new Error('@xterm/addon-unicode11 exports no Unicode11Addon'))
  vi.doUnmock('@xterm/addon-unicode11')
  const silent = await freshWidth(() => ({
    Unicode11Addon: class {
      activate() {}
    },
    default: undefined,
  }))
  await expect(silent.loadXtermCodePointWidth()).rejects.toThrow(
    new Error('@xterm/addon-unicode11 registered no provider'),
  )
})

it('steps by whole code points when Intl.Segmenter is missing', async () => {
  vi.stubGlobal('Intl', {})
  vi.resetModules()
  const { nextBoundary, previousBoundary } = await import('../src/width.js')
  vi.unstubAllGlobals()
  const text = 'a👍🏽b'
  const forward: number[] = []
  for (let index = 0; index < text.length; index = nextBoundary(text, index)) forward.push(index)
  expect(forward).toEqual([0, 1, 3, 5])
  expect([6, 5, 3, 1, 0].map((index) => previousBoundary(text, index))).toEqual([5, 3, 1, 0, 0])
  expect(nextBoundary(text, 6)).toBe(6)
})
