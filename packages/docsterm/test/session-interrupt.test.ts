import { beforeEach, describe, expect, it } from 'vitest'
import { getMessages } from '../src/messages.js'
import { SessionController, type SessionIO } from '../src/session-controller.js'
import type { AIProvider, Backend, BackendRunResult, PageContext, RunContext } from '../src/types.js'

const messages = getMessages('en')

const pageContext: PageContext = {
  title: 'Orbit CLI docs',
  url: 'https://example.test/docs',
  description: '',
  headings: [],
}

class RecordingIO implements SessionIO {
  lines: string[] = []
  chunks: string[] = []
  prompts = 0
  clears = 0
  busy = false

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
    this.busy = busy
  }
}

class SlowBackend implements Backend {
  readonly id = 'slow'
  readonly prompt = '$ '
  context: RunContext | null = null
  private finish: ((result: BackendRunResult) => void) | null = null

  async init(): Promise<void> {}

  run(_command: string, context?: RunContext): Promise<BackendRunResult> {
    this.context = context ?? null
    return new Promise((resolve) => {
      this.finish = resolve
    })
  }

  settle(result: BackendRunResult): void {
    this.finish?.(result)
  }

  dispose(): void {}
}

let io: RecordingIO
let backend: SlowBackend
let controller: SessionController

beforeEach(() => {
  io = new RecordingIO()
  backend = new SlowBackend()
  controller = new SessionController({ backend, messages, io, pageContext })
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('interrupting a running command', () => {
  it('returns to a prompt immediately instead of waiting for the command', async () => {
    void controller.submit('build')
    await flush()
    expect(controller.busy).toBe(true)

    controller.interrupt()

    expect(controller.busy).toBe(false)
    expect(io.lines).toContain(messages.interrupted)
    expect(io.prompts).toBe(1)
  })

  it('aborts the signal the command was given', async () => {
    void controller.submit('build')
    await flush()
    expect(backend.context?.signal.aborted).toBe(false)

    controller.interrupt()

    expect(backend.context?.signal.aborted).toBe(true)
  })

  it('discards output the abandoned command writes afterwards', async () => {
    void controller.submit('build')
    await flush()
    backend.context?.write('step 1\n')
    controller.interrupt()
    backend.context?.write('step 2\n')

    expect(io.chunks).toEqual(['step 1\n'])
  })

  it('ignores the abandoned result: no second prompt, no error hint', async () => {
    void controller.submit('build')
    await flush()
    controller.interrupt()
    backend.settle({ output: 'build complete', exitCode: 1 })
    await flush()

    expect(io.prompts).toBe(1)
    expect(io.lines).not.toContain('build complete')
    expect(io.lines).not.toContain(messages.errorHint)
  })

  it('accepts the next command right after an interrupt', async () => {
    void controller.submit('build')
    await flush()
    controller.interrupt()
    backend.settle({ output: 'too late', exitCode: 0 })

    void controller.submit('echo hi')
    await flush()
    backend.settle({ output: 'hi', exitCode: 0 })
    await flush()

    expect(io.lines).toContain('hi')
    expect(io.lines).not.toContain('too late')
    expect(io.prompts).toBe(2)
  })

  it('does nothing when nothing is running', () => {
    controller.interrupt()

    expect(io.lines).toEqual([])
    expect(io.prompts).toBe(0)
  })
})

describe('interrupting a streaming AI answer', () => {
  it('stops printing chunks once the user cancels', async () => {
    let emit: (chunk: string) => void = () => {}
    let release: () => void = () => {}
    const ai: AIProvider = {
      id: 'fake-ai',
      async suggestCommand() {
        return { command: 'ls', explanation: '' }
      },
      async explainError(_input, onChunk) {
        emit = onChunk ?? (() => {})
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return 'full answer'
      },
    }
    const session = new SessionController({ backend, ai, messages, io, pageContext })

    void session.submit('boom')
    await flush()
    backend.settle({ output: 'boom: not found', exitCode: 127 })
    await flush()

    void session.submit('explain')
    await flush()
    emit('half an ')
    session.interrupt()
    emit('answer')
    release()
    await flush()

    expect(io.chunks).toEqual(['half an '])
    expect(io.lines).not.toContain('full answer')
    expect(session.busy).toBe(false)
  })
})
