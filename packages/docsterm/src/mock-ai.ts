import { formatMessage } from './messages.js'
import type { AIProvider, CommandSuggestion, ExplainInput, Locale, SuggestInput } from './types.js'

export interface MockAIOptions {
  suggestions?: Record<string, CommandSuggestion>
  fallback?: CommandSuggestion
  explanation?: string
  delayMs?: number
  locale?: Locale
}

interface MockTexts {
  fallback: string
  explanation: string
  details: string
  lastOutput: string
}

const texts: Record<Locale, MockTexts> = {
  en: {
    fallback: 'mock AI: no scripted suggestion matches this request, so it suggests help.',
    explanation: 'The command exited with a non-zero code. Check the arguments and try again.',
    details: 'command: {command}, exit {exitCode}',
    lastOutput: 'last output: {line}',
  },
  ru: {
    fallback: 'mock AI: ни одна заготовка не подходит к запросу, поэтому предлагаю help.',
    explanation: 'Команда завершилась с ненулевым кодом. Проверь аргументы и попробуй ещё раз.',
    details: 'команда: {command}, код выхода {exitCode}',
    lastOutput: 'последний вывод: {line}',
  },
}

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError')

const wait = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const pause = async (ms: number | undefined, signal: AbortSignal | undefined): Promise<void> => {
  if (signal?.aborted) throw abortError()
  if (ms) await wait(ms, signal)
}

const lastLine = (output: string): string =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? ''

export function createMockAIProvider(options: MockAIOptions = {}): AIProvider {
  const table = options.suggestions ?? {}
  const textsFor = (locale: Locale | undefined): MockTexts => texts[options.locale ?? locale ?? 'en'] ?? texts.en
  return {
    id: 'mock',
    async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
      await pause(options.delayMs, input.signal)
      const match = Object.entries(table).find(([key]) => input.request.toLowerCase().includes(key.toLowerCase()))
      if (match) return match[1]
      return options.fallback ?? { command: 'help', explanation: textsFor(input.locale).fallback }
    },
    async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
      await pause(options.delayMs, input.signal)
      const local = textsFor(input.locale)
      const line = lastLine(input.output)
      const details = [
        formatMessage(local.details, { command: input.command, exitCode: input.exitCode }),
        line ? formatMessage(local.lastOutput, { line }) : '',
      ]
        .filter(Boolean)
        .join(', ')
      const text = `${options.explanation ?? local.explanation} (${details})`
      if (onChunk) {
        for (const word of text.split(' ')) onChunk(`${word} `)
      }
      return text
    },
  }
}
