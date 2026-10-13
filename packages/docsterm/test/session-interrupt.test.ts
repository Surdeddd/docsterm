import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMessages } from '../src/messages.js'
import { SessionController, type SessionIO } from '../src/session-controller.js'
import type {
  AIProvider,
  Backend,
  BackendRunResult,
  CommandSuggestion,
  ExplainInput,
  InteractiveRun,
  PageContext,
  RunContext,
  RunOutcome,
  SuggestInput,
} from '../src/types.js'

const messages = getMessages('en')

const pageContext: PageContext = {
  title: 'Orbit CLI docs',
  url: 'https://example.test/docs',
  description: '',
  headings: [],
}

class RecordingIO implements SessionIO {
  text = ''
  lines: string[] = []
  chunks: string[] = []
  prompts = 0
  calls = 0
  busy = false
  promptOf: () => string = () => '$ '

  write(text: string): void {
    this.calls += 1
    this.chunks.push(text)
    this.text += text
  }
  print(line: string): void {
    this.calls += 1
    this.lines.push(line)
    this.text += `${line}\n`
  }
  printPrompt(): void {
    this.calls += 1
    this.prompts += 1
    this.text += this.promptOf()
  }
  clearScreen(): void {
    this.calls += 1
    this.text = ''
  }
  setBusy(busy: boolean): void {
    this.calls += 1
    this.busy = busy
  }
}

class SlowBackend implements Backend {
  readonly id = 'slow'
  readonly prompt = '$ '
  context: RunContext | null = null
  commands: string[] = []
  isComplete?: (source: string) => boolean | Promise<boolean>
  private finish: ((result: RunOutcome) => void) | null = null
  private fail: ((error: unknown) => void) | null = null

  async init(): Promise<void> {}

  run(command: string, context?: RunContext): Promise<RunOutcome> {
    this.commands.push(command)
    this.context = context ?? null
    return new Promise((resolve, reject) => {
      this.finish = resolve
      this.fail = reject
    })
  }

  settle(result: RunOutcome): void {
    this.finish?.(result)
  }

  reject(error: unknown): void {
    this.fail?.(error)
  }

  dispose(): void {}
}

class FakeProgram implements InteractiveRun {
  keys: string[] = []
  sizes: Array<[number, number]> = []
  cancelled = 0
  done: Promise<BackendRunResult>
  onCancel: () => void = () => {}
  private finish: (result: BackendRunResult) => void = () => {}

  constructor() {
    this.done = new Promise((resolve) => {
      this.finish = resolve
    })
  }

  onKey(data: string): void {
    this.keys.push(data)
  }

  resize(columns: number, rows: number): void {
    this.sizes.push([columns, rows])
  }

  cancel(): void {
    this.cancelled += 1
    this.onCancel()
  }

  exit(result: BackendRunResult): void {
    this.finish(result)
  }
}

class ThrowingProgram implements InteractiveRun {
  readonly done = new Promise<BackendRunResult>(() => {})
  calls: string[] = []

  onKey(data: string): void {
    this.calls.push(`key:${data}`)
    throw new Error('onKey exploded')
  }

  resize(): void {
    this.calls.push('resize')
    throw new Error('resize exploded')
  }

  cancel(): void {
    this.calls.push('cancel')
    throw new Error('cancel exploded')
  }
}

class RejectingProgram implements InteractiveRun {
  readonly done = new Promise<BackendRunResult>(() => {})
  cancels = 0

  async onKey(): Promise<void> {
    throw new Error('onKey rejected')
  }

  async cancel(): Promise<void> {
    this.cancels += 1
    throw new Error('cancel rejected')
  }
}

class BandIO extends RecordingIO {
  band: string[] = []

  writeOutOfBand(text: string): void {
    this.calls += 1
    this.band.push(text)
    this.text += text
  }
}

let io: RecordingIO
let backend: SlowBackend
let controller: SessionController

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const startProgram = async (program: InteractiveRun) => {
  const pending = controller.submit('watch')
  await flush()
  backend.settle(program)
  await flush()
  return pending
}

const withBand = (): BandIO => {
  const band = new BandIO()
  io = band
  controller = new SessionController({ backend, messages, io: band, pageContext })
  band.promptOf = () => controller.promptText
  return band
}

const leaveOnCancel = (program: FakeProgram): FakeProgram => {
  program.onCancel = () => backend.context?.write('\x1b[?1049l')
  return program
}

const unhandledDuring = async (action: () => Promise<void>): Promise<unknown[]> => {
  const reasons: unknown[] = []
  const record = (reason: unknown) => reasons.push(reason)
  process.on('unhandledRejection', record)
  try {
    await action()
    await flush()
    await flush()
  } finally {
    process.off('unhandledRejection', record)
  }
  return reasons
}

const ctrlC = (session: SessionController) => {
  if (!session.busy && !session.isInteractive) io.text += '^C\n'
  session.interrupt()
}

const withAI = (ai: AIProvider) => {
  const session = new SessionController({ backend, ai, messages, io, pageContext })
  io.promptOf = () => session.promptText
  return session
}

const hangingExplainer = (signals: AbortSignal[]): AIProvider => ({
  id: 'fake-ai',
  async suggestCommand() {
    return { command: 'ls', explanation: '' }
  },
  explainError(input: ExplainInput): Promise<string> {
    if (input.signal) signals.push(input.signal)
    return new Promise(() => {})
  },
})

const failOnce = async (session: SessionController) => {
  void session.submit('boom')
  await flush()
  backend.settle({ output: 'boom: not found', exitCode: 127 })
  await flush()
  io.text = ''
}

beforeEach(() => {
  io = new RecordingIO()
  backend = new SlowBackend()
  controller = new SessionController({ backend, messages, io, pageContext })
  io.promptOf = () => controller.promptText
})

afterEach(() => {
  vi.useRealTimers()
})

describe('interrupting a running command', () => {
  it('returns to a prompt immediately instead of waiting for the command', async () => {
    void controller.submit('build')
    await flush()
    expect(controller.busy).toBe(true)

    controller.interrupt()

    expect(controller.busy).toBe(false)
    expect(io.text).toBe('^C\n$ ')
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
    expect(io.text).toBe('step 1\n^C\n$ ')
  })

  it('puts ^C after a partial line like a real terminal', async () => {
    void controller.submit('build')
    await flush()
    backend.context?.write('step 1')
    controller.interrupt()

    expect(io.text).toBe('step 1^C\n$ ')
  })

  it('erases a progress line before ^C instead of leaving its tail on screen', async () => {
    void controller.submit('build')
    await flush()
    backend.context?.write('[2/5] bundling...\r')
    controller.interrupt()

    expect(io.text).toBe('[2/5] bundling...\r\x1b[K^C\n$ ')
  })

  it('ignores the abandoned result: no second prompt, no error hint', async () => {
    void controller.submit('build')
    await flush()
    controller.interrupt()
    backend.settle({ output: 'build complete', exitCode: 1 })
    await flush()

    expect(io.prompts).toBe(1)
    expect(io.text).toBe('^C\n$ ')
  })

  it('ignores a late rejection of the abandoned command', async () => {
    void controller.submit('build')
    await flush()
    controller.interrupt()
    backend.reject(new DOMException('aborted', 'AbortError'))
    await flush()

    expect(io.text).toBe('^C\n$ ')
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

    expect(backend.commands).toEqual(['build', 'echo hi'])
    expect(io.text).toBe('^C\n$ hi\n$ ')
  })

  it('drops a pending continuation when interrupted during an asynchronous check', async () => {
    let answer: (complete: boolean) => void = () => {}
    backend.isComplete = (source) =>
      source === 'if x:'
        ? false
        : new Promise((resolve) => {
            answer = resolve
          })
    await controller.submit('if x:')
    void controller.submit('  pass')
    await flush()
    expect(controller.busy).toBe(true)

    controller.interrupt()
    answer(true)
    await flush()

    expect(controller.isContinuing).toBe(false)
    expect(controller.promptText).toBe('$ ')
    expect(backend.commands).toEqual([])
  })
})

describe('interrupting while idle, confirming or continuing', () => {
  it('prints only a fresh prompt after the ^C the widget printed', () => {
    ctrlC(controller)

    expect(io.text).toBe('^C\n$ ')
    expect(io.lines).toEqual([])
  })

  it('cancels a pending suggestion and lets the next command run', async () => {
    const ai: AIProvider = {
      id: 'fake-ai',
      async suggestCommand() {
        return { command: 'orbit deploy', explanation: '' }
      },
      async explainError() {
        return ''
      },
    }
    const session = withAI(ai)
    await session.submit('#deploy the app')
    expect(session.isConfirming).toBe(true)
    io.text = io.promptOf()

    ctrlC(session)

    expect(session.isConfirming).toBe(false)
    expect(io.text).toBe(`${messages.confirmRun}^C\n${messages.cancelled}\n$ `)
    void session.submit('ls')
    await flush()
    expect(backend.commands).toEqual(['ls'])
  })

  it('drops the lines collected for a continuation', async () => {
    backend.isComplete = (source) => !source.endsWith(':')
    await controller.submit('def f():')
    expect(controller.isContinuing).toBe(true)
    io.text = ''

    ctrlC(controller)

    expect(controller.isContinuing).toBe(false)
    expect(io.text).toBe('^C\n$ ')
    void controller.submit('print(1)')
    await flush()
    expect(backend.commands).toEqual(['print(1)'])
  })
})

describe('interactive programs', () => {
  it('forwards Ctrl+C to the program and keeps it running', async () => {
    const program = new FakeProgram()
    void startProgram(program)
    await flush()
    expect(controller.isInteractive).toBe(true)

    controller.interrupt()

    expect(program.keys).toEqual(['\x03'])
    expect(controller.isInteractive).toBe(true)
    expect(io.prompts).toBe(0)
  })

  it('abandons a program that ignores Ctrl+C on a second Ctrl+C within a second', async () => {
    const program = new FakeProgram()
    void startProgram(program)
    await flush()

    controller.interrupt()
    controller.interrupt()

    expect(program.keys).toEqual(['\x03'])
    expect(program.cancelled).toBe(1)
    expect(backend.context?.signal.aborted).toBe(true)
    expect(controller.isInteractive).toBe(false)
    expect(controller.busy).toBe(false)
    expect(io.text).toBe('^C\n$ ')

    program.exit({ output: 'late', exitCode: 0 })
    await flush()
    expect(io.text).toBe('^C\n$ ')
  })

  it('lets the program clean up the screen before it is abandoned', async () => {
    const program = new FakeProgram()
    program.onCancel = () => backend.context?.write('\x1b[?1049l')
    void startProgram(program)
    await flush()

    controller.interrupt()
    controller.interrupt()

    expect(io.text).toBe('\x1b[?1049l^C\n$ ')
  })

  it('forwards Ctrl+C again when the second press comes later than a second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const program = new FakeProgram()
    void startProgram(program)
    await flush()

    controller.interrupt()
    vi.setSystemTime(Date.now() + 1500)
    controller.interrupt()

    expect(program.keys).toEqual(['\x03', '\x03'])
    expect(controller.isInteractive).toBe(true)
  })

  it('treats a Ctrl+C key routed to the program like an interrupt', async () => {
    const program = new FakeProgram()
    void startProgram(program)
    await flush()

    controller.handleInteractiveKey('q')
    controller.handleInteractiveKey('\x03')
    controller.handleInteractiveKey('\x03')

    expect(program.keys).toEqual(['q', '\x03'])
    expect(program.cancelled).toBe(1)
    expect(controller.isInteractive).toBe(false)
  })

  it('forwards terminal resizes to the program', async () => {
    const program = new FakeProgram()
    void startProgram(program)
    await flush()

    controller.resize(120, 40)

    expect(program.sizes).toEqual([[120, 40]])
  })

  it('never installs a program that arrives after Ctrl+C', async () => {
    const program = new FakeProgram()
    void controller.submit('pager')
    await flush()
    controller.interrupt()

    backend.settle(program)
    await flush()

    expect(controller.isInteractive).toBe(false)
    expect(program.cancelled).toBe(1)
    void controller.submit('ls')
    await flush()
    expect(backend.commands).toEqual(['pager', 'ls'])
  })

  it('sends Ctrl+C to a late program that cannot be cancelled', async () => {
    const program = new FakeProgram()
    const late: InteractiveRun = { onKey: (data) => program.onKey(data), done: program.done }
    void controller.submit('pager')
    await flush()
    controller.interrupt()

    backend.settle(late)
    await flush()

    expect(controller.isInteractive).toBe(false)
    expect(program.keys).toEqual(['\x03'])
  })

  it('reports a program that fails', async () => {
    let fail: (error: unknown) => void = () => {}
    const broken: InteractiveRun = {
      onKey: () => {},
      done: new Promise((_resolve, reject) => {
        fail = reject
      }),
    }
    const pending = controller.submit('pager')
    await flush()
    backend.settle(broken)
    await flush()
    fail(new Error('pager crashed'))
    await pending

    expect(controller.isInteractive).toBe(false)
    expect(io.text).toBe(`${messages.backendError}: pager crashed\n$ `)
  })
})

describe('the line a program leaves open', () => {
  const explainer: AIProvider = {
    id: 'fake-ai',
    async suggestCommand() {
      return { command: 'ls', explanation: '' }
    },
    async explainError() {
      return ''
    },
  }

  it('ends the partial line of a program before the error hint', async () => {
    const session = withAI(explainer)
    const program = new FakeProgram()
    const pending = session.submit('sudo ls')
    await flush()
    backend.context?.write('Password: ')
    backend.settle(program)
    await flush()
    program.exit({ output: '', exitCode: 130 })
    await pending
    expect(io.text).toBe(`Password: \n${messages.errorHint}\n$ `)
  })

  it('ends the partial line of a program before the error of a rejected run', async () => {
    let fail: (error: unknown) => void = () => {}
    const broken: InteractiveRun = {
      onKey: () => {},
      done: new Promise((_resolve, reject) => {
        fail = reject
      }),
    }
    const pending = controller.submit('sudo ls')
    await flush()
    backend.context?.write('Password: ')
    backend.settle(broken)
    await flush()
    fail(new Error('sudo crashed'))
    await pending
    expect(io.text).toBe(`Password: \n${messages.backendError}: sudo crashed\n$ `)
  })

  it('does not count the alternate screen of a program as an open line', async () => {
    const session = withAI(explainer)
    const program = new FakeProgram()
    const pending = session.submit('less notes')
    await flush()
    backend.context?.write('notes\n\x1b[?1049h\x1b[Hpage one\r\n:')
    backend.settle(program)
    await flush()
    backend.context?.write('\x1b[?1049l')
    program.exit({ output: '', exitCode: 1 })
    await pending
    expect(io.text).toBe(`notes\n\x1b[?1049h\x1b[Hpage one\r\n:\x1b[?1049l${messages.errorHint}\n$ `)
  })
})

describe('the program hook for typeahead', () => {
  class HookedIO extends RecordingIO {
    started = 0

    onInteractive(): void {
      this.started += 1
    }
  }

  it('tells the widget once a program starts reading keys, and never for a discarded one', async () => {
    const hooked = new HookedIO()
    io = hooked
    controller = new SessionController({ backend, messages, io: hooked, pageContext })
    const pending = controller.submit('pager')
    await flush()
    expect(hooked.started).toBe(0)
    const program = new FakeProgram()
    backend.settle(program)
    await flush()
    expect([hooked.started, controller.isInteractive]).toEqual([1, true])
    program.exit({ output: '', exitCode: 0 })
    await pending
    void controller.submit('pager')
    await flush()
    controller.interrupt()
    backend.settle(new FakeProgram())
    await flush()
    expect(hooked.started).toBe(1)
  })
})

describe('programs that throw', () => {
  it('keeps keys and the first Ctrl+C from throwing into the widget', async () => {
    const program = new ThrowingProgram()
    void startProgram(program)
    await flush()

    expect(() => controller.handleInteractiveKey('q')).not.toThrow()
    expect(() => controller.interrupt()).not.toThrow()

    expect(program.calls).toEqual(['key:q', 'key:\x03'])
    expect(controller.isInteractive).toBe(true)
    expect(io.text).toBe('')
  })

  it('abandons the program on a second Ctrl+C even when cancel() throws', async () => {
    const program = new ThrowingProgram()
    void startProgram(program)
    await flush()

    controller.interrupt()
    expect(() => controller.handleInteractiveKey('\x03')).not.toThrow()

    expect(program.calls).toEqual(['key:\x03', 'cancel'])
    expect(controller.isInteractive).toBe(false)
    expect(controller.busy).toBe(false)
    expect(backend.context?.signal.aborted).toBe(true)
    expect(io.text).toBe('^C\n$ ')
  })

  it('disposes cleanly when cancel() throws', async () => {
    const program = new ThrowingProgram()
    void startProgram(program)
    await flush()
    const calls = io.calls

    expect(() => controller.dispose()).not.toThrow()

    expect(program.calls).toEqual(['cancel'])
    expect(controller.isInteractive).toBe(false)
    expect(controller.busy).toBe(false)
    expect(backend.context?.signal.aborted).toBe(true)
    expect(io.calls).toBe(calls)
  })

  it('discards a late program whose cancel() throws and accepts the next command', async () => {
    const program = new ThrowingProgram()
    const pending = controller.submit('pager')
    await flush()
    controller.interrupt()
    backend.settle(program)

    await expect(pending).resolves.toBeUndefined()
    expect(program.calls).toEqual(['cancel'])
    expect(controller.isInteractive).toBe(false)
    expect(io.text).toBe('^C\n$ ')
    void controller.submit('ls')
    await flush()
    expect(backend.commands).toEqual(['pager', 'ls'])
  })

  it('keeps a resize from throwing into the widget', async () => {
    const program = new ThrowingProgram()
    void startProgram(program)
    await flush()

    expect(() => controller.resize(100, 30)).not.toThrow()
    expect(program.calls).toEqual(['resize'])
  })

  it.each<[string, (program: RejectingProgram) => Promise<void>]>([
    [
      'a second Ctrl+C',
      async (program) => {
        void startProgram(program)
        await flush()
        controller.handleInteractiveKey('q')
        controller.interrupt()
        controller.interrupt()
      },
    ],
    [
      'dispose',
      async (program) => {
        void startProgram(program)
        await flush()
        controller.dispose()
      },
    ],
    [
      'a program that arrives after Ctrl+C',
      async (program) => {
        void controller.submit('pager')
        await flush()
        controller.interrupt()
        backend.settle(program)
        await flush()
      },
    ],
  ])('leaves no rejection of onKey() or cancel() unhandled on %s', async (_label, abandon) => {
    const program = new RejectingProgram()

    const reasons = await unhandledDuring(() => abandon(program))

    expect(program.cancels).toBe(1)
    expect(reasons).toEqual([])
    expect(controller.isInteractive).toBe(false)
  })
})

describe('cleanup output of abandoned programs', () => {
  it('writes the cleanup of a program that arrives after Ctrl+C out of band, after the prompt', async () => {
    const band = withBand()
    const program = leaveOnCancel(new FakeProgram())
    void controller.submit('pager')
    await flush()
    backend.context?.write('\x1b[?1049h')
    controller.interrupt()

    backend.settle(program)
    await flush()

    expect(program.cancelled).toBe(1)
    expect(band.chunks).toEqual(['\x1b[?1049h'])
    expect(band.band).toEqual(['\x1b[?1049l'])
    expect(band.text).toBe('\x1b[?1049h^C\n$ \x1b[?1049l')
  })

  it('writes the cleanup of a program abandoned by a second Ctrl+C out of band, before ^C', async () => {
    const band = withBand()
    const program = leaveOnCancel(new FakeProgram())
    void startProgram(program)
    await flush()

    controller.interrupt()
    controller.interrupt()

    expect(band.band).toEqual(['\x1b[?1049l'])
    expect(band.chunks).toEqual([])
    expect(band.text).toBe('\x1b[?1049l^C\n$ ')
  })

  it('puts ^C on its own line after cleanup text that leaves the line open', async () => {
    const band = withBand()
    const program = new FakeProgram()
    program.onCancel = () => backend.context?.write('bye')
    void startProgram(program)
    await flush()

    controller.interrupt()
    controller.interrupt()

    expect(band.band).toEqual(['bye'])
    expect(band.text).toBe('bye\n^C\n$ ')
  })

  it('routes only what cancel() writes, not what the abandoned program writes later', async () => {
    const band = withBand()
    const program = new FakeProgram()
    program.onCancel = () => {
      backend.context?.write('\x1b[?1049l')
      queueMicrotask(() => backend.context?.write('late'))
    }
    void controller.submit('pager')
    await flush()
    controller.interrupt()

    backend.settle(program)
    await flush()

    expect(band.band).toEqual(['\x1b[?1049l'])
    expect(band.text).toBe('^C\n$ \x1b[?1049l')
  })

  it('still drops the cleanup of a late program when the widget has no out-of-band channel', async () => {
    const program = leaveOnCancel(new FakeProgram())
    void controller.submit('pager')
    await flush()
    controller.interrupt()

    backend.settle(program)
    await flush()

    expect(program.cancelled).toBe(1)
    expect(io.text).toBe('^C\n$ ')
  })

  it('keeps the cleanup of a disposed program silent, out-of-band channel included', async () => {
    const band = withBand()
    const program = leaveOnCancel(new FakeProgram())
    void startProgram(program)
    await flush()
    const calls = band.calls

    controller.dispose()

    expect(program.cancelled).toBe(1)
    expect(band.band).toEqual([])
    expect(band.calls).toBe(calls)
  })

  it('keeps a program that arrives after dispose silent too', async () => {
    const band = withBand()
    const program = leaveOnCancel(new FakeProgram())
    void controller.submit('pager')
    await flush()
    controller.dispose()
    const calls = band.calls

    backend.settle(program)
    await flush()

    expect(program.cancelled).toBe(1)
    expect(band.band).toEqual([])
    expect(band.calls).toBe(calls)
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
    const session = withAI(ai)

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
    expect(io.text.endsWith('half an ^C\n$ ')).toBe(true)
    expect(session.busy).toBe(false)
  })

  it('aborts the request signal and stays quiet about the AbortError', async () => {
    const seen: AbortSignal[] = []
    const ai: AIProvider = {
      id: 'fake-ai',
      suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
        const signal = input.signal
        if (!signal) throw new Error('no signal')
        seen.push(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      },
      async explainError(input: ExplainInput) {
        return input.command
      },
    }
    const session = withAI(ai)
    void session.submit('#deploy')
    await flush()
    io.text = ''

    session.interrupt()
    await flush()

    expect(seen[0]?.aborted).toBe(true)
    expect(io.text).toBe('^C\n$ ')
    expect(session.isConfirming).toBe(false)
  })

  it('aborts the explain request on Ctrl+C', async () => {
    const signals: AbortSignal[] = []
    const session = withAI(hangingExplainer(signals))
    await failOnce(session)
    void session.submit('explain')
    await flush()
    expect(signals[0]?.aborted).toBe(false)

    session.interrupt()

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(io.text).toBe(`${messages.explainHeader} - boom (exit 127):\n^C\n$ `)
    expect(session.busy).toBe(false)
  })
})

describe('dispose', () => {
  it('aborts the running command and silences everything it does later', async () => {
    void controller.submit('build')
    await flush()
    const calls = io.calls

    controller.dispose()
    backend.context?.write('step 2\n')
    backend.settle({ output: 'done', exitCode: 1 })
    await flush()
    controller.interrupt()
    await controller.submit('ls')

    expect(backend.context?.signal.aborted).toBe(true)
    expect(io.calls).toBe(calls)
    expect(controller.busy).toBe(false)
    expect(backend.commands).toEqual(['build'])
  })

  it('aborts a pending AI request', async () => {
    const seen: AbortSignal[] = []
    const ai: AIProvider = {
      id: 'fake-ai',
      suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
        if (input.signal) seen.push(input.signal)
        return new Promise(() => {})
      },
      async explainError() {
        return ''
      },
    }
    const session = withAI(ai)
    void session.submit('#deploy')
    await flush()

    session.dispose()

    expect(seen[0]?.aborted).toBe(true)
  })

  it('aborts a pending explain request and prints nothing more', async () => {
    const signals: AbortSignal[] = []
    const session = withAI(hangingExplainer(signals))
    await failOnce(session)
    void session.submit('explain')
    await flush()
    const calls = io.calls

    session.dispose()

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(io.text).toBe(`${messages.explainHeader} - boom (exit 127):\n`)
    expect(io.calls).toBe(calls)
    expect(session.busy).toBe(false)
  })

  it('leaves no busy state behind for the controller of the next mount', async () => {
    void controller.submit('sleep 4')
    await flush()
    controller.dispose()

    const nextIO = new RecordingIO()
    const next = new SessionController({ backend, messages, io: nextIO, pageContext })
    nextIO.promptOf = () => next.promptText
    const pending = next.submit('echo remounted')
    await flush()
    expect(next.busy).toBe(true)
    backend.settle({ output: 'remounted', exitCode: 0 })
    await pending

    expect(backend.commands).toEqual(['sleep 4', 'echo remounted'])
    expect(nextIO.text).toBe('remounted\n$ ')
    expect(io.text).toBe('')
  })

  it('cancels the interactive program', async () => {
    const program = new FakeProgram()
    void controller.submit('watch')
    await flush()
    backend.settle(program)
    await flush()
    expect(controller.isInteractive).toBe(true)

    controller.dispose()

    expect(program.cancelled).toBe(1)
    expect(controller.isInteractive).toBe(false)
  })

  it('clears a pending confirmation', async () => {
    const session = withAI({
      id: 'fake-ai',
      suggestCommand: async () => ({ command: 'orbit deploy', explanation: '' }),
      explainError: async () => '',
    })
    await session.submit('#deploy')
    expect(session.isConfirming).toBe(true)

    session.dispose()

    expect([session.isConfirming, session.promptText]).toEqual([false, '$ '])
    await session.submit('y')
    expect(backend.commands).toEqual([])
  })

  it('clears a pending continuation', async () => {
    backend.isComplete = (source) => !source.endsWith(':')
    await controller.submit('def f():')
    expect(controller.isContinuing).toBe(true)

    controller.dispose()

    expect([controller.isContinuing, controller.promptText]).toEqual([false, '$ '])
  })
})
