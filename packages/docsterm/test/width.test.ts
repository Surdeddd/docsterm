import { beforeAll, describe, expect, it } from 'vitest'
import {
  basicCodePointWidth,
  displayWidth,
  loadXtermCodePointWidth,
  nextBoundary,
  previousBoundary,
  type CodePointWidth,
} from '../src/width.js'

let xterm: CodePointWidth

beforeAll(async () => {
  xterm = await loadXtermCodePointWidth()
})

describe('displayWidth with the xterm Unicode 11 provider', () => {
  it.each([
    ['abc', 3],
    ['日本語', 6],
    ['😀', 2],
    ['👍🏽', 4],
    ['é', 1],
    ['привет', 6],
    ['\x1b[32m/p\x1b[0m $ ', 5],
    ['', 0],
  ])('%j is %i cells', (text, cells) => {
    expect(displayWidth(text, xterm)).toBe(cells)
  })

  it('basic fallback gives control characters no cells, combining and format marks none, and wide scripts two', () => {
    const cases: Array<[number, number]> = [
      [0x00, 0],
      [0x09, 0],
      [0x1b, 0],
      [0x1f, 0],
      [0x20, 1],
      [0x7e, 1],
      [0x7f, 0],
      [0x9f, 0],
      [0xa0, 1],
      [0x2ff, 1],
      [0x300, 0],
      [0x20dd, 0],
      [0x200b, 0],
      [0x4e00, 2],
      [0xac00, 2],
      [0xff01, 2],
      [0x1f600, 2],
      [0x20000, 2],
      [0x0416, 1],
    ]
    expect(cases.map(([codePoint]) => [codePoint, basicCodePointWidth(codePoint)])).toEqual(cases)
    expect(displayWidth('a\tb\x07ć​')).toBe(3)
  })

  it('basic fallback agrees with xterm on common text', () => {
    for (const sample of ['abc', '日本語', '😀', 'é', 'привет', 'ｆｕｌｌ']) {
      expect(displayWidth(sample, basicCodePointWidth)).toBe(displayWidth(sample, xterm))
    }
  })
})

describe('grapheme boundaries', () => {
  it('never splits a surrogate pair, an emoji modifier or a ZWJ family', () => {
    const text = 'a👍🏽b👨‍👩‍👧c'
    const forward: number[] = []
    for (let index = 0; index < text.length; index = nextBoundary(text, index)) forward.push(index)
    expect(forward).toEqual([0, 1, 5, 6, 14])
    expect(previousBoundary(text, text.length)).toBe(14)
    expect(previousBoundary(text, 14)).toBe(6)
    expect(previousBoundary(text, 6)).toBe(5)
    expect(previousBoundary(text, 5)).toBe(1)
    expect(previousBoundary(text, 0)).toBe(0)
  })

  it('treats a combining accent as part of its base letter', () => {
    expect(nextBoundary('éx', 0)).toBe(2)
    expect(previousBoundary('éx', 2)).toBe(0)
  })
})
