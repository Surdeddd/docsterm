import { getHeapStatistics, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMessages } from '../src/messages.js'
import { renderSuggestUser } from '../src/prompts.js'
import { SessionController, type SessionIO } from '../src/session-controller.js'
import type {
  AIProvider,
  Backend,
  BackendRunResult,
  CommandSuggestion,
  DocsTerminalEvent,
  ExplainInput,
  HistoryEntry,
  InteractiveRun,
  Locale,
  PageContext,
  RunContext,
  RunOutcome,
  RunReport,
  SuggestInput,
} from '../src/types.js'

const en = getMessages('en')
const ru = getMessages('ru')

const pageContext: PageContext = {
  title: 'Orbit CLI docs',
  url: 'https://example.test/docs',
  description: 'Deploy apps with orbit',
  headings: ['Install', 'Deploy'],
}

class Screen implements SessionIO {
  text = ''
  lines: string[] = []
  chunks: string[] = []
  prompts = 0
  clears = 0
  busySeq: boolean[] = []
  promptOf: () => string = () => '$ '

  write(text: string): void {
    this.chunks.push(text)
    this.text += text
  }
  print(line: string): void {
    this.lines.push(line)
    this.text += `${line}\n`
  }
  printPrompt(): void {
    this.prompts += 1
    this.text += this.promptOf()
  }
  clearScreen(): void {
    this.clears += 1
    this.text = ''
  }
  setBusy(busy: boolean): void {
    this.busySeq.push(busy)
  }
  size(): { columns: number; rows: number } {
    return { columns: 100, rows: 30 }
  }
}

class FakeBackend implements Backend {
  id = 'fake'
  prompt = '$ '
  continuationPrompt: string | undefined = undefined
  commands: string[] = []
  contexts: RunContext[] = []
  respond: (command: string, context: RunContext) => RunOutcome | Promise<RunOutcome> = () => ({
    output: 'ok',
    exitCode: 0,
  })
  isComplete?: (source: string) => boolean | Promise<boolean>
  describe?: () => string

  async init(): Promise<void> {}

  async run(command: string, context?: RunContext): Promise<RunOutcome> {
    if (!context) throw new Error('missing run context')
    this.commands.push(command)
    this.contexts.push(context)
    return this.respond(command, context)
  }

  dispose(): void {}
}

class FakeAI implements AIProvider {
  readonly id = 'fake-ai'
  suggestion: CommandSuggestion = { command: 'orbit deploy', explanation: 'deploys the app' }
  chunks: string[] = ['the flag ', 'is unknown']
  explanation = 'the flag is unknown'
  failWith: unknown = null
  suggestCalls: SuggestInput[] = []
  explainCalls: ExplainInput[] = []

  async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
    this.suggestCalls.push(input)
    if (this.failWith) throw this.failWith
    return this.suggestion
  }

  async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
    this.explainCalls.push(input)
    if (this.failWith) throw this.failWith
    if (onChunk) for (const chunk of this.chunks) onChunk(chunk)
    return this.explanation
  }
}

interface StartOptions {
  ai?: AIProvider | null
  locale?: Locale
  io?: SessionIO
  lineHistory?: () => readonly string[]
  onExecuted?: (command: string) => void
  onEvent?: (event: DocsTerminalEvent) => void
  onResult?: (result: RunReport) => void
}

let screen: Screen
let backend: FakeBackend
let ai: FakeAI

const start = (options: StartOptions = {}): SessionController => {
  const locale = options.locale ?? 'en'
  const session = new SessionController({
    backend,
    ai: options.ai === null ? undefined : (options.ai ?? ai),
    messages: getMessages(locale),
    locale,
    io: options.io ?? screen,
    pageContext,
    lineHistory: options.lineHistory,
    onExecuted: options.onExecuted,
    onEvent: options.onEvent,
    onResult: options.onResult,
  })
  screen.promptOf = () => session.promptText
  return session
}

const type = async (session: SessionController, line: string): Promise<void> => {
  screen.text += `${line}\n`
  await session.submit(line)
}

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  screen = new Screen()
  backend = new FakeBackend()
  ai = new FakeAI()
})

describe('basic commands', () => {
  it('prints a fresh prompt on empty input', async () => {
    await type(start(), '   ')
    expect(screen.text).toBe('   \n$ ')
    expect(backend.commands).toEqual([])
  })

  it('runs a command and prints its output', async () => {
    await type(start(), 'orbit status')
    expect(backend.commands).toEqual(['orbit status'])
    expect(screen.text).toBe('orbit status\nok\n$ ')
    expect(screen.busySeq).toEqual([true, false])
  })

  it('trims the line before running it', async () => {
    await start().submit('  orbit status  ')
    expect(backend.commands).toEqual(['orbit status'])
  })

  it('skips printing empty output', async () => {
    backend.respond = () => ({ output: '', exitCode: 0 })
    await type(start(), 'quiet')
    expect(screen.text).toBe('quiet\n$ ')
  })

  it('prints the explain hint on failure when ai is available', async () => {
    backend.respond = () => ({ output: 'boom', exitCode: 2 })
    await type(start(), 'orbit destroy')
    expect(screen.text).toBe(`orbit destroy\nboom\n${en.errorHint}\n$ `)
  })

  it('stays silent about explain when ai is missing', async () => {
    backend.respond = () => ({ output: 'boom', exitCode: 2 })
    await type(start({ ai: null }), 'orbit destroy')
    expect(screen.text).toBe('orbit destroy\nboom\n$ ')
  })

  it('ignores input while busy', async () => {
    const pending = deferred<RunOutcome>()
    backend.respond = () => pending.promise
    const session = start()
    const first = session.submit('slow')
    await session.submit('second')
    expect(backend.commands).toEqual(['slow'])
    pending.resolve({ output: 'done', exitCode: 0 })
    await first
    expect(screen.lines).toEqual(['done'])
  })

  it('is busy as soon as submit returns, so a pasted next line cannot overtake the first', async () => {
    const pending = deferred<RunOutcome>()
    backend.respond = () => pending.promise
    const session = start()
    const first = session.submit('first')
    expect(session.busy).toBe(true)
    const second = session.submit('second')
    pending.resolve({ output: 'one', exitCode: 0 })
    await Promise.all([first, second])
    expect(backend.commands).toEqual(['first'])
    expect(screen.text).toBe('one\n$ ')
  })

  it('treats a result without output as empty output', async () => {
    backend.respond = () => ({ exitCode: 0 }) as unknown as RunOutcome
    await type(start(), 'touch x')
    expect(screen.text).toBe('touch x\n$ ')
  })

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a word', 'one'],
    ['a blank string', ' '],
  ])('treats an exit code that is %s as success', async (_label, exitCode) => {
    backend.respond = () => ({ output: 'done', exitCode }) as unknown as RunOutcome
    const session = start()
    await type(session, 'job')
    await type(session, 'explain')
    expect(screen.text).toBe(`job\ndone\n$ explain\n${en.nothingToExplain}\n$ `)
    await session.submit('#next')
    const input = ai.suggestCalls[0] as SuggestInput
    expect(input.history).toEqual([{ command: 'job', output: 'done', exitCode: 0 }])
    expect(renderSuggestUser(input)).toBe('Request: next\n\nRecent commands:\n$ job (exit 0)\n\nAnswer in English.')
  })

  it('reads an exit code given as a numeric string as that number', async () => {
    backend.respond = () => ({ output: 'denied', exitCode: '1' }) as unknown as RunOutcome
    const session = start()
    await type(session, 'job')
    expect(screen.text).toBe(`job\ndenied\n${en.errorHint}\n$ `)
    await session.submit('explain')
    expect(ai.explainCalls[0]).toMatchObject({ command: 'job', output: 'denied', exitCode: 1 })
  })

  it('passes the terminal size, the locale and a live signal to the backend', async () => {
    await start({ locale: 'ru' }).submit('ls')
    const context = backend.contexts[0]
    expect(context?.columns).toBe(100)
    expect(context?.rows).toBe(30)
    expect(context?.locale).toBe('ru')
    expect(context?.signal.aborted).toBe(false)
  })
})

describe('streaming contract', () => {
  it('prints what the backend returns after what it streamed', async () => {
    backend.respond = (_command, context) => {
      context.write('[1/2] bundling...\n')
      context.write('[2/2] uploading...\n')
      return { output: 'build complete in 3.5s', exitCode: 0 }
    }
    await type(start(), 'build')
    expect(screen.text).toBe('build\n[1/2] bundling...\n[2/2] uploading...\nbuild complete in 3.5s\n$ ')
  })

  it('keeps the README example intact: stream working..., return done', async () => {
    backend.respond = (_command, context) => {
      context.write('working...\n')
      return { output: 'done\n', exitCode: 0 }
    }
    await type(start(), 'job')
    expect(screen.text).toBe('job\nworking...\ndone\n$ ')
  })

  it('drops a leading copy of the streamed text from the returned output', async () => {
    backend.respond = (_command, context) => {
      context.write('a\n')
      context.write('b\n')
      return { output: 'a\nb\nc', exitCode: 0 }
    }
    await type(start(), 'abc')
    expect(screen.text).toBe('abc\na\nb\nc\n$ ')
  })

  it('drops a returned copy that is shorter than the stream because it lost the final newline', async () => {
    backend.respond = (_command, context) => {
      context.write('hello\n')
      return { output: 'hello', exitCode: 0 }
    }
    const session = start()
    await type(session, 'greet')
    expect(screen.text).toBe('greet\nhello\n$ ')
    backend.respond = () => ({ output: 'boom', exitCode: 1 })
    await session.submit('broken')
    await session.submit('#next')
    expect(ai.suggestCalls[0]?.history[0]).toEqual({ command: 'greet', output: 'hello\n', exitCode: 0 })
  })

  it('prints a returned error longer than the stream in full and records both for explain', async () => {
    backend.respond = (_command, context) => {
      context.write('x\n')
      return { output: 'error: disk full', exitCode: 1 }
    }
    const session = start()
    await type(session, 'save')
    expect(screen.text).toBe(`save\nx\nerror: disk full\n${en.errorHint}\n$ `)
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('x\nerror: disk full')
  })

  it('records streamed plus returned output in the history the AI sees', async () => {
    backend.respond = (_command, context) => {
      context.write('[1/2] bundling...\n')
      return { output: 'build complete in 3.5s', exitCode: 0 }
    }
    const session = start()
    await session.submit('build')
    await session.submit('#what next')
    expect(ai.suggestCalls[0]?.history).toEqual([
      { command: 'build', output: '[1/2] bundling...\nbuild complete in 3.5s', exitCode: 0 },
    ])
  })

  it('continues a partial streamed line with the returned output', async () => {
    backend.respond = (_command, context) => {
      context.write('Downloading orbit.tar.gz ... ')
      return { output: 'done (2.1 MB)', exitCode: 0 }
    }
    await type(start(), 'fetch')
    expect(screen.text).toBe('fetch\nDownloading orbit.tar.gz ... done (2.1 MB)\n$ ')
  })

  it('ends a partial streamed line before the explain hint and the prompt', async () => {
    backend.respond = (_command, context) => {
      context.write('Downloading orbit.tar.gz ... ')
      return { output: '', exitCode: 1 }
    }
    await type(start(), 'fetch')
    expect(screen.text).toBe(`fetch\nDownloading orbit.tar.gz ... \n${en.errorHint}\n$ `)
  })

  it('ends a partial streamed line before the prompt on success', async () => {
    backend.respond = (_command, context) => {
      context.write('\x1b[32mready\x1b[0m')
      return { output: '', exitCode: 0 }
    }
    await type(start(), 'probe')
    expect(screen.text).toBe('probe\n\x1b[32mready\x1b[0m\n$ ')
  })

  it('erases the rest of a progress line before the explain hint', async () => {
    backend.respond = (_command, context) => {
      context.write('[1/3] uploading orbit.tar.gz... 42%\r')
      return { output: '', exitCode: 1 }
    }
    await type(start(), 'deploy')
    expect(screen.text).toBe(`deploy\n[1/3] uploading orbit.tar.gz... 42%\r\x1b[K${en.errorHint}\n$ `)
  })

  it('erases the rest of a coloured progress line before the prompt', async () => {
    backend.respond = (_command, context) => {
      context.write('\x1b[32m42%\x1b[0m\r')
      return { output: '', exitCode: 0 }
    }
    await type(start(), 'upload')
    expect(screen.text).toBe('upload\n\x1b[32m42%\x1b[0m\r\x1b[K$ ')
  })

  it('erases the rest of a progress line before a backend error', async () => {
    backend.respond = (_command, context) => {
      context.write('42%\r')
      throw new Error('network down')
    }
    await type(start(), 'upload')
    expect(screen.text).toBe(`upload\n42%\r\x1b[K${en.backendError}: network down\n${en.errorHint}\n$ `)
  })

  it('leaves a progress line alone once a newline ended it', async () => {
    backend.respond = (_command, context) => {
      context.write('42%\r100%\r\n')
      return { output: '', exitCode: 0 }
    }
    await type(start(), 'upload')
    expect(screen.text).toBe('upload\n42%\r100%\r\n$ ')
  })

  it('ignores writes that arrive after the command finished', async () => {
    backend.respond = () => ({ output: 'done', exitCode: 0 })
    const session = start()
    await type(session, 'job')
    backend.contexts[0]?.write('late log line\n')
    expect(screen.text).toBe('job\ndone\n$ ')
  })

  it('ignores explain chunks that arrive after the answer', async () => {
    let emit: (text: string) => void = () => {}
    const late: AIProvider = {
      id: 'late',
      suggestCommand: async () => ({ command: 'ls', explanation: '' }),
      explainError: async (_input, onChunk) => {
        emit = onChunk ?? emit
        onChunk?.('answer')
        return 'answer'
      },
    }
    backend.respond = () => ({ output: 'boom', exitCode: 1 })
    const session = start({ ai: late })
    await session.submit('broken')
    screen.text = ''
    await session.submit('explain')
    emit(' and a late chunk')
    expect(screen.text).toBe(`${en.explainHeader} - broken (exit 1):\nanswer\n$ `)
  })

  it('keeps colours on screen but strips them from what explain receives', async () => {
    backend.respond = (_command, context) => {
      context.write('\x1b[31mfailed\x1b[0m\n')
      return { output: '', exitCode: 1 }
    }
    const session = start()
    await type(session, 'test')
    expect(screen.chunks).toEqual(['\x1b[31mfailed\x1b[0m\n'])
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('failed\n')
  })
})

describe('evidence for explain', () => {
  const logLines = (count: number) =>
    Array.from({ length: count }, (_, index) => `processing order ${index}`).join('\n')

  it('keeps the head and the tail of a long log so the final error reaches explain', async () => {
    const error = "TypeError: Cannot read properties of undefined (reading 'price')"
    const full = `${logLines(150)}\n${error}`
    expect(full.length).toBeGreaterThan(3000)
    backend.respond = () => ({ output: full, exitCode: 1 })
    const session = start()
    await session.submit('node orders.js')
    await session.submit('explain')
    const output = ai.explainCalls[0]?.output ?? ''
    expect(output).toBe(`${full.slice(0, 500)}\n...\n${full.slice(-1500)}`)
    expect(output.endsWith(error)).toBe(true)
  })

  it('caps a long stream the same way without keeping all of it', async () => {
    const chunk = `${'x'.repeat(4095)}\n`
    const parts = Array.from({ length: 256 }, (_, index) => `${index}:${chunk}`)
    backend.respond = (_command, context) => {
      for (const part of parts) context.write(part)
      return { output: 'final error', exitCode: 1 }
    }
    const session = start()
    await session.submit('flood')
    await session.submit('explain')
    const full = `${parts.join('')}final error`
    expect(ai.explainCalls[0]?.output).toBe(`${full.slice(0, 500)}\n...\n${full.slice(-1500)}`)
  })

  it('recognizes a copied prefix even when the stream was too long to keep', async () => {
    const streamed = Array.from({ length: 80 }, (_, index) => `${index}:${'y'.repeat(999)}\n`)
    backend.respond = (_command, context) => {
      for (const part of streamed) context.write(part)
      return { output: `${streamed.join('')}summary`, exitCode: 0 }
    }
    await start().submit('long')
    expect(screen.lines).toEqual(['summary'])
  })

  it('does not record the screen paint of an interactive program', async () => {
    const finished = deferred<{ output: string; exitCode: number }>()
    backend.respond = (command) => {
      if (command !== 'less notes.txt') return { output: 'boom', exitCode: 1 }
      const run: InteractiveRun = {
        onKey: (key) => {
          if (key === 'q') finished.resolve({ output: '', exitCode: 0 })
        },
        done: finished.promise,
      }
      return run
    }
    const session = start()
    const pending = session.submit('less notes.txt')
    await flush()
    expect(session.isInteractive).toBe(true)
    backend.contexts[0]?.write('\x1b[?1049h\x1b[2J\x1b[Hpage one\r\n:')
    session.handleInteractiveKey('q')
    await pending
    expect(screen.chunks).toEqual(['\x1b[?1049h\x1b[2J\x1b[Hpage one\r\n:'])
    await session.submit('broken')
    await session.submit('explain')
    expect(ai.explainCalls[0]?.history.map((entry) => entry.output)).toEqual(['', 'boom'])
  })

  it('records what a program prints after it starts reading input', async () => {
    const finished = deferred<BackendRunResult>()
    backend.respond = (_command, context) => {
      context.write('name? ')
      const run: InteractiveRun = {
        onKey: (key) => {
          if (key !== '\r') {
            context.write(key)
            return
          }
          context.write('\r\nTraceback (most recent call last):\n  File "ask.py", line 2\nValueError: empty name\n')
          finished.resolve({ output: '', exitCode: 1 })
        },
        done: finished.promise,
      }
      return run
    }
    const session = start()
    const pending = session.submit('python ask.py')
    await flush()
    expect(session.isInteractive).toBe(true)
    session.handleInteractiveKey('x')
    session.handleInteractiveKey('\r')
    await pending
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe(
      'name? x\r\nTraceback (most recent call last):\n  File "ask.py", line 2\nValueError: empty name\n',
    )
  })

  it('records the text around a pager but never its screen paint', async () => {
    const finished = deferred<BackendRunResult>()
    backend.respond = (_command, context) => {
      context.write('before\n')
      context.write('\x1b[?1049h\x1b[H\x1b[2Jpage one\r\n:')
      const run: InteractiveRun = {
        onKey: (key) => {
          if (key !== 'q') return
          context.write('\x1b[?1049l')
          context.write('after\nerror: build failed\n')
          finished.resolve({ output: '', exitCode: 1 })
        },
        done: finished.promise,
      }
      return run
    }
    const session = start()
    const pending = session.submit('echo before; less notes.txt; echo after; build')
    await flush()
    session.handleInteractiveKey('q')
    await pending
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('before\nafter\nerror: build failed\n')
  })

  it.each([
    ['1049', '\x1b[?1049h', '\x1b[?1049l'],
    ['1047', '\x1b[?1047h', '\x1b[?1047l'],
    ['47', '\x1b[?47h', '\x1b[?47l'],
    ['a list of modes', '\x1b[?25;1049h', '\x1b[?1049;25l'],
    ['an 8-bit CSI', '\x9b?1049h', '\x9b?1049l'],
    ['another mode to leave', '\x1b[?1049h', '\x1b[?47l'],
  ])('skips what streams on the alternate screen switched with %s', async (_label, enter, leave) => {
    backend.respond = (_command, context) => {
      context.write(`before\n${enter}\x1b[Hframe 1`)
      context.write('\x1b[Hframe 2')
      context.write(`${leave}after\n`)
      return { output: 'failed', exitCode: 1 }
    }
    const session = start()
    await session.submit('watch orbit status')
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('before\nafter\nfailed')
  })

  it('records the returned output even when the stream ends on the alternate screen', async () => {
    backend.respond = (_command, context) => {
      context.write('before\n\x1b[?1049h\x1b[Hframe')
      return { output: 'summary', exitCode: 1 }
    }
    const session = start()
    await session.submit('watch orbit status')
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('before\nsummary')
  })

  it('keeps recording when a sequence only looks like a screen switch', async () => {
    backend.respond = (_command, context) => {
      context.write('a\x1b[1049hb\x1b[?1049 hc\x1b[?25hd\n')
      return { output: '', exitCode: 1 }
    }
    const session = start()
    await session.submit('show')
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('abcd\n')
  })

  it('notices a screen switch split across writes', async () => {
    backend.respond = (_command, context) => {
      for (const chunk of ['before\n\x1b[?10', '49h\x1b[Hframe\x1b', '[?1049', 'lafter\n']) context.write(chunk)
      return { output: '', exitCode: 1 }
    }
    const session = start()
    await session.submit('top')
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('before\nafter\n')
  })

  it('notices a long list of modes that ends in a screen switch split across writes', async () => {
    backend.respond = (_command, context) => {
      for (const chunk of ['before\n\x1b[?1000;1006;1049', 'hPAINT\x1b[?1049l', 'after\n']) context.write(chunk)
      return { output: '', exitCode: 1 }
    }
    const session = start()
    await session.submit('top')
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('before\nafter\n')
  })

  it('still recognizes a copied prefix when the stream ends in an unfinished escape', async () => {
    backend.respond = (_command, context) => {
      context.write('a\n\x1b[')
      return { output: 'a\n\x1b[summary', exitCode: 0 }
    }
    await start().submit('odd')
    expect(screen.lines).toEqual(['summary'])
  })
})

describe('memory held for explain and history', { timeout: 60_000 }, () => {
  setFlagsFromString('--expose-gc')
  const collectGarbage = runInNewContext('gc') as () => void

  const quiet: SessionIO = {
    write: () => {},
    print: () => {},
    printPrompt: () => {},
    clearScreen: () => {},
    setBusy: () => {},
  }

  const forgetLastRegExpMatch = (): boolean => /x/.test('x')

  const usedMegabytes = (): number => {
    collectGarbage()
    collectGarbage()
    return getHeapStatistics().used_heap_size / 2 ** 20
  }

  const heapMegabytes = (): number => {
    forgetLastRegExpMatch()
    return usedMegabytes()
  }

  const hugeLog = (letter: string): string => Array.from({ length: 500_000 }, () => `${letter.repeat(99)}\n`).join('')

  const streamHugeLog = (context: RunContext): void => {
    context.write(hugeLog('x'))
  }

  const streamOneLineOfHugeLog = (context: RunContext): void => {
    context.write(hugeLog('w').slice(0, 100))
  }

  it('keeps only bounded windows of one huge streamed chunk while the command runs', async () => {
    const running = deferred<RunOutcome>()
    backend.respond = (_command, context) => {
      streamHugeLog(context)
      return running.promise
    }
    const session = start({ io: quiet })
    const before = heapMegabytes()
    void session.submit('tail -f huge.log')
    await flush()
    const during = heapMegabytes()
    expect(session.busy).toBe(true)
    running.resolve({ output: '', exitCode: 0 })
    expect(during - before).toBeLessThan(8)
  })

  it('stores small copies of a huge streamed chunk and a huge returned output', async () => {
    backend.respond = (_command, context) => {
      streamHugeLog(context)
      return { output: hugeLog('y'), exitCode: 1 }
    }
    const session = start({ io: quiet })
    const before = heapMegabytes()
    await session.submit('cat huge.log')
    const after = heapMegabytes()
    expect(after - before).toBeLessThan(8)
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe(`${hugeLog('x').slice(0, 500)}\n...\n${hugeLog('y').slice(-1500)}`)
  })

  it('does not leave a huge chunk or output as the subject of its last RegExp match', async () => {
    backend.respond = (_command, context) => {
      streamHugeLog(context)
      return { output: hugeLog('y'), exitCode: 1 }
    }
    const session = start({ io: quiet })
    const before = heapMegabytes()
    await session.submit('cat huge.log')
    const after = usedMegabytes()
    expect(after - before).toBeLessThan(8)
  })

  it('stores a copy, not a slice, of a short output cut from a huge string', async () => {
    backend.respond = (_command, context) => {
      streamOneLineOfHugeLog(context)
      return { output: '', exitCode: 1 }
    }
    const session = start({ io: quiet })
    const before = heapMegabytes()
    await session.submit('head -1 huge.log')
    const after = heapMegabytes()
    expect(after - before).toBeLessThan(8)
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe(`${'w'.repeat(99)}\n`)
  })

  it('keeps the last fifty history entries of about two kilobytes each, even when the backend keeps its run contexts', async () => {
    const chunk = `${'k'.repeat(1023)}\n`
    backend.respond = (_command, context) => {
      for (let index = 0; index < 47; index += 1) context.write(chunk)
      return { output: '', exitCode: 0 }
    }
    const session = start({ io: quiet })
    const before = heapMegabytes()
    for (let index = 0; index < 120; index += 1) await session.submit(`job ${index}`)
    const after = heapMegabytes()
    const history = (session as unknown as { history: HistoryEntry[] }).history
    expect(backend.contexts).toHaveLength(120)
    expect([history.length, history[0]?.command, history.at(-1)?.command]).toEqual([50, 'job 70', 'job 119'])
    expect(history.every((entry) => entry.output.length === 2005)).toBe(true)
    expect(after - before).toBeLessThan(3)
  })

  it('stores a small copy of a huge backend error', async () => {
    backend.respond = () => Promise.reject(new Error(hugeLog('z')))
    const session = start({ io: quiet })
    const before = heapMegabytes()
    await session.submit('crash')
    const after = heapMegabytes()
    expect(after - before).toBeLessThan(8)
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe(`${hugeLog('z').slice(0, 500)}\n...\n${hugeLog('z').slice(-1500)}`)
  })
})

describe('backend exceptions', () => {
  it('reports the error, records it and offers explain', async () => {
    backend.respond = () => Promise.reject(new Error('worker crashed'))
    const session = start()
    await type(session, 'anything')
    expect(screen.text).toBe(`anything\n${en.backendError}: worker crashed\n${en.errorHint}\n$ `)
    await session.submit('explain')
    expect(ai.explainCalls[0]).toMatchObject({ command: 'anything', output: 'worker crashed', exitCode: 1 })
  })

  it('prints the error message without the control sequences it carries', async () => {
    backend.respond = () => Promise.reject(new Error('bad\x1b[2J\x1b[Hthing\x07'))
    const session = start({ ai: null })
    await type(session, 'anything')
    expect(screen.text).toBe(`anything\n${en.backendError}: badthing\n$ `)
  })

  it('does not offer explain without ai', async () => {
    backend.respond = () => Promise.reject(new Error('pyodide crashed'))
    await type(start({ ai: null }), 'anything')
    expect(screen.text).toBe(`anything\n${en.backendError}: pyodide crashed\n$ `)
  })

  it('records what streamed before the throw together with the error message', async () => {
    backend.respond = (_command, context) => {
      context.write('step 1\n')
      context.write('step 2\n')
      throw new Error('worker crashed')
    }
    const session = start()
    await type(session, 'migrate')
    expect(screen.text).toBe(`migrate\nstep 1\nstep 2\n${en.backendError}: worker crashed\n${en.errorHint}\n$ `)
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('step 1\nstep 2\nworker crashed')
  })

  it('starts the error on its own line after a partial streamed line', async () => {
    backend.respond = (_command, context) => {
      context.write('Downloading orbit.tar.gz ... ')
      throw new Error('network down')
    }
    const session = start()
    await type(session, 'fetch')
    expect(screen.text).toBe(
      `fetch\nDownloading orbit.tar.gz ... \n${en.backendError}: network down\n${en.errorHint}\n$ `,
    )
    await session.submit('explain')
    expect(ai.explainCalls[0]?.output).toBe('Downloading orbit.tar.gz ... \nnetwork down')
  })

  it('strips escape sequences and keeps the head and the tail of a long stream that ends in a throw', async () => {
    const lines = Array.from({ length: 150 }, (_, index) => `processing order ${index}\n`)
    const error = "TypeError: Cannot read properties of undefined (reading 'price')"
    backend.respond = (_command, context) => {
      for (const line of lines) context.write(`\x1b[2m${line}\x1b[0m`)
      throw new Error(`\x1b[31m${error}\x1b[0m`)
    }
    const session = start()
    await session.submit('node orders.js')
    await session.submit('explain')
    const full = `${lines.join('')}${error}`
    expect(full.length).toBeGreaterThan(3000)
    expect(ai.explainCalls[0]?.output).toBe(`${full.slice(0, 500)}\n...\n${full.slice(-1500)}`)
  })
})

describe('builtins', () => {
  it('clears the screen and prints a prompt', async () => {
    const session = start()
    await type(session, 'clear')
    expect(screen.clears).toBe(1)
    expect(screen.text).toBe('$ ')
    expect(backend.commands).toEqual([])
  })

  it('prints help with the keys', async () => {
    await type(start(), 'help')
    expect(screen.text).toBe(`help\n${en.helpText}\n${en.keysHelp}\n$ `)
  })

  it('prints the AI-free help without ai', async () => {
    await type(start({ ai: null }), 'help')
    expect(screen.text).toBe(`help\n${en.helpTextNoAi}\n${en.keysHelp}\n$ `)
  })

  it('appends what the backend says about itself to help', async () => {
    backend.describe = () => 'virtual shell: ls, cat, orbit'
    await type(start({ ai: null }), 'help')
    expect(screen.text).toBe(`help\n${en.helpTextNoAi}\n${en.keysHelp}\nvirtual shell: ls, cat, orbit\n$ `)
  })

  it('lists the line history like bash', async () => {
    const lineHistory = () => ['echo one', 'echo two', 'history']
    await type(start({ lineHistory }), 'history')
    expect(screen.text).toBe('history\n    1  echo one\n    2  echo two\n    3  history\n$ ')
    expect(backend.commands).toEqual([])
  })

  it('right-aligns history numbers in five columns', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => `cmd${index + 1}`)
    await start({ lineHistory: () => entries }).submit('history')
    expect(screen.lines.slice(8, 10)).toEqual(['    9  cmd9', '   10  cmd10'])
  })

  it('prints only a prompt for history when the widget keeps none', async () => {
    await type(start(), 'history')
    expect(screen.text).toBe('history\n$ ')
  })

  it('matches builtins only as the whole trimmed line', async () => {
    const session = start()
    await session.submit('help me')
    await session.submit('history | tail -1')
    await session.submit('explain why')
    await session.submit('clear;')
    expect(backend.commands).toEqual(['help me', 'history | tail -1', 'explain why', 'clear;'])
    await session.submit('  help  ')
    expect(screen.lines.slice(-2)).toEqual([en.helpText, en.keysHelp])
  })

  it('prints help for a bare # when ai is configured', async () => {
    await type(start(), '#')
    expect(screen.text).toBe(`#\n${en.helpText}\n$ `)
  })
})

describe('without ai', () => {
  it('passes # lines to the backend as comments', async () => {
    const session = start({ ai: null })
    await type(session, '# install the orbit cli first')
    await session.submit('#')
    expect(backend.commands).toEqual(['# install the orbit cli first', '#'])
    expect(screen.text).toBe('# install the orbit cli first\nok\n$ ok\n$ ')
  })

  it('answers explain with a configuration hint', async () => {
    await type(start({ ai: null }), 'explain')
    expect(screen.text).toBe(`explain\n${en.aiNotConfigured}\n$ `)
  })
})

describe('continuation', () => {
  const pythonLike = (source: string) => !(source.split('\n')[0] ?? '').endsWith(':') || source.endsWith('\n')

  it('asks for more lines until the backend says the source is complete', async () => {
    backend.isComplete = pythonLike
    const session = start()
    await type(session, 'def f():')
    expect(session.isContinuing).toBe(true)
    expect(session.promptText).toBe('... ')
    await type(session, '    return 1')
    expect(backend.commands).toEqual([])
    await type(session, '')
    expect(backend.commands).toEqual(['def f():\n    return 1\n'])
    expect(session.isContinuing).toBe(false)
    expect(screen.text).toBe('def f():\n...     return 1\n... \nok\n$ ')
  })

  it('uses the continuation prompt of the backend', async () => {
    backend.isComplete = (source) => !source.endsWith('\\')
    backend.continuationPrompt = '> '
    const session = start()
    await type(session, 'echo a \\')
    expect(session.promptText).toBe('> ')
    await type(session, 'b')
    expect(backend.commands).toEqual(['echo a \\\nb'])
  })

  it('checks builtins and # only on the first line', async () => {
    backend.isComplete = pythonLike
    const session = start()
    await session.submit('for x in y:')
    await session.submit('help')
    await session.submit('#deploy')
    await session.submit('history')
    await session.submit('')
    expect(backend.commands).toEqual(['for x in y:\nhelp\n#deploy\nhistory\n'])
    expect(ai.suggestCalls).toEqual([])
  })

  it('stays busy while an asynchronous check runs', async () => {
    const verdict = deferred<boolean>()
    backend.isComplete = () => verdict.promise
    const session = start()
    const pending = session.submit('if x:')
    await flush()
    expect(session.busy).toBe(true)
    await session.submit('ignored')
    verdict.resolve(false)
    await pending
    expect(session.busy).toBe(false)
    expect(session.isContinuing).toBe(true)
    expect(screen.busySeq).toEqual([true, false])
    expect(backend.commands).toEqual([])
  })

  it('runs the source when the check throws', async () => {
    backend.isComplete = () => {
      throw new Error('parser crashed')
    }
    await start().submit('x = (')
    expect(backend.commands).toEqual(['x = ('])
  })

  it('starts fresh after a complete source', async () => {
    backend.isComplete = pythonLike
    const session = start()
    await session.submit('print(1)')
    await session.submit('print(2)')
    expect(backend.commands).toEqual(['print(1)', 'print(2)'])
  })
})

describe('confirmation', () => {
  it('shows the question as the prompt instead of writing it separately', async () => {
    const session = start()
    await type(session, '#deploy my app')
    expect(session.isConfirming).toBe(true)
    expect(session.promptText).toBe(en.confirmRun)
    expect(screen.chunks).toEqual([])
    expect(screen.text).toBe(
      `#deploy my app\n${en.aiThinking}\ndeploys the app\n${en.suggestionLabel}: orbit deploy\n${en.confirmRun}`,
    )
  })

  it('runs the suggestion after y like a typed command', async () => {
    backend.respond = () => ({ output: 'Deployed', exitCode: 0 })
    const session = start()
    await session.submit('#deploy my app')
    screen.text = ''
    await type(session, 'y')
    expect(backend.commands).toEqual(['orbit deploy'])
    expect(session.isConfirming).toBe(false)
    expect(screen.text).toBe('y\nDeployed\n$ ')
  })

  it.each(['y', 'Y', 'yes', ' YES '])('accepts %j in English', async (answer) => {
    const session = start()
    await session.submit('#deploy')
    await session.submit(answer)
    expect(backend.commands).toEqual(['orbit deploy'])
  })

  it.each(['n', '', 'yep', 'д', 'да'])('cancels on %j in English', async (answer) => {
    const session = start()
    await session.submit('#deploy')
    screen.text = ''
    await type(session, answer)
    expect(backend.commands).toEqual([])
    expect(screen.text).toBe(`${answer}\n${en.cancelled}\n$ `)
  })

  it.each(['y', 'yes', 'д', 'да', 'Да', ' ДА '])('accepts %j in Russian', async (answer) => {
    const session = start({ locale: 'ru' })
    await session.submit('#задеплой')
    await session.submit(answer)
    expect(backend.commands).toEqual(['orbit deploy'])
  })

  it.each(['н', 'нет', ''])('cancels on %j in Russian', async (answer) => {
    const session = start({ locale: 'ru' })
    await session.submit('#задеплой')
    screen.text = ''
    await type(session, answer)
    expect(backend.commands).toEqual([])
    expect(screen.text).toBe(`${answer}\n${ru.cancelled}\n$ `)
  })

  it('runs the next command normally after a cancelled suggestion', async () => {
    const session = start()
    await session.submit('#deploy')
    await session.submit('n')
    await session.submit('ls')
    expect(backend.commands).toEqual(['ls'])
  })

  it('sends a confirmed builtin through the builtins', async () => {
    ai.suggestion = { command: 'help', explanation: 'shows help' }
    const session = start()
    await session.submit('#what can I do')
    screen.text = ''
    await type(session, 'y')
    expect(backend.commands).toEqual([])
    expect(screen.text).toBe(`y\n${en.helpText}\n${en.keysHelp}\n$ `)
  })

  it('clears the screen for a confirmed clear', async () => {
    ai.suggestion = { command: 'clear', explanation: 'clears the screen' }
    const session = start()
    await session.submit('#clear the screen')
    await session.submit('y')
    expect(screen.clears).toBe(1)
    expect(screen.text).toBe('$ ')
  })

  it('lists history for a confirmed history', async () => {
    ai.suggestion = { command: 'history', explanation: 'lists commands' }
    const session = start({ lineHistory: () => ['ls'] })
    await session.submit('#show my commands')
    await session.submit('y')
    expect(screen.lines.at(-1)).toBe('    1  ls')
    expect(backend.commands).toEqual([])
  })

  it('never sends a confirmed # line back to the AI', async () => {
    ai.suggestion = { command: '# nothing to do', explanation: 'a comment' }
    const session = start()
    await session.submit('#do nothing')
    await session.submit('y')
    expect(backend.commands).toEqual(['# nothing to do'])
    expect(ai.suggestCalls).toHaveLength(1)
  })

  it('reports only accepted suggestions through onExecuted', async () => {
    const executed: string[] = []
    const session = start({ onExecuted: (command) => executed.push(command) })
    await session.submit('ls')
    await session.submit('#deploy')
    await session.submit('n')
    await session.submit('#deploy')
    await session.submit('yes')
    expect(executed).toEqual(['orbit deploy'])
  })
})

describe('events', () => {
  const duration = expect.any(Number) as number

  const recorder = () => {
    const events: DocsTerminalEvent[] = []
    return { events, onEvent: (event: DocsTerminalEvent) => events.push(event) }
  }

  it('reports every command with its source, exit code and duration', async () => {
    const { events, onEvent } = recorder()
    backend.respond = (command) => ({ output: 'out', exitCode: command === 'fail' ? 2 : 0 })
    const session = start({ onEvent })
    await session.submit('ls')
    await session.submit('fail', 'paste')
    await session.submit('cat x', 'api')
    await session.submit('help', 'api')
    expect(events).toEqual([
      { type: 'command', command: 'ls', source: 'typed', exitCode: 0, durationMs: duration },
      { type: 'command', command: 'fail', source: 'paste', exitCode: 2, durationMs: duration },
      { type: 'command', command: 'cat x', source: 'api', exitCode: 0, durationMs: duration },
      { type: 'command', command: 'help', source: 'api', exitCode: 0, durationMs: duration },
    ])
    expect(events.every((event) => event.type !== 'command' || event.durationMs >= 0)).toBe(true)
  })

  it('measures durationMs on the performance clock from the start of the run to its end', async () => {
    let clock = 1000.4
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      const { events, onEvent } = recorder()
      backend.respond = () => {
        clock += 249.7
        return { output: '', exitCode: 0 }
      }
      await start({ onEvent }).submit('build')
      expect(events).toEqual([{ type: 'command', command: 'build', source: 'typed', exitCode: 0, durationMs: 250 }])
    } finally {
      now.mockRestore()
    }
  })

  it('sends # lines that were pasted or came from the API to the backend, typed ones to the AI', async () => {
    const session = start()
    await session.submit('# install deps', 'paste')
    await session.submit('#deploy', 'api')
    await session.submit('#deploy')
    expect(backend.commands).toEqual(['# install deps', '#deploy'])
    expect(ai.suggestCalls.map((input) => input.request)).toEqual(['deploy'])
  })

  it('takes the source of a continued command from its first line', async () => {
    const { events, onEvent } = recorder()
    backend.isComplete = (source) => !source.endsWith(':')
    const session = start({ onEvent })
    await session.submit('def f():', 'api')
    await session.submit('  pass')
    expect(events).toEqual([
      { type: 'command', command: 'def f():\n  pass', source: 'api', exitCode: 0, durationMs: duration },
    ])
  })

  it('reports an answered suggestion before the command it ran', async () => {
    const { events, onEvent } = recorder()
    const session = start({ onEvent })
    await session.submit('#deploy my app')
    await session.submit('y')
    await session.submit('#deploy again')
    await session.submit('n')
    await session.submit('#deploy once more')
    session.interrupt()
    expect(events).toEqual([
      { type: 'ai-suggest', request: 'deploy my app', command: 'orbit deploy', accepted: true },
      { type: 'command', command: 'orbit deploy', source: 'ai', exitCode: 0, durationMs: duration },
      { type: 'ai-suggest', request: 'deploy again', command: 'orbit deploy', accepted: false },
      { type: 'ai-suggest', request: 'deploy once more', command: 'orbit deploy', accepted: false },
    ])
  })

  it('reports a suggestion without a usable command, and an AI failure as an error first', async () => {
    const { events, onEvent } = recorder()
    const session = start({ onEvent })
    ai.suggestion = { command: '', explanation: '' }
    await session.submit('#nothing')
    ai.failWith = new Error('HTTP 401: \x1b[31minvalid key\x1b[0m')
    await session.submit('#deploy')
    expect(events).toEqual([
      { type: 'ai-suggest', request: 'nothing' },
      { type: 'error', phase: 'ai', message: 'HTTP 401: invalid key' },
      { type: 'ai-suggest', request: 'deploy' },
    ])
  })

  it('reports explain requests and their failures', async () => {
    const { events, onEvent } = recorder()
    backend.respond = () => ({ output: 'boom', exitCode: 1 })
    const session = start({ onEvent })
    await session.submit('build')
    await session.submit('explain')
    ai.failWith = new Error('network down')
    await session.submit('explain')
    expect(events).toEqual([
      { type: 'command', command: 'build', source: 'typed', exitCode: 1, durationMs: duration },
      { type: 'ai-explain', command: 'build' },
      { type: 'ai-explain', command: 'build' },
      { type: 'error', phase: 'ai', message: 'network down' },
    ])
  })

  it('reports a backend exception as a run error, then the failed command', async () => {
    const { events, onEvent } = recorder()
    backend.respond = () => Promise.reject(new Error('worker\x1b[2J crashed'))
    await start({ onEvent }).submit('migrate', 'paste')
    expect(events).toEqual([
      { type: 'error', phase: 'run', message: 'worker crashed' },
      { type: 'command', command: 'migrate', source: 'paste', exitCode: 1, durationMs: duration },
    ])
  })

  it('reports Ctrl+C with the running command, without one for an AI request, and not at a prompt', async () => {
    const { events, onEvent } = recorder()
    const hanging = deferred<RunOutcome>()
    backend.respond = () => hanging.promise
    const thinking: AIProvider = {
      id: 'slow-ai',
      suggestCommand: () => new Promise(() => {}),
      explainError: async () => '',
    }
    const session = start({ onEvent, ai: thinking })
    void session.submit('build')
    await flush()
    session.interrupt()
    session.interrupt()
    void session.submit('#deploy')
    await flush()
    session.interrupt()
    backend.isComplete = (source) => !source.endsWith(':')
    backend.respond = () => ({ output: '', exitCode: 0 })
    await session.submit('def f():')
    session.interrupt()
    expect(events).toEqual([{ type: 'interrupt', command: 'build' }, { type: 'interrupt' }])
  })

  it('reports Ctrl+C on an interactive program each time it is pressed', async () => {
    const { events, onEvent } = recorder()
    const results: RunReport[] = []
    let finish: (result: BackendRunResult) => void = () => {}
    backend.respond = (_command, context) => {
      context.write('\x1b[1mwatching\x1b[0m\n')
      const run: InteractiveRun = {
        onKey: () => {},
        done: new Promise((resolve) => {
          finish = resolve
        }),
      }
      return run
    }
    const session = start({ onEvent, onResult: (result) => results.push(result) })
    void session.submit('watch')
    await flush()
    session.interrupt()
    session.interrupt()
    finish({ output: '', exitCode: 0 })
    await flush()
    expect(events).toEqual([
      { type: 'interrupt', command: 'watch' },
      { type: 'interrupt', command: 'watch' },
    ])
    expect(results).toEqual([{ exitCode: 130, output: 'watching\n' }])
  })

  it('hands the run result to onResult: plain text, tail-capped, 130 with the partial output on Ctrl+C', async () => {
    const results: RunReport[] = []
    const session = start({ onResult: (result) => results.push(result) })
    backend.respond = (_command, context) => {
      context.write('\x1b[32mok\x1b[0m\r\n')
      return { output: 'done', exitCode: 0 }
    }
    await session.submit('build')
    const long = `${'x'.repeat(5000)}\nEND`
    backend.respond = () => ({ output: long, exitCode: 3 })
    await session.submit('flood')
    const hanging = deferred<RunOutcome>()
    backend.respond = (_command, context) => {
      context.write('\x1b[31mstep 1\x1b[0m\n')
      return hanging.promise
    }
    void session.submit('slow')
    await flush()
    session.interrupt()
    await session.submit('help')
    expect(results.slice(0, 3)).toEqual([
      { exitCode: 0, output: 'ok\ndone' },
      { exitCode: 3, output: long.slice(-4096) },
      { exitCode: 130, output: 'step 1\n' },
    ])
    expect(results[3]).toEqual({ exitCode: 0, output: [en.helpText, en.keysHelp].join('\n') })
  })

  it('reports 130 for Ctrl+C during explain and during a slow completeness check, naming the checked command', async () => {
    const { events, onEvent } = recorder()
    const results: RunReport[] = []
    const thinking: AIProvider = {
      id: 'slow-ai',
      suggestCommand: async () => ({ command: 'ls', explanation: '' }),
      explainError: () => new Promise(() => {}),
    }
    backend.respond = () => ({ output: 'boom', exitCode: 1 })
    const session = start({ onEvent, ai: thinking, onResult: (result) => results.push(result) })
    await session.submit('build')
    void session.submit('explain')
    await flush()
    session.interrupt()
    backend.isComplete = () => new Promise(() => {})
    void session.submit('make all', 'api')
    await flush()
    session.interrupt()
    expect(results).toEqual([
      { exitCode: 1, output: 'boom' },
      { exitCode: 130, output: '' },
      { exitCode: 130, output: '' },
    ])
    expect(events.slice(1)).toEqual([
      { type: 'ai-explain', command: 'build' },
      { type: 'interrupt' },
      { type: 'interrupt', command: 'make all' },
    ])
  })

  it('asks the AI to explain only for a typed explain and sends other explain lines to the backend', async () => {
    backend.respond = (command) => ({ output: '', exitCode: command === 'build' ? 1 : 0 })
    const session = start()
    await session.submit('build')
    await session.submit('explain', 'paste')
    await session.submit('explain', 'api')
    expect(backend.commands).toEqual(['build', 'explain', 'explain'])
    expect(ai.explainCalls).toEqual([])
    backend.respond = () => ({ output: '', exitCode: 1 })
    await session.submit('build')
    await session.submit('explain')
    expect(ai.explainCalls.map((input) => input.command)).toEqual(['build'])
  })

  it('logs an exception thrown by onEvent and keeps the session working', async () => {
    const bug = new Error('listener bug')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const session = start({
        onEvent: () => {
          throw bug
        },
      })
      await type(session, 'ls')
      await type(session, 'pwd')
      expect(backend.commands).toEqual(['ls', 'pwd'])
      expect(screen.text).toBe('ls\nok\n$ pwd\nok\n$ ')
      expect(consoleError.mock.calls).toEqual([[bug], [bug]])
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('completion', () => {
  it('asks the backend, and answers null without one, when it fails, while confirming and after dispose', async () => {
    const session = start()
    expect(await session.complete('ls', 2)).toBeNull()
    const backendWithCompletion = backend as FakeBackend & { complete?: Backend['complete'] }
    backendWithCompletion.complete = ({ line, cursor }) => ({ from: 0, to: cursor, candidates: [`${line}-status`] })
    expect(await session.complete('orbit', 5)).toEqual({ from: 0, to: 5, candidates: ['orbit-status'] })
    backendWithCompletion.complete = () => null
    expect(await session.complete('x', 1)).toBeNull()
    backendWithCompletion.complete = async () => {
      throw new Error('completion crashed')
    }
    expect(await session.complete('x', 1)).toBeNull()
    backendWithCompletion.complete = () => {
      throw new Error('completion crashed')
    }
    expect(await session.complete('x', 1)).toBeNull()
    backendWithCompletion.complete = () => ({ from: 0, to: 1, candidates: ['yes'] })
    await session.submit('#deploy')
    expect(await session.complete('y', 1)).toBeNull()
    expect(screen.prompts).toBe(1)
    session.dispose()
    session.dispose()
    expect(await session.complete('y', 1)).toBeNull()
    expect(screen.prompts).toBe(1)
  })
})

describe('setters', () => {
  it('switches ai on and off for the next request', async () => {
    const session = start()
    session.setAI(undefined)
    await session.submit('#comment')
    expect(backend.commands).toEqual(['#comment'])
    session.setAI(ai)
    await session.submit('#deploy')
    expect(ai.suggestCalls).toHaveLength(1)
  })

  it('switches language for texts and answers', async () => {
    const session = start()
    session.setMessages(ru, 'ru')
    await session.submit('#задеплой')
    expect(session.promptText).toBe(ru.confirmRun)
    expect(ai.suggestCalls[0]?.locale).toBe('ru')
    await session.submit('да')
    expect(backend.commands).toEqual(['orbit deploy'])
  })

  it('uses the latest page context for the next request', async () => {
    const session = start()
    session.setPageContext({ ...pageContext, title: 'Billing API' })
    await session.submit('#list invoices')
    expect(ai.suggestCalls[0]?.context.title).toBe('Billing API')
  })
})
