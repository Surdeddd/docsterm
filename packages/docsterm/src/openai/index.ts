import { AIProviderError, isAbortError } from '../errors.js'
import { keyStore } from '../key-store.js'
import { getMessages } from '../messages.js'
import {
  buildExplainSystem,
  buildSuggestSystem,
  renderExplainUser,
  renderSuggestUser,
} from '../prompts.js'
import { sanitizeProse } from '../text.js'
import type { AIProvider, CommandSuggestion, ExplainInput, Locale, SuggestInput } from '../types.js'
import {
  isFields,
  JSON_INSTRUCTION,
  NOT_JSON,
  parseSuggestionText,
  SUGGESTION_SCHEMA,
  tryJson,
  type Fields,
} from './suggestion.js'

export { parseSuggestionText }

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
export type OpenAITokenParam = 'max_tokens' | 'max_completion_tokens'
export type OpenAIJsonMode = 'object' | 'schema' | 'off'

export interface OpenAIProviderOptions {
  model: string
  preset?: OpenAIPreset
  baseURL?: string
  apiKey?: string
  keyName?: string
  maxTokens?: number
  tokenParam?: OpenAITokenParam
  headers?: Record<string, string>
  jsonMode?: OpenAIJsonMode
  stream?: boolean
  id?: string
  fetchImpl?: typeof fetch
}

export class ProviderKeyMissingError extends AIProviderError {
  constructor(keyName: string) {
    super('key-missing', `no api key configured (${keyName})`)
    this.name = 'ProviderKeyMissingError'
  }
}

interface Capabilities {
  tokenParam: OpenAITokenParam
  jsonMode: OpenAIJsonMode
}

const PRESET_CAPABILITIES: Record<OpenAIPreset, Capabilities> = {
  openai: { tokenParam: 'max_completion_tokens', jsonMode: 'schema' },
  openrouter: { tokenParam: 'max_tokens', jsonMode: 'object' },
  groq: { tokenParam: 'max_completion_tokens', jsonMode: 'object' },
  deepseek: { tokenParam: 'max_tokens', jsonMode: 'object' },
  mistral: { tokenParam: 'max_tokens', jsonMode: 'object' },
  together: { tokenParam: 'max_tokens', jsonMode: 'object' },
  xai: { tokenParam: 'max_tokens', jsonMode: 'object' },
  gemini: { tokenParam: 'max_tokens', jsonMode: 'object' },
  ollama: { tokenParam: 'max_tokens', jsonMode: 'object' },
  lmstudio: { tokenParam: 'max_tokens', jsonMode: 'schema' },
}

const GENERIC_CAPABILITIES: Capabilities = { tokenParam: 'max_tokens', jsonMode: 'object' }

const LOCAL_PRESETS: OpenAIPreset[] = ['ollama', 'lmstudio']

const HOSTED_ENDPOINTS = new Set<string>(
  (Object.keys(OPENAI_PRESETS) as OpenAIPreset[])
    .filter((name) => !LOCAL_PRESETS.includes(name))
    .map((name) => OPENAI_PRESETS[name]),
)

const DEFAULT_MAX_TOKENS = 4096

const hostOf = (baseURL: string): string => {
  try {
    return new URL(baseURL, globalThis.location?.href).host || baseURL
  } catch {
    return baseURL
  }
}

export function defaultKeyName(options: Pick<OpenAIProviderOptions, 'preset' | 'baseURL'>): string {
  return `docsterm:key:${options.baseURL ? hostOf(options.baseURL) : (options.preset ?? 'openai')}`
}

const capabilitiesFor = (options: OpenAIProviderOptions): Capabilities => {
  if (options.preset) return PRESET_CAPABILITIES[options.preset]
  return options.baseURL ? GENERIC_CAPABILITIES : PRESET_CAPABILITIES.openai
}

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: unknown) => (isFields(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

const messageOf = (error: unknown): string => {
  if (typeof error === 'string') return error
  return isFields(error) && typeof error.message === 'string' ? error.message : ''
}

const clip = (text: string): string => sanitizeProse(text).replace(/\s+/g, ' ').trim().slice(0, 300)

const upstreamError = (error: unknown, fallback: string): AIProviderError => {
  const code = isFields(error) ? error.code : undefined
  const message = clip(messageOf(error)) || fallback
  return new AIProviderError('http', message, typeof code === 'number' ? { status: code } : {})
}

interface Step {
  text: string
  finish: string | null
}

const stepOf = (payload: unknown, fallback: string): Step => {
  if (!isFields(payload)) return { text: '', finish: null }
  if (payload.error) throw upstreamError(payload.error, fallback)
  const choice: unknown = Array.isArray(payload.choices) ? payload.choices[0] : undefined
  if (!isFields(choice)) return { text: '', finish: null }
  const part: Fields = isFields(choice.delta) ? choice.delta : isFields(choice.message) ? choice.message : {}
  if (typeof part.refusal === 'string' && part.refusal.trim() !== '') {
    throw new AIProviderError('refused', sanitizeProse(part.refusal))
  }
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null
  if (finish === 'error') throw new AIProviderError('http', fallback)
  return { text: contentText(part.content), finish }
}

interface SseEvent {
  type: string
  data: string
}

const payloadsOf = (data: string): unknown[] => {
  const whole = tryJson(data)
  if (whole !== NOT_JSON) return [whole]
  return data
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== '[DONE]')
    .map(tryJson)
    .filter((payload) => payload !== NOT_JSON)
}

const collector = (fallback: string, onText?: (text: string) => void) => {
  let text = ''
  let finish: string | null = null
  const take = (payload: unknown): void => {
    const step = stepOf(payload, fallback)
    if (step.text !== '') {
      text += step.text
      onText?.(step.text)
    }
    if (step.finish) finish = step.finish
  }
  return {
    take,
    event(event: SseEvent): void {
      if (event.type === 'error') {
        const payload = tryJson(event.data)
        if (payload === NOT_JSON) throw upstreamError(event.data, fallback)
        throw upstreamError(isFields(payload) && payload.error !== undefined ? payload.error : payload, fallback)
      }
      for (const payload of payloadsOf(event.data)) take(payload)
    },
    result(): string {
      if (finish === 'length') throw new AIProviderError('truncated', 'the answer hit the token limit')
      if (finish === 'content_filter') throw new AIProviderError('refused', 'the answer was blocked by a content filter')
      if (text.trim() === '') throw new AIProviderError('empty', 'the model returned no text')
      return text
    },
  }
}

const sseParser = (dispatch: (event: SseEvent) => void) => {
  let buffer = ''
  let skipLineFeed = false
  let data: string[] = []
  let type = ''
  const flush = (): void => {
    if (data.length > 0) dispatch({ type: type || 'message', data: data.join('\n') })
    data = []
    type = ''
  }
  const line = (text: string): void => {
    if (text === '') {
      flush()
      return
    }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon === -1 ? text : text.slice(0, colon)
    const raw = colon === -1 ? '' : text.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'data') data.push(value)
    else if (field === 'event') type = value
  }
  return {
    push(chunk: string): void {
      let text = chunk
      if (skipLineFeed && text !== '') {
        if (text.startsWith('\n')) text = text.slice(1)
        skipLineFeed = false
      }
      buffer += text
      let start = 0
      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index]
        if (char !== '\n' && char !== '\r') continue
        line(buffer.slice(start, index))
        if (char === '\r') {
          if (index + 1 === buffer.length) skipLineFeed = true
          else if (buffer[index + 1] === '\n') index += 1
        }
        start = index + 1
      }
      buffer = buffer.slice(start)
    },
    end(): void {
      if (buffer !== '') line(buffer)
      buffer = ''
      flush()
    },
  }
}

export function extractStreamDeltas(chunk: string): string[] {
  const deltas: string[] = []
  const collect = collector(getMessages('en').aiServiceError, (text) => deltas.push(text))
  const parser = sseParser(collect.event)
  parser.push(chunk)
  parser.end()
  return deltas
}

const textOfBody = (body: string, fallback: string, onText?: (text: string) => void): string => {
  const collect = collector(fallback, onText)
  const parsed = tryJson(body)
  if (parsed !== NOT_JSON) {
    collect.take(parsed)
  } else {
    const parser = sseParser(collect.event)
    parser.push(body)
    parser.end()
  }
  return collect.result()
}

const abortError = (): Error => new DOMException('The operation was aborted.', 'AbortError')

const transportError = (error: unknown, signal?: AbortSignal): Error => {
  if (signal?.aborted || isAbortError(error)) return abortError()
  return new AIProviderError('network', error instanceof Error ? error.message : String(error), { cause: error })
}

const bodyMessage = (root: unknown): string => {
  if (!isFields(root)) return messageOf(root)
  if (root.error !== undefined) return messageOf(root.error)
  return messageOf(root) || (typeof root.detail === 'string' ? root.detail : '')
}

const errorDetail = (body: string): string => {
  const parsed = tryJson(body)
  if (parsed !== NOT_JSON) return clip(bodyMessage(Array.isArray(parsed) ? parsed[0] : parsed))
  const text = clip(body)
  return text.startsWith('<') ? '' : text
}

const httpFailure = async (
  response: Response,
  signal: AbortSignal | undefined,
  fallback: string,
): Promise<{ error: AIProviderError; body: string }> => {
  const body = await response.text().catch((error: unknown) => {
    if (signal?.aborted || isAbortError(error)) throw abortError()
    return ''
  })
  if (signal?.aborted) throw abortError()
  const message = `${response.status}: ${errorDetail(body) || fallback}`
  return { error: new AIProviderError('http', message, { status: response.status }), body }
}

const readText = async (response: Response, signal?: AbortSignal): Promise<string> => {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw transportError(error, signal)
  }
  if (signal?.aborted) throw abortError()
  return text
}

const serviceError = (locale?: Locale): string => getMessages(locale ?? 'en').aiServiceError

const isEventStream = (response: Response): boolean =>
  (response.headers.get('content-type') ?? '').includes('text/event-stream')

const streamText = async (
  response: Response,
  signal: AbortSignal | undefined,
  fallback: string,
  onText: (text: string) => void,
): Promise<string> => {
  const reader = response.body?.getReader()
  if (!reader) return textOfBody(await readText(response, signal), fallback, onText)
  const collect = collector(fallback, onText)
  const parser = sseParser(collect.event)
  const decoder = new TextDecoder()
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  const next = async () => {
    try {
      return await reader.read()
    } catch (error) {
      throw transportError(error, signal)
    }
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (let chunk = await next(); !chunk.done; chunk = await next()) {
      if (signal?.aborted) throw abortError()
      parser.push(decoder.decode(chunk.value, { stream: true }))
    }
    if (signal?.aborted) throw abortError()
    parser.push(decoder.decode())
    parser.end()
    return collect.result()
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

export function createOpenAIProvider(options: OpenAIProviderOptions): AIProvider {
  const preset = options.preset
  const baseURL = (options.baseURL ?? (preset ? OPENAI_PRESETS[preset] : OPENAI_PRESETS.openai)).replace(
    /\/$/,
    '',
  )
  const capabilities = capabilitiesFor(options)
  const tokenParam = options.tokenParam ?? capabilities.tokenParam
  const jsonMode = options.jsonMode ?? capabilities.jsonMode
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const keyName = options.keyName ?? defaultKeyName(options)
  const keyOptional = (preset !== undefined && LOCAL_PRESETS.includes(preset)) || !HOSTED_ENDPOINTS.has(baseURL)
  const useStream = options.stream ?? true
  const doFetch = options.fetchImpl ?? globalThis.fetch

  const resolveKey = (): string | null => {
    const key = options.apiKey || keyStore.get(keyName)
    if (key) return key
    if (keyOptional) return null
    throw new ProviderKeyMissingError(keyName)
  }

  const post = async (body: Fields, signal?: AbortSignal): Promise<Response> => {
    const key = resolveKey()
    if (signal?.aborted) throw abortError()
    try {
      return await doFetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...options.headers,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw transportError(error, signal)
    }
  }

  const ensureOk = async (response: Response, signal: AbortSignal | undefined, fallback: string): Promise<Response> => {
    if (!response.ok) throw (await httpFailure(response, signal, fallback)).error
    return response
  }

  const responseFormat = (): Fields | null => {
    if (jsonMode === 'schema') {
      return {
        type: 'json_schema',
        json_schema: { name: 'command_suggestion', strict: true, schema: SUGGESTION_SCHEMA },
      }
    }
    return jsonMode === 'object' ? { type: 'json_object' } : null
  }

  return {
    id: options.id ?? preset ?? 'openai',

    async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
      const base: Fields = {
        model: options.model,
        [tokenParam]: maxTokens,
        messages: [
          { role: 'system', content: `${buildSuggestSystem(input.context, input.backendId)}\n\n${JSON_INSTRUCTION}` },
          { role: 'user', content: renderSuggestUser(input) },
        ],
      }
      const fallback = serviceError(input.locale)
      const format = responseFormat()
      let response = await post(format ? { ...base, response_format: format } : base, input.signal)
      if (format && response.status === 400) {
        const failure = await httpFailure(response, input.signal, fallback)
        if (!/response_format/i.test(failure.body)) throw failure.error
        response = await post(base, input.signal)
      }
      await ensureOk(response, input.signal, fallback)
      return parseSuggestionText(textOfBody(await readText(response, input.signal), fallback))
    },

    async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
      const body: Fields = {
        model: options.model,
        [tokenParam]: maxTokens,
        messages: [
          { role: 'system', content: buildExplainSystem(input.context, input.backendId) },
          { role: 'user', content: renderExplainUser(input) },
        ],
      }
      const fallback = serviceError(input.locale)
      if (!useStream || !onChunk) {
        const response = await ensureOk(await post(body, input.signal), input.signal, fallback)
        return textOfBody(await readText(response, input.signal), fallback, onChunk)
      }
      const response = await ensureOk(await post({ ...body, stream: true }, input.signal), input.signal, fallback)
      if (!isEventStream(response)) return textOfBody(await readText(response, input.signal), fallback, onChunk)
      return streamText(response, input.signal, fallback, onChunk)
    },
  }
}
