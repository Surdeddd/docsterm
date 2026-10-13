import { sanitizeProse } from './text.js'
import type { ExplainInput, HistoryEntry, Locale, PageContext, SuggestInput } from './types.js'

const envHints: Readonly<Record<string, string>> = {
  shell: 'a POSIX-like shell emulated in the browser, with a virtual file system and a fixed set of commands',
  javascript:
    'a JavaScript REPL in the browser; a command is one JavaScript expression or statement, not a shell command',
  pyodide: 'a Python 3 REPL running client-side in the browser; a command is one Python statement or expression',
  wasi: 'a terminal that runs one WebAssembly (WASI) program; a command is the program name followed by its arguments, with no pipes, redirects or variables',
  websocket: 'a shell on a remote server, reached over a WebSocket',
  mock: 'a scripted demo shell with a fixed set of commands',
}

const hintFor = (backendId: string): string =>
  Object.hasOwn(envHints, backendId) ? envHints[backendId] : 'a command-line environment'

const join = (blocks: string[]): string => blocks.filter(Boolean).join('\n\n')

const pageBlock = (context: PageContext): string =>
  [
    context.title ? `Page title: ${context.title}` : '',
    context.description ? `Page description: ${context.description}` : '',
    context.headings.length > 0 ? `Page headings: ${context.headings.slice(0, 15).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

const environmentBlock = (description: string | undefined): string => {
  const text = description === undefined ? '' : sanitizeProse(description).trim()
  return text === '' ? '' : `Environment details:\n${text}`
}

const historyBlock = (history: readonly HistoryEntry[]): string =>
  history.length === 0
    ? ''
    : `Recent commands:\n${history
        .map((entry) => `$ ${sanitizeProse(entry.command)} (exit ${entry.exitCode})`)
        .join('\n')}`

const answerLine = (locale: Locale | undefined): string =>
  locale === 'ru' ? 'Answer in Russian.' : 'Answer in English.'

export function buildSuggestSystem(context: PageContext, backendId: string): string {
  return join([
    `You translate a documentation reader's natural-language request into exactly one command for ${hintFor(backendId)}.`,
    'Reply with JSON only, matching the provided schema: a single runnable command and a one-sentence explanation.',
    'Never invent commands the environment cannot run.',
    pageBlock(context),
  ])
}

export function renderSuggestUser(input: SuggestInput): string {
  return join([
    environmentBlock(input.backendDescription),
    `Request: ${input.request}`,
    historyBlock(input.history),
    answerLine(input.locale),
  ])
}

export function buildExplainSystem(context: PageContext, backendId: string): string {
  return join([
    `A documentation reader ran a command in ${hintFor(backendId)} and it failed. Explain why it failed and how to fix it, in at most four short sentences of plain text.`,
    pageBlock(context),
  ])
}

export function renderExplainUser(input: ExplainInput): string {
  return join([
    environmentBlock(input.backendDescription),
    `Command: ${input.command}`,
    `Exit code: ${input.exitCode}`,
    `Output:\n${input.output || '(no output)'}`,
    historyBlock(input.history),
    answerLine(input.locale),
  ])
}
