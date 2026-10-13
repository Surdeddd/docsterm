import { formatMessage, getMessages } from '../messages.js'
import { ANSI_SOURCE, normalizeOutput, stripAnsi } from '../text.js'
import type { BackendRunResult, InteractiveRun, RunContext } from '../types.js'
import { basicCodePointWidth } from '../width.js'
import type { CommandContext, CommandResult } from './context.js'
import { isOptionError, parseOptions } from './options.js'

const ENTER_ALTERNATE = '\x1b[?1049h'
const LEAVE_ALTERNATE = '\x1b[?1049l'
const HOME_AND_CLEAR = '\x1b[H\x1b[2J'
const INVERSE = '\x1b[7m'
const RESET = '\x1b[0m'
const TAB_WIDTH = 8
const TOKEN = new RegExp(`${ANSI_SOURCE}|[\\s\\S]`, 'gu')
const KEY = /\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b[\s\S]?|[\s\S]/gu
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g
const LESS_SPEC = { flags: '~cdEeFfIiKMmNnQqRrSsuWwX' }

export interface PagerView {
  lines: string[]
  offset: number
  height: number
  title: string
  columns?: number
  hint?: string
  sources?: readonly number[]
  total?: number
}

export interface PagerLayout {
  rows: string[]
  sources: number[]
  total: number
}

const isControl = (codePoint: number): boolean => codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)

export function wrapRows(text: string, columns: number): PagerLayout {
  const width = Math.max(columns, 1)
  const logical = text.replace(/\n$/, '').split('\n')
  const rows: string[] = []
  const sources: number[] = []
  logical.forEach((line, source) => {
    let row = ''
    let column = 0
    let style = ''
    const close = (): void => {
      rows.push(style ? `${row}${RESET}` : row)
      sources.push(source)
    }
    const wrap = (): void => {
      close()
      row = style
      column = 0
    }
    for (const [token] of line.matchAll(TOKEN)) {
      if (token.startsWith('\x1b')) {
        if (token.startsWith('\x1b[') && token.endsWith('m')) {
          row += token
          style = /^\x1b\[[0;]*m$/.test(token) ? '' : `${style}${token}`
        }
        continue
      }
      if (token === '\t') {
        if (column >= width) wrap()
        const spaces = Math.min(TAB_WIDTH - (column % TAB_WIDTH), width - column)
        row += ' '.repeat(spaces)
        column += spaces
        continue
      }
      const codePoint = token.codePointAt(0) as number
      if (isControl(codePoint)) continue
      const cells = basicCodePointWidth(codePoint)
      if (cells > 0 && column + cells > width && column > 0) wrap()
      row += token
      column += cells
    }
    close()
  })
  return { rows, sources, total: logical.length }
}

const fitWidth = (text: string, columns: number): string => {
  let result = ''
  let used = 0
  for (const char of text) {
    const cells = basicCodePointWidth(char.codePointAt(0) as number)
    if (used + cells > columns) break
    result += char
    used += cells
  }
  return result
}

export function renderPage(view: PagerView): string {
  const body = view.lines.slice(view.offset, view.offset + view.height)
  const padded = [...body, ...Array.from({ length: Math.max(view.height - body.length, 0) }, () => '')]
  const shown = Math.min(view.offset + view.height, view.lines.length)
  const last = view.sources ? (view.sources[shown - 1] ?? -1) + 1 : shown
  const total = view.total ?? view.lines.length
  const percent = view.lines.length === 0 ? 100 : Math.round((shown / view.lines.length) * 100)
  const title = stripAnsi(view.title).replace(CONTROLS, '')
  const status = ` ${title} ${last}/${total} (${percent}%) - ${view.hint ?? getMessages('en').pagerHint} `
  const fitted = view.columns === undefined ? status : fitWidth(status, view.columns)
  return `${HOME_AND_CLEAR}${padded.join('\r\n')}\r\n${INVERSE}${fitted}${RESET}`
}

type PagerAction = 'quit' | 'pageDown' | 'pageUp' | 'lineDown' | 'lineUp' | 'halfDown' | 'halfUp' | 'top' | 'bottom'

const KEY_GROUPS: ReadonlyArray<readonly [PagerAction, readonly string[]]> = [
  ['quit', ['q', 'Q', 'ZZ', '\x03']],
  ['pageDown', [' ', 'f', '\x06', '\x16', '\x1b[6~']],
  ['pageUp', ['b', '\x02', '\x1b[5~']],
  ['lineDown', ['j', 'e', '\r', '\n', '\x05', '\x0e', '\x1b[B', '\x1bOB']],
  ['lineUp', ['k', 'y', '\x19', '\x10', '\x0b', '\x1b[A', '\x1bOA']],
  ['halfDown', ['d', '\x04']],
  ['halfUp', ['u', '\x15']],
  ['top', ['g', '<', '\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']],
  ['bottom', ['G', '>', '\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']],
]

const KEY_ACTIONS = new Map(KEY_GROUPS.flatMap(([action, keys]) => keys.map((key) => [key, action] as const)))

export function nextOffset(view: PagerView, key: string): number | 'quit' {
  const maxOffset = Math.max(view.lines.length - view.height, 0)
  const clamp = (value: number): number => Math.min(Math.max(value, 0), maxOffset)
  const half = Math.max(Math.floor(view.height / 2), 1)
  switch (KEY_ACTIONS.get(key)) {
    case 'quit':
      return 'quit'
    case 'pageDown':
      return clamp(view.offset + view.height)
    case 'pageUp':
      return clamp(view.offset - view.height)
    case 'lineDown':
      return clamp(view.offset + 1)
    case 'lineUp':
      return clamp(view.offset - 1)
    case 'halfDown':
      return clamp(view.offset + half)
    case 'halfUp':
      return clamp(view.offset - half)
    case 'top':
      return 0
    case 'bottom':
      return maxOffset
    default:
      return view.offset
  }
}

export type PagerStart = 'end' | number

const startOffset = (layout: PagerLayout, height: number, start: PagerStart | undefined): number => {
  const maxOffset = Math.max(layout.rows.length - height, 0)
  if (start === 'end') return maxOffset
  if (start === undefined || start <= 1) return 0
  const row = layout.sources.indexOf(start - 1)
  return row === -1 ? maxOffset : Math.min(row, maxOffset)
}

export function createPager(text: string, title: string, ctx: RunContext, start?: PagerStart): InteractiveRun {
  const hint = getMessages(ctx.locale ?? 'en').pagerHint
  let columns = ctx.columns
  let rows = ctx.rows
  let layout = wrapRows(text, columns)
  let offset = startOffset(layout, Math.max(rows - 1, 1), start)
  let finished = false
  let pendingZ = false
  let finish: (result: BackendRunResult) => void = () => {}
  const done = new Promise<BackendRunResult>((resolve) => {
    finish = resolve
  })

  const view = (): PagerView => ({
    lines: layout.rows,
    offset,
    height: Math.max(rows - 1, 1),
    title,
    columns,
    hint,
    sources: layout.sources,
    total: layout.total,
  })
  const draw = (): void => ctx.write(renderPage(view()))
  const abort = (): void => close(130)
  const close = (exitCode: number): void => {
    if (finished) return
    finished = true
    ctx.signal.removeEventListener('abort', abort)
    ctx.write(LEAVE_ALTERNATE)
    finish({ output: '', exitCode })
  }
  const press = (key: string): void => {
    if (key === 'Z') {
      if (pendingZ) close(0)
      pendingZ = !pendingZ
      return
    }
    pendingZ = false
    const target = nextOffset(view(), key)
    if (target === 'quit') {
      close(0)
    } else if (target !== offset) {
      offset = target
      draw()
    }
  }

  if (ctx.signal.aborted) {
    finished = true
    finish({ output: '', exitCode: 130 })
  } else {
    ctx.signal.addEventListener('abort', abort, { once: true })
    ctx.write(ENTER_ALTERNATE)
    draw()
  }

  return {
    onKey(data: string): void {
      for (const [key] of data.matchAll(KEY)) {
        if (finished) return
        press(key)
      }
    },
    resize(nextColumns: number, nextRows: number): void {
      if (finished) return
      const top = layout.sources[offset] ?? 0
      columns = nextColumns
      rows = nextRows
      layout = wrapRows(text, columns)
      const maxOffset = Math.max(layout.rows.length - Math.max(rows - 1, 1), 0)
      offset = Math.min(Math.max(layout.sources.indexOf(top), 0), maxOffset)
      draw()
    },
    cancel(): void {
      close(130)
    },
    done,
  }
}

export interface LessInput {
  piped?: boolean
}

const startCommand = (args: readonly string[]): PagerStart | undefined => {
  let start: PagerStart | undefined
  for (const arg of args) {
    if (arg === '+G') start = 'end'
    else if (arg === '+g') start = 1
    else if (/^\+\d+g?$/.test(arg)) start = Number.parseInt(arg.slice(1), 10)
  }
  return start
}

const readPage = (ctx: CommandContext, name: string, operand: string): { text: string } | { error: string } => {
  if (operand === '-') return { text: ctx.stdin }
  const path = ctx.fs.resolve(ctx.cwd, operand)
  const directory = ctx.fs.isDir(path)
  const text = directory ? null : ctx.fs.read(path)
  if (text !== null) return { text }
  return { error: `${name}: ${operand}: ${directory ? 'Is a directory' : 'No such file or directory'}\n` }
}

const copyThrough = (ctx: CommandContext, name: string, operands: readonly string[], piped: boolean): CommandResult => {
  let stdout = ''
  let stderr = ''
  const out =
    ctx.write ??
    ((text: string) => {
      stdout += text
    })
  const err =
    ctx.writeError ??
    ((text: string) => {
      stderr += text
    })
  if (operands.length === 0) {
    if (!piped) return { stderr: `${name}: missing filename\n`, exitCode: 1 }
    out(ctx.stdin)
    return { stdout, exitCode: 0 }
  }
  let exitCode = 0
  for (const operand of operands) {
    const page = readPage(ctx, name, operand)
    if ('error' in page) {
      err(page.error)
      exitCode = 1
      continue
    }
    if (name === 'more' && operands.length > 1) out(`::::::::::::::\n${operand}\n::::::::::::::\n`)
    out(page.text)
  }
  return { stdout, stderr, exitCode }
}

export function lessCommand(ctx: CommandContext, run: RunContext | undefined, input: LessInput = {}): InteractiveRun | CommandResult {
  const name = ctx.argv[0] ?? 'less'
  const options = parseOptions(
    ctx.argv.filter((arg, index) => index === 0 || !arg.startsWith('+')),
    LESS_SPEC,
  )
  if (isOptionError(options)) return { stderr: `${options.error}\n`, exitCode: 2 }
  const piped = input.piped ?? ctx.stdin !== ''
  if (ctx.isTTY === false) return copyThrough(ctx, name, options.operands, piped)
  if (!run) {
    return { stderr: `${formatMessage(getMessages(ctx.locale ?? 'en').shellNeedsTerminal, { name })}\n`, exitCode: 1 }
  }
  const start = startCommand(ctx.argv.slice(1))
  if (options.operands.length === 0) {
    if (!piped) return { stderr: `${name}: missing filename\n`, exitCode: 1 }
    return createPager(ctx.stdin, 'stdin', run, start)
  }
  const errors: string[] = []
  for (const operand of options.operands) {
    const page = readPage(ctx, name, operand)
    if ('error' in page) {
      errors.push(page.error)
      continue
    }
    if (errors.length > 0) {
      const report = ctx.writeError ?? ((message: string) => run.write(normalizeOutput(message)))
      report(errors.join(''))
    }
    return createPager(page.text, operand === '-' ? 'stdin' : operand, run, start)
  }
  return { stderr: errors.join(''), exitCode: 1 }
}
