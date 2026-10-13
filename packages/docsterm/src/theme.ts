import type { ITheme } from '@xterm/xterm'
import type { ThemePreference } from './types.js'

export const lightTheme: ITheme = {
  background: '#fdfdfc',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#fdfdfc',
  selectionBackground: '#b3d4fc',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#656d76',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#1b73d4',
  brightMagenta: '#835ec7',
  brightCyan: '#2a7c90',
  brightWhite: '#6c757e',
}

export const darkTheme: ITheme = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#7d8590',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function prefersDarkScheme(): boolean {
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches
}

function parseColor(color: string): [number, number, number] | null {
  const value = color.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1]
  if (hex && (hex.length === 3 || hex.length === 4)) {
    return [0, 1, 2].map((index) => Number.parseInt(`${hex[index]}${hex[index]}`, 16)) as [number, number, number]
  }
  if (hex && (hex.length === 6 || hex.length === 8)) {
    return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

function isLight(color: string | undefined): boolean | null {
  const parts = color === undefined ? null : parseColor(color)
  if (!parts) return null
  const linear = parts.map((part) => {
    const c = part / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] > 0.179
}

export function resolveTheme(pref: ThemePreference, dark: boolean = prefersDarkScheme()): ITheme {
  if (pref === 'light') return lightTheme
  if (pref === 'dark') return darkTheme
  if (pref === 'auto') return dark ? darkTheme : lightTheme
  const light = isLight(pref.background) ?? !dark
  const defined = Object.fromEntries(Object.entries(pref).filter(([, value]) => value !== undefined))
  return { ...(light ? lightTheme : darkTheme), ...defined }
}

export function watchTheme(pref: ThemePreference, apply: (theme: ITheme) => void): () => void {
  apply(resolveTheme(pref))
  if (pref !== 'auto' || typeof matchMedia !== 'function') return () => {}
  const query = matchMedia(DARK_QUERY)
  const listener = () => apply(resolveTheme('auto', query.matches))
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
