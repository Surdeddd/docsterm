import { describe, expect, it, vi } from 'vitest'
import {
  createOpenAIProvider,
  extractStreamDeltas,
  OPENAI_PRESETS,
  parseSuggestionText,
  ProviderKeyMissingError,
} from '../src/openai/index.js'
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

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const chatResponse = (content: string) =>
  jsonResponse({ choices: [{ message: { content } }] })

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

describe('parseSuggestionText', () => {
  it('parses a plain json object', () => {
    expect(parseSuggestionText('{"command":"ls","explanation":"lists files"}')).toEqual({
      command: 'ls',
      explanation: 'lists files',
    })
  })

  it('tolerates markdown fences and surrounding prose', () => {
    const raw = 'Sure!\n```json\n{"command":"orbit deploy","explanation":"ships it"}\n```\n'
    expect(parseSuggestionText(raw).command).toBe('orbit deploy')
  })

  it('defaults a missing explanation to an empty string', () => {
    expect(parseSuggestionText('{"command":"ls"}').explanation).toBe('')
  })

  it('rejects a response without a command', () => {
    expect(() => parseSuggestionText('{"explanation":"nope"}')).toThrow('no command')
  })
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
    expect(extractStreamDeltas('data: {broken\ndata: {"choices":[{"delta":{"content":"ok"}}]}')).toEqual([
      'ok',
    ])
  })
})

describe('createOpenAIProvider', () => {
  it('posts to the preset base url with a bearer key', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"command":"orbit deploy","explanation":"ships"}'))
    const ai = createOpenAIProvider({
      preset: 'openrouter',
      model: 'openai/gpt-4.1-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const suggestion = await ai.suggestCommand(suggestInput)
    expect(suggestion.command).toBe('orbit deploy')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${OPENAI_PRESETS.openrouter}/chat/completions`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.model).toBe('openai/gpt-4.1-mini')
    expect(JSON.stringify(body.messages)).toContain('Orbit docs')
    expect(JSON.stringify(body.response_format)).toContain('json_object')
  })

  it('sends a json_schema response format when asked', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"command":"ls","explanation":""}'))
    const ai = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test',
      jsonMode: 'schema',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await ai.suggestCommand(suggestInput)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.stringify(JSON.parse(init.body as string))).toContain('json_schema')
  })

  it('omits the authorization header for local presets without a key', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('{"command":"ls","explanation":""}'))
    const ai = createOpenAIProvider({
      preset: 'ollama',
      model: 'llama3.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await ai.suggestCommand(suggestInput)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('localhost:11434')
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('throws ProviderKeyMissingError for hosted providers without a key', async () => {
    const ai = createOpenAIProvider({ model: 'gpt-4.1-mini', fetchImpl: (async () => chatResponse('{}')) as unknown as typeof fetch })
    await expect(ai.suggestCommand(suggestInput)).rejects.toBeInstanceOf(ProviderKeyMissingError)
  })

  it('surfaces http errors with status and body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('quota exceeded', { status: 429, statusText: 'Too Many Requests' }),
    )
    const ai = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(ai.suggestCommand(suggestInput)).rejects.toThrow(/429/)
  })

  it('streams explanation chunks split across network reads', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"the flag "}}]}\ndata: {"choices":[{"delta"',
        ':{"content":"is unknown"}}]}\ndata: [DONE]\n',
      ]),
    )
    const ai = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const chunks: string[] = []
    const full = await ai.explainError(explainInput, (chunk) => chunks.push(chunk))
    expect(chunks).toEqual(['the flag ', 'is unknown'])
    expect(full).toBe('the flag is unknown')
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).stream).toBe(true)
  })

  it('falls back to a non-streaming request when streaming is disabled', async () => {
    const fetchImpl = vi.fn(async () => chatResponse('exit code 1 means the flag is unknown'))
    const ai = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const chunks: string[] = []
    const full = await ai.explainError(explainInput, (chunk) => chunks.push(chunk))
    expect(full).toContain('flag is unknown')
    expect(chunks).toHaveLength(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).stream).toBeUndefined()
  })

  it('uses the preset name as the provider id', () => {
    expect(createOpenAIProvider({ preset: 'groq', model: 'llama-3.3-70b' }).id).toBe('groq')
  })
})
