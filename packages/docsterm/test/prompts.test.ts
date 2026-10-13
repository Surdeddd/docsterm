import { describe, expect, it } from 'vitest'
import { buildExplainSystem, buildSuggestSystem, renderExplainUser, renderSuggestUser } from '../src/prompts.js'
import type { ExplainInput, PageContext, SuggestInput } from '../src/types.js'

const context: PageContext = {
  title: 'Orbit CLI docs',
  url: 'https://example.test/docs',
  description: 'Deploy apps with orbit',
  headings: ['Install', 'Deploy'],
}

const hints: Record<string, string> = {
  shell: 'a POSIX-like shell emulated in the browser, with a virtual file system and a fixed set of commands',
  javascript:
    'a JavaScript REPL in the browser; a command is one JavaScript expression or statement, not a shell command',
  pyodide: 'a Python 3 REPL running client-side in the browser; a command is one Python statement or expression',
  wasi: 'a terminal that runs one WebAssembly (WASI) program; a command is the program name followed by its arguments, with no pipes, redirects or variables',
  websocket: 'a shell on a remote server, reached over a WebSocket',
  mock: 'a scripted demo shell with a fixed set of commands',
}

const generic = 'a command-line environment'

const suggestInput = (overrides: Partial<SuggestInput> = {}): SuggestInput => ({
  request: 'deploy the app',
  backendId: 'shell',
  context,
  history: [],
  ...overrides,
})

const explainInput = (overrides: Partial<ExplainInput> = {}): ExplainInput => ({
  command: 'orbit destroy',
  output: 'boom',
  exitCode: 1,
  backendId: 'shell',
  context,
  history: [],
  ...overrides,
})

describe('environment hints', () => {
  it.each(Object.entries(hints))('describes the %s backend precisely', (backendId, hint) => {
    expect(buildSuggestSystem(context, backendId).split('\n')[0]).toBe(
      `You translate a documentation reader's natural-language request into exactly one command for ${hint}.`,
    )
    expect(buildExplainSystem(context, backendId).split('\n')[0]).toBe(
      `A documentation reader ran a command in ${hint} and it failed. Explain why it failed and how to fix it, in at most four short sentences of plain text.`,
    )
  })

  it.each(['custom', 'constructor', '__proto__', 'toString'])('falls back to a generic hint for %s', (backendId) => {
    expect(buildSuggestSystem(context, backendId).split('\n')[0]).toBe(
      `You translate a documentation reader's natural-language request into exactly one command for ${generic}.`,
    )
  })

  it('keeps the page context in the system prompt', () => {
    expect(buildSuggestSystem(context, 'shell').split('\n\n').slice(-1)[0]).toBe(
      'Page title: Orbit CLI docs\nPage description: Deploy apps with orbit\nPage headings: Install; Deploy',
    )
  })
})

describe('suggestion request', () => {
  it('adds the environment details, the history and the answer language', () => {
    const text = renderSuggestUser(
      suggestInput({
        backendDescription: 'virtual shell with ls and orbit',
        history: [{ command: 'ls', output: 'README.md', exitCode: 0 }],
        locale: 'ru',
      }),
    )
    expect(text).toBe(
      'Environment details:\nvirtual shell with ls and orbit\n\nRequest: deploy the app\n\nRecent commands:\n$ ls (exit 0)\n\nAnswer in Russian.',
    )
  })

  it('answers in English by default and skips empty blocks', () => {
    expect(renderSuggestUser(suggestInput())).toBe('Request: deploy the app\n\nAnswer in English.')
    expect(renderSuggestUser(suggestInput({ locale: 'en', backendDescription: '  ' }))).toBe(
      'Request: deploy the app\n\nAnswer in English.',
    )
  })

  it('strips escape sequences from history commands and the description', () => {
    const text = renderSuggestUser(
      suggestInput({
        backendDescription: '\x1b[1mshell\x1b[0m\x07',
        history: [{ command: '\x1b[31mls\x1b[0m', output: '', exitCode: 2 }],
      }),
    )
    expect(text).toBe(
      'Environment details:\nshell\n\nRequest: deploy the app\n\nRecent commands:\n$ ls (exit 2)\n\nAnswer in English.',
    )
  })
})

describe('explanation request', () => {
  it('adds the environment details, the history and the answer language', () => {
    const text = renderExplainUser(
      explainInput({
        backendDescription: 'virtual shell',
        history: [{ command: 'orbit destroy', output: 'boom', exitCode: 1 }],
        locale: 'ru',
      }),
    )
    expect(text).toBe(
      'Environment details:\nvirtual shell\n\nCommand: orbit destroy\n\nExit code: 1\n\nOutput:\nboom\n\nRecent commands:\n$ orbit destroy (exit 1)\n\nAnswer in Russian.',
    )
  })

  it('marks missing output and answers in English by default', () => {
    expect(renderExplainUser(explainInput({ output: '' }))).toBe(
      'Command: orbit destroy\n\nExit code: 1\n\nOutput:\n(no output)\n\nAnswer in English.',
    )
  })
})
