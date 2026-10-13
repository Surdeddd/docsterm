export interface LongOption {
  key: string
  argument?: 'required' | 'optional'
}

export interface OptionSpec {
  flags?: string
  values?: string
  numeric?: string
  long?: Readonly<Record<string, string | LongOption>>
}

export interface ParsedOptions {
  flags: Set<string>
  values: Map<string, string[]>
  order: string[]
  operands: string[]
}

export interface OptionError {
  error: string
}

export function isOptionError(result: ParsedOptions | OptionError): result is OptionError {
  return 'error' in result
}

export function lastValue(parsed: ParsedOptions, key: string): string | undefined {
  return parsed.values.get(key)?.at(-1)
}

export function lastOf(parsed: ParsedOptions, keys: readonly string[]): string | undefined {
  return [...parsed.order].reverse().find((key) => keys.includes(key))
}

const isDigit = (char: string): boolean => char >= '0' && char <= '9'

const resolveLong = (
  spec: OptionSpec,
  name: string,
): { name: string; option: LongOption } | 'ambiguous' | null => {
  const table = spec.long ?? {}
  const names = Object.keys(table)
  const exact = names.includes(name) ? [name] : names.filter((candidate) => candidate.startsWith(name))
  const keys = new Set(exact.map((candidate) => JSON.stringify(table[candidate])))
  if (exact.length === 0) return null
  if (keys.size > 1) return 'ambiguous'
  const found = exact[0] as string
  const entry = table[found] as string | LongOption
  if (typeof entry !== 'string') return { name: found, option: entry }
  return { name: found, option: { key: entry, argument: spec.values?.includes(entry) ? 'required' : undefined } }
}

export function parseOptions(argv: readonly string[], spec: OptionSpec): ParsedOptions | OptionError {
  const command = argv[0] ?? ''
  const parsed: ParsedOptions = { flags: new Set(), values: new Map(), order: [], operands: [] }
  const record = (key: string, value?: string): void => {
    parsed.order.push(key)
    if (value === undefined) parsed.flags.add(key)
    else parsed.values.set(key, [...(parsed.values.get(key) ?? []), value])
  }

  let index = 1
  let ended = false
  while (index < argv.length) {
    const token = argv[index] as string
    index += 1
    if (ended || token === '-' || !token.startsWith('-')) {
      parsed.operands.push(token)
      continue
    }
    if (token === '--') {
      ended = true
      continue
    }

    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = token.slice(2, equals === -1 ? undefined : equals)
      const inline = equals === -1 ? undefined : token.slice(equals + 1)
      const found = resolveLong(spec, name)
      if (found === 'ambiguous') return { error: `${command}: option '--${name}' is ambiguous` }
      if (!found) return { error: `${command}: unrecognized option '${token}'` }
      const { argument, key } = found.option
      if (!argument) {
        if (inline !== undefined) return { error: `${command}: option '--${found.name}' doesn't allow an argument` }
        record(key)
      } else if (argument === 'optional' || inline !== undefined) {
        record(key, inline ?? '')
      } else {
        const next = argv[index]
        if (next === undefined) return { error: `${command}: option '--${found.name}' requires an argument` }
        index += 1
        record(key, next)
      }
      continue
    }

    let position = 1
    while (position < token.length) {
      const letter = String.fromCodePoint(token.codePointAt(position) as number)
      if (spec.numeric && isDigit(letter)) {
        let end = position
        while (end < token.length && isDigit(token[end] as string)) end += 1
        record(spec.numeric, token.slice(position, end))
        position = end
        continue
      }
      if (spec.values?.includes(letter)) {
        const rest = token.slice(position + letter.length)
        if (rest !== '') {
          record(letter, rest)
        } else {
          const next = argv[index]
          if (next === undefined) return { error: `${command}: option requires an argument -- '${letter}'` }
          index += 1
          record(letter, next)
        }
        break
      }
      if (!spec.flags?.includes(letter)) return { error: `${command}: invalid option -- '${letter}'` }
      record(letter)
      position += letter.length
    }
  }
  return parsed
}
