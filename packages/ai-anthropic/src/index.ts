import Anthropic from '@anthropic-ai/sdk'
import { keyStore } from 'docsterm'
import type { AIProvider, CommandSuggestion, ExplainInput, SuggestInput } from 'docsterm'
import { buildExplainSystem, buildSuggestSystem, renderExplainUser, renderSuggestUser } from './prompts'

export const ANTHROPIC_KEY_NAME = 'docsterm:anthropic-key'
export const DEFAULT_MODEL = 'claude-opus-5'
const DEFAULT_MAX_TOKENS = 1024

export class KeyMissingError extends Error {
  constructor() {
    super('anthropic api key is not configured')
    this.name = 'KeyMissingError'
  }
}

interface ModelResult {
  stop_reason: string | null
  content: Array<{ type: string; text?: string }>
}

interface TextStream {
  on(event: 'text', listener: (delta: string) => void): unknown
  finalMessage(): Promise<ModelResult>
}

export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<ModelResult>
    stream(params: Record<string, unknown>): TextStream
  }
}

export interface AnthropicProviderOptions {
  apiKey?: string
  model?: string
  maxTokens?: number
  clientFactory?: (apiKey: string) => AnthropicLike
}

const suggestionSchema = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['command', 'explanation'],
  additionalProperties: false,
}

const defaultClientFactory = (apiKey: string): AnthropicLike =>
  new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) as unknown as AnthropicLike

const textOf = (result: ModelResult): string =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): AIProvider {
  const model = options.model ?? DEFAULT_MODEL
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const factory = options.clientFactory ?? defaultClientFactory

  const client = (): AnthropicLike => {
    const apiKey = options.apiKey ?? keyStore.get(ANTHROPIC_KEY_NAME)
    if (!apiKey) throw new KeyMissingError()
    return factory(apiKey)
  }

  return {
    id: 'anthropic',
    async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
      const result = await client().messages.create({
        model,
        max_tokens: maxTokens,
        system: buildSuggestSystem(input.context, input.backendId),
        messages: [{ role: 'user', content: renderSuggestUser(input) }],
        output_config: { format: { type: 'json_schema', schema: suggestionSchema } },
      })
      if (result.stop_reason === 'refusal') throw new Error('request declined by safety filters')
      const text = textOf(result)
      if (!text) throw new Error('empty model response')
      const parsed = JSON.parse(text) as CommandSuggestion
      return { command: parsed.command, explanation: parsed.explanation }
    },
    async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
      const stream = client().messages.stream({
        model,
        max_tokens: maxTokens,
        system: buildExplainSystem(input.context, input.backendId),
        messages: [{ role: 'user', content: renderExplainUser(input) }],
      })
      if (onChunk) stream.on('text', (delta) => onChunk(delta))
      const final = await stream.finalMessage()
      if (final.stop_reason === 'refusal') throw new Error('request declined by safety filters')
      return textOf(final)
    },
  }
}
