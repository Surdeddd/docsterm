import { keyStore } from '../key-store.js'
import {
  buildExplainSystem,
  buildSuggestSystem,
  renderExplainUser,
  renderSuggestUser,
} from '../prompts.js'
import type { AIProvider, CommandSuggestion, ExplainInput, SuggestInput } from '../types.js'

export const OPENAI_KEY_NAME = 'docsterm:openai-key'

export const OPENAI_PRESETS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  xai: 'https://api.x.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
} as const

export type OpenAIPreset = keyof typeof OPENAI_PRESETS

export interface OpenAIProviderOptions {
  model: string
  preset?: OpenAIPreset
  baseURL?: string
  apiKey?: string
  keyName?: string
  maxTokens?: number
  headers?: Record<string, string>
  jsonMode?: 'object' | 'schema' | 'off'
  stream?: boolean
  id?: string
  fetchImpl?: typeof fetch
}

export class ProviderKeyMissingError extends Error {
  constructor(keyName: string) {
    super(`no api key configured (${keyName})`)
    this.name = 'ProviderKeyMissingError'
  }
}

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['command', 'explanation'],
  additionalProperties: false,
}

const LOCAL_PRESETS: OpenAIPreset[] = ['ollama', 'lmstudio']

export function parseSuggestionText(text: string): CommandSuggestion {
  const withoutFence = text.replace(/```(?:json)?/gi, '').trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  const candidate = start === -1 || end === -1 ? withoutFence : withoutFence.slice(start, end + 1)
  const parsed = JSON.parse(candidate) as Partial<CommandSuggestion>
  if (typeof parsed.command !== 'string' || parsed.command.trim() === '') {
    throw new Error('model response has no command field')
  }
  return { command: parsed.command, explanation: parsed.explanation ?? '' }
}

export function extractStreamDeltas(chunk: string): string[] {
  const deltas: string[] = []
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
      }
      const choice = parsed.choices?.[0]
      const text = choice?.delta?.content ?? choice?.message?.content
      if (typeof text === 'string' && text.length > 0) deltas.push(text)
    } catch {
      continue
    }
  }
  return deltas
}

export function createOpenAIProvider(options: OpenAIProviderOptions): AIProvider {
  const preset = options.preset
  const baseURL = (options.baseURL ?? (preset ? OPENAI_PRESETS[preset] : OPENAI_PRESETS.openai)).replace(
    /\/$/,
    '',
  )
  const keyName = options.keyName ?? OPENAI_KEY_NAME
  const keyOptional = preset !== undefined && LOCAL_PRESETS.includes(preset)
  const maxTokens = options.maxTokens ?? 1024
  const jsonMode = options.jsonMode ?? 'object'
  const useStream = options.stream ?? true
  const doFetch = options.fetchImpl ?? globalThis.fetch

  const resolveKey = (): string | null => {
    const key = options.apiKey ?? keyStore.get(keyName)
    if (key) return key
    if (keyOptional) return null
    throw new ProviderKeyMissingError(keyName)
  }

  const request = async (body: Record<string, unknown>): Promise<Response> => {
    const key = resolveKey()
    const response = await doFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...options.headers,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${response.status} ${response.statusText}: ${detail.slice(0, 200)}`.trim())
    }
    return response
  }

  const responseFormat = (): Record<string, unknown> | undefined => {
    if (jsonMode === 'off') return undefined
    if (jsonMode === 'schema') {
      return {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'command_suggestion', strict: true, schema: SUGGESTION_SCHEMA },
        },
      }
    }
    return { response_format: { type: 'json_object' } }
  }

  return {
    id: options.id ?? preset ?? 'openai',

    async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
      const response = await request({
        model: options.model,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'system',
            content: `${buildSuggestSystem(input.context, input.backendId)}\n\nReply with a JSON object shaped {"command": string, "explanation": string} and nothing else.`,
          },
          { role: 'user', content: renderSuggestUser(input) },
        ],
        ...responseFormat(),
      })
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const text = data.choices?.[0]?.message?.content ?? ''
      if (text.trim() === '') throw new Error('empty model response')
      return parseSuggestionText(text)
    },

    async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
      const body = {
        model: options.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: buildExplainSystem(input.context, input.backendId) },
          { role: 'user', content: renderExplainUser(input) },
        ],
      }

      if (!useStream || !onChunk) {
        const response = await request(body)
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const text = data.choices?.[0]?.message?.content ?? ''
        if (onChunk && text) onChunk(text)
        return text
      }

      const response = await request({ ...body, stream: true })
      const reader = response.body?.getReader()
      if (!reader) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const text = data.choices?.[0]?.message?.content ?? ''
        if (text) onChunk(text)
        return text
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lastBreak = buffer.lastIndexOf('\n')
        if (lastBreak === -1) continue
        const ready = buffer.slice(0, lastBreak)
        buffer = buffer.slice(lastBreak + 1)
        for (const delta of extractStreamDeltas(ready)) {
          full += delta
          onChunk(delta)
        }
      }
      for (const delta of extractStreamDeltas(buffer)) {
        full += delta
        onChunk(delta)
      }
      return full
    },
  }
}
