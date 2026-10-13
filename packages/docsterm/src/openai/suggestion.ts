import { AIProviderError } from '../errors.js'
import type { CommandSuggestion } from '../types.js'

export type Fields = Record<string, unknown>

export const NOT_JSON = Symbol('not-json')

export const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['command', 'explanation'],
  additionalProperties: false,
}

export const JSON_INSTRUCTION =
  'Reply with a JSON object shaped {"command": string, "explanation": string} and nothing else.'

const MAX_RESCANS = 8

export const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return NOT_JSON
  }
}

const isJsonSpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r'

interface Search {
  readonly text: string
  readonly tried: Set<number>
  answer: CommandSuggestion | null
  sawObject: boolean
}

const answerAt = (search: Search, start: number, end: number): CommandSuggestion | null => {
  if (search.tried.has(start)) return null
  search.tried.add(start)
  const { text } = search
  let first = start + 1
  while (first < end && isJsonSpace(text[first])) first += 1
  if (text[first] !== '"' && text[first] !== '}') return null
  const parsed = tryJson(text.slice(start, end + 1))
  if (!isFields(parsed)) return null
  search.sawObject = true
  const { command, explanation } = parsed
  if (typeof command !== 'string' || command.trim() === '') return null
  return { command, explanation: typeof explanation === 'string' ? explanation : '' }
}

const scan = (search: Search, from: number): number => {
  const { text } = search
  const starts: number[] = []
  const nested: Array<Array<[number, number]> | undefined> = []
  let inString = false
  let escaped = false
  let quoted = false
  let restart = -1
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '{') {
      if (starts.length === 0) quoted = false
      starts.push(index)
    } else if (char === '"') {
      inString = starts.length > 0
      quoted ||= inString
    } else if (char === '}') {
      const start = starts.pop()
      if (start === undefined) continue
      const depth = starts.length
      nested.length = Math.min(nested.length, depth)
      if (depth === 0) {
        search.answer = answerAt(search, start, index)
        if (search.answer) return -1
        if (quoted && restart === -1) restart = start + 1
        continue
      }
      const siblings = nested[depth - 1]
      if (siblings) siblings.push([start, index])
      else nested[depth - 1] = [[start, index]]
    }
  }
  for (const siblings of nested) {
    for (const [start, end] of siblings ?? []) {
      search.answer = answerAt(search, start, end)
      if (search.answer) return -1
    }
  }
  const open = starts[0]
  return restart === -1 && quoted && open !== undefined ? open + 1 : restart
}

export function parseSuggestionText(text: string): CommandSuggestion {
  const search: Search = { text, tried: new Set(), answer: null, sawObject: false }
  for (let pass = 0, from = 0; pass <= MAX_RESCANS && from !== -1; pass += 1) from = scan(search, from)
  if (search.answer) return search.answer
  throw new AIProviderError(
    'invalid',
    search.sawObject ? 'model response has no command field' : 'model response is not a JSON object',
  )
}
