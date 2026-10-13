import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ITheme } from '@xterm/xterm'
import { darkTheme, lightTheme, resolveTheme, watchTheme } from '../src/theme.js'

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

const channel = (value: number) => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

const below = (theme: ITheme, skip: readonly string[] = []) =>
  ANSI.filter((name) => !skip.includes(name)).filter(
    (name) => contrast(theme[name] ?? '#000000', theme.background ?? '#000000') < 4.5,
  )

interface FakeQuery {
  matches: boolean
  listeners: Set<() => void>
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

const fakeScheme = (dark: boolean) => {
  const query: FakeQuery = {
    matches: dark,
    listeners: new Set(),
    addEventListener: (_type, listener) => query.listeners.add(listener),
    removeEventListener: (_type, listener) => query.listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', () => query)
  return {
    query,
    flip(next: boolean) {
      query.matches = next
      for (const listener of query.listeners) listener()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('built-in themes', () => {
  it('give the block cursor an accent so the character under it stays readable', () => {
    expect(lightTheme.cursorAccent).toBe(lightTheme.background)
    expect(darkTheme.cursorAccent).toBe(darkTheme.background)
  })

  it('keep every light ANSI colour at 4.5:1 against the background', () => {
    expect(below(lightTheme)).toEqual([])
  })

  it('keep every dark ANSI colour except black at 4.5:1 against the background', () => {
    expect(below(darkTheme, ['black'])).toEqual([])
  })
})

describe('resolveTheme', () => {
  it('merges a partial light theme over the light base', () => {
    expect(resolveTheme({ background: '#ffffff', foreground: '#1f2328' })).toEqual({
      ...lightTheme,
      background: '#ffffff',
      foreground: '#1f2328',
    })
  })

  it('merges a partial dark theme over the dark base', () => {
    expect(resolveTheme({ background: '#000000', cursor: '#ff8800' })).toEqual({
      ...darkTheme,
      background: '#000000',
      cursor: '#ff8800',
    })
  })

  it('reads short hex and rgb() backgrounds', () => {
    expect(resolveTheme({ background: '#fff' }).cursor).toBe(lightTheme.cursor)
    expect(resolveTheme({ background: 'rgb(250, 250, 250)' }).cursor).toBe(lightTheme.cursor)
    expect(resolveTheme({ background: 'rgba(10, 10, 20, 1)' }).cursor).toBe(darkTheme.cursor)
  })

  it('splits light from dark backgrounds at relative luminance 0.179, whatever the colour syntax', () => {
    const base = (background: string) =>
      [true, false].map((dark) => (resolveTheme({ background }, dark).cursor === lightTheme.cursor ? 'light' : 'dark')).join('/')
    const cases: Array<[string, string]> = [
      ['#757575', 'dark/dark'],
      ['#767676', 'light/light'],
      ['#666', 'dark/dark'],
      ['#777', 'light/light'],
      ['#7778', 'light/light'],
      ['#757575ff', 'dark/dark'],
      ['#767676cc', 'light/light'],
      [' #7A7A7A ', 'light/light'],
      ['rgb(117, 117, 117)', 'dark/dark'],
      ['rgba(118,118,118,0.5)', 'light/light'],
      ['#e00000', 'dark/dark'],
      ['#ff0000', 'light/light'],
      ['#00a000', 'light/light'],
      ['#0000ff', 'dark/dark'],
    ]
    expect(cases.map(([background]) => [background, base(background)])).toEqual(cases)
  })

  it('falls back to the colour scheme when the object has no readable background', () => {
    expect(resolveTheme({ cursor: '#ff0000' }, true)).toEqual({ ...darkTheme, cursor: '#ff0000' })
    expect(resolveTheme({ cursor: '#ff0000' }, false)).toEqual({ ...lightTheme, cursor: '#ff0000' })
  })

  it('keeps base values for fields the caller left undefined', () => {
    expect(resolveTheme({ background: '#ffffff', cursor: undefined }).cursor).toBe(lightTheme.cursor)
  })

  it('does not mutate the caller object', () => {
    const custom = { background: '#ffffff' }
    resolveTheme(custom)
    expect(custom).toEqual({ background: '#ffffff' })
  })

  it('resolves auto from the colour scheme', () => {
    expect(resolveTheme('auto', true)).toBe(darkTheme)
    expect(resolveTheme('auto', false)).toBe(lightTheme)
    expect(resolveTheme('light', true)).toBe(lightTheme)
    expect(resolveTheme('dark', false)).toBe(darkTheme)
  })

  it('reads prefers-color-scheme when no scheme is passed', () => {
    fakeScheme(true)
    expect(resolveTheme('auto')).toBe(darkTheme)
  })
})

describe('watchTheme', () => {
  it('follows prefers-color-scheme changes for auto until stopped', () => {
    const scheme = fakeScheme(false)
    const applied: Array<string | undefined> = []
    const stop = watchTheme('auto', (theme) => applied.push(theme.background))
    scheme.flip(true)
    scheme.flip(false)
    stop()
    scheme.flip(true)
    expect(applied).toEqual([lightTheme.background, darkTheme.background, lightTheme.background])
    expect(scheme.query.listeners.size).toBe(0)
  })

  it('applies a fixed theme once and never listens', () => {
    const scheme = fakeScheme(false)
    const applied: Array<string | undefined> = []
    watchTheme('dark', (theme) => applied.push(theme.background))
    scheme.flip(true)
    expect(applied).toEqual([darkTheme.background])
    expect(scheme.query.listeners.size).toBe(0)
  })

  it('works without matchMedia', () => {
    const applied: Array<string | undefined> = []
    const stop = watchTheme('auto', (theme) => applied.push(theme.background))
    stop()
    expect(applied).toEqual([lightTheme.background])
  })
})
