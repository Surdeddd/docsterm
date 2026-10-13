import { stripAnsi } from './text.js'

export type CodePointWidth = (codePoint: number) => number

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u
const WIDE = /^[\p{Extended_Pictographic}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]$/u

export function basicCodePointWidth(codePoint: number): number {
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  if (codePoint < 0x300) return 1
  const char = String.fromCodePoint(codePoint)
  if (ZERO_WIDTH.test(char)) return 0
  if (WIDE.test(char)) return 2
  return 1
}

let xtermWidth: Promise<CodePointWidth> | null = null

export function loadXtermCodePointWidth(): Promise<CodePointWidth> {
  if (!xtermWidth) {
    xtermWidth = import('@xterm/addon-unicode11').then((module) => {
      const loaded = module as unknown as {
        Unicode11Addon?: new () => { activate(terminal: unknown): void }
        default?: { Unicode11Addon?: new () => { activate(terminal: unknown): void } }
      }
      const Addon = loaded.Unicode11Addon ?? loaded.default?.Unicode11Addon
      if (!Addon) throw new Error('@xterm/addon-unicode11 exports no Unicode11Addon')
      let provider: { wcwidth(codePoint: number): number } | null = null
      new Addon().activate({
        unicode: {
          register: (candidate: { wcwidth(codePoint: number): number }) => {
            provider = candidate
          },
        },
      })
      const found = provider as { wcwidth(codePoint: number): number } | null
      if (!found) throw new Error('@xterm/addon-unicode11 registered no provider')
      return (codePoint: number) => found.wcwidth(codePoint)
    })
    xtermWidth.catch(() => {
      xtermWidth = null
    })
  }
  return xtermWidth
}

export function displayWidth(text: string, width: CodePointWidth = basicCodePointWidth): number {
  let total = 0
  for (const char of stripAnsi(text)) total += width(char.codePointAt(0) ?? 0)
  return total
}

const segmenter: { segment(input: string): Iterable<{ index: number }> } | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

function boundaries(text: string): number[] {
  const points: number[] = []
  if (segmenter) {
    for (const part of segmenter.segment(text)) points.push(part.index)
  } else {
    let index = 0
    for (const char of text) {
      points.push(index)
      index += char.length
    }
  }
  points.push(text.length)
  return points
}

export function previousBoundary(text: string, index: number): number {
  let result = 0
  for (const point of boundaries(text)) {
    if (point >= index) break
    result = point
  }
  return result
}

export function nextBoundary(text: string, index: number): number {
  for (const point of boundaries(text)) {
    if (point > index) return point
  }
  return text.length
}
