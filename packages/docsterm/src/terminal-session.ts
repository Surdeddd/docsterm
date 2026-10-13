import { LineEditor, type LineSnapshot } from './line-editor.js'
import { measureRows, renderLine, wrapText } from './line-render.js'
import type { Messages } from './messages.js'
import { SessionController, type SessionContinuation, type SessionIO } from './session-controller.js'
import { normalizeOutput, sanitizeProse } from './text.js'
import type {
  AIProvider,
  Backend,
  BackendHost,
  DocsTerminalEvent,
  InputSource,
  Locale,
  PageContext,
  RunReport,
} from './types.js'
import { basicCodePointWidth, type CodePointWidth } from './width.js'

export interface TerminalLike {
  write(data: string, callback?: () => void): void
  readonly cols: number
  readonly rows: number
  readonly buffer: {
    readonly active: { readonly cursorX: number; readonly cursorY: number; readonly type: 'normal' | 'alternate' }
  }
}

export type TerminalSessionIO = SessionIO & { writeOutOfBand(text: string): void }

export interface TerminalSessionOptions {
  terminal: TerminalLike
  backend: Backend
  ai?: AIProvider
  messages: Messages
  locale: Locale
  pageContext: PageContext
  welcome: string
  width?: CodePointWidth
  onEvent?(event: DocsTerminalEvent): void
}

interface Geometry {
  row: number
  top: number
}

interface Draft {
  readonly line: LineSnapshot
  readonly continuation: SessionContinuation | null
}

interface Ticket {
  readonly resolve: (report: RunReport) => void
  readonly reject: (error: unknown) => void
  lines: number
  report: RunReport | null
  draft: Draft | null
  started: boolean
  padded: boolean
  cut: boolean
}

interface Feed {
  readonly kind: 'text'
  readonly text: string
  readonly source: 'paste' | 'api'
  readonly enter: boolean
  readonly ticket?: Ticket
}

type Pending = string | Feed | { readonly kind: 'clear' }

type Phase = 'booting' | 'running' | 'failed' | 'disposed'

const INTERRUPT = '\x03'
const INTERRUPTED = 130
const INCOMPLETE = 2
const SETTLE_ROUNDS = 4
const TAB = '    '
const PASTE_MODE = /(?:\x1b\[|\x9b)\?([\d;]*)([hl])/g
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const BRACKETED_PASTE = '\x1b[?2004h'
const PROMPT_MODES = `\x1b[!p\x1b[0m\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b>${BRACKETED_PASTE}`
const LEAVE_ALTERNATE = `\x1b[?1049l${PROMPT_MODES}`
const CLEAR_ALL = '\x1b[H\x1b[2J\x1b[3J'
const CLEAR_SCREEN = '\x1b[H\x1b[2J'

const CONTROL = /[\x00-\x1f\x7f-\x9f]/

const STRING_INTRODUCERS = new Set([']', 'P', 'X', '^', '_'])

const SCREEN_SWITCHES = /(\x1b\[|\x9b)\?([\d;]*)([hl])/g

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049])

const withoutScreenSwitches = (text: string): string =>
  text.replace(SCREEN_SWITCHES, (whole, introducer: string, list: string, final: string) => {
    const modes = list.split(';')
    const kept = modes.filter((mode) => !ALTERNATE_SCREEN_MODES.has(Number(mode)))
    if (kept.length === modes.length) return whole
    return kept.length === 0 ? '' : `${introducer}?${kept.join(';')}${final}`
  })

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f)

function stringLength(data: string, index: number): number {
  const bell = data[index + 1] === ']'
  for (let end = index + 2; end < data.length; end += 1) {
    if (bell && data[end] === '\x07') return end + 1 - index
    if (data[end] === '\x1b' && data[end + 1] === '\\') return end + 2 - index
  }
  return data.length - index
}

function escapeLength(data: string, index: number): number {
  if (data.startsWith(PASTE_START, index)) {
    const end = data.indexOf(PASTE_END, index + PASTE_START.length)
    return end === -1 ? data.length - index : end + PASTE_END.length - index
  }
  const next = data[index + 1]
  if (next === undefined || next === '\x1b') return 1
  if (STRING_INTRODUCERS.has(next)) return stringLength(data, index)
  if (next === 'O') return Math.min(3, data.length - index)
  if (next !== '[') return (data.codePointAt(index + 1) ?? 0) > 0xffff ? 3 : 2
  let end = index + 2
  while (end < data.length && data.charCodeAt(end) >= 0x20 && data.charCodeAt(end) <= 0x3f) end += 1
  return Math.min(end + 1, data.length) - index
}

function keyLength(data: string, index: number): number {
  if (data[index] === '\x1b') return escapeLength(data, index)
  if (isControl(data.charCodeAt(index))) return 1
  let end = index + 1
  while (end < data.length && !isControl(data.charCodeAt(end))) end += 1
  return end - index
}

export function splitKeys(data: string): string[] {
  const keys: string[] = []
  for (let index = 0; index < data.length; ) {
    const length = keyLength(data, index)
    keys.push(data.slice(index, index + length))
    index += length
  }
  return keys
}

function pasteText(key: string): string {
  const body = key.slice(PASTE_START.length)
  return sanitizeProse(body.endsWith(PASTE_END) ? body.slice(0, -PASTE_END.length) : body).replace(/\t/g, TAB)
}

function expandPaste(key: string): Pending[] {
  const lines = pasteText(key).split('\n')
  return lines.flatMap((line, index): Pending[] => [
    ...(line === '' ? [] : [{ kind: 'text', text: line, source: 'paste', enter: false } as const]),
    ...(index < lines.length - 1 ? ['\r'] : []),
  ])
}

function runLines(text: string): string[] {
  const clean = sanitizeProse(text)
  return (clean.endsWith('\n') ? clean.slice(0, -1) : clean).split('\n')
}

const isApi = (item: Pending): boolean => typeof item !== 'string' && (item.kind === 'clear' || item.source === 'api')

function pasteModeIn(text: string): boolean | null {
  let mode: boolean | null = null
  for (const match of text.matchAll(PASTE_MODE)) {
    if (match[1]?.split(';').includes('2004')) mode = match[2] === 'h'
  }
  return mode
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const abortError = () => new DOMException('disposed', 'AbortError')

export class TerminalSession {
  readonly host: BackendHost
  readonly io: TerminalSessionIO
  private readonly editor: LineEditor
  private readonly controller: SessionController
  private readonly width: CodePointWidth
  private readonly tickets = new Set<Ticket>()
  private queue: Pending[] = []
  private messages: Messages
  private locale: Locale
  private phase: Phase = 'booting'
  private failure: unknown = null
  private accepting = false
  private geometry: Geometry = { row: 0, top: 0 }
  private promptHead: string[] = []
  private promptLine = ''
  private writes = 0
  private promptSeq = 0
  private prompts = 0
  private pumping = false
  private submitting: Ticket | null = null
  private active: Ticket | null = null
  private draft: Draft | null = null
  private programPaste: boolean | null = null

  constructor(private readonly options: TerminalSessionOptions) {
    this.messages = options.messages
    this.locale = options.locale
    this.width = options.width ?? basicCodePointWidth
    const write = (text: string) => this.emit(text)
    const locale = () => this.locale
    this.host = {
      write,
      get locale() {
        return locale()
      },
    }
    this.editor = new LineEditor({
      onRender: (buffer, cursor) => this.render(buffer, cursor),
      onSubmit: (line, source) => this.submit(line, source),
      onInterrupt: () => this.interrupt(),
      onComplete: (buffer, cursor) => this.controller.complete(buffer, cursor),
      onCandidates: (candidates) => this.showCandidates(candidates),
      onClearScreen: () => this.clearScreen(),
    })
    const terminal = options.terminal
    this.io = {
      write: (text) => {
        this.programPaste = pasteModeIn(text) ?? this.programPaste
        this.emit(text)
      },
      writeOutOfBand: (text) =>
        this.emit(terminal.buffer.active.type === 'normal' ? withoutScreenSwitches(text) : text),
      print: (line) => this.emit(`${line}\n`),
      printProse: (text) => this.emit(`${this.wrapped(text)}\n`),
      printPrompt: () => {
        this.prompts += 1
        this.finishSubmission()
        void this.showPrompt(false)
      },
      clearScreen: () => this.out(CLEAR_ALL),
      setBusy: (busy) => {
        if (busy) this.accepting = false
      },
      size: () => ({ columns: terminal.cols, rows: terminal.rows }),
      onInteractive: () => {
        if (this.programPaste !== true) this.out('\x1b[?2004l')
        this.pump()
      },
    }
    this.controller = new SessionController({
      backend: options.backend,
      ai: options.ai,
      messages: options.messages,
      locale: options.locale,
      io: this.io,
      pageContext: options.pageContext,
      lineHistory: () => this.editor.entries(),
      onExecuted: (command) => this.recordExecuted(command),
      onEvent: (event) => this.notify(event),
      onResult: (result) => {
        if (this.active) this.active.report = result
      },
    })
  }

  get ready(): boolean {
    return this.accepting
  }

  get isInteractive(): boolean {
    return this.controller.isInteractive
  }

  async start(): Promise<void> {
    this.out(BRACKETED_PASTE)
    this.print(this.wrapped(this.options.welcome))
    this.print(this.wrapped(this.messages.backendLoading))
    try {
      await this.options.backend.init(this.host)
    } catch (error) {
      if (this.phase === 'disposed') throw error
      this.phase = 'failed'
      this.failure = error
      this.queue = []
      this.rejectAll(error)
      this.print(this.wrapped(`${this.messages.backendFailed}: ${sanitizeProse(describeError(error))}`))
      this.print(this.wrapped(this.messages.reloadHint))
      throw error
    }
    if (this.phase === 'disposed') return
    this.phase = 'running'
    this.notify({ type: 'ready' })
    await this.showPrompt(false)
  }

  input(data: string): void {
    if (this.phase === 'failed' || this.phase === 'disposed') return
    const pasted = data.length >= PASTE_START.length + PASTE_END.length && data.startsWith(PASTE_START) && data.endsWith(PASTE_END)
    for (const key of pasted ? [data] : splitKeys(data)) this.dispatch(key)
  }

  run(text: string): Promise<RunReport> {
    if (this.phase === 'disposed') return Promise.reject(abortError())
    if (this.phase === 'failed') return Promise.reject(this.failure)
    const lines = runLines(text)
    return new Promise<RunReport>((resolve, reject) => {
      const ticket: Ticket = {
        resolve,
        reject,
        lines: lines.length,
        report: null,
        draft: null,
        started: false,
        padded: false,
        cut: false,
      }
      this.tickets.add(ticket)
      for (const line of lines) this.queue.push({ kind: 'text', text: line, source: 'api', enter: true, ticket })
      this.kick()
    })
  }

  insert(text: string): void {
    if (this.phase === 'failed' || this.phase === 'disposed') return
    this.queue.push({ kind: 'text', text: sanitizeProse(text).replace(/\n/g, ' '), source: 'api', enter: false })
    this.kick()
  }

  clear(): void {
    if (this.phase === 'failed' || this.phase === 'disposed') return
    this.queue.push({ kind: 'clear' })
    this.kick()
  }

  resize(columns: number, rows: number): void {
    if (this.phase === 'disposed') return
    this.controller.resize(columns, rows)
    if (!this.accepting) return
    this.out(this.clearBlock())
    void this.showPrompt(true)
  }

  setMessages(messages: Messages, locale: Locale): void {
    this.messages = messages
    this.locale = locale
    this.controller.setMessages(messages, locale)
  }

  setAI(ai: AIProvider | undefined): void {
    this.controller.setAI(ai)
  }

  setPageContext(context: PageContext): void {
    this.controller.setPageContext(context)
  }

  dispose(): void {
    if (this.phase === 'disposed') return
    this.phase = 'disposed'
    this.accepting = false
    this.queue = []
    this.promptSeq += 1
    this.controller.dispose()
    this.rejectAll(abortError())
  }

  private dispatch(key: string): void {
    if (key === INTERRUPT) {
      this.interrupt()
      return
    }
    if (this.controller.isInteractive && !this.pumping && this.queue.every(isApi)) {
      this.controller.handleInteractiveKey(key)
      return
    }
    this.queue.push(key)
    this.kick()
  }

  private kick(): void {
    if (this.controller.isInteractive) this.pump()
    else this.drain()
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    const step = () => {
      const live = this.phase !== 'disposed' && this.controller.isInteractive
      const index = live ? this.queue.findIndex((item) => !isApi(item)) : -1
      const [item] = index === -1 ? [] : this.queue.splice(index, 1)
      if (item === undefined) {
        this.pumping = false
        return
      }
      if (typeof item === 'string' && item.startsWith(PASTE_START)) {
        this.queue.splice(index, 0, ...expandPaste(item))
        step()
        return
      }
      this.controller.handleInteractiveKey(typeof item === 'string' ? item : item.kind === 'text' ? item.text : '')
      setTimeout(step, 0)
    }
    step()
  }

  private drain(): void {
    while (this.accepting && this.queue.length > 0) {
      const index = this.controller.isConfirming ? this.queue.findIndex((item) => !isApi(item)) : 0
      const [item] = index === -1 ? [] : this.queue.splice(index, 1)
      if (item === undefined) return
      this.feed(item, index)
    }
  }

  private feed(item: Pending, index: number): void {
    if (typeof item === 'string') {
      if (item.startsWith(PASTE_START)) this.queue.splice(index, 0, ...expandPaste(item))
      else this.editor.handleKey(item)
      return
    }
    if (item.kind === 'clear') {
      this.out(CLEAR_ALL)
      void this.showPrompt(true)
      return
    }
    const ticket = item.ticket
    if (ticket && !ticket.started) {
      ticket.started = true
      const continuation = this.controller.takeContinuation()
      if (continuation || this.editor.value !== '') {
        ticket.draft = { line: this.editor.snapshot(), continuation }
        this.editor.reset()
        this.queue.splice(index, 0, item)
        this.out(this.clearBlock())
        void this.showPrompt(true)
        return
      }
    }
    this.editor.insert(item.text, item.source)
    if (!item.enter) return
    this.submitting = ticket ?? null
    this.editor.handleKey('\r')
  }

  private interrupt(): void {
    this.dropQueue()
    if (this.controller.isInteractive || this.controller.busy) {
      this.controller.interrupt()
      return
    }
    if (!this.accepting) {
      this.print(this.messages.interrupted)
      if (this.phase === 'running') this.controller.interrupt()
      return
    }
    this.leave(this.editor.value, this.messages.interrupted)
    this.editor.reset()
    const prompts = this.prompts
    this.controller.interrupt()
    if (this.prompts === prompts) void this.showPrompt(false)
  }

  private dropQueue(): void {
    const dropped = this.queue
    this.queue = []
    for (const item of dropped) {
      if (typeof item === 'string' || item.kind !== 'text' || !item.ticket) continue
      const ticket = item.ticket
      ticket.cut = true
      ticket.lines -= 1
      if (ticket.lines === 0) this.settleTicket(ticket)
    }
  }

  private submit(line: string, source: InputSource): void {
    const confirming = this.controller.isConfirming
    this.active = this.submitting
    this.submitting = null
    this.programPaste = null
    this.leave(line)
    if (!confirming) this.editor.pushHistory(line)
    void this.controller.submit(line, source)
  }

  private finishSubmission(): void {
    const ticket = this.active
    if (!ticket) return
    this.active = null
    ticket.lines -= 1
    if (ticket.lines > 0) return
    if (this.controller.isContinuing && !ticket.padded) {
      ticket.padded = true
      ticket.lines = 1
      this.queue.unshift({ kind: 'text', text: '', source: 'api', enter: true, ticket })
      return
    }
    if (this.controller.isContinuing) {
      this.controller.takeContinuation()
      this.print(this.messages.interrupted)
      ticket.report = { exitCode: INCOMPLETE, output: '' }
      this.notify({ type: 'error', phase: 'run', message: this.messages.runIncomplete })
    }
    this.settleTicket(ticket)
  }

  private settleTicket(ticket: Ticket): void {
    if (!this.tickets.delete(ticket)) return
    const report = ticket.report ?? { exitCode: 0, output: '' }
    const draft = ticket.draft
    if (draft && this.queue.some((item) => !isApi(item))) this.keepInHistory(draft)
    else if (draft) this.draft = draft
    ticket.resolve(ticket.cut ? { exitCode: INTERRUPTED, output: report.output } : report)
  }

  private keepInHistory(draft: Draft): void {
    if (draft.line.buffer.trim() !== '') this.editor.pushHistory(draft.line.buffer)
  }

  private restoreDraft(): void {
    const draft = this.draft
    this.draft = null
    if (!draft) return
    if (this.controller.isContinuing || this.controller.isConfirming) {
      this.keepInHistory(draft)
      return
    }
    if (draft.continuation) this.controller.resumeContinuation(draft.continuation)
    this.editor.restore(draft.line)
  }

  private rejectAll(error: unknown): void {
    const open = [...this.tickets]
    this.tickets.clear()
    this.active = null
    this.submitting = null
    for (const ticket of open) ticket.reject(error)
  }

  private wrapped(text: string): string {
    return wrapText(text, this.options.terminal.cols, this.width)
  }

  private notify(event: DocsTerminalEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch (error) {
      console.error(error)
    }
  }

  private recordExecuted(command: string): void {
    if (CONTROL.test(command)) return
    if (this.editor.entries().at(-1)?.trim() === command.trim()) return
    this.editor.pushHistory(command)
  }

  private showCandidates(candidates: string[]): void {
    if (!this.accepting) return
    this.leave(this.editor.value)
    this.out(normalizeOutput(`${candidates.join('  ')}\n`))
    void this.showPrompt(true)
  }

  private clearScreen(): void {
    if (!this.accepting) return
    this.out(CLEAR_SCREEN)
    void this.showPrompt(true)
  }

  private emit(text: string): void {
    if (this.phase === 'disposed' || text === '') return
    if (!this.accepting) {
      this.out(normalizeOutput(text))
      return
    }
    this.out(`${this.clearBlock()}${normalizeOutput(text)}`)
    void this.showPrompt(true)
  }

  private print(line: string): void {
    this.out(normalizeOutput(`${line}\n`))
  }

  private out(text: string): void {
    if (this.phase === 'disposed' || text === '') return
    this.writes += 1
    this.options.terminal.write(text)
  }

  private async showPrompt(keep: boolean): Promise<void> {
    const seq = (this.promptSeq += 1)
    const stale = () => seq !== this.promptSeq || this.phase !== 'running'
    this.accepting = false
    if (!keep) {
      this.editor.reset()
      this.restoreDraft()
    }
    this.out(PROMPT_MODES)
    const terminal = this.options.terminal
    for (let round = 1; ; round += 1) {
      const writes = this.writes
      await new Promise<void>((resolve) => terminal.write('', resolve))
      if (stale()) return
      if (round >= SETTLE_ROUNDS) break
      if (writes !== this.writes) continue
      if (terminal.buffer.active.type !== 'alternate') break
      this.out(LEAVE_ALTERNATE)
    }
    const { cursorX, cursorY } = terminal.buffer.active
    const lines = this.controller.promptText.replace(/\r\n?/g, '\n').split('\n')
    const fresh = cursorX !== 0
    this.promptLine = lines.pop() ?? ''
    this.promptHead = lines
    const top = cursorY + (fresh ? 1 : 0) + this.headRows()
    this.geometry = { row: 0, top: Math.min(top, terminal.rows - 1) }
    if (!keep && this.controller.isConfirming) this.queue = this.queue.filter(isApi)
    this.accepting = true
    this.out(`${fresh ? '\r\n' : ''}${lines.map((line) => `${line}\r\n`).join('')}`)
    this.render(this.editor.value, this.editor.position)
    this.drain()
  }

  private headRows(): number {
    const columns = this.options.terminal.cols
    return this.promptHead.reduce((rows, line) => rows + measureRows(line, columns, this.width), 0)
  }

  private render(buffer: string, cursor: number): void {
    if (!this.accepting) return
    const frame = this.frame(buffer, cursor, false)
    this.geometry = { ...this.geometry, row: frame.row, top: frame.top }
    this.out(frame.text)
  }

  private leave(line: string, marker = ''): void {
    this.accepting = false
    this.out(`${this.frame(line, line.length, true).text}${marker}\r\n`)
  }

  private frame(buffer: string, cursor: number, final: boolean) {
    const terminal = this.options.terminal
    return renderLine({
      prompt: this.promptLine,
      buffer: buffer.replace(/\t/g, TAB),
      cursor: buffer.slice(0, cursor).replace(/\t/g, TAB).length,
      columns: terminal.cols,
      height: terminal.rows,
      previousRow: this.geometry.row,
      top: this.geometry.top,
      width: this.width,
      final,
    })
  }

  private clearBlock(): string {
    const climb = this.geometry.row + this.headRows()
    return `${climb > 0 ? `\x1b[${climb}A` : ''}\r\x1b[0m\x1b[0J`
  }
}
