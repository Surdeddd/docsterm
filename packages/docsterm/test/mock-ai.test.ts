import { describe, expect, it, vi } from 'vitest'
import { createMockAIProvider } from '../src/mock-ai.js'
import type { ExplainInput, PageContext, SuggestInput } from '../src/types.js'

const context: PageContext = { title: '', url: '', description: '', headings: [] }

const request = (overrides: Partial<SuggestInput> = {}): SuggestInput => ({
  request: 'unknown',
  backendId: 'mock',
  context,
  history: [],
  ...overrides,
})

const failure = (overrides: Partial<ExplainInput> = {}): ExplainInput => ({
  command: 'orbit destroy',
  output: 'boom',
  exitCode: 1,
  backendId: 'mock',
  context,
  history: [],
  ...overrides,
})

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('createMockAIProvider', () => {
  it('matches suggestions by substring, case-insensitive', async () => {
    const ai = createMockAIProvider({
      suggestions: { deploy: { command: 'orbit deploy', explanation: 'ship it' } },
    })
    const suggestion = await ai.suggestCommand(request({ request: 'please Deploy the app' }))
    expect(suggestion.command).toBe('orbit deploy')
  })

  it('falls back when nothing matches', async () => {
    const ai = createMockAIProvider({ fallback: { command: 'ls', explanation: '' } })
    const suggestion = await ai.suggestCommand(request())
    expect(suggestion.command).toBe('ls')
  })

  it('says clearly that the default fallback found no match', async () => {
    const suggestion = await createMockAIProvider().suggestCommand(request())
    expect(suggestion).toEqual({
      command: 'help',
      explanation: 'mock AI: no scripted suggestion matches this request, so it suggests help.',
    })
  })

  it('speaks Russian when asked through the option', async () => {
    const ai = createMockAIProvider({ locale: 'ru' })
    expect(await ai.suggestCommand(request())).toEqual({
      command: 'help',
      explanation: 'mock AI: ни одна заготовка не подходит к запросу, поэтому предлагаю help.',
    })
    expect(await ai.explainError(failure())).toBe(
      'Команда завершилась с ненулевым кодом. Проверь аргументы и попробуй ещё раз. (команда: orbit destroy, код выхода 1, последний вывод: boom)',
    )
  })

  it('follows the locale of the request when no option is given', async () => {
    const ai = createMockAIProvider()
    const suggestion = await ai.suggestCommand(request({ locale: 'ru' }))
    expect(suggestion.explanation).toBe('mock AI: ни одна заготовка не подходит к запросу, поэтому предлагаю help.')
  })

  it('lets the option win over the locale of the request', async () => {
    const ai = createMockAIProvider({ locale: 'en' })
    const suggestion = await ai.suggestCommand(request({ locale: 'ru' }))
    expect(suggestion.explanation).toBe('mock AI: no scripted suggestion matches this request, so it suggests help.')
  })

  it('quotes the last line of the output it was given', async () => {
    const ai = createMockAIProvider()
    const text = await ai.explainError(failure({ output: 'step 1\nerror: disk full\n\n' }))
    expect(text).toBe(
      'The command exited with a non-zero code. Check the arguments and try again. (command: orbit destroy, exit 1, last output: error: disk full)',
    )
  })

  it('leaves the output out when there is none', async () => {
    const ai = createMockAIProvider({ explanation: 'Custom text.' })
    expect(await ai.explainError(failure({ output: '' }))).toBe('Custom text. (command: orbit destroy, exit 1)')
  })

  it('streams the same text it returns', async () => {
    const ai = createMockAIProvider()
    const chunks: string[] = []
    const full = await ai.explainError(failure(), (chunk) => chunks.push(chunk))
    expect(chunks.join('').trim()).toBe(full)
    expect(full).toBe(
      'The command exited with a non-zero code. Check the arguments and try again. (command: orbit destroy, exit 1, last output: boom)',
    )
  })

  it('rejects with an AbortError when the signal is already aborted', async () => {
    const ai = createMockAIProvider()
    const signal = AbortSignal.abort()
    const suggestError = await rejection(ai.suggestCommand(request({ signal })))
    const explainError = await rejection(ai.explainError(failure({ signal })))
    for (const error of [suggestError, explainError]) {
      expect(error).toBeInstanceOf(DOMException)
      expect((error as DOMException).name).toBe('AbortError')
    }
  })

  it('stops waiting at once and emits nothing when the signal aborts during the delay', async () => {
    vi.useFakeTimers()
    try {
      const ai = createMockAIProvider({ delayMs: 10_000 })
      const controller = new AbortController()
      const chunks: string[] = []
      const pending = rejection(ai.explainError(failure({ signal: controller.signal }), (chunk) => chunks.push(chunk)))
      await vi.advanceTimersByTimeAsync(20)
      expect(vi.getTimerCount()).toBe(1)
      controller.abort()
      const error = await pending
      expect([(error as DOMException).name, chunks, vi.getTimerCount()]).toEqual(['AbortError', [], 0])
    } finally {
      vi.useRealTimers()
    }
  })
})
