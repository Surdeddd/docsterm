import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError, isAbortError } from '../src/errors.js'
import {
  createOpenAIProvider,
  defaultKeyName,
  extractStreamDeltas,
  OPENAI_KEY_NAME,
  OPENAI_PRESETS,
  parseSuggestionText,
  ProviderKeyMissingError,
  type OpenAIPreset,
  type OpenAIProviderOptions,
} from '../src/openai/index.js'
import { buildExplainSystem, buildSuggestSystem, renderExplainUser, renderSuggestUser } from '../src/prompts.js'
import type { ExplainInput, PageContext, SuggestInput } from '../src/types.js'

const context: PageContext = {
  title: 'Orbit docs',
  url: 'https://example.test',
  description: 'Deploy apps',
  headings: ['Install', 'Deploy'],
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

const SCHEMA_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'command_suggestion', strict: true, schema: SCHEMA },
}

const JSON_INSTRUCTION = 'Reply with a JSON object shaped {"command": string, "explanation": string} and nothing else.'

const SCAN_BUDGET_MS = 5000
const SCAN_TIMEOUT_MS = 60_000

const scanned = (raw: string): { error: unknown; elapsed: number; parsed: number } => {
  const parse = vi.spyOn(JSON, 'parse')
  const started = performance.now()
  let error: unknown
  try {
    parseSuggestionText(raw)
  } catch (caught) {
    error = caught
  }
  const elapsed = performance.now() - started
  const parsed = parse.mock.calls.reduce((total, [text]) => total + String(text).length, 0)
  parse.mockRestore()
  return { error, elapsed, parsed }
}

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => {
      storage.set(name, value)
    },
    removeItem: (name: string) => {
      storage.delete(name)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const chatResponse = (content: unknown, extra: Record<string, unknown> = {}) =>
  jsonResponse({ choices: [{ message: { content, ...extra }, finish_reason: 'stop' }] })

const streamResponse = (chunks: string[]) => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const byteStreamResponse = (parts: Uint8Array[]) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const delta = (content: unknown, finish: string | null = null) =>
  JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })

const sse = (...payloads: string[]) => payloads.map((payload) => `data: ${payload}\n\n`).join('')

interface Call {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

const fakeFetch = (...replies: Array<() => Response | Promise<Response>>) => {
  const calls: Call[] = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (!reply) throw new Error('no reply configured')
    return reply()
  }
  return { fetchImpl: fetchImpl as typeof fetch, calls }
}

const provider = (options: Partial<OpenAIProviderOptions>, ...replies: Array<() => Response | Promise<Response>>) => {
  const { fetchImpl, calls } = fakeFetch(...replies)
  const ai = createOpenAIProvider({ model: 'test-model', apiKey: 'sk-test', fetchImpl, ...options })
  return { ai, calls }
}

const call = (calls: Call[], index = 0): Call => {
  const found = calls[index]
  if (!found) throw new Error(`no fetch call #${index}`)
  return found
}

const rejection = async (promise: Promise<unknown>): Promise<AIProviderError> => {
  const error = await promise.then(
    () => new Error('expected a rejection'),
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(AIProviderError)
  return error as AIProviderError
}

const outcome = (error: AIProviderError) => ({ code: error.code, status: error.status, message: error.message })

const suggestBody = (fields: Record<string, unknown>) => ({
  model: 'test-model',
  messages: [
    { role: 'system', content: expect.stringContaining(JSON_INSTRUCTION) },
    { role: 'user', content: expect.stringContaining('deploy the app') },
  ],
  ...fields,
})

describe('parseSuggestionText', () => {
  it('parses a plain json object', () => {
    expect(parseSuggestionText('{"command":"ls","explanation":"lists files"}')).toEqual({
      command: 'ls',
      explanation: 'lists files',
    })
  })

  it('tolerates markdown fences and surrounding prose', () => {
    const raw = 'Sure!\n```json\n{"command":"orbit deploy","explanation":"ships it"}\n```\n'
    expect(parseSuggestionText(raw)).toEqual({ command: 'orbit deploy', explanation: 'ships it' })
  })

  it('defaults a missing explanation to an empty string', () => {
    expect(parseSuggestionText('{"command":"ls"}')).toEqual({ command: 'ls', explanation: '' })
  })

  it('rejects a response without a command', () => {
    expect(() => parseSuggestionText('{"explanation":"nope"}')).toThrow('no command')
  })

  it('takes the first balanced object and ignores prose with braces after it', () => {
    const raw = '{"command":"ls *.ts","explanation":"lists sources"}\nTip: wrap globs like {a,b}'
    expect(parseSuggestionText(raw)).toEqual({ command: 'ls *.ts', explanation: 'lists sources' })
  })

  it('skips brace groups that are not json before the answer', () => {
    const raw = 'Globs such as {a,b} expand: {"command":"ls {a,b}.txt","explanation":"two files"}'
    expect(parseSuggestionText(raw)).toEqual({ command: 'ls {a,b}.txt', explanation: 'two files' })
  })

  it('keeps braces and escaped quotes inside json strings', () => {
    const raw = '{"command":"echo \\"}{\\"","explanation":"prints braces"}'
    expect(parseSuggestionText(raw)).toEqual({ command: 'echo "}{"', explanation: 'prints braces' })
  })

  it('reports unusable answers as invalid instead of crashing', () => {
    for (const raw of ['null', 'not json at all', '{"command":42}', '{"command":"   "}', '[1,2]']) {
      let error: unknown
      try {
        parseSuggestionText(raw)
      } catch (caught) {
        error = caught
      }
      expect(error, raw).toBeInstanceOf(AIProviderError)
      expect((error as AIProviderError).code, raw).toBe('invalid')
    }
  })

  it('drops an explanation that is not a string', () => {
    expect(parseSuggestionText('{"command":"ls","explanation":42}')).toEqual({ command: 'ls', explanation: '' })
  })

  it('treats unmatched braces in the prose before the answer as text', () => {
    const answer = { command: 'ls', explanation: 'lists files' }
    expect(parseSuggestionText('Type { to open a block, then: {"command":"ls","explanation":"lists files"}')).toEqual(
      answer,
    )
    expect(parseSuggestionText('Blocks { nest { like {"command":"ls","explanation":"lists files"}')).toEqual(answer)
    expect(parseSuggestionText('Use { with {a,b} or: {"command":"ls","explanation":"lists files"} {')).toEqual(answer)
  })

  it('skips a balanced group that is not json as a whole, inner objects included', () => {
    const raw =
      '{note {"command":"rm -rf docs","explanation":"x"}} or, after a lone {, {"command":"ls","explanation":"lists files"}'
    expect(parseSuggestionText(raw)).toEqual({ command: 'ls', explanation: 'lists files' })
  })

  it('scans a 200 KB unterminated reply once instead of once per brace', () => {
    const raw = '{"a":'.repeat(40_000)
    expect(raw.length).toBe(200_000)
    const { error, elapsed, parsed } = scanned(raw)
    expect(error).toBeInstanceOf(AIProviderError)
    expect([(error as AIProviderError).code, parsed]).toEqual(['invalid', 0])
    expect(elapsed).toBeLessThan(SCAN_BUDGET_MS)
  }, SCAN_TIMEOUT_MS)

  it('finds the answer after prose whose stray brace is followed by an odd number of quotes', () => {
    const cases: Array<[string, string]> = [
      ['Use "{" then {"command":"ls","explanation":"x"}', 'ls'],
      ['<think>The user wants "ls {dir" hmm</think>\n{"command":"ls","explanation":"lists"}', 'ls'],
      ['Note {see "docs} here. {"command":"pwd","explanation":"x"}', 'pwd'],
      ['Use "{" then {"command":"echo }","explanation":"prints a brace"}', 'echo }'],
      ['Say "{" or "{" and then {"command":"ls -a","explanation":"x"}', 'ls -a'],
      ['{note "a"} Use "{" then {"command":"ls","explanation":"x"}', 'ls'],
      ['A 12" ruler { is "long. Answer:\n```json\n{"command":"du -h","explanation":"sizes"}\n```', 'du -h'],
    ]
    expect(cases.map(([raw]) => parseSuggestionText(raw).command)).toEqual(cases.map(([, command]) => command))
  })

  it('skips json objects without a command in the prose before the answer', () => {
    expect(
      parseSuggestionText('Config such as {"port": 8080} is optional. {"command":"orbit up","explanation":"starts"}'),
    ).toEqual({ command: 'orbit up', explanation: 'starts' })
    expect(parseSuggestionText('Run "echo {}" first, then: {"command":"ls","explanation":"x"}')).toEqual({
      command: 'ls',
      explanation: 'x',
    })
    expect(parseSuggestionText('{"command":"  "} or rather {"command":"pwd"}')).toEqual({
      command: 'pwd',
      explanation: '',
    })
    expect(() => parseSuggestionText('{"port": 8080}')).toThrow('model response has no command field')
  })

  it('stays fast on large replies built to defeat the scan', () => {
    const shapes = [
      '{"a":'.repeat(40_000),
      '{x}'.repeat(70_000),
      `{${'{x}'.repeat(70_000)}`,
      'Use "{" then '.repeat(16_000),
      '{ "'.repeat(70_000),
      '{"a" "}'.repeat(30_000),
      `${'{"a" "}'.repeat(30_000)}{"command":"ls"}`,
    ]
    const runs = shapes.map((raw) => ({ length: raw.length, ...scanned(raw) }))
    expect(shapes.every((raw) => raw.length >= 200_000)).toBe(true)
    expect(runs.filter((run) => run.parsed > 2 * run.length)).toEqual([])
    expect(runs.filter((run) => run.elapsed >= SCAN_BUDGET_MS)).toEqual([])
  }, SCAN_TIMEOUT_MS)
})

describe('extractStreamDeltas', () => {
  it('pulls content out of sse data lines and ignores [DONE]', () => {
    const chunk = [
      'data: {"choices":[{"delta":{"content":"the flag "}}]}',
      'data: {"choices":[{"delta":{"content":"is unknown"}}]}',
      'data: [DONE]',
      '',
    ].join('\n')
    expect(extractStreamDeltas(chunk)).toEqual(['the flag ', 'is unknown'])
  })

  it('skips malformed lines instead of throwing', () => {
    expect(extractStreamDeltas('data: {broken\ndata: {"choices":[{"delta":{"content":"ok"}}]}')).toEqual(['ok'])
  })

  it('joins a json payload spread over several data lines of one event', () => {
    const chunk = 'data: {"choices":[{"delta":\ndata: {"content":"joined"}}]}\n\n'
    expect(extractStreamDeltas(chunk)).toEqual(['joined'])
  })

  it('accepts lone CR and CRLF line endings and ignores comments', () => {
    const cr = `data: ${delta('a')}\r\rdata: ${delta('b')}\r\r`
    const crlf = `: keep-alive\r\ndata: ${delta('c')}\r\n\r\ndata:${delta('d')}\r\n\r\n`
    expect(extractStreamDeltas(cr)).toEqual(['a', 'b'])
    expect(extractStreamDeltas(crlf)).toEqual(['c', 'd'])
  })

  it('joins content parts and skips reasoning parts', () => {
    const parts = [
      { type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] },
      { type: 'text', text: 'the flag' },
      { type: 'text', text: ' is unknown' },
    ]
    expect(extractStreamDeltas(sse(delta(parts)))).toEqual(['the flag is unknown'])
  })
})

describe('createOpenAIProvider request shape', () => {
  it('posts to the preset base url with a bearer key and json_object mode', async () => {
    const { ai, calls } = provider(
      { preset: 'openrouter', model: 'openai/gpt-4.1-mini' },
      () => chatResponse('{"command":"orbit deploy","explanation":"ships"}'),
    )
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ships' })
    expect(call(calls).url).toBe(`${OPENAI_PRESETS.openrouter}/chat/completions`)
    expect(call(calls).init.method).toBe('POST')
    expect(call(calls).init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test' })
    expect(call(calls).body).toEqual({
      ...suggestBody({ max_tokens: 4096, response_format: { type: 'json_object' } }),
      model: 'openai/gpt-4.1-mini',
    })
  })

  it('sends the custom headers on top of the defaults, so they can replace the key header', async () => {
    const replies = () => chatResponse('{"command":"ls","explanation":""}')
    const added = provider({ headers: { 'x-docs-session': 's1' } }, replies)
    const replaced = provider({ headers: { authorization: 'Bearer gateway', 'content-type': 'application/json; charset=utf-8' } }, replies)
    await added.ai.suggestCommand(suggestInput)
    await replaced.ai.explainError(explainInput)
    const sent = [added.calls, replaced.calls].map((calls) => [call(calls).init.method, call(calls).init.headers])
    expect(sent).toEqual([
      ['POST', { 'content-type': 'application/json', authorization: 'Bearer sk-test', 'x-docs-session': 's1' }],
      ['POST', { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer gateway' }],
    ])
  })

  it('sends max_completion_tokens and a strict json_schema to OpenAI', async () => {
    const { ai, calls } = provider({}, () => chatResponse('{"command":"ls","explanation":""}'))
    await ai.suggestCommand(suggestInput)
    expect(call(calls).url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call(calls).body).toEqual(
      suggestBody({ max_completion_tokens: 4096, response_format: SCHEMA_FORMAT }),
    )
  })

  it('uses the per-preset token parameter and json mode', async () => {
    const expected: Record<OpenAIPreset, [string, unknown]> = {
      openai: ['max_completion_tokens', SCHEMA_FORMAT],
      openrouter: ['max_tokens', { type: 'json_object' }],
      groq: ['max_completion_tokens', { type: 'json_object' }],
      deepseek: ['max_tokens', { type: 'json_object' }],
      mistral: ['max_tokens', { type: 'json_object' }],
      together: ['max_tokens', { type: 'json_object' }],
      xai: ['max_tokens', { type: 'json_object' }],
      gemini: ['max_tokens', { type: 'json_object' }],
      ollama: ['max_tokens', { type: 'json_object' }],
      lmstudio: ['max_tokens', SCHEMA_FORMAT],
    }
    for (const preset of Object.keys(OPENAI_PRESETS) as OpenAIPreset[]) {
      const { ai, calls } = provider({ preset }, () => chatResponse('{"command":"ls","explanation":""}'))
      await ai.suggestCommand(suggestInput)
      const [tokenParam, format] = expected[preset]
      expect(call(calls).body, preset).toEqual(suggestBody({ [tokenParam]: 4096, response_format: format }))
    }
  })

  it('treats a custom base url as a generic OpenAI-compatible server', async () => {
    const { ai, calls } = provider({ baseURL: 'https://gateway.acme.dev/v1/' }, () =>
      chatResponse('{"command":"ls","explanation":""}'),
    )
    await ai.suggestCommand(suggestInput)
    expect(call(calls).url).toBe('https://gateway.acme.dev/v1/chat/completions')
    expect(call(calls).body).toEqual(suggestBody({ max_tokens: 4096, response_format: { type: 'json_object' } }))
  })

  it('lets tokenParam, jsonMode and maxTokens override the preset', async () => {
    const { ai, calls } = provider(
      { baseURL: 'https://gateway.acme.dev/v1', tokenParam: 'max_completion_tokens', jsonMode: 'off', maxTokens: 900 },
      () => chatResponse('{"command":"ls","explanation":""}'),
    )
    await ai.suggestCommand(suggestInput)
    expect(call(calls).body).toEqual(suggestBody({ max_completion_tokens: 900 }))
  })

  it('streams explanations with the same token parameter and no response format', async () => {
    const { ai, calls } = provider({}, () => streamResponse([sse(delta('boom means '), delta('a crash')), 'data: [DONE]\n\n']))
    const chunks: string[] = []
    await expect(ai.explainError(explainInput, (chunk) => chunks.push(chunk))).resolves.toBe('boom means a crash')
    expect(chunks).toEqual(['boom means ', 'a crash'])
    expect(call(calls).body).toEqual({
      model: 'test-model',
      max_completion_tokens: 4096,
      messages: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: expect.stringContaining('orbit destroy') },
      ],
      stream: true,
    })
  })

  it('falls back to a non-streaming request when streaming is disabled', async () => {
    const { ai, calls } = provider({ stream: false }, () => chatResponse('exit code 1 means the flag is unknown'))
    const chunks: string[] = []
    const full = await ai.explainError(explainInput, (chunk) => chunks.push(chunk))
    expect(full).toBe('exit code 1 means the flag is unknown')
    expect(chunks).toEqual(['exit code 1 means the flag is unknown'])
    expect(call(calls).body.stream).toBeUndefined()
  })

  it('omits the authorization header for local presets without a key', async () => {
    const { fetchImpl, calls } = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
    const ai = createOpenAIProvider({ preset: 'ollama', model: 'llama3.1', fetchImpl })
    await ai.suggestCommand(suggestInput)
    expect(call(calls).url).toBe('http://localhost:11434/v1/chat/completions')
    expect(call(calls).init.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('builds the messages from the whole input, so locale and backend description reach the model', async () => {
    const extra = { locale: 'ru' as const, backendDescription: 'Ubuntu 24.04 container with git and kubectl' }
    const suggest: SuggestInput = { ...suggestInput, ...extra }
    const explain: ExplainInput = { ...explainInput, ...extra }
    const { ai, calls } = provider(
      {},
      () => chatResponse('{"command":"ls","explanation":""}'),
      () => streamResponse([sse(delta('ok'))]),
    )
    await ai.suggestCommand(suggest)
    await ai.explainError(explain, () => undefined)
    expect(call(calls, 0).body.messages).toEqual([
      { role: 'system', content: `${buildSuggestSystem(context, 'mock')}\n\n${JSON_INSTRUCTION}` },
      { role: 'user', content: renderSuggestUser(suggest) },
    ])
    expect(call(calls, 1).body.messages).toEqual([
      { role: 'system', content: buildExplainSystem(context, 'mock') },
      { role: 'user', content: renderExplainUser(explain) },
    ])
  })

  it('uses the preset name as the provider id', () => {
    expect(createOpenAIProvider({ preset: 'groq', model: 'openai/gpt-oss-120b' }).id).toBe('groq')
  })
})

describe('createOpenAIProvider keys', () => {
  it('derives the default key name from the preset or the base url host', () => {
    expect(defaultKeyName({})).toBe('docsterm:key:openai')
    expect(defaultKeyName({ preset: 'groq' })).toBe('docsterm:key:groq')
    expect(defaultKeyName({ baseURL: 'https://gateway.acme.dev/v1' })).toBe('docsterm:key:gateway.acme.dev')
    expect(defaultKeyName({ preset: 'openai', baseURL: 'http://localhost:8080/v1' })).toBe('docsterm:key:localhost:8080')
  })

  it('never sends a key saved for OpenAI to another vendor or gateway', async () => {
    storage.set(OPENAI_KEY_NAME, 'sk-proj-readers-openai-key')
    const vendor = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
    const error = await rejection(
      createOpenAIProvider({ model: 'm', fetchImpl: vendor.fetchImpl, preset: 'deepseek' }).suggestCommand(suggestInput),
    )
    expect(error).toBeInstanceOf(ProviderKeyMissingError)
    expect(outcome(error)).toEqual({
      code: 'key-missing',
      status: undefined,
      message: 'no api key configured (docsterm:key:deepseek)',
    })
    expect(vendor.calls).toHaveLength(0)

    const gateway = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
    await createOpenAIProvider({ model: 'm', fetchImpl: gateway.fetchImpl, baseURL: 'https://gateway.acme.dev/v1' })
      .suggestCommand(suggestInput)
    expect(call(gateway.calls).init.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('needs no key for a custom endpoint and then sends no authorization header at all', async () => {
    const bodies: Array<Record<string, string>> = []
    for (const options of [
      { baseURL: 'https://docs.example/ai/v1' },
      { preset: 'openrouter' as const, baseURL: 'https://docs.example/openrouter/' },
      { baseURL: '/api/ai', headers: { 'x-docs-session': 's1' } },
    ]) {
      const { fetchImpl, calls } = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
      await expect(
        createOpenAIProvider({ model: 'm', fetchImpl, ...options }).suggestCommand(suggestInput),
      ).resolves.toEqual({ command: 'ls', explanation: '' })
      bodies.push({ url: call(calls).url, ...(call(calls).init.headers as Record<string, string>) })
    }
    expect(bodies).toEqual([
      { url: 'https://docs.example/ai/v1/chat/completions', 'content-type': 'application/json' },
      { url: 'https://docs.example/openrouter/chat/completions', 'content-type': 'application/json' },
      { url: '/api/ai/chat/completions', 'content-type': 'application/json', 'x-docs-session': 's1' },
    ])
  })

  it('still requires a key for a hosted vendor endpoint, also when its address is passed as baseURL', async () => {
    for (const options of [
      {},
      { preset: 'groq' as const },
      { baseURL: 'https://api.openai.com/v1/' },
      { preset: 'openrouter' as const, baseURL: 'https://openrouter.ai/api/v1' },
    ]) {
      const { fetchImpl, calls } = fakeFetch(() => chatResponse('{}'))
      const error = await rejection(createOpenAIProvider({ model: 'm', fetchImpl, ...options }).suggestCommand(suggestInput))
      expect(error.code, JSON.stringify(options)).toBe('key-missing')
      expect(calls).toHaveLength(0)
    }
  })

  it('reads the per-endpoint slot', async () => {
    storage.set('docsterm:key:deepseek', 'sk-deepseek')
    storage.set('docsterm:key:gateway.acme.dev', 'sk-gateway')
    for (const [options, key] of [
      [{ preset: 'deepseek' as const }, 'sk-deepseek'],
      [{ baseURL: 'https://gateway.acme.dev/v1' }, 'sk-gateway'],
    ] as const) {
      const { fetchImpl, calls } = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
      await createOpenAIProvider({ model: 'm', fetchImpl, ...options }).suggestCommand(suggestInput)
      expect((call(calls).init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`)
    }
  })

  it('no longer reads the shared 0.7 slot, which may hold another vendor key', async () => {
    storage.set(OPENAI_KEY_NAME, 'sk-or-v1-openrouter-key-saved-by-0.7')
    for (const options of [{}, { preset: 'openai' as const }]) {
      const { fetchImpl, calls } = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
      const error = await rejection(createOpenAIProvider({ model: 'gpt-5', fetchImpl, ...options }).suggestCommand(suggestInput))
      expect(outcome(error)).toEqual({
        code: 'key-missing',
        status: undefined,
        message: 'no api key configured (docsterm:key:openai)',
      })
      expect(calls).toHaveLength(0)
    }
    storage.set('docsterm:key:openai', 'sk-new')
    const { fetchImpl, calls } = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
    await createOpenAIProvider({ model: 'gpt-5', fetchImpl }).suggestCommand(suggestInput)
    expect((call(calls).init.headers as Record<string, string>).authorization).toBe('Bearer sk-new')
  })

  it('lets an explicit keyName win', async () => {
    storage.set('docsterm:key:custom', 'sk-custom')
    const { fetchImpl, calls } = fakeFetch(() => chatResponse('{"command":"ls","explanation":""}'))
    await createOpenAIProvider({
      model: 'm',
      baseURL: 'https://gateway.acme.dev/v1',
      keyName: 'docsterm:key:custom',
      fetchImpl,
    }).suggestCommand(suggestInput)
    expect((call(calls).init.headers as Record<string, string>).authorization).toBe('Bearer sk-custom')
  })

  it('throws ProviderKeyMissingError, an AIProviderError, for hosted providers without a key', async () => {
    const { fetchImpl } = fakeFetch(() => chatResponse('{}'))
    const error = await rejection(createOpenAIProvider({ model: 'gpt-4.1-mini', fetchImpl }).suggestCommand(suggestInput))
    expect(error).toBeInstanceOf(ProviderKeyMissingError)
    expect(error.code).toBe('key-missing')
  })
})

describe('createOpenAIProvider errors', () => {
  it('formats http errors as status and error.message', async () => {
    const body = {
      error: {
        message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        type: 'invalid_request_error',
        param: 'max_tokens',
      },
    }
    const { ai, calls } = provider({}, () => jsonResponse(body, 400))
    expect(outcome(await rejection(ai.suggestCommand(suggestInput)))).toEqual({
      code: 'http',
      status: 400,
      message: "400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    })
    expect(calls).toHaveLength(1)
  })

  it('formats plain-text error bodies and strips control sequences from them', async () => {
    const { ai } = provider({}, () => new Response('quota \x1b[31mexceeded\x1b[0m', { status: 429 }))
    expect(outcome(await rejection(ai.suggestCommand(suggestInput)))).toEqual({
      code: 'http',
      status: 429,
      message: '429: quota exceeded',
    })
  })

  it('keeps server error text on one line and at most 300 characters', async () => {
    const long = `first line\nsecond line ${'x'.repeat(400)}`
    const { ai } = provider({}, () => jsonResponse({ error: { message: long } }, 500))
    const error = await rejection(ai.suggestCommand(suggestInput))
    expect(error.message).toBe(`500: ${`first line second line ${'x'.repeat(400)}`.slice(0, 300)}`)
  })

  it('takes the server message from a string error, a message or a FastAPI detail string', async () => {
    const bodies: Array<[unknown, number]> = [
      [{ detail: 'Not authenticated' }, 401],
      [{ error: 'upstream quota exceeded' }, 429],
      [{ message: 'model is loading' }, 503],
      [[{ error: { message: 'Resource has been exhausted' } }], 429],
      [{ detail: [{ loc: ['body', 'model'], msg: 'field required', type: 'missing' }] }, 422],
    ]
    const messages: string[] = []
    for (const [body, status] of bodies) {
      const { ai } = provider({ stream: false }, () => jsonResponse(body, status))
      messages.push((await rejection(ai.explainError(explainInput, () => undefined))).message)
    }
    expect(messages).toEqual([
      '401: Not authenticated',
      '429: upstream quota exceeded',
      '503: model is loading',
      '429: Resource has been exhausted',
      '422: the AI service reported an error',
    ])
  })

  it('retries once without response_format when a 400 mentions it', async () => {
    const lmStudio = { error: "'response_format.type' must be 'json_schema' or 'text'" }
    const { ai, calls } = provider(
      { preset: 'deepseek' },
      () => jsonResponse(lmStudio, 400),
      () => chatResponse('Here you go: {"command":"orbit deploy","explanation":"ships it"}'),
    )
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ships it' })
    expect(calls).toHaveLength(2)
    expect(call(calls, 0).body).toEqual(suggestBody({ max_tokens: 4096, response_format: { type: 'json_object' } }))
    expect(call(calls, 1).body).toEqual(suggestBody({ max_tokens: 4096 }))
  })

  it('retries only once and only for response_format errors', async () => {
    const mention = () => jsonResponse({ error: { message: 'response_format json_schema is not supported' } }, 400)
    const twice = provider({}, mention, mention)
    expect(outcome(await rejection(twice.ai.suggestCommand(suggestInput)))).toEqual({
      code: 'http',
      status: 400,
      message: '400: response_format json_schema is not supported',
    })
    expect(twice.calls).toHaveLength(2)

    const other = provider({}, () => jsonResponse({ error: { message: 'model not found' } }, 400))
    expect(outcome(await rejection(other.ai.suggestCommand(suggestInput)))).toEqual({
      code: 'http',
      status: 400,
      message: '400: model not found',
    })
    expect(other.calls).toHaveLength(1)
  })

  it('uses the localized service error when the server sends no error message', async () => {
    const replies: Array<() => Response> = [
      () => new Response('', { status: 503, statusText: 'Service Unavailable' }),
      () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, statusText: 'Bad Gateway' }),
      () => jsonResponse({ error: { type: 'server_error' } }, 500),
    ]
    const messages: string[] = []
    for (const locale of ['en', 'ru'] as const) {
      for (const reply of replies) {
        const { ai } = provider({ stream: false }, reply)
        messages.push((await rejection(ai.explainError({ ...explainInput, locale }, () => undefined))).message)
      }
    }
    expect(messages).toEqual([
      '503: the AI service reported an error',
      '502: the AI service reported an error',
      '500: the AI service reported an error',
      '503: сервис AI сообщил об ошибке',
      '502: сервис AI сообщил об ошибке',
      '500: сервис AI сообщил об ошибке',
    ])
    const { ai } = provider({}, () => new Response('', { status: 503, statusText: 'Service Unavailable' }))
    expect(outcome(await rejection(ai.suggestCommand({ ...suggestInput, locale: 'ru' })))).toEqual({
      code: 'http',
      status: 503,
      message: '503: сервис AI сообщил об ошибке',
    })
  })

  it('reports an unreachable endpoint as a network error', async () => {
    const { ai } = provider({}, () => Promise.reject(new TypeError('Failed to fetch')))
    expect(outcome(await rejection(ai.suggestCommand(suggestInput)))).toEqual({
      code: 'network',
      status: undefined,
      message: 'Failed to fetch',
    })
  })

  it('maps refusals, cut-off answers and empty answers to their codes', async () => {
    const cases: Array<[() => Response, string]> = [
      [() => chatResponse(null, { refusal: "I can't help with that." }), 'refused'],
      [() => jsonResponse({ choices: [{ message: { content: '{"command":"orbit dep' }, finish_reason: 'length' }] }), 'truncated'],
      [() => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }), 'refused'],
      [() => chatResponse(''), 'empty'],
      [() => jsonResponse({ choices: [] }), 'empty'],
      [() => chatResponse('I would rather not say.'), 'invalid'],
    ]
    for (const [reply, code] of cases) {
      const { ai } = provider({}, reply)
      expect((await rejection(ai.suggestCommand(suggestInput))).code, code).toBe(code)
    }
  })

  it('reads array content parts in a completion', async () => {
    const parts = [
      { type: 'thinking', thinking: [{ type: 'text', text: 'the user wants a deploy' }] },
      { type: 'text', text: '{"command":"orbit deploy","explanation":"ships it"}' },
    ]
    const { ai } = provider({ preset: 'mistral' }, () => chatResponse(parts))
    await expect(ai.suggestCommand(suggestInput)).resolves.toEqual({ command: 'orbit deploy', explanation: 'ships it' })
  })
})

describe('createOpenAIProvider streaming', () => {
  const explain = async (...chunks: string[]) => {
    const { ai } = provider({}, () => streamResponse(chunks))
    const received: string[] = []
    const result = await ai.explainError(explainInput, (chunk) => received.push(chunk)).then(
      (text) => ({ text }),
      (error: unknown) => ({ error }),
    )
    return { received, result }
  }

  it('streams explanation chunks split across network reads', async () => {
    const { received, result } = await explain(
      'data: {"choices":[{"delta":{"content":"the flag "}}]}\n\ndata: {"choices":[{"delta"',
      ':{"content":"is unknown"}}]}\n\ndata: [DONE]\n\n',
    )
    expect(received).toEqual(['the flag ', 'is unknown'])
    expect(result).toEqual({ text: 'the flag is unknown' })
  })

  it('handles CRLF split between reads without dispatching early', async () => {
    const { received, result } = await explain(`data: ${delta('one ')}\r`, `\n\r\ndata: ${delta('two')}\r\n\r\n`)
    expect(received).toEqual(['one ', 'two'])
    expect(result).toEqual({ text: 'one two' })
  })

  it('decodes multi-byte characters split across reads', async () => {
    const bytes = new TextEncoder().encode(sse(delta('привет')))
    const cut = bytes.findIndex((byte) => byte >= 0x80) + 1
    const { ai } = provider({}, () => byteStreamResponse([bytes.slice(0, cut), bytes.slice(cut)]))
    const received: string[] = []
    await expect(ai.explainError(explainInput, (chunk) => received.push(chunk))).resolves.toBe('привет')
    expect(received).toEqual(['привет'])
  })

  it('throws on an error payload in the stream', async () => {
    const { result } = await explain(sse('{"error":{"message":"rate limited","code":429}}'))
    expect(outcome((result as { error: AIProviderError }).error)).toEqual({
      code: 'http',
      status: 429,
      message: 'rate limited',
    })
  })

  it('throws on an error event', async () => {
    const json = await explain('event: error\ndata: {"error":{"message":"overloaded"}}\n\n')
    expect(outcome((json.result as { error: AIProviderError }).error)).toEqual({
      code: 'http',
      status: undefined,
      message: 'overloaded',
    })
    const plain = await explain('event: error\ndata: overloaded\n\n')
    expect(outcome((plain.result as { error: AIProviderError }).error)).toEqual({
      code: 'http',
      status: undefined,
      message: 'overloaded',
    })
  })

  it('throws on a mid-stream provider error after the partial text', async () => {
    const failure = JSON.stringify({
      error: { code: 'server_error', message: 'Provider disconnected' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    })
    const { received, result } = await explain(sse(delta('The flag --fast '), failure))
    expect(received).toEqual(['The flag --fast '])
    expect(outcome((result as { error: AIProviderError }).error)).toEqual({
      code: 'http',
      status: undefined,
      message: 'Provider disconnected',
    })
  })

  it('throws a localized error when the stream fails without a message of its own', async () => {
    const { result } = await explain(sse(delta('partial'), delta('', 'error')))
    expect(outcome((result as { error: AIProviderError }).error)).toEqual({
      code: 'http',
      status: undefined,
      message: 'the AI service reported an error',
    })
    const { ai } = provider({}, () => streamResponse([sse('{"error":{"code":502}}')]))
    const error = await rejection(ai.explainError({ ...explainInput, locale: 'ru' }, () => undefined))
    expect(outcome(error)).toEqual({ code: 'http', status: 502, message: 'сервис AI сообщил об ошибке' })
  })

  it('reports an answer cut off by the token limit after streaming it', async () => {
    const { received, result } = await explain(sse(delta('The flag'), delta(' is', 'length')))
    expect(received).toEqual(['The flag', ' is'])
    expect((result as { error: AIProviderError }).error.code).toBe('truncated')
  })

  it('reports an empty stream as an empty answer', async () => {
    const { result } = await explain('data: [DONE]\n\n')
    expect((result as { error: AIProviderError }).error.code).toBe('empty')
  })

  it('parses a json body sent back to a stream request as a completion', async () => {
    const { ai } = provider({}, () => chatResponse('the flag is unknown'))
    const received: string[] = []
    await expect(ai.explainError(explainInput, (chunk) => received.push(chunk))).resolves.toBe('the flag is unknown')
    expect(received).toEqual(['the flag is unknown'])
  })

  it('reads streamed array deltas', async () => {
    const { received, result } = await explain(sse(delta([{ type: 'text', text: 'array ' }]), delta([{ type: 'text', text: 'delta' }])))
    expect(received).toEqual(['array ', 'delta'])
    expect(result).toEqual({ text: 'array delta' })
  })
})

describe('createOpenAIProvider cancellation', () => {
  it('passes the abort signal to fetch', async () => {
    const controller = new AbortController()
    const { ai, calls } = provider(
      {},
      () => chatResponse('{"command":"ls","explanation":""}'),
      () => streamResponse([sse(delta('ok'))]),
    )
    await ai.suggestCommand({ ...suggestInput, signal: controller.signal })
    await ai.explainError({ ...explainInput, signal: controller.signal }, () => undefined)
    expect(call(calls, 0).init.signal).toBe(controller.signal)
    expect(call(calls, 1).init.signal).toBe(controller.signal)
  })

  it('cancels the response body and rejects with an AbortError when aborted mid-stream', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(sse(delta('the flag '))))
      },
      cancel() {
        cancelled = true
      },
    })
    const controller = new AbortController()
    const { ai } = provider({}, () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    const received: string[] = []
    const error = await ai
      .explainError({ ...explainInput, signal: controller.signal }, (chunk) => {
        received.push(chunk)
        controller.abort()
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )
    expect(isAbortError(error)).toBe(true)
    expect(received).toEqual(['the flag '])
    expect(cancelled).toBe(true)
  })

  it('rejects with an AbortError, not an http error, when aborted while reading an error body', async () => {
    const results: unknown[] = []
    for (const status of [500, 400]) {
      const controller = new AbortController()
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"error":{"message":"rate'))
          controller.signal.addEventListener('abort', () => {
            stream.error(new DOMException('The operation was aborted.', 'AbortError'))
          })
        },
        pull() {
          controller.abort()
        },
      })
      const { ai, calls } = provider({}, () => new Response(body, { status, headers: { 'content-type': 'application/json' } }))
      const error = await ai.suggestCommand({ ...suggestInput, signal: controller.signal }).then(
        () => null,
        (reason: unknown) => reason,
      )
      results.push({ status, abort: isAbortError(error), http: error instanceof AIProviderError, calls: calls.length })
    }
    expect(results).toEqual([
      { status: 500, abort: true, http: false, calls: 1 },
      { status: 400, abort: true, http: false, calls: 1 },
    ])
  })

  it('does not send a request whose signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ai, calls } = provider({}, () => chatResponse('{"command":"ls","explanation":""}'))
    const error = await ai.suggestCommand({ ...suggestInput, signal: controller.signal }).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(isAbortError(error)).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
