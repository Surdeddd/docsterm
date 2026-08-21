import type { AIProvider, CommandSuggestion, ExplainInput, SuggestInput } from './types'

export interface MockAIOptions {
  suggestions?: Record<string, CommandSuggestion>
  fallback?: CommandSuggestion
  explanation?: string
  delayMs?: number
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createMockAIProvider(options: MockAIOptions = {}): AIProvider {
  const fallback = options.fallback ?? { command: 'help', explanation: 'mock fallback suggestion' }
  const explanation =
    options.explanation ?? 'The command exited with a non-zero code. Check the arguments and try again.'
  const table = options.suggestions ?? {}
  return {
    id: 'mock',
    async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
      if (options.delayMs) await wait(options.delayMs)
      const match = Object.entries(table).find(([key]) =>
        input.request.toLowerCase().includes(key.toLowerCase()),
      )
      return match ? match[1] : fallback
    },
    async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
      if (options.delayMs) await wait(options.delayMs)
      const text = `${explanation} (command: ${input.command}, exit ${input.exitCode})`
      if (onChunk) {
        for (const word of text.split(' ')) onChunk(`${word} `)
      }
      return text
    },
  }
}
