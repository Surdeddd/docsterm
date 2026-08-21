export interface Word {
  value: string
  quoted: boolean
}

export interface Redirect {
  type: 'write' | 'append' | 'read'
  target: string
}

export interface ParsedCommand {
  words: Word[]
  redirects: Redirect[]
}

export interface Pipeline {
  commands: ParsedCommand[]
}

export interface Segment {
  pipeline: Pipeline
  operator: 'always' | 'and' | 'or'
}

const OPERATORS = ['&&', '||', '>>', ';', '|', '>', '<']

export type Token = { type: 'word'; value: string; quoted: boolean } | { type: 'op'; value: string }

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let current = ''
  let quoted = false
  let hasWord = false
  let index = 0

  const flush = () => {
    if (!hasWord) return
    tokens.push({ type: 'word', value: current, quoted })
    current = ''
    quoted = false
    hasWord = false
  }

  while (index < input.length) {
    const char = input[index] as string

    if (char === "'" || char === '"') {
      const closing = input.indexOf(char, index + 1)
      if (closing === -1) throw new Error(`unbalanced ${char} quote`)
      const body = input.slice(index + 1, closing)
      current += char === "'" ? body : body
      quoted = true
      hasWord = true
      index = closing + 1
      continue
    }

    if (char === '\\' && index + 1 < input.length) {
      current += input[index + 1]
      quoted = true
      hasWord = true
      index += 2
      continue
    }

    if (char === ' ' || char === '\t') {
      flush()
      index += 1
      continue
    }

    const operator = OPERATORS.find((candidate) => input.startsWith(candidate, index))
    if (operator) {
      flush()
      tokens.push({ type: 'op', value: operator })
      index += operator.length
      continue
    }

    current += char
    hasWord = true
    index += 1
  }

  flush()
  return tokens
}

export function parse(input: string): Segment[] {
  const tokens = tokenize(input)
  const segments: Segment[] = []
  let commands: ParsedCommand[] = []
  let command: ParsedCommand = { words: [], redirects: [] }
  let operator: Segment['operator'] = 'always'

  const pushCommand = () => {
    if (command.words.length > 0 || command.redirects.length > 0) commands.push(command)
    command = { words: [], redirects: [] }
  }

  const pushSegment = (next: Segment['operator']) => {
    pushCommand()
    if (commands.length > 0) segments.push({ pipeline: { commands }, operator })
    commands = []
    operator = next
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token
    if (token.type === 'word') {
      command.words.push({ value: token.value, quoted: token.quoted })
      continue
    }
    if (token.value === '|') {
      pushCommand()
      continue
    }
    if (token.value === ';') {
      pushSegment('always')
      continue
    }
    if (token.value === '&&') {
      pushSegment('and')
      continue
    }
    if (token.value === '||') {
      pushSegment('or')
      continue
    }
    const next = tokens[index + 1]
    if (!next || next.type !== 'word') throw new Error(`missing target after ${token.value}`)
    command.redirects.push({
      type: token.value === '>' ? 'write' : token.value === '>>' ? 'append' : 'read',
      target: next.value,
    })
    index += 1
  }

  pushSegment('always')
  return segments
}
