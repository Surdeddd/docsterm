export const WORD_CHARS = '\\p{L}\\p{M}\\p{N}_'

export const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: '\\p{L}\\p{M}\\p{N}',
  alpha: '\\p{L}\\p{M}',
  blank: '\\p{Zs}\\t',
  cntrl: '\\p{Cc}',
  digit: '0-9',
  graph: '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}',
  lower: '\\p{Ll}',
  print: '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}\\p{Zs}',
  punct: '\\p{P}\\p{S}',
  space: '\\s',
  upper: '\\p{Lu}',
  word: WORD_CHARS,
  xdigit: '0-9A-Fa-f',
}

let collator: Intl.Collator | null = null

export const collate = (a: string, b: string): number => (collator ??= new Intl.Collator('en')).compare(a, b)

export const codeOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const compareNames = (a: string, b: string): number => collate(a, b) || codeOrder(a, b)
