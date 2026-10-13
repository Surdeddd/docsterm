export const ANSI_SOURCE = String.raw`\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|(?=\x1b))|\x1b[PX^_][^\x1b]*(?:\x1b\\|(?=\x1b))|\x1b[ -/]*[0-~]`

const ANSI_PATTERN = new RegExp(ANSI_SOURCE, 'g')

const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

const INVISIBLE_SOURCE = String.raw`[\p{Cf}\p{Zl}\p{Zp}\p{Cn}\p{Cs}ᅟᅠㅤﾠ]`

const INVISIBLE = new RegExp(INVISIBLE_SOURCE, 'u')

const INVISIBLES = new RegExp(INVISIBLE_SOURCE, 'gu')

export function hasInvisible(text: string): boolean {
  return INVISIBLE.test(text)
}

export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLES, '')
}

export function normalizeOutput(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function sanitizeProse(text: string): string {
  return stripAnsi(text).replace(/\r\n?/g, '\n').replace(CONTROL_PATTERN, '')
}

export function sanitizeCommand(text: string): string {
  return sanitizeProse(text).trim()
}
