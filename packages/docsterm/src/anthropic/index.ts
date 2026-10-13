import { AIProviderError, isAbortError } from '../errors.js'
import { keyStore } from '../key-store.js'
import { getMessages } from '../messages.js'
import { JSON_INSTRUCTION, parseSuggestionText, SUGGESTION_SCHEMA } from '../openai/suggestion.js'
import { buildExplainSystem, buildSuggestSystem, renderExplainUser, renderSuggestUser } from '../prompts.js'
import { sanitizeProse } from '../text.js'
import type { AIProvider, CommandSuggestion, ExplainInput, Locale, SuggestInput } from '../types.js'

export const ANTHROPIC_KEY_NAME = 'docsterm:anthropic-key'
export const DEFAULT_MODEL = 'claude-opus-5-5'
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_EFFORT = 'low'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const MODEL_NAME = /\bclaude-(opus|sonnet|haiku|fable|mythos)\b(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/
const SDK_NO_BODY = 'status code (no body)'
const NAMES_FORMAT = /output_config\.format|json_schema|structured.outputs?\b/i

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export class KeyMissingError extends AIProviderError {
  constructor() {
    super('key-missing', 'anthropic api key is not configured')
    this.name = 'KeyMissingError'
  }
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  system: string
  messages: Array<{ role: 'user'; content: string }>
  output_config?: {
    effort?: AnthropicEffort
    format?: { type: 'json_schema'; schema: Record<string, unknown> }
  }
  betas?: string[]
  fallbacks?: 'default'
}

export interface AnthropicMessage {
  stop_reason: string | null
  content: Array<{ type: string; text?: string }>
}

export interface AnthropicTextStream {
  on(event: 'text', listener: (delta: string) => void): unknown
  finalMessage(): Promise<AnthropicMessage>
}

export interface AnthropicRequestOptions {
  signal?: AbortSignal
}

export interface AnthropicMessagesLike {
  create(params: AnthropicRequest, options?: AnthropicRequestOptions): Promise<AnthropicMessage>
  stream(params: AnthropicRequest, options?: AnthropicRequestOptions): AnthropicTextStream
}

export interface AnthropicLike {
  messages: AnthropicMessagesLike
  beta?: { messages: AnthropicMessagesLike }
}

export interface AnthropicProviderOptions {
  apiKey?: string
  baseURL?: string
  model?: string
  maxTokens?: number
  effort?: AnthropicEffort | false
  fallbacks?: boolean
  clientFactory?(apiKey: string | undefined): AnthropicLike | Promise<AnthropicLike>
}

type JsonFormat = NonNullable<NonNullable<AnthropicRequest['output_config']>['format']>

const SUGGESTION_FORMAT: JsonFormat = { type: 'json_schema', schema: SUGGESTION_SCHEMA }

type Field = 'effort' | 'format' | 'fallbacks'

interface RequestShape {
  effort: AnthropicEffort | undefined
  format: JsonFormat | undefined
  fallbacks: boolean
}

interface ModelTraits {
  effort: boolean
  fallbacks: boolean
}

const traitsOf = (model: string): ModelTraits => {
  const match = MODEL_NAME.exec(model)
  const major = Number(match?.[2] ?? 0)
  const minor = Number(match?.[3] ?? 0)
  const since = (wantMajor: number, wantMinor: number): boolean =>
    major > wantMajor || (major === wantMajor && minor >= wantMinor)
  switch (match?.[1]) {
    case 'mythos':
      return { effort: true, fallbacks: true }
    case 'fable':
      return { effort: true, fallbacks: major === 5 && minor === 1 }
    case 'opus':
      return { effort: since(4, 5), fallbacks: major === 5 }
    case 'sonnet':
      return { effort: since(4, 6), fallbacks: major === 5 && minor === 5 }
    case 'haiku':
      return { effort: since(5, 5), fallbacks: false }
    default:
      return { effort: false, fallbacks: false }
  }
}

const sdkClientFactory =
  (baseURL: string | undefined) =>
  async (apiKey: string | undefined): Promise<AnthropicLike> => {
    const { Anthropic } = await import('@anthropic-ai/sdk')
    if (apiKey) return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...(baseURL ? { baseURL } : {}) })
    return new Anthropic({
      apiKey: '',
      authToken: null,
      baseURL,
      defaultHeaders: { 'X-Api-Key': null, Authorization: null },
      dangerouslyAllowBrowser: true,
    })
  }

const isSdkAbort = async (error: Error): Promise<boolean> => {
  try {
    const { APIUserAbortError } = await import('@anthropic-ai/sdk')
    return typeof APIUserAbortError === 'function' && error instanceof APIUserAbortError
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const answerOf = (result: AnthropicMessage): string => {
  if (result.stop_reason === 'refusal') throw new AIProviderError('refused', 'request declined by safety filters')
  if (result.stop_reason === 'max_tokens' || result.stop_reason === 'model_context_window_exceeded') {
    throw new AIProviderError('truncated', `the answer stopped at ${result.stop_reason}`)
  }
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  if (text.trim() === '') throw new AIProviderError('empty', 'the model returned no text')
  return text
}

const statusOf = (error: unknown): number | undefined => {
  const status = isRecord(error) ? error.status : undefined
  return typeof status === 'number' ? status : undefined
}

const bodyMessage = (body: Record<string, unknown>): unknown => {
  if (isRecord(body.error)) return body.error.message
  if (typeof body.error === 'string') return body.error
  return typeof body.message === 'string' ? body.message : body.detail
}

const rawMessage = (error: Error, status: number | undefined): unknown => {
  const body = (error as { error?: unknown }).error
  if (isRecord(body)) return bodyMessage(body)
  if (body !== undefined) return body
  return status === undefined ? undefined : error.message.replace(/^\d{3}\s+/, '')
}

const serverMessage = (error: Error, status: number | undefined): string => {
  const raw = rawMessage(error, status)
  const text = typeof raw === 'string' ? sanitizeProse(raw).replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  return text.startsWith('<') || text === SDK_NO_BODY ? '' : text
}

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError')

const providerError = async (
  error: unknown,
  signal: AbortSignal | undefined,
  locale: Locale | undefined,
): Promise<unknown> => {
  if (signal?.aborted || isAbortError(error)) return abortError()
  if (error instanceof AIProviderError || !(error instanceof Error) || !('status' in error)) return error
  const status = statusOf(error)
  const body = (error as { error?: unknown }).error
  if (status === undefined && body === undefined) {
    return (await isSdkAbort(error)) ? abortError() : new AIProviderError('network', error.message, { cause: error })
  }
  const message = serverMessage(error, status) || getMessages(locale ?? 'en').aiServiceError
  if (status === undefined) return new AIProviderError('http', message, { cause: error })
  return new AIProviderError('http', `${status}: ${message}`, { status, cause: error })
}

const rejectedFields = (shape: RequestShape, error: unknown): Field[] => {
  if (!(error instanceof Error) || statusOf(error) !== 400) return []
  const message = serverMessage(error, 400)
  const namesEffort = /effort/i.test(message)
  const namesFormat = NAMES_FORMAT.test(message)
  const namesConfig = !namesEffort && !namesFormat && /output_config/i.test(message)
  const fields: Field[] = []
  if (shape.effort && (namesEffort || namesConfig)) fields.push('effort')
  if (shape.format && (namesFormat || namesConfig)) fields.push('format')
  if (shape.fallbacks && /fallback/i.test(message)) fields.push('fallbacks')
  return fields
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): AIProvider {
  const model = options.model ?? DEFAULT_MODEL
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const traits = traitsOf(model)
  const effort = options.effort ?? (traits.effort ? DEFAULT_EFFORT : false)
  const useFallbacks = options.fallbacks ?? traits.fallbacks
  const factory = options.clientFactory ?? sdkClientFactory(options.baseURL)
  const viaDefaultEndpoint = options.clientFactory === undefined && options.baseURL === undefined
  const rejected = new Set<Field>()

  const connect = async (): Promise<AnthropicLike> => {
    const stored = options.baseURL === undefined ? keyStore.get(ANTHROPIC_KEY_NAME) : null
    const apiKey = options.apiKey || stored || undefined
    if (!apiKey && viaDefaultEndpoint) throw new KeyMissingError()
    return factory(apiKey)
  }

  const learned = (shape: RequestShape, error: unknown): boolean => {
    const fields = rejectedFields(shape, error)
    for (const field of fields) rejected.add(field)
    return fields.length > 0
  }

  const send = async <T>(
    system: string,
    user: string,
    format: JsonFormat | undefined,
    signal: AbortSignal | undefined,
    call: (messages: AnthropicMessagesLike, params: AnthropicRequest) => Promise<T>,
  ): Promise<T> => {
    const client = await connect()
    const shapeNow = (): RequestShape => ({
      effort: rejected.has('effort') || !effort ? undefined : effort,
      format: rejected.has('format') ? undefined : format,
      fallbacks: !rejected.has('fallbacks') && useFallbacks && client.beta !== undefined,
    })
    const attempt = (shape: RequestShape): Promise<T> => {
      const config = { ...(shape.effort ? { effort: shape.effort } : {}), ...(shape.format ? { format: shape.format } : {}) }
      const params: AnthropicRequest = {
        model,
        max_tokens: maxTokens,
        system: format && !shape.format ? `${system}\n\n${JSON_INSTRUCTION}` : system,
        messages: [{ role: 'user', content: user }],
        ...(Object.keys(config).length > 0 ? { output_config: config } : {}),
        ...(shape.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      }
      return call(shape.fallbacks && client.beta ? client.beta.messages : client.messages, params)
    }
    const first = shapeNow()
    try {
      return await attempt(first)
    } catch (error) {
      if (!learned(first, error) || signal?.aborted) throw error
      const retry = shapeNow()
      try {
        return await attempt(retry)
      } catch (again) {
        learned(retry, again)
        throw again
      }
    }
  }

  return {
    id: 'anthropic',

    async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
      try {
        const system = buildSuggestSystem(input.context, input.backendId)
        const result = await send(system, renderSuggestUser(input), SUGGESTION_FORMAT, input.signal, (messages, params) =>
          messages.create(params, { signal: input.signal }),
        )
        return parseSuggestionText(answerOf(result))
      } catch (error) {
        throw await providerError(error, input.signal, input.locale)
      }
    },

    async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
      try {
        const system = buildExplainSystem(input.context, input.backendId)
        const result = await send(system, renderExplainUser(input), undefined, input.signal, (messages, params) => {
          const stream = messages.stream(params, { signal: input.signal })
          if (onChunk) stream.on('text', (delta) => onChunk(delta))
          return stream.finalMessage()
        })
        return answerOf(result)
      } catch (error) {
        throw await providerError(error, input.signal, input.locale)
      }
    },
  }
}
