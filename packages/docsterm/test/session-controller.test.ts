import { beforeEach, describe, expect, it } from 'vitest'
import { getMessages, type Messages } from '../src/messages'
import { SessionController, type SessionIO } from '../src/session-controller'
import type {
  AIProvider,
  Backend,
  BackendRunResult,
  CommandSuggestion,
  ExplainInput,
  PageContext,
  SuggestInput,
} from '../src/types'

const messages: Messages = getMessages('en')

const pageContext: PageContext = {
  title: 'Orbit CLI docs',
  url: 'https://example.test/docs',
  description: 'Deploy apps with orbit',
  headings: ['Install', 'Deploy'],
}

class FakeIO implements SessionIO {
  lines: string[] = []
  chunks: string[] = []
  prompts = 0
  clears = 0
  busySeq: boolean[] = []

  write(text: string): void {
    this.chunks.push(text)
  }
  print(line: string): void {
    this.lines.push(line)
  }
  printPrompt(): void {
    this.prompts += 1
  }
  clearScreen(): void {
    this.clears += 1
  }
  setBusy(busy: boolean): void {
    this.busySeq.push(busy)
  }
}

class FakeBackend implements Backend {
  readonly id = 'fake'
  readonly prompt = '$ '
  commands: string[] = []
  result: BackendRunResult = { output: 'ok', exitCode: 0 }
  pending: Array<(result: BackendRunResult) => void> = []
  manual = false

  async init(): Promise<void> {}

  run(command: string): Promise<BackendRunResult> {
    this.commands.push(command)
    if (!this.manual) return Promise.resolve(this.result)
    return new Promise((resolve) => this.pending.push(resolve))
  }

  dispose(): void {}
}

class FakeAI implements AIProvider {
  readonly id = 'fake-ai'
  suggestion: CommandSuggestion = { command: 'orbit deploy', explanation: 'deploys the app' }
  explanation = 'the flag is unknown'
  failWith: Error | null = null
  suggestCalls: SuggestInput[] = []
  explainCalls: ExplainInput[] = []
  streamChunks = true

  async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
    this.suggestCalls.push(input)
    if (this.failWith) throw this.failWith
    return this.suggestion
  }

  async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
    this.explainCalls.push(input)
    if (this.failWith) throw this.failWith
    if (onChunk && this.streamChunks) {
      onChunk('the flag ')
      onChunk('is unknown')
    }
    return this.explanation
  }
}

let io: FakeIO
let backend: FakeBackend
let ai: FakeAI

const controller = (withAi = true) =>
  new SessionController({ backend, ai: withAi ? ai : undefined, messages, io, pageContext })

beforeEach(() => {
  io = new FakeIO()
  backend = new FakeBackend()
  ai = new FakeAI()
})

describe('SessionController basic commands', () => {
  it('prints a fresh prompt on empty input', async () => {
    await controller().submit('   ')
    expect(io.prompts).toBe(1)
    expect(backend.commands).toEqual([])
  })

  it('runs a command and prints its output', async () => {
    await controller().submit('orbit status')
    expect(backend.commands).toEqual(['orbit status'])
    expect(io.lines).toEqual(['ok'])
    expect(io.prompts).toBe(1)
    expect(io.busySeq).toEqual([true, false])
  })

  it('skips printing empty output', async () => {
    backend.result = { output: '', exitCode: 0 }
    await controller().submit('quiet')
    expect(io.lines).toEqual([])
  })

  it('prints the explain hint on failure when ai is available', async () => {
    backend.result = { output: 'boom', exitCode: 2 }
    await controller().submit('orbit destroy')
    expect(io.lines).toEqual(['boom', messages.errorHint])
  })

  it('stays silent about explain when ai is missing', async () => {
    backend.result = { output: 'boom', exitCode: 2 }
    await controller(false).submit('orbit destroy')
    expect(io.lines).toEqual(['boom'])
  })

  it('reports backend exceptions without throwing', async () => {
    backend.run = () => Promise.reject(new Error('pyodide crashed'))
    await controller().submit('anything')
    expect(io.lines[0]).toBe(`${messages.backendError}: pyodide crashed`)
    expect(io.prompts).toBe(1)
  })

  it('handles clear and help builtins', async () => {
    const session = controller()
    await session.submit('clear')
    expect(io.clears).toBe(1)
    await session.submit('help')
    expect(io.lines).toEqual([messages.helpText])
    expect(io.prompts).toBe(2)
  })

  it('ignores input while busy', async () => {
    backend.manual = true
    const session = controller()
    const first = session.submit('slow')
    await session.submit('second')
    expect(backend.commands).toEqual(['slow'])
    backend.pending[0]?.({ output: 'done', exitCode: 0 })
    await first
    expect(io.lines).toEqual(['done'])
  })
})

describe('SessionController AI suggestion flow', () => {
  it('suggests a command and runs it after y', async () => {
    const session = controller()
    await session.submit('#deploy my app')
    expect(io.lines).toContain(messages.aiThinking)
    expect(io.lines).toContain(`${messages.suggestionLabel}: orbit deploy`)
    expect(io.chunks).toContain(messages.confirmRun)
    expect(session.isConfirming).toBe(true)
    await session.submit('y')
    expect(backend.commands).toEqual(['orbit deploy'])
    expect(session.isConfirming).toBe(false)
  })

  it('cancels the suggestion on anything but y', async () => {
    const session = controller()
    await session.submit('#deploy my app')
    await session.submit('n')
    expect(backend.commands).toEqual([])
    expect(io.lines).toContain(messages.cancelled)
  })

  it('passes request, backend id and page context to the provider', async () => {
    await controller().submit('#deploy my app')
    const call = ai.suggestCalls[0]
    expect(call?.request).toBe('deploy my app')
    expect(call?.backendId).toBe('fake')
    expect(call?.context.title).toBe('Orbit CLI docs')
  })

  it('reports missing ai for # requests', async () => {
    await controller(false).submit('#deploy')
    expect(io.lines).toEqual([messages.aiNotConfigured])
    expect(io.prompts).toBe(1)
  })

  it('prints a help hint for a bare #', async () => {
    await controller().submit('#')
    expect(io.lines).toEqual([messages.helpText])
  })

  it('prints aiError when the provider throws', async () => {
    ai.failWith = new Error('401 unauthorized')
    await controller().submit('#deploy')
    expect(io.lines.at(-1)).toBe(`${messages.aiError}: 401 unauthorized`)
    expect(io.prompts).toBe(1)
  })
})

describe('SessionController explain flow', () => {
  it('streams the explanation for the last failed command', async () => {
    backend.result = { output: 'boom', exitCode: 3 }
    const session = controller()
    await session.submit('orbit destroy')
    await session.submit('explain')
    expect(io.lines).toContain(`${messages.explainHeader}:`)
    expect(io.chunks.join('')).toContain('the flag is unknown')
    const call = ai.explainCalls[0]
    expect(call?.command).toBe('orbit destroy')
    expect(call?.output).toBe('boom')
    expect(call?.exitCode).toBe(3)
  })

  it('prints the full text when the provider does not stream', async () => {
    ai.streamChunks = false
    backend.result = { output: 'boom', exitCode: 1 }
    const session = controller()
    await session.submit('fail')
    await session.submit('explain')
    expect(io.lines).toContain(ai.explanation)
  })

  it('says there is nothing to explain without a failure', async () => {
    await controller().submit('explain')
    expect(io.lines).toEqual([messages.nothingToExplain])
  })

  it('sends at most the last five history entries to ai', async () => {
    backend.result = { output: 'x', exitCode: 0 }
    const session = controller()
    for (let i = 0; i < 7; i += 1) await session.submit(`cmd${i}`)
    backend.result = { output: 'bad', exitCode: 1 }
    await session.submit('failing')
    await session.submit('explain')
    expect(ai.explainCalls[0]?.history).toHaveLength(5)
  })
})
