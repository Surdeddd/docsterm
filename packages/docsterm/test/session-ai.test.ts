import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'
import { beforeEach, describe, expect, it } from 'vitest'
import { AIProviderError, type AIErrorCode } from '../src/errors.js'
import { formatMessage, getMessages, type Messages } from '../src/messages.js'
import { SessionController, type SessionIO } from '../src/session-controller.js'
import { normalizeOutput } from '../src/text.js'
import type {
  AIProvider,
  Backend,
  BackendRunResult,
  CommandSuggestion,
  ExplainInput,
  Locale,
  PageContext,
  SuggestInput,
} from '../src/types.js'

const en = getMessages('en')
const ru = getMessages('ru')

const pageContext: PageContext = {
  title: 'Orbit CLI docs',
  url: 'https://example.test/docs',
  description: 'Deploy apps with orbit',
  headings: ['Install'],
}

class Screen implements SessionIO {
  text = ''
  promptOf: () => string = () => '$ '
  size?: () => { columns: number; rows: number } = () => ({ columns: 120, rows: 40 })

  write(text: string): void {
    this.text += text
  }
  print(line: string): void {
    this.text += `${line}\n`
  }
  printPrompt(): void {
    this.text += this.promptOf()
  }
  clearScreen(): void {
    this.text = ''
  }
  setBusy(): void {}
}

class FakeBackend implements Backend {
  id = 'shell'
  prompt = '$ '
  commands: string[] = []
  result: BackendRunResult = { output: 'boom', exitCode: 1 }
  describe?: () => string

  async init(): Promise<void> {}

  async run(command: string): Promise<BackendRunResult> {
    this.commands.push(command)
    return this.result
  }

  dispose(): void {}
}

class FakeAI implements AIProvider {
  readonly id = 'fake-ai'
  suggestion: unknown = { command: 'orbit deploy', explanation: 'deploys the app' }
  chunks: string[] = []
  explanation: unknown = 'the flag is unknown'
  failWith: unknown = null
  suggestCalls: SuggestInput[] = []
  explainCalls: ExplainInput[] = []

  async suggestCommand(input: SuggestInput): Promise<CommandSuggestion> {
    this.suggestCalls.push(input)
    if (this.failWith) throw this.failWith
    return this.suggestion as CommandSuggestion
  }

  async explainError(input: ExplainInput, onChunk?: (text: string) => void): Promise<string> {
    this.explainCalls.push(input)
    for (const chunk of this.chunks) onChunk?.(chunk)
    if (this.failWith) throw this.failWith
    return this.explanation as string
  }
}

let screen: Screen
let backend: FakeBackend
let ai: FakeAI

const start = (locale: Locale = 'en'): SessionController => {
  const session = new SessionController({
    backend,
    ai,
    messages: getMessages(locale),
    locale,
    io: screen,
    pageContext,
  })
  screen.promptOf = () => session.promptText
  return session
}

const fail = async (session: SessionController, command = 'orbit destroy') => {
  await session.submit(command)
  screen.text = ''
}

const countTo = (count: number): string =>
  Array.from({ length: count }, (_, index) => `echo ${index + 1}`).join('\n')

beforeEach(() => {
  screen = new Screen()
  backend = new FakeBackend()
  ai = new FakeAI()
})

describe('what the AI is given', () => {
  it('passes locale, a live signal and the backend description to suggestions', async () => {
    backend.describe = () => 'virtual shell with ls, cat and orbit'
    await start('ru').submit('#задеплой')
    const input = ai.suggestCalls[0]
    expect(input?.request).toBe('задеплой')
    expect(input?.backendId).toBe('shell')
    expect(input?.backendDescription).toBe('virtual shell with ls, cat and orbit')
    expect(input?.locale).toBe('ru')
    expect(input?.signal).toBeInstanceOf(AbortSignal)
    expect(input?.signal?.aborted).toBe(false)
    expect(input?.context).toEqual(pageContext)
  })

  it('passes the same details to explanations', async () => {
    backend.describe = () => 'virtual shell'
    const session = start('ru')
    await fail(session)
    await session.submit('explain')
    const input = ai.explainCalls[0]
    expect(input).toMatchObject({
      command: 'orbit destroy',
      output: 'boom',
      exitCode: 1,
      backendId: 'shell',
      backendDescription: 'virtual shell',
      locale: 'ru',
    })
    expect(input?.signal?.aborted).toBe(false)
  })

  it('leaves the description out when the backend has none', async () => {
    await start().submit('#deploy')
    expect(ai.suggestCalls[0]?.backendDescription).toBeUndefined()
  })

  it('sends at most the last five history entries', async () => {
    backend.result = { output: 'x', exitCode: 0 }
    const session = start()
    for (let index = 0; index < 7; index += 1) await session.submit(`cmd${index}`)
    await session.submit('#next')
    expect(ai.suggestCalls[0]?.history.map((entry) => entry.command)).toEqual([
      'cmd2',
      'cmd3',
      'cmd4',
      'cmd5',
      'cmd6',
    ])
  })
})

describe('AI errors', () => {
  const coded: Array<[AIErrorCode, keyof Messages]> = [
    ['key-missing', 'keyMissing'],
    ['refused', 'aiRefused'],
    ['truncated', 'aiTruncated'],
    ['empty', 'aiEmpty'],
    ['invalid', 'aiInvalid'],
    ['network', 'aiNetwork'],
  ]

  it.each(coded)('maps %s to the %s message for suggestions', async (code, key) => {
    ai.failWith = new AIProviderError(code, 'raw provider text')
    await start().submit('#deploy')
    expect(screen.text).toBe(`${en.aiThinking}\n${en[key]}\n$ `)
  })

  it.each(coded)('maps %s to the %s message in Russian explanations', async (code, key) => {
    const session = start('ru')
    await fail(session)
    ai.failWith = new AIProviderError(code, 'raw provider text')
    await session.submit('explain')
    expect(screen.text).toBe(
      `${ru.explainHeader} - orbit destroy (${formatMessage(ru.exitStatus, { code: 1 })}):\n${ru[key]}\n$ `,
    )
  })

  it('shows http errors with their message', async () => {
    ai.failWith = new AIProviderError('http', '429: rate limited', { status: 429 })
    await start().submit('#deploy')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiError}: 429: rate limited\n$ `)
  })

  it('shows unknown errors with their message', async () => {
    ai.failWith = new Error('401 unauthorized')
    await start().submit('#deploy')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiError}: 401 unauthorized\n$ `)
  })

  it.each(['KeyMissingError', 'ProviderKeyMissingError'])('treats %s as a missing key', async (name) => {
    ai.failWith = Object.assign(new Error('anthropic api key is not configured'), { name })
    await start('ru').submit('#задеплой')
    expect(screen.text).toBe(`${ru.aiThinking}\n${ru.keyMissing}\n$ `)
  })

  it('strips control sequences from provider error text', async () => {
    ai.failWith = new Error('bad gateway\x1b[2K\rsuggested command: ls')
    await start().submit('#deploy')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiError}: bad gateway\nsuggested command: ls\n$ `)
  })

  it('ignores error codes inherited from the prototype', async () => {
    ai.failWith = Object.assign(new Error('odd'), { code: 'constructor' })
    await start().submit('#deploy')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiError}: odd\n$ `)
  })
})

describe('suggestion hygiene', () => {
  it.each([
    ['bidi isolates', 'echo hi⁧⁦; echo PWNED⁩⁦ # note⁩⁩'],
    ['a bidi override', 'echo safe‮; rm -rf ~'],
    ['a line separator', 'console.log(1) // note stealKeys()'],
    ['a paragraph separator', 'ls rm -rf ~'],
    ['a zero-width joiner', 'echo a‍b'],
    ['a zero-width space', 'rm​ -rf /tmp/x'],
    ['tag characters', 'echo ok \u{e0072}\u{e006d}'],
  ])('refuses a suggestion that hides %s, without asking', async (_label, command) => {
    ai.suggestion = { command, explanation: 'Looks harmless.' }
    const session = start()
    await session.submit('#do it')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiInvalid}\n$ `)
    expect(session.isConfirming).toBe(false)
    await session.submit('y')
    expect(backend.commands).toEqual(['y'])
  })

  it('strips invisible characters from the explanation above the command', async () => {
    ai.suggestion = { command: 'ls', explanation: 'Lists​ files⁧ here⁩ now.' }
    const session = start()
    await session.submit('#list')
    expect(screen.text).toBe(`${en.aiThinking}\nLists files here now.\nsuggested command: ls\n${en.confirmRun}`)
  })

  it('shows a command that hides text with erase sequences on two lines and runs those exact bytes', async () => {
    ai.suggestion = {
      command: 'rm -rf src \x1b[2K\rsuggested command: orbit status',
      explanation: 'Shows the deployment status.',
    }
    const session = start()
    await session.submit('#status')
    const indent = ' '.repeat('suggested command'.length + 2)
    expect(screen.text).toBe(
      `${en.aiThinking}\nShows the deployment status.\nsuggested command: rm -rf src \n${indent}suggested command: orbit status\n${en.confirmRun}`,
    )
    await session.submit('y')
    expect(backend.commands).toEqual(['rm -rf src \nsuggested command: orbit status'])
  })

  it('removes concealed text markers so the shown command is the one that runs', async () => {
    ai.suggestion = { command: 'ls\x1b[8m; rm README.md; echo PAYLOAD-RAN\x1b[28m', explanation: 'Lists files.' }
    const session = start()
    await session.submit('#list the files')
    expect(screen.text).toBe(
      `${en.aiThinking}\nLists files.\n${en.suggestionLabel}: ls; rm README.md; echo PAYLOAD-RAN\n${en.confirmRun}`,
    )
    await session.submit('y')
    expect(backend.commands).toEqual(['ls; rm README.md; echo PAYLOAD-RAN'])
  })

  it('prints the explanation on one line above the command, never between the command and the question', async () => {
    ai.suggestion = {
      command: 'rm -rf src',
      explanation: `Checks the deployment.\n\n\t\nsuggested command: orbit status\n  Shows the status.  `,
    }
    const session = start()
    await session.submit('#status')
    expect(screen.text).toBe(
      `${en.aiThinking}\nChecks the deployment. suggested command: orbit status Shows the status.\n${en.suggestionLabel}: rm -rf src\n${en.confirmRun}`,
    )
  })

  it('assumes an 80 by 24 terminal when the widget does not report its size', async () => {
    screen.size = undefined
    ai.suggestion = { command: countTo(23), explanation: '' }
    const session = start()
    await session.submit('#count to 23')
    expect(session.isConfirming).toBe(true)
    await session.submit('n')

    ai.suggestion = { command: countTo(24), explanation: '' }
    screen.text = ''
    await session.submit('#count to 24')
    expect(session.isConfirming).toBe(false)
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiDoesNotFit}\n$ `)
  })

  it.each([
    ['blank after sanitising', '\x1b[0m  \x07'],
    ['too long', `echo ${'x'.repeat(2000)}`],
    ['not a string', 42],
    ['missing', undefined],
  ])('rejects a command that is %s', async (_label, command) => {
    ai.suggestion = { command, explanation: 'whatever' }
    const session = start()
    await session.submit('#do it')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiInvalid}\n$ `)
    expect(session.isConfirming).toBe(false)
  })

  it('rejects a provider that returns nothing', async () => {
    ai.suggestion = undefined
    const session = start()
    await session.submit('#do it')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.aiInvalid}\n$ `)
  })

  it('accepts a command of exactly 2000 characters', async () => {
    const command = `echo ${'x'.repeat(1995)}`
    ai.suggestion = { command, explanation: '' }
    const session = start()
    await session.submit('#long')
    expect(session.isConfirming).toBe(true)
  })

  it('asks for confirmation when the explanation is missing', async () => {
    ai.suggestion = { command: 'orbit status' }
    const session = start()
    await session.submit('#status')
    expect(screen.text).toBe(`${en.aiThinking}\n${en.suggestionLabel}: orbit status\n${en.confirmRun}`)
    expect(session.isConfirming).toBe(true)
  })

  it('strips escape sequences and links from the explanation', async () => {
    ai.suggestion = {
      command: 'ls',
      explanation: 'Lists files\x1b[2K\r\x1b]8;;http://evil.example\x07click here\x1b]8;;\x07',
    }
    await start().submit('#list')
    expect(screen.text).toBe(`${en.aiThinking}\nLists files click here\n${en.suggestionLabel}: ls\n${en.confirmRun}`)
  })

  it('shows a multi-line command line by line under the label and runs it as one string', async () => {
    ai.suggestion = { command: 'cd src\nls', explanation: 'Lists the sources.' }
    const session = start()
    await session.submit('#list sources')
    expect(screen.text).toBe(
      `${en.aiThinking}\nLists the sources.\nsuggested command: cd src\n${' '.repeat(19)}ls\n${en.confirmRun}`,
    )
    await session.submit('y')
    expect(backend.commands).toEqual(['cd src\nls'])
  })

  it('explains in Russian why a command that does not fit is refused', async () => {
    screen.size = () => ({ columns: 80, rows: 6 })
    ai.suggestion = { command: countTo(6), explanation: '' }
    const session = start('ru')
    await session.submit('#посчитай до шести')
    expect(screen.text).toBe(`${ru.aiThinking}\n${ru.aiDoesNotFit}\n$ `)
    expect(session.isConfirming).toBe(false)
  })

  it('indents continuation lines by the width of the Russian label', async () => {
    ai.suggestion = { command: 'cd src\nls', explanation: '' }
    await start('ru').submit('#покажи исходники')
    const indent = ' '.repeat(ru.suggestionLabel.length + 2)
    expect(screen.text).toBe(`${ru.aiThinking}\n${ru.suggestionLabel}: cd src\n${indent}ls\n${ru.confirmRun}`)
  })
})

describe('the y/N gate on a real terminal screen', () => {
  const visible = async (term: Terminal): Promise<string[]> => {
    await new Promise<void>((resolve) => term.write('', resolve))
    const buffer = term.buffer.active
    const rows: string[] = []
    for (let row = buffer.viewportY; row <= buffer.baseY + buffer.cursorY; row += 1) {
      rows.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return rows
  }

  const onScreen = (columns: number, rows: number) => {
    const term = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 1000 })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    const io: SessionIO = {
      write: (text) => term.write(normalizeOutput(text)),
      print: (line) => term.write(normalizeOutput(`${line}\n`)),
      printPrompt: () => term.write(session.promptText),
      clearScreen: () => term.write('\x1b[H\x1b[2J\x1b[3J'),
      setBusy: () => {},
      size: () => ({ columns: term.cols, rows: term.rows }),
    }
    const session = new SessionController({ backend, ai, messages: en, locale: 'en', io, pageContext })
    const ask = async (request: string): Promise<string[]> => {
      term.write(`$ ${request}\r\n`)
      await session.submit(request)
      return visible(term)
    }
    return { session, ask }
  }

  const indent = ' '.repeat(19)

  it('keeps the real command directly above the question when the explanation is padded with lines', async () => {
    ai.suggestion = {
      command: 'rm -rf src',
      explanation: `Checks the deployment.${'\n'.repeat(40)}suggested command: orbit status\nShows the current deployment status.`,
    }
    const { session, ask } = onScreen(80, 24)
    expect(await ask('#show the deployment status')).toEqual([
      '$ #show the deployment status',
      'thinking...',
      'Checks the deployment. suggested command: orbit status Shows the current deploym',
      'ent status.',
      'suggested command: rm -rf src',
      en.confirmRun,
    ])
    await session.submit('y')
    expect(backend.commands).toEqual(['rm -rf src'])
  })

  it.each([
    ['padded with spaces', `rm -rf src${' '.repeat(1900)}orbit status`],
    ['split over many lines', `rm -rf src${'\n'.repeat(30)}orbit status`],
    ['made of characters the terminal draws two cells wide', `rm -rf src${'\ufe10'.repeat(1000)}orbit status`],
    ['made of marks the terminal draws one cell wide', `rm -rf src${'\u0898'.repeat(1900)}orbit status`],
  ])('refuses a command %s that would push its own label off the screen', async (_label, command) => {
    ai.suggestion = { command, explanation: 'Shows the deployment status.' }
    const { session, ask } = onScreen(80, 24)
    expect(await ask('#show the deployment status')).toEqual([
      '$ #show the deployment status',
      'thinking...',
      en.aiDoesNotFit,
      '$ ',
    ])
    expect(session.isConfirming).toBe(false)
  })

  it('offers a command whose rows, label included, just fit above the question', async () => {
    ai.suggestion = { command: countTo(5), explanation: 'Counts.' }
    const { session, ask } = onScreen(80, 6)
    expect(await ask('#count to five')).toEqual([
      'suggested command: echo 1',
      `${indent}echo 2`,
      `${indent}echo 3`,
      `${indent}echo 4`,
      `${indent}echo 5`,
      en.confirmRun,
    ])
    expect(session.isConfirming).toBe(true)
  })

  it('refuses a command one row taller than the space above the question', async () => {
    ai.suggestion = { command: countTo(6), explanation: '' }
    const { session, ask } = onScreen(80, 6)
    expect(await ask('#count to six')).toEqual(['$ #count to six', 'thinking...', en.aiDoesNotFit, '$ '])
    expect(session.isConfirming).toBe(false)
  })

  it('counts wrapped rows exactly at the terminal width', async () => {
    ai.suggestion = { command: `echo ${'a'.repeat(216)}\nls\nls`, explanation: '' }
    const { session, ask } = onScreen(80, 6)
    expect(await ask('#fill')).toEqual([
      `suggested command: echo ${'a'.repeat(56)}`,
      'a'.repeat(80),
      'a'.repeat(80),
      `${indent}ls`,
      `${indent}ls`,
      en.confirmRun,
    ])
    expect(session.isConfirming).toBe(true)

    ai.suggestion = { command: `echo ${'a'.repeat(217)}\nls\nls`, explanation: '' }
    const next = onScreen(80, 6)
    expect(await next.ask('#fill')).toEqual(['$ #fill', 'thinking...', en.aiDoesNotFit, '$ '])
    expect(next.session.isConfirming).toBe(false)
  })
})

describe('explain output', () => {
  it('names the command and its exit code in the header and streams the answer', async () => {
    ai.chunks = ['the flag ', 'is unknown']
    const session = start()
    await fail(session)
    await session.submit('explain')
    expect(screen.text).toBe(`${en.explainHeader} - orbit destroy (exit 1):\nthe flag is unknown\n$ `)
  })

  it('shows only the first line of a multi-line command in the header', async () => {
    const session = start()
    await fail(session, 'for i in range(3):\n    print(i / 0)\n')
    await session.submit('explain')
    expect(screen.text.split('\n')[0]).toBe(`${en.explainHeader} - for i in range(3): ... (exit 1):`)
  })

  it('prints the full answer when the provider does not stream', async () => {
    const session = start()
    await fail(session)
    await session.submit('explain')
    expect(screen.text).toBe(`${en.explainHeader} - orbit destroy (exit 1):\nthe flag is unknown\n$ `)
  })

  it('strips control sequences from streamed chunks and from the full answer', async () => {
    ai.chunks = ['the flag\x1b[2J', ' is unknown\x07']
    const session = start()
    await fail(session)
    await session.submit('explain')
    expect(screen.text).toBe(`${en.explainHeader} - orbit destroy (exit 1):\nthe flag is unknown\n$ `)

    ai.chunks = []
    ai.explanation = '\x1b]52;c;ZXZpbA==\x07plain answer'
    screen.text = ''
    await session.submit('explain')
    expect(screen.text).toBe(`${en.explainHeader} - orbit destroy (exit 1):\nplain answer\n$ `)
  })

  it('reports an empty answer', async () => {
    ai.explanation = '  '
    const session = start()
    await fail(session)
    await session.submit('explain')
    expect(screen.text).toBe(`${en.explainHeader} - orbit destroy (exit 1):\n${en.aiEmpty}\n$ `)
  })

  it('puts an error after a partial answer on its own line', async () => {
    ai.chunks = ['The command failed because']
    ai.failWith = new Error('stream reset by peer')
    const session = start()
    await fail(session)
    await session.submit('explain')
    expect(screen.text).toBe(
      `${en.explainHeader} - orbit destroy (exit 1):\nThe command failed because\n${en.aiError}: stream reset by peer\n$ `,
    )
  })

  it('says there is nothing to explain without a failure', async () => {
    await start().submit('explain')
    expect(screen.text).toBe(`${en.nothingToExplain}\n$ `)
  })
})
