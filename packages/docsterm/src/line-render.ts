export interface LineRenderInput {
  prompt: string
  buffer: string
  cursor: number
  columns: number
  previousRow: number
}

export interface LineRender {
  text: string
  row: number
  rows: number
}

export function renderLine(input: LineRenderInput): LineRender {
  const columns = Math.max(input.columns, 1)
  const line = `${input.prompt}${input.buffer}`
  const cursorIndex = input.prompt.length + input.cursor
  const cursorRow = Math.floor(cursorIndex / columns)
  const cursorColumn = cursorIndex % columns
  const lastRow = Math.floor(line.length / columns)

  const toBlockStart = input.previousRow > 0 ? `\x1b[${input.previousRow}A` : ''
  const wrapGuard = line.length > 0 && line.length % columns === 0 ? ' ' : ''
  const toCursorRow = lastRow > cursorRow ? `\x1b[${lastRow - cursorRow}A` : ''

  return {
    text: `${toBlockStart}\r\x1b[0J${line}${wrapGuard}\x1b[${cursorColumn + 1}G${toCursorRow}`,
    row: cursorRow,
    rows: lastRow,
  }
}

export function moveToBlockEnd(row: number, rows: number): string {
  const down = rows - row
  return `${down > 0 ? `\x1b[${down}B` : ''}\r`
}
