export type Locale = 'en' | 'ru'

export interface BackendRunResult {
  output: string
  exitCode: number
}

export interface BackendHost {
  write(text: string): void
}

export interface RunContext {
  write(text: string): void
  signal: AbortSignal
  columns: number
  rows: number
}

export interface InteractiveRun {
  onKey(data: string): void | Promise<void>
  done: Promise<BackendRunResult>
}

export type RunOutcome = BackendRunResult | InteractiveRun

export interface CompletionRequest {
  line: string
  cursor: number
}

export interface CompletionReply {
  from: number
  to: number
  candidates: string[]
}

export interface Backend {
  readonly id: string
  readonly prompt: string
  init(host: BackendHost): Promise<void>
  run(command: string, context?: RunContext): Promise<RunOutcome>
  complete?(request: CompletionRequest): CompletionReply | Promise<CompletionReply | null> | null
  dispose(): void
}

export interface SimpleBackend extends Backend {
  run(command: string, context?: RunContext): Promise<BackendRunResult>
}

export const isInteractiveRun = (value: RunOutcome): value is InteractiveRun =>
  typeof (value as InteractiveRun).onKey === 'function'

export interface PageContext {
  title: string
  url: string
  description: string
  headings: string[]
}

export interface HistoryEntry {
  command: string
  output: string
  exitCode: number
}

export interface CommandSuggestion {
  command: string
  explanation: string
}

export interface SuggestInput {
  request: string
  backendId: string
  context: PageContext
  history: HistoryEntry[]
}

export interface ExplainInput {
  command: string
  output: string
  exitCode: number
  backendId: string
  context: PageContext
  history: HistoryEntry[]
}

export interface AIProvider {
  readonly id: string
  suggestCommand(input: SuggestInput): Promise<CommandSuggestion>
  explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string>
}

export interface TerminalTheme {
  background?: string
  foreground?: string
  cursor?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export interface DocsTerminalOptions {
  backend: Backend
  ai?: AIProvider
  locale?: Locale
  theme?: 'light' | 'dark' | 'auto' | TerminalTheme
  fontFamily?: string
  fontSize?: number
  pageContext?: Partial<PageContext>
  welcome?: string
}
