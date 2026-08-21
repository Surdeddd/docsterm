import { describe, expect, it } from 'vitest'
import { createMockAIProvider } from '../src/mock-ai'
import type { ExplainInput, PageContext } from '../src/types'

const context: PageContext = { title: '', url: '', description: '', headings: [] }

describe('createMockAIProvider', () => {
  it('matches suggestions by substring, case-insensitive', async () => {
    const ai = createMockAIProvider({
      suggestions: { deploy: { command: 'orbit deploy', explanation: 'ship it' } },
    })
    const suggestion = await ai.suggestCommand({
      request: 'please Deploy the app',
      backendId: 'mock',
      context,
      history: [],
    })
    expect(suggestion.command).toBe('orbit deploy')
  })

  it('falls back when nothing matches', async () => {
    const ai = createMockAIProvider({ fallback: { command: 'ls', explanation: '' } })
    const suggestion = await ai.suggestCommand({
      request: 'unknown',
      backendId: 'mock',
      context,
      history: [],
    })
    expect(suggestion.command).toBe('ls')
  })

  it('streams the same text it returns', async () => {
    const ai = createMockAIProvider()
    const input: ExplainInput = {
      command: 'orbit destroy',
      output: 'boom',
      exitCode: 1,
      backendId: 'mock',
      context,
      history: [],
    }
    const chunks: string[] = []
    const full = await ai.explainError(input, (chunk) => chunks.push(chunk))
    expect(chunks.join('').trim()).toBe(full)
    expect(full).toContain('orbit destroy')
  })
})
