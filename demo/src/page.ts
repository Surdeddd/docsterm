import type { Locale, TerminalTheme } from 'docsterm'

export type PageTheme = 'light' | 'dark'

export const LOCALE_KEY = 'docsterm-demo:locale'
export const THEME_KEY = 'docsterm-demo:theme'

export const TERMINAL_FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
export const TERMINAL_FONT_SIZE = 13

export const pageLocale = (): Locale => (document.documentElement.lang === 'ru' ? 'ru' : 'en')

export const pageTheme = (): PageTheme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

export const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

export const terminalThemes: Record<PageTheme, TerminalTheme> = {
  light: {
    background: '#f1f2f3',
    foreground: '#0f1114',
    cursor: '#b52a0b',
    cursorAccent: '#f1f2f3',
    selectionBackground: 'rgba(181, 42, 11, 0.22)',
    black: '#0f1114',
    red: '#b52a0b',
    green: '#256d4a',
    yellow: '#7a5600',
    blue: '#1f4fa8',
    magenta: '#8d3a86',
    cyan: '#1c6b74',
    white: '#5c626b',
    brightBlack: '#5f656e',
    brightRed: '#c2361a',
    brightGreen: '#2a7a50',
    brightYellow: '#8a6100',
    brightBlue: '#2458b5',
    brightMagenta: '#94408c',
    brightCyan: '#1f7580',
    brightWhite: '#0f1114',
  },
  dark: {
    background: '#14171c',
    foreground: '#e9eaec',
    cursor: '#ff4f2b',
    cursorAccent: '#14171c',
    selectionBackground: 'rgba(255, 79, 43, 0.26)',
    black: '#31363d',
    red: '#ff6a4a',
    green: '#5fd08a',
    yellow: '#e7b75a',
    blue: '#78a8ff',
    magenta: '#cf9bf0',
    cyan: '#63cbd6',
    white: '#b9bfc7',
    brightBlack: '#8c939d',
    brightRed: '#ff7658',
    brightGreen: '#84e0a7',
    brightYellow: '#f3cd83',
    brightBlue: '#9cc0ff',
    brightMagenta: '#dfb4fa',
    brightCyan: '#8adfe8',
    brightWhite: '#ffffff',
  },
}
