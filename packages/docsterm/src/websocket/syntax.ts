type Closer = 'fi' | 'done' | 'esac' | '}' | ')'

type Position = 'command' | 'argument' | 'for-name' | 'for-in' | 'for-list' | 'case-word' | 'case-in'

type Nested = { kind: 'dquote' } | { kind: 'backtick' } | { kind: 'param'; depth: number } | { kind: 'cmdsub'; depth: number }

interface Heredoc {
  delimiter: string
  strip: boolean
}

const OPERATORS = new Set([';', '&', '|', '(', ')', '<', '>'])
const WORD_BREAKS = new Set([' ', '\t', '\n', ...OPERATORS])
const COMMENT_AFTER = new Set([' ', '\t', '\n', ';', '&', '|', '('])

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t'

export function isShellComplete(source: string): boolean {
  const text = source.replace(/\r\n?/g, '\n')
  const nested: Nested[] = []
  const blocks: Closer[] = []
  const heredocs: Heredoc[] = []
  let position: Position = 'command'
  let word: string | null = null
  let literal = true
  let dangling = false
  let redirect = false
  let unsure = false
  let index = 0

  const inCase = (): boolean => blocks.at(-1) === 'esac'

  const close = (closer: Closer): void => {
    if (blocks.at(-1) === closer) blocks.pop()
    else unsure = true
  }

  const reserved = (value: string): void => {
    if (inCase()) {
      if (position === 'case-word') position = 'case-in'
      else if (position === 'case-in') {
        if (value === 'in') position = 'command'
        else unsure = true
      } else if (position === 'command' && value === 'esac') {
        blocks.pop()
        position = 'argument'
      } else if (position === 'command' && value === 'case') {
        blocks.push('esac')
        position = 'case-word'
      } else position = 'argument'
      return
    }
    if (position === 'for-name') {
      position = 'for-in'
      return
    }
    if (position === 'for-in') {
      if (value === 'in') position = 'for-list'
      else if (value === 'do') position = 'command'
      else unsure = true
      return
    }
    if (position !== 'command') return
    switch (value) {
      case 'if':
        blocks.push('fi')
        return
      case '{':
        blocks.push('}')
        return
      case 'while':
      case 'until':
        blocks.push('done')
        return
      case 'for':
        blocks.push('done')
        position = 'for-name'
        return
      case 'case':
        blocks.push('esac')
        position = 'case-word'
        return
      case 'then':
      case 'else':
      case 'elif':
      case 'do':
      case '!':
        return
      case 'fi':
      case 'done':
      case '}':
        close(value)
        position = 'argument'
        return
      case 'esac':
        unsure = true
        return
      default:
        position = 'argument'
    }
  }

  const endWord = (): void => {
    if (word === null) return
    const value = literal ? word : ''
    word = null
    literal = true
    if (redirect) {
      redirect = false
      return
    }
    dangling = false
    reserved(value)
  }

  const lineBreak = (): void => {
    if (position !== 'case-word' && position !== 'case-in') position = 'command'
  }

  const startWord = (quoted: boolean): void => {
    if (word === null) word = ''
    if (quoted) literal = false
  }

  const delimiterAt = (from: number): { value: string; next: number } | null => {
    let at = from
    while (isBlank(text[at])) at += 1
    let value = ''
    const start = at
    while (at < text.length && !WORD_BREAKS.has(text[at] ?? '')) {
      const char = text[at]
      if (char === "'" || char === '"') {
        let end = at + 1
        while (end < text.length && text[end] !== char) end += char === '"' && text[end] === '\\' ? 2 : 1
        if (end >= text.length) return null
        const inner = text.slice(at + 1, end)
        value += char === '"' ? inner.replace(/\\(.)/g, '$1') : inner
        at = end + 1
      } else if (char === '\\') {
        value += text[at + 1] ?? ''
        at += 2
      } else {
        value += char
        at += 1
      }
    }
    return at > start ? { value, next: at } : null
  }

  const bodiesFrom = (from: number): number => {
    let at = from
    for (const doc of heredocs) {
      for (;;) {
        if (at >= text.length) return -1
        const end = text.indexOf('\n', at)
        const line = text.slice(at, end === -1 ? text.length : end)
        at = end === -1 ? text.length : end + 1
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
        if (end === -1) return -1
      }
    }
    heredocs.length = 0
    return at
  }

  const operator = (char: string): void => {
    const next = text[index + 1]
    if (char === '|' || char === '&') {
      const doubled = next === char
      dangling = char === '|' || doubled
      index += doubled ? 2 : 1
      position = 'command'
      return
    }
    if (char === ';') {
      dangling = false
      index += next === ';' ? 2 : 1
      position = 'command'
      return
    }
    if (char === '(' || char === ')') {
      index += 1
      if (inCase()) position = 'command'
      else if (char === ')') {
        close(')')
        position = 'argument'
      } else if (position === 'command') blocks.push(')')
      else {
        let after = index
        while (isBlank(text[after])) after += 1
        if (text[after] === ')') {
          index = after + 1
          position = 'command'
        } else unsure = true
      }
      return
    }
    if (char === '<' && next === '<') {
      if (text[index + 2] === '<') {
        index += 3
        redirect = true
        return
      }
      const strip = text[index + 2] === '-'
      const found = delimiterAt(index + (strip ? 3 : 2))
      if (!found) {
        unsure = true
        index = text.length
        return
      }
      heredocs.push({ delimiter: found.value, strip })
      index = found.next
      return
    }
    index += next === '>' || next === '&' || next === '|' || (char === '<' && next === '>') ? 2 : 1
    redirect = true
  }

  const scanNested = (context: Nested): void => {
    const char = text[index] ?? ''
    const next = text[index + 1]
    if (char === '\\') {
      index += 2
      return
    }
    if (context.kind === 'backtick') {
      if (char === '`') nested.pop()
      index += 1
      return
    }
    if (char === '$' && (next === '(' || next === '{')) {
      nested.push({ kind: next === '(' ? 'cmdsub' : 'param', depth: 1 })
      index += 2
      return
    }
    if (char === '`') {
      nested.push({ kind: 'backtick' })
      index += 1
      return
    }
    if (context.kind === 'dquote') {
      if (char === '"') nested.pop()
      index += 1
      return
    }
    if (char === '"') {
      nested.push({ kind: 'dquote' })
      index += 1
      return
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      index = end === -1 ? text.length : end + 1
      return
    }
    const opener = context.kind === 'param' ? '{' : '('
    const closer = context.kind === 'param' ? '}' : ')'
    if (char === opener) context.depth += 1
    else if (char === closer) {
      context.depth -= 1
      if (context.depth === 0) nested.pop()
    } else if (char === '#' && context.kind === 'cmdsub' && COMMENT_AFTER.has(text[index - 1] ?? '')) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
      return
    }
    index += 1
  }

  while (index < text.length && !unsure) {
    const context = nested.at(-1)
    if (context) {
      scanNested(context)
      continue
    }
    const char = text[index] ?? ''
    const next = text[index + 1]
    if (char === '\\') {
      if (index + 1 >= text.length) return false
      if (next !== '\n') startWord(true)
      index += 2
    } else if (char === "'") {
      startWord(true)
      const end = text.indexOf("'", index + 1)
      if (end === -1) return false
      index = end + 1
    } else if (char === '"' || char === '`') {
      startWord(true)
      nested.push({ kind: char === '"' ? 'dquote' : 'backtick' })
      index += 1
    } else if (char === '$' && (next === '(' || next === '{')) {
      startWord(true)
      nested.push({ kind: next === '(' ? 'cmdsub' : 'param', depth: 1 })
      index += 2
    } else if (char === '#' && word === null) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    } else if (isBlank(char)) {
      endWord()
      index += 1
    } else if (char === '\n') {
      endWord()
      lineBreak()
      index += 1
      if (heredocs.length > 0) {
        const after = bodiesFrom(index)
        if (after === -1) return false
        index = after
      }
    } else if (OPERATORS.has(char)) {
      endWord()
      operator(char)
    } else {
      startWord(false)
      word = `${word ?? ''}${char}`
      index += 1
    }
  }
  if (unsure) return true
  if (nested.length > 0) return false
  endWord()
  if (unsure) return true
  return heredocs.length === 0 && !dangling && blocks.length === 0
}
