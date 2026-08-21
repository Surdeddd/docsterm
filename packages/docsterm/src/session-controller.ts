import type { Messages } from './messages.js'
import type { AIProvider, Backend, HistoryEntry, PageContext } from './types.js'

export interface SessionIO {
  write(text: string): void
  print(line: string): void
  printPrompt(): void
  clearScreen(): void
  setBusy(busy: boolean): void
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

  constructor(private readonly opts: SessionControllerOptions) {}

  get busy(): boolean {
    return this.busyFlag
  }

  get isConfirming(): boolean {
    return this.pendingSuggestion !== null
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
    this.setBusy(true)
    try {
      const result = await backend.run(command)
      if (result.output.length > 0) io.print(result.output)
      this.recordHistory({ command, output: result.output.slice(0, OUTPUT_CAP), exitCode: result.exitCode })
      if (result.exitCode !== 0) {
        this.lastError = { command, output: result.output.slice(0, OUTPUT_CAP), exitCode: result.exitCode }
        if (ai) io.print(messages.errorHint)
      }
    } catch (error) {
      io.print(`${messages.backendError}: ${errorText(error)}`)
    } finally {
      this.setBusy(false)
      io.printPrompt()
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
    this.setBusy(true)
    io.print(messages.aiThinking)
    try {
      const suggestion = await ai.suggestCommand({
        request,
        backendId: backend.id,
        context: this.opts.pageContext,
        history: this.history.slice(-HISTORY_FOR_AI),
      })
      io.print(`${messages.suggestionLabel}: ${suggestion.command}`)
      if (suggestion.explanation.length > 0) io.print(suggestion.explanation)
      this.pendingSuggestion = suggestion.command
      io.write(messages.confirmRun)
    } catch (error) {
      io.print(`${messages.aiError}: ${errorText(error)}`)
      io.printPrompt()
    } finally {
      this.setBusy(false)
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
          chunks += 1
          io.write(chunk)
        },
      )
      if (chunks === 0) io.print(full)
      else io.write('\n')
    } catch (error) {
      io.print(`${messages.aiError}: ${errorText(error)}`)
    } finally {
      this.setBusy(false)
      io.printPrompt()
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
