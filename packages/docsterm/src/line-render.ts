import { ANSI_SOURCE } from './text.js'
import { basicCodePointWidth, displayWidth, nextBoundary, type CodePointWidth } from './width.js'

export interface LineRenderInput {
  prompt: string
  buffer: string
  cursor: number
  columns: number
  previousRow: number
  height?: number
  top?: number
  width?: CodePointWidth
  final?: boolean
}

export interface LineRender {
  text: string
  row: number
  rows: number
  top: number
}

interface Position {
  row: number
  column: number
}

interface LineLayout {
  rowStarts: number[]
  end: Position
  cursor: Position
}

const ESCAPE = new RegExp(ANSI_SOURCE, 'y')
const ESCAPES = new RegExp(ANSI_SOURCE, 'g')
const HAS_ESCAPE = /[\x1b\x9b]/

function escapeAt(text: string, index: number): number {
  ESCAPE.lastIndex = index
  return ESCAPE.exec(text)?.[0].length ?? 0
}

function layoutLine(line: string, columns: number, width: CodePointWidth, target: number): LineLayout {
  const rowStarts = [0]
  let row = 0
  let column = 0
  let cursor: Position | null = null
  let index = 0
  while (index < line.length) {
    const escape = escapeAt(line, index)
    if (escape > 0) {
      index += escape
      continue
    }
    const codePoint = line.codePointAt(index) ?? 0
    const cells = width(codePoint)
    if (cells > 0 && column > 0 && column + cells > columns) {
      row += 1
      column = 0
      rowStarts.push(index)
    }
    if (index === target) cursor = { row, column }
    column += cells
    index += codePoint > 0xffff ? 2 : 1
  }
  const wrapped = column >= columns ? { row: row + 1, column: 0 } : { row, column }
  return { rowStarts, end: { row, column }, cursor: cursor ?? wrapped }
}

const up = (count: number) => (count > 0 ? `\x1b[${count}A` : '')

export function renderLine(input: LineRenderInput): LineRender {
  const columns = Math.max(input.columns, 1)
  const height = Math.max(input.height ?? Number.POSITIVE_INFINITY, 1)
  const separator = HAS_ESCAPE.test(input.prompt) ? '\x1b[0m' : ''
  const line = `${input.prompt}${separator}${input.buffer}`
  const target = input.final ? line.length : input.prompt.length + separator.length + input.cursor
  const layout = layoutLine(line, columns, input.width ?? basicCodePointWidth, target)
  const guard = !input.final && layout.end.column >= columns
  if (guard) layout.rowStarts.push(line.length)
  const last = layout.end.row + (guard ? 1 : 0)

  const top = input.top ?? 0
  const reach = Math.max(top, 0)
  const hidden = reach - top
  const first = hidden <= last ? hidden : 0
  const from = layout.rowStarts[first] ?? 0
  const bottom = reach + last - first
  const scroll = Math.max(bottom - (height - 1), 0)
  const nextTop = reach - first - scroll
  const end = bottom - scroll
  const prefix = line.slice(0, from).match(ESCAPES)?.join('') ?? ''
  const body = `${up(top + input.previousRow - reach)}\r\x1b[0m\x1b[0J${prefix}${line.slice(from)}`
  if (input.final) return { text: body, row: last, rows: last, top: nextTop }

  const cursorRow = Math.max(nextTop + layout.cursor.row, 0)
  return {
    text: `${body}${guard ? ' ' : ''}\x1b[${layout.cursor.column + 1}G${up(end - cursorRow)}`,
    row: cursorRow - nextTop,
    rows: last,
    top: nextTop,
  }
}

export function measureRows(text: string, columns: number, width: CodePointWidth = basicCodePointWidth): number {
  return layoutLine(text, Math.max(columns, 1), width, text.length).end.row + 1
}

const WRAP_LIMIT = 10_000

function pieces(word: string, columns: number, width: CodePointWidth): string[] {
  const parts: string[] = []
  let start = 0
  let cells = 0
  for (let index = 0; index < word.length; ) {
    const next = nextBoundary(word, index)
    const added = displayWidth(word.slice(index, next), width)
    if (cells + added > columns && index > start) {
      parts.push(word.slice(start, index))
      start = index
      cells = 0
    }
    cells += added
    index = next
  }
  parts.push(word.slice(start))
  return parts
}

function wrapLine(line: string, columns: number, width: CodePointWidth): string {
  const rows: string[] = []
  let row: string | null = null
  let used = 0
  for (const word of line.split(' ')) {
    const cells = displayWidth(word, width)
    if (row !== null && used + 1 + cells <= columns) {
      row = `${row} ${word}`
      used += 1 + cells
      continue
    }
    if (row !== null) rows.push(row)
    const parts = cells > columns ? pieces(word, columns, width) : [word]
    rows.push(...parts.slice(0, -1))
    row = parts.at(-1) ?? ''
    used = displayWidth(row, width)
  }
  if (row !== null) rows.push(row)
  return rows.join('\n')
}

export function wrapText(text: string, columns: number, width: CodePointWidth = basicCodePointWidth): string {
  if (!Number.isFinite(columns) || columns < 1 || text.length > WRAP_LIMIT) return text
  const limit = Math.floor(columns)
  return text
    .split('\n')
    .map((line) => wrapLine(line, limit, width))
    .join('\n')
}

export function moveToBlockEnd(row: number, rows: number): string {
  const down = rows - row
  return `${down > 0 ? `\x1b[${down}B` : ''}\r`
}
