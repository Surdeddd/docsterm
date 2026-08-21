import type { ITheme } from '@xterm/xterm'
import type { TerminalTheme } from './types'

export const lightTheme: ITheme = {
  background: '#fdfdfc',
  foreground: '#1f2328',
  cursor: '#1f2328',
  selectionBackground: '#b3d4fc',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
}

export const darkTheme: ITheme = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
}

export function resolveTheme(pref: 'light' | 'dark' | 'auto' | TerminalTheme): ITheme {
  if (typeof pref === 'object') return pref
  if (pref === 'light') return lightTheme
  if (pref === 'dark') return darkTheme
  const prefersDark =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  return prefersDark ? darkTheme : lightTheme
}
