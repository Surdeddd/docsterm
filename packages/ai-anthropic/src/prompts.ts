import type { ExplainInput, PageContext, SuggestInput } from 'docsterm'

const envHints: Record<string, string> = {
  pyodide:
    'a Python 3 REPL running client-side in the browser; a command is one Python statement or expression',
  mock: 'a scripted demo shell with a fixed set of commands',
}

const hintFor = (backendId: string): string => envHints[backendId] ?? 'a command-line environment'

const pageBlock = (context: PageContext): string =>
  [
    context.title ? `Page title: ${context.title}` : '',
    context.description ? `Page description: ${context.description}` : '',
    context.headings.length > 0 ? `Page headings: ${context.headings.slice(0, 15).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

const historyBlock = (history: SuggestInput['history']): string =>
  history.length === 0
    ? ''
    : `Recent commands:\n${history
        .map((entry) => `$ ${entry.command} (exit ${entry.exitCode})`)
        .join('\n')}`

export function buildSuggestSystem(context: PageContext, backendId: string): string {
  return [
    `You translate a documentation reader's natural-language request into exactly one command for ${hintFor(backendId)}.`,
    'Reply with JSON only, matching the provided schema: a single runnable command and a one-sentence explanation.',
    'Never invent commands the environment cannot run.',
    pageBlock(context),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function renderSuggestUser(input: SuggestInput): string {
  return [`Request: ${input.request}`, historyBlock(input.history)].filter(Boolean).join('\n\n')
}

export function buildExplainSystem(context: PageContext, backendId: string): string {
  return [
    `A documentation reader ran a command in ${hintFor(backendId)} and it failed. Explain why it failed and how to fix it, in at most four short sentences of plain text.`,
    pageBlock(context),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function renderExplainUser(input: ExplainInput): string {
  return [
    `Command: ${input.command}`,
    `Exit code: ${input.exitCode}`,
    `Output:\n${input.output || '(no output)'}`,
    historyBlock(input.history),
  ]
    .filter(Boolean)
    .join('\n\n')
}
