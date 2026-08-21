import { describe, expect, it } from 'vitest'
import type { ExplainInput, PageContext, SuggestInput } from '../src/types.js'
import { createAnthropicProvider, KeyMissingError, type AnthropicLike } from '../src/anthropic/index.js'

const context: PageContext = {
  title: 'Orbit docs',
  url: 'https://example.test',
  description: 'Deploy apps',
  headings: ['Install'],
}

const suggestInput: SuggestInput = {
  request: 'deploy the app',
  backendId: 'mock',
  context,
  history: [{ command: 'orbit init', output: 'ok', exitCode: 0 }],
}

const explainInput: ExplainInput = {
  command: 'orbit destroy',
  output: 'boom',
  exitCode: 1,
  backendId: 'mock',
  context,
  history: [],
}

interface Captured {
  create: Record<string, unknown>[]
  stream: Record<string, unknown>[]
}

const fakeClient = (behavior: {
  createResult?: { stop_reason: string | null; content: Array<{ type: string; text?: string }> }
  streamText?: string[]
  streamStop?: string | null
}): { client: AnthropicLike; captured: Captured } => {
  const captured: Captured = { create: [], stream: [] }
  const client: AnthropicLike = {
    messages: {
      async create(params) {
        captured.create.push(params)
        return (
          behavior.createResult ?? {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '{"command":"orbit deploy","explanation":"ship"}' }],
          }
        )
      },
      stream(params) {
        captured.stream.push(params)
        const listeners: Array<(delta: string) => void> = []
        return {
          on(_event, listener) {
            listeners.push(listener)
            return this
          },
          async finalMessage() {
            const parts = behavior.streamText ?? ['it ', 'failed']
            for (const part of parts) for (const listener of listeners) listener(part)
            return {
              stop_reason: behavior.streamStop ?? 'end_turn',
              content: parts.map((text) => ({ type: 'text', text })),
            }
          },
        }
      },
    },
  }
  return { client, captured }
}

const provider = (behavior: Parameters<typeof fakeClient>[0]) => {
  const { client, captured } = fakeClient(behavior)
  return {
    ai: createAnthropicProvider({ apiKey: 'sk-test', clientFactory: () => client }),
    captured,
  }
}

describe('createAnthropicProvider', () => {
  it('throws KeyMissingError without a key', async () => {
    const ai = createAnthropicProvider()
    await expect(ai.suggestCommand(suggestInput)).rejects.toBeInstanceOf(KeyMissingError)
  })

  it('parses a structured suggestion and sends the right request', async () => {
    const { ai, captured } = provider({})
    const suggestion = await ai.suggestCommand(suggestInput)
    expect(suggestion).toEqual({ command: 'orbit deploy', explanation: 'ship' })
    const params = captured.create[0] ?? {}
    expect(params.model).toBe('claude-opus-5')
    expect(String(params.system)).toContain('Orbit docs')
    expect(JSON.stringify(params.output_config)).toContain('json_schema')
    expect(JSON.stringify(params.messages)).toContain('deploy the app')
    expect(JSON.stringify(params.messages)).toContain('orbit init')
  })

  it('throws on refusal instead of returning content', async () => {
    const { ai } = provider({ createResult: { stop_reason: 'refusal', content: [] } })
    await expect(ai.suggestCommand(suggestInput)).rejects.toThrow('declined')
  })

  it('streams explanation chunks and returns the full text', async () => {
    const { ai, captured } = provider({ streamText: ['the flag ', 'is unknown'] })
    const chunks: string[] = []
    const full = await ai.explainError(explainInput, (chunk) => chunks.push(chunk))
    expect(chunks).toEqual(['the flag ', 'is unknown'])
    expect(full).toBe('the flag is unknown')
    expect(JSON.stringify(captured.stream[0])).toContain('orbit destroy')
  })

  it('throws when the explanation stream ends in refusal', async () => {
    const { ai } = provider({ streamStop: 'refusal' })
    await expect(ai.explainError(explainInput)).rejects.toThrow('declined')
  })
})
