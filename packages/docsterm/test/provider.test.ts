import { Anthropic, APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  createAnthropicProvider,
  DEFAULT_MODEL,
  KeyMissingError,
  type AnthropicLike,
  type AnthropicMessagesLike,
  type AnthropicProviderOptions,
  type AnthropicRequest,
} from '../src/anthropic/index.js'
import { AIProviderError, isAbortError } from '../src/errors.js'
import { buildExplainSystem, buildSuggestSystem, renderExplainUser, renderSuggestUser } from '../src/prompts.js'
import type { ExplainInput, PageContext, SuggestInput } from '../src/types.js'

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

const SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['command', 'explanation'],
  additionalProperties: false,
}

const FALLBACK: Pick<AnthropicRequest, 'betas' | 'fallbacks'> = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
}

interface ModelResult {
  stop_reason: string | null
  content: Array<{ type: string; text?: string; thinking?: string }>
}

interface Reply {
  result?: ModelResult
  text?: string[]
  stop?: string | null
  error?: unknown
  failures?: unknown[]
}

interface Recorded {
  endpoint: 'messages' | 'beta'
  method: 'create' | 'stream'
  params: AnthropicRequest
  options: unknown
}

const fakeClient = (reply: Reply = {}, withBeta = true) => {
  const calls: Recorded[] = []
  const endpoint = (name: Recorded['endpoint']): AnthropicMessagesLike => ({
    async create(params, options) {
      calls.push({ endpoint: name, method: 'create', params, options })
      const failure = reply.failures?.shift()
      if (failure) throw failure
      if (reply.error) throw reply.error
      return (
        reply.result ?? {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"command":"orbit deploy","explanation":"ship"}' }],
        }
      )
    },
    stream(params, options) {
      calls.push({ endpoint: name, method: 'stream', params, options })
      const failure = reply.failures?.shift()
      const listeners: Array<(delta: string) => void> = []
      const parts = reply.text ?? ['it ', 'failed']
      return {
        on(_event, listener) {
          listeners.push(listener)
          return this
        },
        async finalMessage() {
          if (failure) throw failure
          if (reply.error) throw reply.error
          for (const part of parts) for (const listener of listeners) listener(part)
          return {
            stop_reason: reply.stop === undefined ? 'end_turn' : reply.stop,
            content: parts.map((text) => ({ type: 'text', text })),
          }
        },
      }
    },
  })
  const client: AnthropicLike = withBeta
    ? { messages: endpoint('messages'), beta: { messages: endpoint('beta') } }
    : { messages: endpoint('messages') }
  return { client, calls }
}

const provider = (reply: Reply = {}, options: Partial<AnthropicProviderOptions> = {}, withBeta = true) => {
  const { client, calls } = fakeClient(reply, withBeta)
  return {
    ai: createAnthropicProvider({ apiKey: 'sk-test', clientFactory: () => client, ...options }),
    calls,
  }
}

const only = (calls: Recorded[]): Recorded => {
  expect(calls).toHaveLength(1)
  return calls[0] as Recorded
}

const rejection = async (promise: Promise<unknown>): Promise<AIProviderError> => {
  const error = await promise.then(
    () => new Error('expected a rejection'),
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(AIProviderError)
  return error as AIProviderError
}

const suggestParams = (fields: Record<string, unknown>) => ({
  model: 'claude-opus-5-5',
  max_tokens: 8192,
  system: expect.stringContaining('Orbit docs'),
  messages: [{ role: 'user', content: expect.stringContaining('deploy the app') }],
  ...fields,
})

const explainParams = (fields: Record<string, unknown>) => ({
  model: 'claude-opus-5-5',
  max_tokens: 8192,
  system: expect.stringContaining('Orbit docs'),
  messages: [{ role: 'user', content: expect.stringContaining('orbit destroy') }],
  ...fields,
})

const FORMAT: NonNullable<AnthropicRequest['output_config']>['format'] = { type: 'json_schema', schema: SCHEMA }

const badRequest = (message: string) =>
  APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers())

const sse = (...entries: Array<[string, unknown]>) =>
  entries.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const STREAM_START: Array<[string, unknown]> = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  ],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The flag ' } }],
]

interface SdkRequest {
  url: string
  beta: string | null
  body: Record<string, unknown>
}

const sdkProvider = (...replies: Array<() => Response>) => {
  const requests: SdkRequest[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: String(url),
      beta: new Headers(init?.headers).get('anthropic-beta'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    const reply = replies[Math.min(requests.length, replies.length) - 1]
    if (!reply) throw new Error('no reply configured')
    return reply()
  }
  const ai = createAnthropicProvider({
    apiKey: 'sk-test',
    clientFactory: (apiKey) => new Anthropic({ apiKey, fetch, maxRetries: 0, dangerouslyAllowBrowser: true }),
  })
  return { ai, requests }
}

const JSON_INSTRUCTION = 'Reply with a JSON object shaped {"command": string, "explanation": string} and nothing else.'

const SUGGEST_SYSTEM = buildSuggestSystem(context, 'mock')

const exactSuggest = (fields: Partial<AnthropicRequest>): AnthropicRequest => ({
  model: 'claude-opus-5-5',
  max_tokens: 8192,
  system: SUGGEST_SYSTEM,
  messages: [{ role: 'user', content: renderSuggestUser(suggestInput) }],
  ...fields,
})

const exactExplain = (fields: Partial<AnthropicRequest>): AnthropicRequest => ({
  model: 'claude-opus-5-5',
  max_tokens: 8192,
  system: buildExplainSystem(context, 'mock'),
  messages: [{ role: 'user', content: renderExplainUser(explainInput) }],
  ...fields,
})

const hangingFetch = () => {
  let started: () => void = () => undefined
  const requested = new Promise<void>((resolve) => {
    started = resolve
  })
  const fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      started()
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), {
        once: true,
      })
    })
  return { fetch, requested }
}

const jsonReply = (payload: unknown, status = 200) => () =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.doUnmock('@anthropic-ai/sdk')
  vi.resetModules()
})

describe('createAnthropicProvider', () => {
  it('defaults to Claude Opus 5.5', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5')
  })

  it('throws KeyMissingError for the default endpoint without a key and never loads the SDK', async () => {
    const error = await rejection(createAnthropicProvider().suggestCommand(suggestInput))
    expect(error).toBeInstanceOf(KeyMissingError)
    expect(error.code).toBe('key-missing')

    vi.resetModules()
    let loads = 0
    vi.doMock('@anthropic-ai/sdk', () => {
      loads += 1
      return {}
    })
    const fresh = await import('../src/anthropic/index.js')
    const again = await fresh.createAnthropicProvider().explainError(explainInput).then(
      () => null,
      (reason: unknown) => reason as { name?: unknown; code?: unknown },
    )
    expect([again?.name, again?.code, loads]).toEqual(['KeyMissingError', 'key-missing', 0])
  })

  it('calls a custom clientFactory without a key, passing undefined', async () => {
    const keys: unknown[] = []
    const { client, calls } = fakeClient()
    const ai = createAnthropicProvider({
      clientFactory: (apiKey) => {
        keys.push(apiKey)
        return client
      },
    })
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
    expect(keys).toEqual([undefined])
    expect(calls).toHaveLength(1)
  })

  it('needs no key behind a baseURL proxy and then sends neither x-api-key nor authorization', async () => {
    const seen: Array<[string, string | null, string | null]> = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push([String(url), headers.get('x-api-key'), headers.get('authorization')])
      return jsonReply({
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '{"command":"orbit deploy","explanation":"ship"}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      })()
    })
    const keys = new Map<string, string>([['docsterm:anthropic-key', 'sk-readers-own-key']])
    vi.stubGlobal('localStorage', { getItem: (name: string) => keys.get(name) ?? null })
    try {
      const proxy = createAnthropicProvider({ baseURL: 'https://docs.example/anthropic', fallbacks: false })
      await expect(proxy.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
      const keyed = createAnthropicProvider({ apiKey: 'sk-proxy', baseURL: 'https://docs.example/anthropic', fallbacks: false })
      await keyed.suggestCommand(suggestInput)
      const direct = createAnthropicProvider({ fallbacks: false })
      await direct.suggestCommand(suggestInput)
      expect(seen).toEqual([
        ['https://docs.example/anthropic/v1/messages', null, null],
        ['https://docs.example/anthropic/v1/messages', 'sk-proxy', null],
        ['https://api.anthropic.com/v1/messages', 'sk-readers-own-key', null],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('asks for a structured suggestion at low effort with server-side fallbacks and the abort signal', async () => {
    const { ai, calls } = provider()
    const signal = new AbortController().signal
    await expect(ai.suggestCommand({ ...suggestInput, signal })).resolves.toEqual({
      command: 'orbit deploy',
      explanation: 'ship',
    })
    expect(only(calls)).toEqual({
      endpoint: 'beta',
      method: 'create',
      params: suggestParams({
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        ...FALLBACK,
      }),
      options: { signal },
    })
  })

  it('streams the explanation at low effort with fallbacks and the abort signal', async () => {
    const { ai, calls } = provider({ text: ['the flag ', 'is unknown'] })
    const signal = new AbortController().signal
    const chunks: string[] = []
    await expect(ai.explainError({ ...explainInput, signal }, (chunk) => chunks.push(chunk))).resolves.toBe(
      'the flag is unknown',
    )
    expect(chunks).toEqual(['the flag ', 'is unknown'])
    expect(only(calls)).toEqual({
      endpoint: 'beta',
      method: 'stream',
      params: explainParams({ output_config: { effort: 'low' }, ...FALLBACK }),
      options: { signal },
    })
  })

  it('builds the prompts from the whole input, so locale and backend description reach the model', async () => {
    const extra = { locale: 'ru' as const, backendDescription: 'Ubuntu 24.04 container with git and kubectl' }
    const suggest: SuggestInput = { ...suggestInput, ...extra }
    const explain: ExplainInput = { ...explainInput, ...extra }
    const { ai, calls } = provider()
    await ai.suggestCommand(suggest)
    await ai.explainError(explain)
    expect(calls.map((recorded) => [recorded.params.system, recorded.params.messages])).toEqual([
      [buildSuggestSystem(context, 'mock'), [{ role: 'user', content: renderSuggestUser(suggest) }]],
      [buildExplainSystem(context, 'mock'), [{ role: 'user', content: renderExplainUser(explain) }]],
    ])
  })

  it('uses the plain messages endpoint without betas when fallbacks are off', async () => {
    const { ai, calls } = provider({}, { fallbacks: false })
    await ai.suggestCommand(suggestInput)
    expect(only(calls)).toEqual({
      endpoint: 'messages',
      method: 'create',
      params: suggestParams({ output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } }),
      options: { signal: undefined },
    })
  })

  it('falls back to the plain messages endpoint for a client without the beta namespace', async () => {
    const { ai, calls } = provider({}, {}, false)
    await ai.explainError(explainInput)
    expect(only(calls)).toMatchObject({ endpoint: 'messages', method: 'stream' })
    expect(only(calls).params).toEqual(explainParams({ output_config: { effort: 'low' } }))
  })

  it('honours the model, maxTokens and effort options, and effort false omits it', async () => {
    const tuned = provider({}, { model: 'claude-sonnet-5-5', maxTokens: 2048, effort: 'high' })
    await tuned.ai.suggestCommand(suggestInput)
    expect(only(tuned.calls).params).toEqual({
      ...suggestParams({
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
        ...FALLBACK,
      }),
      model: 'claude-sonnet-5-5',
      max_tokens: 2048,
    })

    const plain = provider({}, { effort: false })
    await plain.ai.suggestCommand(suggestInput)
    await plain.ai.explainError(explainInput)
    expect(plain.calls.map((recorded) => recorded.params.output_config)).toEqual([
      { format: { type: 'json_schema', schema: SCHEMA } },
      undefined,
    ])
    expect(Object.keys(plain.calls[1]?.params ?? {})).not.toContain('output_config')
  })

  it('accepts an async client factory', async () => {
    const { client } = fakeClient()
    const ai = createAnthropicProvider({ apiKey: 'sk-test', clientFactory: async () => client })
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
  })

  it('throws refused on a refusal stop reason instead of returning content', async () => {
    const suggest = provider({ result: { stop_reason: 'refusal', content: [] } })
    const refusedSuggestion = await rejection(suggest.ai.suggestCommand(suggestInput))
    expect([refusedSuggestion.code, refusedSuggestion.message]).toEqual(['refused', 'request declined by safety filters'])

    const explain = provider({ stop: 'refusal' })
    expect((await rejection(explain.ai.explainError(explainInput))).code).toBe('refused')
  })

  it('checks stop_reason max_tokens before parsing the answer', async () => {
    const cut = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"command":"orbit dep' }] }
    expect((await rejection(provider({ result: cut }).ai.suggestCommand(suggestInput))).code).toBe('truncated')

    const window = { stop_reason: 'model_context_window_exceeded', content: [{ type: 'text', text: '{"comm' }] }
    expect((await rejection(provider({ result: window }).ai.suggestCommand(suggestInput))).code).toBe('truncated')

    const { ai } = provider({ text: ['The flag', ' is'], stop: 'max_tokens' })
    const chunks: string[] = []
    expect((await rejection(ai.explainError(explainInput, (chunk) => chunks.push(chunk)))).code).toBe('truncated')
    expect(chunks).toEqual(['The flag', ' is'])
  })

  it('reports thinking-only answers as empty', async () => {
    const thinking = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] }
    expect((await rejection(provider({ result: thinking }).ai.suggestCommand(suggestInput))).code).toBe('empty')
    expect((await rejection(provider({ text: [] }).ai.explainError(explainInput))).code).toBe('empty')
  })

  it('validates the parsed suggestion fields', async () => {
    const answer = (text: string) => ({ result: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
    await expect(provider(answer('{"command":"orbit status"}')).ai.suggestCommand(suggestInput)).resolves.toEqual({
      command: 'orbit status',
      explanation: '',
    })
    await expect(
      provider(answer('{"command":"ls","explanation":42}')).ai.suggestCommand(suggestInput),
    ).resolves.toEqual({ command: 'ls', explanation: '' })
    for (const text of ['{"explanation":"x"}', '{"command":"   "}', 'not json']) {
      expect((await rejection(provider(answer(text)).ai.suggestCommand(suggestInput))).code, text).toBe('invalid')
    }
  })

  it('maps SDK http errors to AIProviderError http with the status and the API message', async () => {
    const unauthorized = APIError.generate(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      undefined,
      new Headers(),
    )
    const error = await rejection(provider({ error: unauthorized }).ai.suggestCommand(suggestInput))
    expect([error.code, error.status, error.message]).toEqual(['http', 401, '401: invalid x-api-key'])
  })

  it('maps SDK connection errors to network errors', async () => {
    const offline = new APIConnectionError({ message: 'Connection error.' })
    const error = await rejection(provider({ error: offline }).ai.explainError(explainInput))
    expect([error.code, error.message]).toEqual(['network', 'Connection error.'])
  })

  it('maps a mid-stream error event to an http error with the server message, not a network error', async () => {
    const body = sse(...STREAM_START, ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
    const { ai } = sdkProvider(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    const chunks: string[] = []
    const error = await rejection(ai.explainError(explainInput, (chunk) => chunks.push(chunk)))
    expect(chunks).toEqual(['The flag '])
    expect([error.code, error.status, error.message]).toEqual(['http', undefined, 'Overloaded'])
  })

  it('uses the localized service error when the API sends no error message', async () => {
    const replies: Array<() => Response> = [
      () => new Response('', { status: 529 }),
      () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 }),
      jsonReply({ type: 'error', error: { type: 'api_error' } }, 500),
      () =>
        new Response(sse(...STREAM_START, ['error', { type: 'error', error: { type: 'overloaded_error' } }]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ]
    const seen: Array<[string, number | undefined, string]> = []
    for (const locale of ['en', 'ru'] as const) {
      for (const reply of replies) {
        const { ai } = sdkProvider(reply)
        const error = await rejection(ai.explainError({ ...explainInput, locale }, () => undefined))
        seen.push([error.code, error.status, error.message])
      }
    }
    expect(seen).toEqual([
      ['http', 529, '529: the AI service reported an error'],
      ['http', 502, '502: the AI service reported an error'],
      ['http', 500, '500: the AI service reported an error'],
      ['http', undefined, 'the AI service reported an error'],
      ['http', 529, '529: сервис AI сообщил об ошибке'],
      ['http', 502, '502: сервис AI сообщил об ошибке'],
      ['http', 500, '500: сервис AI сообщил об ошибке'],
      ['http', undefined, 'сервис AI сообщил об ошибке'],
    ])
  })

  it('sends neither effort nor fallbacks to claude-haiku-4-5 and claude-sonnet-4-5', async () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']) {
      const { ai, calls } = provider({}, { model })
      await ai.suggestCommand(suggestInput)
      await ai.explainError(explainInput)
      expect(calls, model).toEqual([
        {
          endpoint: 'messages',
          method: 'create',
          params: { ...suggestParams({ output_config: { format: FORMAT } }), model },
          options: { signal: undefined },
        },
        { endpoint: 'messages', method: 'stream', params: { ...explainParams({}), model }, options: { signal: undefined } },
      ])
    }
  })

  it('sends effort and fallbacks by default only to the models that support them', async () => {
    const table: Array<[string, boolean, boolean]> = [
      ['claude-opus-4-1', false, false],
      ['claude-opus-4-20250514', false, false],
      ['claude-3-7-sonnet-latest', false, false],
      ['claude-opus-4-5', true, false],
      ['claude-opus-4-8', true, false],
      ['claude-sonnet-4-6', true, false],
      ['claude-sonnet-5', true, false],
      ['claude-fable-5', true, false],
      ['claude-sonnet-5-5', true, true],
      ['claude-opus-5', true, true],
      ['claude-opus-5-5', true, true],
      ['claude-fable-5-1', true, true],
      ['claude-mythos-5-1', true, true],
      ['us.anthropic.claude-opus-4-5-20251101-v1:0', true, false],
    ]
    const seen: Array<[string, boolean, boolean]> = []
    for (const [model] of table) {
      const { ai, calls } = provider({}, { model })
      await ai.explainError(explainInput)
      const { endpoint, params } = only(calls)
      const effort = (params.output_config as { effort?: unknown } | undefined)?.effort
      const fallbacks = endpoint === 'beta' && params.fallbacks === 'default' && Array.isArray(params.betas)
      if (effort !== undefined) expect(effort, model).toBe('low')
      seen.push([model, effort !== undefined, fallbacks])
    }
    expect(seen).toEqual(table)
  })

  it('sends low effort but no fallbacks to claude-haiku-5-5 and later Haiku models', async () => {
    const seen: Array<[string, unknown]> = []
    for (const model of ['claude-haiku-5-5', 'claude-haiku-6', 'claude-haiku-4-5', 'claude-3-5-haiku-latest']) {
      const { ai, calls } = provider({}, { model })
      await ai.explainError(explainInput)
      const { endpoint, params } = only(calls)
      seen.push([`${model} ${endpoint}`, params.output_config])
    }
    expect(seen).toEqual([
      ['claude-haiku-5-5 messages', { effort: 'low' }],
      ['claude-haiku-6 messages', { effort: 'low' }],
      ['claude-haiku-4-5 messages', undefined],
      ['claude-3-5-haiku-latest messages', undefined],
    ])
  })

  it('lets explicit effort and fallbacks options override the model defaults', async () => {
    const forced = provider({}, { model: 'claude-haiku-4-5', effort: 'medium', fallbacks: true })
    await forced.ai.explainError(explainInput)
    expect(only(forced.calls)).toEqual({
      endpoint: 'beta',
      method: 'stream',
      params: { ...explainParams({ output_config: { effort: 'medium' }, ...FALLBACK }), model: 'claude-haiku-4-5' },
      options: { signal: undefined },
    })

    const off = provider({}, { model: 'claude-opus-5-5', effort: false, fallbacks: false })
    await off.ai.explainError(explainInput)
    expect(only(off.calls)).toEqual({
      endpoint: 'messages',
      method: 'stream',
      params: explainParams({}),
      options: { signal: undefined },
    })
  })

  it('retries once without effort when a 400 names it, keeping the format and the fallbacks', async () => {
    const { ai, calls } = provider({ failures: [badRequest('output_config.effort: not supported on this model')] })
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
    expect(calls.map((recorded) => [recorded.endpoint, recorded.params])).toEqual([
      ['beta', suggestParams({ output_config: { effort: 'low', format: FORMAT }, ...FALLBACK })],
      ['beta', suggestParams({ output_config: { format: FORMAT }, ...FALLBACK })],
    ])
  })

  it('retries once on the plain endpoint without fallbacks when a 400 names them', async () => {
    const { ai, calls } = provider({
      failures: [badRequest('fallbacks: server-side fallback is not available for this model')],
      text: ['the flag ', 'is unknown'],
    })
    const chunks: string[] = []
    await expect(ai.explainError(explainInput, (chunk) => chunks.push(chunk))).resolves.toBe('the flag is unknown')
    expect(chunks).toEqual(['the flag ', 'is unknown'])
    expect(calls.map((recorded) => [recorded.endpoint, recorded.method, recorded.params])).toEqual([
      ['beta', 'stream', explainParams({ output_config: { effort: 'low' }, ...FALLBACK })],
      ['messages', 'stream', explainParams({ output_config: { effort: 'low' } })],
    ])
  })

  it('sends the fallback beta as a header through the SDK and drops it on the retry', async () => {
    const { ai, requests } = sdkProvider(
      jsonReply(
        { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not available for this model' } },
        400,
      ),
      jsonReply({
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '{"command":"orbit deploy","explanation":"ship"}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    )
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
    expect(requests.map(({ url, beta, body }) => [url, beta, body.fallbacks, body.betas, body.output_config])).toEqual([
      [
        'https://api.anthropic.com/v1/messages?beta=true',
        'server-side-fallback-2026-07-01',
        'default',
        undefined,
        { effort: 'low', format: FORMAT },
      ],
      ['https://api.anthropic.com/v1/messages', null, undefined, undefined, { effort: 'low', format: FORMAT }],
    ])
  })

  it('retries once without output_config when a 400 names it', async () => {
    const { ai, calls } = provider({ failures: [badRequest('output_config: Extra inputs are not permitted')] })
    await ai.suggestCommand(suggestInput)
    expect(calls.map((recorded) => recorded.params)).toEqual([
      suggestParams({ output_config: { effort: 'low', format: FORMAT }, ...FALLBACK }),
      suggestParams({ ...FALLBACK }),
    ])
    expect(Object.keys(calls[1]?.params ?? {})).not.toContain('output_config')
  })

  it('retries only once, only on a 400, and only for a field it sent', async () => {
    const twice = provider({
      failures: [badRequest('effort is not supported on this model'), badRequest('fallbacks are not supported')],
    })
    const second = await rejection(twice.ai.suggestCommand(suggestInput))
    expect([second.code, second.status, second.message]).toEqual(['http', 400, '400: fallbacks are not supported'])
    expect(twice.calls).toHaveLength(2)

    const other = provider({ failures: [badRequest('max_tokens: must be at most 128000')] })
    expect((await rejection(other.ai.suggestCommand(suggestInput))).message).toBe('400: max_tokens: must be at most 128000')
    expect(other.calls).toHaveLength(1)

    const unsent = provider({ failures: [badRequest('effort is not supported on this model')] }, { model: 'claude-haiku-4-5' })
    await rejection(unsent.ai.suggestCommand(suggestInput))
    expect(unsent.calls).toHaveLength(1)

    const overloaded = APIError.generate(
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'effort queue overloaded' } },
      undefined,
      new Headers(),
    )
    const busy = provider({ failures: [overloaded] })
    await rejection(busy.ai.suggestCommand(suggestInput))
    expect(busy.calls).toHaveLength(1)
  })

  it('spells out the JSON shape in the system prompt when the retry drops the format', async () => {
    const { ai, calls } = provider({
      failures: [badRequest('output_config: Extra inputs are not permitted')],
      result: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Sure, here it is: {"command":"orbit deploy","explanation":"ship"}' }],
      },
    })
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
    expect(calls.map((recorded) => [recorded.endpoint, recorded.params])).toEqual([
      ['beta', exactSuggest({ output_config: { effort: 'low', format: FORMAT }, ...FALLBACK })],
      ['beta', exactSuggest({ system: `${SUGGEST_SYSTEM}\n\n${JSON_INSTRUCTION}`, ...FALLBACK })],
    ])
  })

  it('drops only the format when a 400 names it, keeping effort and fallbacks', async () => {
    const messages = [
      'output_config.format: Extra inputs are not permitted',
      'claude-3-haiku-20240307 does not support structured outputs',
      'output_config.format.json_schema is not supported on this model',
    ]
    for (const message of messages) {
      const { ai, calls } = provider({ failures: [badRequest(message)] })
      await ai.suggestCommand(suggestInput)
      expect(
        calls.map((recorded) => recorded.params),
        message,
      ).toEqual([
        exactSuggest({ output_config: { effort: 'low', format: FORMAT }, ...FALLBACK }),
        exactSuggest({ system: `${SUGGEST_SYSTEM}\n\n${JSON_INSTRUCTION}`, output_config: { effort: 'low' }, ...FALLBACK }),
      ])
    }
  })

  it('drops only effort when a 400 names it, and the whole output_config of an explanation with it', async () => {
    const { ai, calls } = provider({ failures: [badRequest('output_config.effort: Input should be low, medium or high')] })
    await ai.explainError(explainInput)
    expect(calls.map((recorded) => [recorded.endpoint, recorded.method, recorded.params])).toEqual([
      ['beta', 'stream', exactExplain({ output_config: { effort: 'low' }, ...FALLBACK })],
      ['beta', 'stream', exactExplain({ ...FALLBACK })],
    ])
  })

  it('remembers rejected fallbacks and leaves them out of every later request', async () => {
    const { ai, calls } = provider({
      failures: [badRequest('fallbacks: server-side fallback is not available on this platform')],
    })
    await ai.suggestCommand(suggestInput)
    await ai.suggestCommand(suggestInput)
    await ai.explainError(explainInput)
    expect(calls.map((recorded) => [recorded.endpoint, recorded.method, recorded.params])).toEqual([
      ['beta', 'create', exactSuggest({ output_config: { effort: 'low', format: FORMAT }, ...FALLBACK })],
      ['messages', 'create', exactSuggest({ output_config: { effort: 'low', format: FORMAT } })],
      ['messages', 'create', exactSuggest({ output_config: { effort: 'low', format: FORMAT } })],
      ['messages', 'stream', exactExplain({ output_config: { effort: 'low' } })],
    ])
  })

  it('remembers a rejected effort or format across suggestions and explanations', async () => {
    const effort = provider({ failures: [badRequest('effort is not supported on this model')] })
    await effort.ai.explainError(explainInput)
    await effort.ai.suggestCommand(suggestInput)
    await effort.ai.explainError(explainInput)
    expect(effort.calls.map((recorded) => recorded.params)).toEqual([
      exactExplain({ output_config: { effort: 'low' }, ...FALLBACK }),
      exactExplain({ ...FALLBACK }),
      exactSuggest({ output_config: { format: FORMAT }, ...FALLBACK }),
      exactExplain({ ...FALLBACK }),
    ])

    const format = provider({ failures: [badRequest('output_config.format: Extra inputs are not permitted')] })
    await format.ai.suggestCommand(suggestInput)
    await format.ai.suggestCommand(suggestInput)
    await format.ai.explainError(explainInput)
    const shaped = exactSuggest({
      system: `${SUGGEST_SYSTEM}\n\n${JSON_INSTRUCTION}`,
      output_config: { effort: 'low' },
      ...FALLBACK,
    })
    expect(format.calls.map((recorded) => recorded.params)).toEqual([
      exactSuggest({ output_config: { effort: 'low', format: FORMAT }, ...FALLBACK }),
      shaped,
      shaped,
      exactExplain({ output_config: { effort: 'low' }, ...FALLBACK }),
    ])
  })

  it('remembers every field named by the first and the retried 400, so the next request succeeds at once', async () => {
    const { ai, calls } = provider({
      failures: [badRequest('effort is not supported on this model'), badRequest('fallbacks are not supported')],
    })
    expect((await rejection(ai.suggestCommand(suggestInput))).message).toBe('400: fallbacks are not supported')
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
    expect(calls.map((recorded) => [recorded.endpoint, recorded.params])).toEqual([
      ['beta', exactSuggest({ output_config: { effort: 'low', format: FORMAT }, ...FALLBACK })],
      ['beta', exactSuggest({ output_config: { format: FORMAT }, ...FALLBACK })],
      ['messages', exactSuggest({ output_config: { format: FORMAT } })],
    ])
  })

  it('keeps what it learned per provider instance', async () => {
    const { client, calls } = fakeClient({ failures: [badRequest('fallbacks: not available for this model')] })
    const first = createAnthropicProvider({ apiKey: 'sk-test', clientFactory: () => client })
    const second = createAnthropicProvider({ apiKey: 'sk-test', clientFactory: () => client })
    await first.suggestCommand(suggestInput)
    await second.suggestCommand(suggestInput)
    await first.suggestCommand(suggestInput)
    expect(calls.map((recorded) => recorded.endpoint)).toEqual(['beta', 'messages', 'beta', 'messages'])
  })

  it('takes the server message from a string error field or a detail string', async () => {
    const replies: Array<[unknown, number]> = [
      [{ error: 'upstream quota exceeded' }, 429],
      [{ detail: 'Not authenticated' }, 401],
      [{ message: 'model is loading' }, 503],
      [{ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }, 500],
    ]
    const seen: string[] = []
    for (const [payload, status] of replies) {
      const { ai } = sdkProvider(jsonReply(payload, status))
      seen.push((await rejection(ai.explainError(explainInput, () => undefined))).message)
    }
    expect(seen).toEqual([
      '429: upstream quota exceeded',
      '401: Not authenticated',
      '503: model is loading',
      '500: Internal server error',
    ])
  })

  it('accepts a real SDK client from clientFactory without a cast', async () => {
    expectTypeOf(() => new Anthropic({ apiKey: 'x', baseURL: 'https://proxy.example' })).toExtend<
      NonNullable<AnthropicProviderOptions['clientFactory']>
    >()
    expectTypeOf<Anthropic>().toExtend<AnthropicLike>()
    const { fetch, requested } = hangingFetch()
    const controller = new AbortController()
    const ai = createAnthropicProvider({
      apiKey: 'sk-test',
      clientFactory: (apiKey) => new Anthropic({ apiKey, fetch, baseURL: 'https://proxy.example', maxRetries: 0 }),
    })
    const pending = ai.suggestCommand({ ...suggestInput, signal: controller.signal }).then(
      () => null,
      (reason: unknown) => reason,
    )
    await requested
    controller.abort()
    expect(isAbortError(await pending)).toBe(true)
  })

  it('reports a real SDK abort that did not come from the input signal as an AbortError', async () => {
    const outcomes: unknown[] = []
    for (const method of ['create', 'stream'] as const) {
      const { fetch, requested } = hangingFetch()
      const own = new AbortController()
      const sdk = new Anthropic({ apiKey: 'sk-test', fetch, maxRetries: 0 })
      const client: AnthropicLike = {
        messages: {
          create: (params, options) => sdk.messages.create(params, { ...options, signal: own.signal }),
          stream: (params, options) => sdk.messages.stream(params, { ...options, signal: own.signal }),
        },
      }
      const ai = createAnthropicProvider({ apiKey: 'sk-test', clientFactory: () => client })
      const settled = (method === 'create' ? ai.suggestCommand(suggestInput) : ai.explainError(explainInput)).then(
        () => null,
        (reason: unknown) => reason,
      )
      await requested
      own.abort()
      const error = await settled
      outcomes.push([method, error instanceof DOMException, isAbortError(error)])
    }
    expect(outcomes).toEqual([
      ['create', true, true],
      ['stream', true, true],
    ])
  })

  it('rejects with an AbortError when the request was aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ai } = provider({ error: new APIUserAbortError() })
    const error = await ai.suggestCommand({ ...suggestInput, signal: controller.signal }).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(isAbortError(error)).toBe(true)
  })

  it('loads the SDK only when the first request needs a client', async () => {
    vi.resetModules()
    const constructed: unknown[] = []
    let loads = 0
    vi.doMock('@anthropic-ai/sdk', () => {
      loads += 1
      class Anthropic {
        readonly messages: AnthropicMessagesLike
        readonly beta: { messages: AnthropicMessagesLike }

        constructor(options: unknown) {
          constructed.push(options)
          const { client } = fakeClient()
          this.messages = client.messages
          this.beta = client.beta as { messages: AnthropicMessagesLike }
        }
      }
      return { Anthropic, default: Anthropic }
    })
    const fresh = await import('../src/anthropic/index.js')
    expect(loads).toBe(0)
    const ai = fresh.createAnthropicProvider({ apiKey: 'sk-test' })
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ship' })
    expect(loads).toBe(1)
    expect(constructed).toEqual([{ apiKey: 'sk-test', dangerouslyAllowBrowser: true }])
  })
})
