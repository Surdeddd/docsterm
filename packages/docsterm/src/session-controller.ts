import type { Messages } from './messages.js'
import {
  isInteractiveRun,
  type AIProvider,
  type Backend,
  type BackendRunResult,
  type CompletionReply,
  type HistoryEntry,
  type InteractiveRun,
  type PageContext,
} from './types.js'

export interface SessionIO {
  write(text: string): void
  print(line: string): void
  printPrompt(): void
  clearScreen(): void
  setBusy(busy: boolean): void
  size?(): { columns: number; rows: number }
}

export interface SessionControllerOptions {
  backend: Backend
  ai?: AIProvider
  messages: Messages
  io: SessionIO
  pageContext: PageContext
}

interface FailedRun {
  command: string
  output: string
  exitCode: number
}

const HISTORY_CAP = 50
const HISTORY_FOR_AI = 5
const OUTPUT_CAP = 2000

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class SessionController {
  private readonly history: HistoryEntry[] = []
  private lastError: FailedRun | null = null
  private pendingSuggestion: string | null = null
  private busyFlag = false
  private controller: AbortController | null = null
  private interactive: InteractiveRun | null = null
  private token = 0

  constructor(private readonly opts: SessionControllerOptions) {}

  get busy(): boolean {
    return this.busyFlag
  }

  get isConfirming(): boolean {
    return this.pendingSuggestion !== null
  }

  get isInteractive(): boolean {
    return this.interactive !== null
  }

  async complete(line: string, cursor: number): Promise<CompletionReply | null> {
    const backend = this.opts.backend
    if (!backend.complete) return null
    try {
      return (await backend.complete({ line, cursor })) ?? null
    } catch {
      return null
    }
  }

  handleInteractiveKey(data: string): void {
    void this.interactive?.onKey(data)
  }

  interrupt(): void {
    if (this.interactive) {
      void this.interactive.onKey('\x03')
      return
    }
    if (!this.busyFlag) return
    const { io, messages } = this.opts
    this.controller?.abort()
    this.token += 1
    this.controller = null
    this.pendingSuggestion = null
    this.setBusy(false)
    io.print(messages.interrupted)
    io.printPrompt()
  }

  async submit(line: string): Promise<void> {
    if (this.busyFlag) return
    const { io, messages } = this.opts
    const trimmed = line.trim()
    if (this.pendingSuggestion !== null) {
      await this.resolveConfirmation(trimmed)
      return
    }
    if (trimmed === '') {
      io.printPrompt()
      return
    }
    if (trimmed.startsWith('#')) {
      await this.suggest(trimmed.slice(1).trim())
      return
    }
    if (trimmed === 'clear') {
      io.clearScreen()
      io.printPrompt()
      return
    }
    if (trimmed === 'help') {
      io.print(messages.helpText)
      io.printPrompt()
      return
    }
    if (trimmed === 'explain') {
      await this.explain()
      return
    }
    await this.run(trimmed)
  }

  private async run(command: string): Promise<void> {
    const { io, messages, backend, ai } = this.opts
    const token = (this.token += 1)
    const current = () => token === this.token
    this.setBusy(true)
    const controller = new AbortController()
    this.controller = controller
    let streamed = ''
    try {
      const size = io.size?.() ?? { columns: 80, rows: 24 }
      const outcome = await backend.run(command, {
        write: (text) => {
          if (!current()) return
          streamed += text
          io.write(text)
        },
        signal: controller.signal,
        columns: size.columns,
        rows: size.rows,
      })

      const result = isInteractiveRun(outcome) ? await this.driveInteractive(outcome) : outcome
      if (!current()) return
      const printable = result.output.slice(streamed.length === 0 ? 0 : streamed.length)
      if (streamed === '' && result.output.length > 0) io.print(result.output)
      else if (printable.length > 0) io.print(printable)

      const combined = streamed.length > 0 ? streamed : result.output
      this.recordHistory({
        command,
        output: combined.slice(0, OUTPUT_CAP),
        exitCode: result.exitCode,
      })
      if (result.exitCode !== 0) {
        this.lastError = {
          command,
          output: combined.slice(0, OUTPUT_CAP),
          exitCode: result.exitCode,
        }
        if (ai) io.print(messages.errorHint)
      }
    } catch (error) {
      if (!current()) return
      io.print(`${messages.backendError}: ${errorText(error)}`)
    } finally {
      if (current()) {
        this.controller = null
        this.interactive = null
        this.setBusy(false)
        io.printPrompt()
      }
    }
  }

  private async driveInteractive(run: InteractiveRun): Promise<BackendRunResult> {
    this.interactive = run
    try {
      return await run.done
    } finally {
      this.interactive = null
    }
  }

  private async suggest(request: string): Promise<void> {
    const { io, messages, ai, backend } = this.opts
    if (!ai) {
      io.print(messages.aiNotConfigured)
      io.printPrompt()
      return
    }
    if (request === '') {
      io.print(messages.helpText)
      io.printPrompt()
      return
    }
    const token = (this.token += 1)
    const current = () => token === this.token
    this.setBusy(true)
    io.print(messages.aiThinking)
    try {
      const suggestion = await ai.suggestCommand({
        request,
        backendId: backend.id,
        context: this.opts.pageContext,
        history: this.history.slice(-HISTORY_FOR_AI),
      })
      if (!current()) return
      io.print(`${messages.suggestionLabel}: ${suggestion.command}`)
      if (suggestion.explanation.length > 0) io.print(suggestion.explanation)
      this.pendingSuggestion = suggestion.command
      io.write(messages.confirmRun)
    } catch (error) {
      if (!current()) return
      io.print(`${messages.aiError}: ${errorText(error)}`)
      io.printPrompt()
    } finally {
      if (current()) this.setBusy(false)
    }
  }

  private async resolveConfirmation(answer: string): Promise<void> {
    const { io, messages } = this.opts
    const command = this.pendingSuggestion ?? ''
    this.pendingSuggestion = null
    if (answer.toLowerCase() === 'y') {
      await this.run(command)
      return
    }
    io.print(messages.cancelled)
    io.printPrompt()
  }

  private async explain(): Promise<void> {
    const { io, messages, ai, backend } = this.opts
    if (!ai) {
      io.print(messages.aiNotConfigured)
      io.printPrompt()
      return
    }
    const failed = this.lastError
    if (!failed) {
      io.print(messages.nothingToExplain)
      io.printPrompt()
      return
    }
    const token = (this.token += 1)
    const current = () => token === this.token
    this.setBusy(true)
    io.print(`${messages.explainHeader}:`)
    try {
      let chunks = 0
      const full = await ai.explainError(
        {
          command: failed.command,
          output: failed.output,
          exitCode: failed.exitCode,
          backendId: backend.id,
          context: this.opts.pageContext,
          history: this.history.slice(-HISTORY_FOR_AI),
        },
        (chunk) => {
          if (!current()) return
          chunks += 1
          io.write(chunk)
        },
      )
      if (!current()) return
      if (chunks === 0) io.print(full)
      else io.write('\n')
    } catch (error) {
      if (!current()) return
      io.print(`${messages.aiError}: ${errorText(error)}`)
    } finally {
      if (current()) {
        this.setBusy(false)
        io.printPrompt()
      }
    }
  }

  private recordHistory(entry: HistoryEntry): void {
    this.history.push(entry)
    if (this.history.length > HISTORY_CAP) this.history.shift()
  }

  private setBusy(busy: boolean): void {
    this.busyFlag = busy
    this.opts.io.setBusy(busy)
  }
}
