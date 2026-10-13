import { formatMessage, type Messages } from './messages.js'
import { ANSI_SOURCE, hasInvisible, sanitizeCommand, sanitizeProse, stripAnsi, withoutInvisible } from './text.js'
import {
  isInteractiveRun,
  type AIProvider,
  type Backend,
  type BackendRunResult,
  type CommandSource,
  type CompletionReply,
  type DocsTerminalEvent,
  type HistoryEntry,
  type InputSource,
  type InteractiveRun,
  type Locale,
  type PageContext,
  type RunReport,
  type SuggestInput,
} from './types.js'
import { displayWidth } from './width.js'

export interface SessionIO {
  write(text: string): void
  writeOutOfBand?(text: string): void
  print(line: string): void
  printProse?(text: string): void
  printPrompt(): void
  clearScreen(): void
  setBusy(busy: boolean): void
  size?(): { columns: number; rows: number }
  onInteractive?(): void
}

export interface SessionControllerOptions {
  backend: Backend
  ai?: AIProvider
  messages: Messages
  locale?: Locale
  io: SessionIO
  pageContext: PageContext
  lineHistory?: () => readonly string[]
  onExecuted?(command: string): void
  onEvent?(event: DocsTerminalEvent): void
  onResult?(result: RunReport): void
}

export interface SessionContinuation {
  readonly source: string
  readonly origin: CommandSource
}

interface Task {
  readonly signal: AbortSignal
  current(): boolean
}

interface Running {
  readonly command: string
  readonly log: StreamLog
}

interface Program {
  readonly run: InteractiveRun
  readonly task: Task
}

type LineState = 'start' | 'open' | 'progress'

const HISTORY_CAP = 50
const HISTORY_FOR_AI = 5
const OUTPUT_HEAD = 500
const OUTPUT_TAIL = 1500
const ELISION = '\n...\n'
const STREAM_WINDOW = 16384
const COMMAND_LIMIT = 2000
const DOUBLE_INTERRUPT_MS = 1000
const DEFAULT_SIZE = { columns: 80, rows: 24 }
const TAB_CELLS = 8
const FIRST_WIDE_CODE_POINT = 0x1100
const BUILTINS = new Set(['clear', 'help', 'history', 'explain'])
const KEY_MISSING_ERRORS = new Set(['KeyMissingError', 'ProviderKeyMissingError'])
const ERASE_LINE = '\x1b[K'
const ESCAPES = new RegExp(ANSI_SOURCE, 'g')
const SCREEN_SWITCH = /^(?:\x1b\[|\x9b)\?([\d;]*)([hl])$/
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049])
const UNFINISHED_ESCAPE = /^(?:\x1b(?:\[[0-?]*)?|\x9b[0-?]*)$/
const UNFINISHED_LIMIT = 64
const RESULT_LIMIT = 4096
const INTERRUPTED = 130

const YES: Record<Locale, readonly string[]> = {
  en: ['y', 'yes'],
  ru: ['y', 'yes', 'д', 'да'],
}

const AI_ERROR_MESSAGES: Readonly<Record<string, keyof Messages>> = {
  'key-missing': 'keyMissing',
  refused: 'aiRefused',
  truncated: 'aiTruncated',
  empty: 'aiEmpty',
  invalid: 'aiInvalid',
  network: 'aiNetwork',
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const exitCodeOf = (value: unknown): number => {
  const code = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof code === 'number' && Number.isFinite(code) ? code : 0
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

const elapsed = (started: number): number => Math.max(0, Math.round(now() - started))

const resultText = (text: string): string => {
  const plain = sanitizeProse(text)
  return plain.length <= RESULT_LIMIT ? plain : plain.slice(-RESULT_LIMIT)
}

const safely = (action: () => void): void => {
  try {
    action()
  } catch (error) {
    console.error(error)
  }
}

const detach = (text: string): string => {
  const middle = text.length >> 1
  return middle === 0 ? text : [text.slice(0, middle), text.slice(middle)].join('')
}

const excerpt = (head: string, tail: string): string =>
  [head.slice(0, OUTPUT_HEAD), ELISION, tail.slice(-OUTPUT_TAIL)].join('')

const brief = (plain: string): string =>
  plain.length <= OUTPUT_HEAD + OUTPUT_TAIL ? detach(plain) : excerpt(plain, plain)

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const lineStateAfter = (plain: string): LineState => {
  if (plain.endsWith('\n')) return 'start'
  return plain.endsWith('\r') ? 'progress' : 'open'
}

const ignoreFailure = (action: () => unknown): void => {
  try {
    void Promise.resolve(action()).catch(() => undefined)
  } catch {
    return
  }
}

const screenSwitch = (sequence: string): boolean | null => {
  const match = SCREEN_SWITCH.exec(sequence)
  if (!match) return null
  const modes = match[1].split(';').map(Number)
  return modes.some((mode) => ALTERNATE_SCREEN_MODES.has(mode)) ? match[2] === 'h' : null
}

const unfinishedFrom = (text: string): number => {
  const floor = Math.max(text.length - UNFINISHED_LIMIT, 0)
  for (let index = text.length - 1; index >= floor; index -= 1) {
    const code = text.charCodeAt(index)
    if (code === 0x1b || code === 0x9b) return UNFINISHED_ESCAPE.test(text.slice(index)) ? index : text.length
  }
  return text.length
}

const withoutFinalNewline = (text: string): string => {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

const firstLine = (command: string): string => {
  const [head = '', ...rest] = command.split('\n')
  return rest.length > 0 ? `${head} ...` : head
}

const maxCells = (char: string): number => {
  if (char === '\t') return TAB_CELLS
  return (char.codePointAt(0) ?? 0) < FIRST_WIDE_CODE_POINT ? 1 : 2
}

const rowsFor = (line: string, columns: number): number => {
  let rows = 1
  let column = 0
  for (const char of line) {
    const cells = maxCells(char)
    if (column + cells > columns) {
      rows += 1
      column = 0
    }
    column += cells
  }
  return rows
}

class StreamLog {
  private head = ''
  private tail = ''
  private length = 0
  private pending = ''
  private alternate = false

  add(text: string, keep = true): string {
    const input = this.pending === '' ? text : `${this.pending}${text}`
    const cut = unfinishedFrom(input)
    this.pending = input.slice(cut)
    const visible = this.scan(cut === input.length ? input : input.slice(0, cut))
    if (keep) this.append(visible)
    return visible
  }

  rest(output: string): string {
    this.flush()
    if (this.length === 0) return output
    if (output.length < this.length) return !this.elided && (this.head + this.tail).startsWith(output) ? '' : output
    const copied = this.elided
      ? output.startsWith(this.head) && output.slice(this.length - this.tail.length, this.length) === this.tail
      : output.startsWith(this.head + this.tail)
    return copied ? output.slice(this.length) : output
  }

  record(rest: string, ownLine = false): { evidence: string; output: string } {
    this.flush()
    if (ownLine && !this.endsLine()) this.append('\n')
    this.append(rest)
    const evidence = this.elided
      ? excerpt(stripAnsi(this.head), stripAnsi(this.tail))
      : brief(stripAnsi(this.head + this.tail))
    const output = this.output()
    this.head = ''
    this.tail = ''
    return { evidence, output }
  }

  output(): string {
    return resultText(this.elided ? this.tail : this.head + this.tail)
  }

  private scan(text: string): string {
    if (!text.includes('\x1b[?') && !text.includes('\x9b?')) return this.alternate ? '' : text
    const parts: string[] = []
    let from = 0
    for (const match of text.matchAll(ESCAPES)) {
      const enter = screenSwitch(match[0])
      if (enter === null || enter === this.alternate) continue
      if (enter) parts.push(text.slice(from, match.index))
      from = match.index + match[0].length
      this.alternate = enter
    }
    if (!this.alternate) parts.push(text.slice(from))
    return parts.join('')
  }

  private flush(): void {
    if (!this.alternate) this.append(this.pending)
    this.pending = ''
  }

  private endsLine(): boolean {
    const plain = stripAnsi(this.head + this.tail)
    return plain === '' || plain.endsWith('\n')
  }

  private append(text: string): void {
    if (text === '') return
    this.length += text.length
    const room = STREAM_WINDOW - this.head.length
    if (text.length <= room) {
      this.head += text
      return
    }
    if (room > 0) this.head = detach(this.head + text.slice(0, room))
    this.keepTail(text.slice(room))
  }

  private keepTail(text: string): void {
    if (text.length >= STREAM_WINDOW) {
      this.tail = detach(text.slice(-STREAM_WINDOW))
      return
    }
    this.tail += text
    if (this.tail.length > 2 * STREAM_WINDOW) this.tail = detach(this.tail.slice(-STREAM_WINDOW))
  }

  private get elided(): boolean {
    return this.length > this.head.length + this.tail.length
  }
}

export class SessionController {
  private readonly opts: SessionControllerOptions
  private readonly history: HistoryEntry[] = []
  private lastError: HistoryEntry | null = null
  private pendingSuggestion: string | null = null
  private pendingRequest = ''
  private pendingSource: string | null = null
  private pendingOrigin: CommandSource = 'typed'
  private running: Running | null = null
  private interactive: Program | null = null
  private cancelling: Task | null = null
  private abort: AbortController | null = null
  private busyFlag = false
  private token = 0
  private disposed = false
  private lineState: LineState = 'start'
  private interruptedAt = Number.NEGATIVE_INFINITY
  private cancelWrote = false
  private checking: string | null = null

  constructor(options: SessionControllerOptions) {
    this.opts = { ...options }
  }

  get busy(): boolean {
    return this.busyFlag
  }

  get isConfirming(): boolean {
    return this.pendingSuggestion !== null
  }

  get isInteractive(): boolean {
    return this.interactive !== null
  }

  get isContinuing(): boolean {
    return this.pendingSource !== null
  }

  get promptText(): string {
    const { backend, messages } = this.opts
    if (this.pendingSuggestion !== null) return messages.confirmRun
    if (this.pendingSource !== null) return backend.continuationPrompt ?? '... '
    return backend.prompt
  }

  takeContinuation(): SessionContinuation | null {
    if (this.pendingSource === null || this.busyFlag) return null
    const continuation = { source: this.pendingSource, origin: this.pendingOrigin }
    this.pendingSource = null
    return continuation
  }

  resumeContinuation(continuation: SessionContinuation): void {
    if (this.disposed || this.busyFlag || this.pendingSuggestion !== null || this.pendingSource !== null) return
    this.pendingSource = continuation.source
    this.pendingOrigin = continuation.origin
  }

  setAI(ai: AIProvider | undefined): void {
    this.opts.ai = ai
  }

  setMessages(messages: Messages, locale: Locale): void {
    this.opts.messages = messages
    this.opts.locale = locale
  }

  setPageContext(context: PageContext): void {
    this.opts.pageContext = context
  }

  resize(columns: number, rows: number): void {
    const program = this.interactive
    if (program) ignoreFailure(() => program.run.resize?.(columns, rows))
  }

  dispose(): void {
    if (this.disposed) return
    const program = this.interactive
    this.disposed = true
    this.abort?.abort()
    this.abort = null
    this.token += 1
    this.interactive = null
    this.running = null
    this.pendingSuggestion = null
    this.pendingSource = null
    this.busyFlag = false
    if (program) ignoreFailure(() => program.run.cancel?.())
  }

  async complete(line: string, cursor: number): Promise<CompletionReply | null> {
    const { backend } = this.opts
    if (this.disposed || this.pendingSuggestion !== null || !backend.complete) return null
    try {
      return (await backend.complete({ line, cursor })) ?? null
    } catch {
      return null
    }
  }

  handleInteractiveKey(data: string): void {
    const program = this.interactive
    if (!program || this.disposed) return
    if (data === '\x03') this.interrupt()
    else this.send(program.run, data)
  }

  interrupt(): void {
    if (this.disposed) return
    const program = this.interactive
    if (program) {
      this.interruptProgram(program)
      return
    }
    const { messages } = this.opts
    this.pendingSource = null
    if (this.busyFlag) {
      this.reportInterrupt()
      this.stop()
      this.markInterrupt()
    } else {
      this.lineState = 'start'
      if (this.pendingSuggestion !== null) {
        this.answered(false)
        this.prose(messages.cancelled)
      }
    }
    this.prompt()
  }

  async submit(line: string, source: InputSource = 'typed'): Promise<void> {
    if (this.disposed || this.busyFlag) return
    this.lineState = 'start'
    if (this.pendingSuggestion !== null) return this.confirm(line)
    if (this.pendingSource !== null) return this.collect(`${this.pendingSource}\n${line}`, this.pendingOrigin)
    const trimmed = line.trim()
    if (trimmed === '') return this.prompt()
    const { ai } = this.opts
    if (ai && source === 'typed' && trimmed.startsWith('#')) return this.suggest(ai, trimmed.slice(1).trim())
    if (BUILTINS.has(trimmed) && (trimmed !== 'explain' || source === 'typed')) return this.builtin(trimmed, source)
    return this.collect(trimmed, source)
  }

  private async builtin(word: string, origin: CommandSource): Promise<void> {
    if (word === 'explain') return this.explain()
    const started = now()
    let printed: string[] = []
    if (word === 'clear') this.clear()
    else printed = word === 'help' ? this.help() : this.listHistory()
    this.result(0, printed.join('\n'))
    this.notify({ type: 'command', command: word, source: origin, exitCode: 0, durationMs: elapsed(started) })
    this.prompt()
  }

  private help(): string[] {
    const { ai, messages } = this.opts
    const description = this.describe()
    const lines = [ai ? messages.helpText : messages.helpTextNoAi, messages.keysHelp]
    if (description !== undefined) lines.push(description)
    for (const line of lines) this.prose(line)
    return lines
  }

  private listHistory(): string[] {
    const entries = this.opts.lineHistory?.() ?? []
    const lines = entries.map((entry, index) => `${String(index + 1).padStart(5)}  ${entry}`)
    for (const line of lines) this.line(line)
    return lines
  }

  private async collect(source: string, origin: CommandSource): Promise<void> {
    const verdict = this.verdict(source)
    if (typeof verdict === 'boolean') return this.proceed(source, verdict, origin)
    const task = this.begin()
    this.checking = source
    let complete: boolean
    try {
      complete = (await verdict) !== false
    } catch {
      complete = true
    }
    if (!task.current()) return
    this.checking = null
    if (!complete) {
      this.abort = null
      this.setBusy(false)
    }
    return this.proceed(source, complete, origin)
  }

  private verdict(source: string): boolean | Promise<boolean> {
    const { backend } = this.opts
    if (!backend.isComplete) return true
    try {
      return backend.isComplete(source)
    } catch {
      return true
    }
  }

  private async proceed(source: string, complete: boolean, origin: CommandSource): Promise<void> {
    if (!complete) {
      this.pendingSource = source
      this.pendingOrigin = origin
      this.prompt()
      return
    }
    this.pendingSource = null
    return this.run(source, origin)
  }

  private async run(command: string, origin: CommandSource): Promise<void> {
    const { backend, messages } = this.opts
    const task = this.begin()
    const log = new StreamLog()
    const started = now()
    const settle = (rest: string, exitCode: number, ownLine = false) => {
      const { evidence, output } = log.record(rest, ownLine)
      this.result(exitCode, output)
      this.notify({ type: 'command', command, source: origin, exitCode, durationMs: elapsed(started) })
      this.settle(command, evidence, exitCode)
    }
    this.running = { command, log }
    try {
      const size = this.size()
      const outcome = await backend.run(command, {
        write: (text) => this.stream(task, log, text),
        signal: task.signal,
        columns: size.columns,
        rows: size.rows,
        locale: this.opts.locale,
      })
      if (!task.current()) {
        if (isInteractiveRun(outcome)) this.discard(outcome, task)
        return
      }
      const result = isInteractiveRun(outcome) ? await this.drive(outcome, task) : outcome
      if (!task.current()) return
      const rest = log.rest(typeof result.output === 'string' ? result.output : '')
      if (rest !== '') this.print(withoutFinalNewline(rest))
      settle(rest, exitCodeOf(result.exitCode))
    } catch (error) {
      if (!task.current()) return
      const message = sanitizeProse(errorText(error))
      this.prose(`${messages.backendError}: ${message}`)
      this.notify({ type: 'error', phase: 'run', message })
      settle(message, 1, true)
    } finally {
      if (task.current()) this.finish()
    }
  }

  private stream(task: Task, log: StreamLog, text: string): void {
    const { io } = this.opts
    const cancelling = this.cancelling === task
    if (cancelling && io.writeOutOfBand && !this.disposed) {
      if (text === '') return
      io.writeOutOfBand(text)
      const visible = log.add(text, false)
      if (task.current()) this.follow(visible, true)
      return
    }
    if (!task.current() || this.disposed || text === '') return
    io.write(text)
    this.follow(log.add(text), cancelling)
  }

  private follow(visible: string, cancelling: boolean): void {
    const plain = stripAnsi(visible)
    if (plain === '') return
    this.lineState = lineStateAfter(plain)
    if (cancelling) this.cancelWrote = true
  }

  private async drive(run: InteractiveRun, task: Task): Promise<BackendRunResult> {
    this.interactive = { run, task }
    this.interruptedAt = Number.NEGATIVE_INFINITY
    ignoreFailure(() => this.opts.io.onInteractive?.())
    try {
      return await run.done
    } finally {
      if (task.current()) this.interactive = null
    }
  }

  private interruptProgram(program: Program): void {
    const pressed = Date.now()
    if (pressed - this.interruptedAt > DOUBLE_INTERRUPT_MS) {
      this.interruptedAt = pressed
      this.notify(this.interruptEvent())
      this.send(program.run, '\x03')
      return
    }
    const wrote = this.cancelProgram(program.run, program.task)
    this.reportInterrupt()
    this.stop()
    if (wrote) this.endLine()
    this.markInterrupt()
    this.prompt()
  }

  private interruptEvent(): DocsTerminalEvent {
    const command = this.running?.command ?? this.checking
    return command === null ? { type: 'interrupt' } : { type: 'interrupt', command }
  }

  private reportInterrupt(): void {
    this.result(INTERRUPTED, this.running?.log.output() ?? '')
    this.notify(this.interruptEvent())
  }

  private discard(run: InteractiveRun, task: Task): void {
    ignoreFailure(() => run.done)
    if (typeof run.cancel === 'function') this.cancelProgram(run, task)
    else this.send(run, '\x03')
  }

  private cancelProgram(run: InteractiveRun, task: Task): boolean {
    this.cancelling = task
    this.cancelWrote = false
    ignoreFailure(() => run.cancel?.())
    this.cancelling = null
    return this.cancelWrote
  }

  private send(run: InteractiveRun, data: string): void {
    ignoreFailure(() => run.onKey(data))
  }

  private settle(command: string, output: string, exitCode: number): void {
    const entry: HistoryEntry = { command, output, exitCode }
    this.history.push(entry)
    if (this.history.length > HISTORY_CAP) this.history.shift()
    if (exitCode === 0) return
    this.lastError = entry
    if (this.opts.ai) this.prose(this.opts.messages.errorHint)
  }

  private result(exitCode: number, output: string): void {
    if (!this.disposed) safely(() => this.opts.onResult?.({ exitCode, output }))
  }

  private notify(event: DocsTerminalEvent): void {
    if (!this.disposed) safely(() => this.opts.onEvent?.(event))
  }

  private failed(error: unknown): string {
    const message = sanitizeProse(errorText(error))
    this.notify({ type: 'error', phase: 'ai', message })
    return this.aiFailure(error)
  }

  private async suggest(ai: AIProvider, request: string): Promise<void> {
    const { messages } = this.opts
    if (request === '') {
      this.prose(messages.helpText)
      this.prompt()
      return
    }
    const task = this.begin()
    this.prose(messages.aiThinking)
    const unanswered = () => this.notify({ type: 'ai-suggest', request })
    try {
      const suggestion: unknown = await ai.suggestCommand({ request, ...this.aiInput(task.signal) })
      if (!task.current()) return
      const { command, explanation } = (suggestion ?? {}) as { command?: unknown; explanation?: unknown }
      const clean = typeof command === 'string' ? sanitizeCommand(command) : ''
      if (clean === '' || clean.length > COMMAND_LIMIT || hasInvisible(clean)) {
        this.prose(messages.aiInvalid)
        unanswered()
        return
      }
      const rows = this.suggestionRows(clean)
      if (!this.fitsAboveQuestion(rows)) {
        this.prose(messages.aiDoesNotFit)
        unanswered()
        return
      }
      const note = typeof explanation === 'string' ? withoutInvisible(oneLine(sanitizeProse(explanation))).trim() : ''
      if (note !== '') this.prose(note)
      for (const row of rows) this.line(row)
      this.pendingSuggestion = clean
      this.pendingRequest = request
    } catch (error) {
      if (!task.current()) return
      this.prose(this.failed(error))
      unanswered()
    } finally {
      if (task.current()) this.finish()
    }
  }

  private answered(accepted: boolean): string {
    const command = this.pendingSuggestion ?? ''
    this.pendingSuggestion = null
    this.notify({ type: 'ai-suggest', request: this.pendingRequest, command, accepted })
    return command
  }

  private suggestionRows(command: string): string[] {
    const label = this.opts.messages.suggestionLabel
    const indent = ' '.repeat(displayWidth(label) + 2)
    const [first = '', ...rest] = command.split('\n')
    return [`${label}: ${first}`, ...rest.map((line) => `${indent}${line}`)]
  }

  private fitsAboveQuestion(rows: readonly string[]): boolean {
    const { columns, rows: height } = this.size()
    const needed = [...rows, this.opts.messages.confirmRun].reduce((total, row) => total + rowsFor(row, columns), 0)
    return needed <= height
  }

  private size(): { columns: number; rows: number } {
    return this.opts.io.size?.() ?? DEFAULT_SIZE
  }

  private async confirm(answer: string): Promise<void> {
    const { messages, locale } = this.opts
    const yes = (YES[locale ?? 'en'] ?? YES.en).includes(answer.trim().toLowerCase())
    const command = this.answered(yes)
    if (!yes) {
      this.prose(messages.cancelled)
      this.prompt()
      return
    }
    this.opts.onExecuted?.(command)
    if (BUILTINS.has(command)) return this.builtin(command, 'ai')
    return this.run(command, 'ai')
  }

  private async explain(): Promise<void> {
    const { ai, messages } = this.opts
    const failed = this.lastError
    if (!ai || !failed) {
      this.prose(ai ? messages.nothingToExplain : messages.aiNotConfigured)
      this.prompt()
      return
    }
    this.notify({ type: 'ai-explain', command: failed.command })
    const task = this.begin()
    const status = formatMessage(messages.exitStatus, { code: failed.exitCode })
    this.prose(`${messages.explainHeader} - ${firstLine(failed.command)} (${status}):`)
    let answer = ''
    try {
      const full: unknown = await ai.explainError({ ...failed, ...this.aiInput(task.signal) }, (chunk) => {
        if (!task.current()) return
        const text = sanitizeProse(String(chunk))
        if (text === '') return
        answer = `${answer}${text}`.slice(-RESULT_LIMIT)
        this.emit(text)
      })
      if (!task.current()) return
      if (answer === '') {
        const text = typeof full === 'string' ? sanitizeProse(full).trim() : ''
        answer = text === '' ? messages.aiEmpty : text
        this.prose(answer)
      }
      this.result(0, resultText(answer))
    } catch (error) {
      if (!task.current()) return
      const text = this.failed(error)
      this.prose(text)
      this.result(1, text)
    } finally {
      if (task.current()) this.finish()
    }
  }

  private aiInput(signal: AbortSignal): Omit<SuggestInput, 'request'> {
    const { backend, pageContext, locale } = this.opts
    return {
      backendId: backend.id,
      backendDescription: this.describe(),
      context: pageContext,
      history: this.history.slice(-HISTORY_FOR_AI),
      locale,
      signal,
    }
  }

  private aiFailure(error: unknown): string {
    const { messages } = this.opts
    const { name, code } = (typeof error === 'object' && error !== null ? error : {}) as {
      name?: unknown
      code?: unknown
    }
    if (typeof name === 'string' && KEY_MISSING_ERRORS.has(name)) return messages.keyMissing
    if (typeof code === 'string' && Object.hasOwn(AI_ERROR_MESSAGES, code)) {
      return messages[AI_ERROR_MESSAGES[code]]
    }
    return `${messages.aiError}: ${sanitizeProse(errorText(error))}`
  }

  private describe(): string | undefined {
    const { backend } = this.opts
    if (!backend.describe) return undefined
    try {
      const text = backend.describe().trim()
      return text === '' ? undefined : text
    } catch {
      return undefined
    }
  }

  private begin(): Task {
    const token = (this.token += 1)
    const abort = new AbortController()
    this.abort = abort
    this.setBusy(true)
    return { signal: abort.signal, current: () => token === this.token }
  }

  private stop(): void {
    this.abort?.abort()
    this.abort = null
    this.token += 1
    this.interactive = null
    this.running = null
    this.checking = null
    this.setBusy(false)
  }

  private finish(): void {
    this.token += 1
    this.abort = null
    this.interactive = null
    this.running = null
    this.checking = null
    this.setBusy(false)
    this.prompt()
  }

  private setBusy(busy: boolean): void {
    if (this.busyFlag === busy) return
    this.busyFlag = busy
    if (!this.disposed) this.opts.io.setBusy(busy)
  }

  private emit(text: string): void {
    if (this.disposed || text === '') return
    this.opts.io.write(text)
    const plain = stripAnsi(text)
    if (plain !== '') this.lineState = lineStateAfter(plain)
  }

  private print(text: string): void {
    if (this.disposed) return
    this.opts.io.print(text)
    this.lineState = 'start'
  }

  private line(text: string): void {
    this.endLine()
    this.print(text)
  }

  private prose(text: string): void {
    this.endLine()
    if (this.disposed) return
    const { io } = this.opts
    if (io.printProse) io.printProse(text)
    else io.print(text)
    this.lineState = 'start'
  }

  private markInterrupt(): void {
    if (this.lineState === 'progress') this.endLine()
    this.print(this.opts.messages.interrupted)
  }

  private prompt(): void {
    if (this.disposed) return
    this.endLine()
    this.opts.io.printPrompt()
  }

  private clear(): void {
    if (this.disposed) return
    this.opts.io.clearScreen()
    this.lineState = 'start'
  }

  private endLine(): void {
    if (this.disposed || this.lineState === 'start') return
    this.opts.io.write(this.lineState === 'open' ? '\n' : ERASE_LINE)
    this.lineState = 'start'
  }
}
