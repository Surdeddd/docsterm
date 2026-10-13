import { stripAnsi } from './text.js'
import type { InputSource } from './types.js'
import { nextBoundary, previousBoundary } from './width.js'

export interface CompletionResult {
  from: number
  to: number
  candidates: string[]
}

export interface LineSnapshot {
  buffer: string
  cursor: number
  origins: readonly InputSource[]
}

export interface LineEditorEvents {
  onRender(buffer: string, cursor: number): void
  onSubmit(line: string, source: InputSource): void
  onInterrupt(): void
  onComplete?(buffer: string, cursor: number): Promise<CompletionResult | null>
  onCandidates?(candidates: string[]): void
  onClearScreen?(): void
}

const HISTORY_CAP = 200

type Action =
  | 'submit'
  | 'interrupt'
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'wordLeft'
  | 'wordRight'
  | 'killStart'
  | 'killEnd'
  | 'killWordBack'
  | 'killWordForward'
  | 'yank'
  | 'transpose'
  | 'up'
  | 'down'
  | 'complete'
  | 'clearScreen'

const KEYS = new Map<string, Action>([
  ['\r', 'submit'],
  ['\n', 'submit'],
  ['\x03', 'interrupt'],
  ['\x7f', 'backspace'],
  ['\x1b[3~', 'delete'],
  ['\x04', 'delete'],
  ['\x1b[D', 'left'],
  ['\x1bOD', 'left'],
  ['\x02', 'left'],
  ['\x1b[C', 'right'],
  ['\x1bOC', 'right'],
  ['\x06', 'right'],
  ['\x1b[H', 'home'],
  ['\x1bOH', 'home'],
  ['\x1b[1~', 'home'],
  ['\x01', 'home'],
  ['\x1b[F', 'end'],
  ['\x1bOF', 'end'],
  ['\x1b[4~', 'end'],
  ['\x05', 'end'],
  ['\x1bb', 'wordLeft'],
  ['\x1b[1;3D', 'wordLeft'],
  ['\x1b[1;5D', 'wordLeft'],
  ['\x1b[1;9D', 'wordLeft'],
  ['\x1bf', 'wordRight'],
  ['\x1b[1;3C', 'wordRight'],
  ['\x1b[1;5C', 'wordRight'],
  ['\x1b[1;9C', 'wordRight'],
  ['\x15', 'killStart'],
  ['\x0b', 'killEnd'],
  ['\x17', 'killWordBack'],
  ['\x08', 'killWordBack'],
  ['\x1b\x7f', 'killWordBack'],
  ['\x1bd', 'killWordForward'],
  ['\x1b[3;5~', 'killWordForward'],
  ['\x19', 'yank'],
  ['\x14', 'transpose'],
  ['\x1b[A', 'up'],
  ['\x1bOA', 'up'],
  ['\x1b[B', 'down'],
  ['\x1bOB', 'down'],
  ['\t', 'complete'],
  ['\x0c', 'clearScreen'],
])

const isPrintable = (char: string) => char === '\t' || (char >= ' ' && (char < '\x7f' || char > '\x9f'))

const printableOnly = (text: string) => [...text].filter(isPrintable).join('')

export function commonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = [...(values[0] ?? '')]
  for (const value of values.slice(1)) {
    const points = [...value]
    let index = 0
    while (index < prefix.length && index < points.length && prefix[index] === points[index]) index += 1
    prefix = prefix.slice(0, index)
    if (prefix.length === 0) break
  }
  return prefix.join('')
}

const withoutLoneBackslash = (text: string): string =>
  (/\\*$/.exec(text)?.[0].length ?? 0) % 2 === 1 ? text.slice(0, -1) : text

export class LineEditor {
  private buffer = ''
  private cursor = 0
  private origins: InputSource[] = []
  private history: string[] = []
  private historyIndex = -1
  private draft = ''
  private draftOrigins: InputSource[] = []
  private readonly edits = new Map<number, string>()
  private killed = ''
  private stamp = 0

  constructor(private readonly events: LineEditorEvents) {}

  get value(): string {
    return this.buffer
  }

  get position(): number {
    return this.cursor
  }

  get source(): InputSource {
    const first = this.buffer.search(/\S/)
    return first === -1 ? 'typed' : (this.origins[first] ?? 'typed')
  }

  handleKey(data: string): void {
    const action = KEYS.get(data)
    if (action) this.perform(action)
    else if (!data.startsWith('\x1b')) this.insert(data)
  }

  insert(text: string, source: InputSource = 'typed'): void {
    const printable = printableOnly(text)
    if (printable !== '') this.replace(this.cursor, this.cursor, printable, this.cursor + printable.length, source)
  }

  snapshot(): LineSnapshot {
    return { buffer: this.buffer, cursor: this.cursor, origins: [...this.origins] }
  }

  restore(snapshot: LineSnapshot): void {
    this.reset()
    this.buffer = snapshot.buffer
    this.cursor = Math.min(snapshot.cursor, snapshot.buffer.length)
    this.origins = [...snapshot.origins]
  }

  pushHistory(line: string): void {
    if (line.trim() === '') return
    if (this.history[this.history.length - 1] === line) return
    this.history.push(line)
    if (this.history.length > HISTORY_CAP) this.history.shift()
  }

  entries(): string[] {
    return [...this.history]
  }

  reset(): void {
    this.buffer = ''
    this.cursor = 0
    this.origins = []
    this.historyIndex = -1
    this.edits.clear()
    this.stamp += 1
  }

  private perform(action: Action): void {
    const { buffer, cursor } = this
    switch (action) {
      case 'submit': {
        const source = this.source
        this.reset()
        this.events.onSubmit(buffer, source)
        return
      }
      case 'interrupt':
        this.reset()
        this.events.onInterrupt()
        return
      case 'backspace':
        if (cursor > 0) this.replace(previousBoundary(buffer, cursor), cursor, '')
        return
      case 'delete':
        if (cursor < buffer.length) this.replace(cursor, nextBoundary(buffer, cursor), '', cursor)
        return
      case 'left':
        if (cursor > 0) this.moveTo(previousBoundary(buffer, cursor))
        return
      case 'right':
        if (cursor < buffer.length) this.moveTo(nextBoundary(buffer, cursor))
        return
      case 'home':
        this.moveTo(0)
        return
      case 'end':
        this.moveTo(buffer.length)
        return
      case 'wordLeft':
        this.moveTo(/\S+\s*$/.exec(buffer.slice(0, cursor))?.index ?? 0)
        return
      case 'wordRight':
        this.moveTo(cursor + (/^\s*\S+/.exec(buffer.slice(cursor))?.[0].length ?? buffer.length - cursor))
        return
      case 'killStart':
        this.kill(0, cursor)
        return
      case 'killEnd':
        this.kill(cursor, buffer.length)
        return
      case 'killWordBack':
        this.kill(/\S*\s*$/.exec(buffer.slice(0, cursor))?.index ?? cursor, cursor)
        return
      case 'killWordForward':
        this.kill(cursor, cursor + (/^\s*\S*/.exec(buffer.slice(cursor))?.[0].length ?? 0))
        return
      case 'yank':
        if (this.killed !== '') this.replace(cursor, cursor, this.killed)
        return
      case 'transpose':
        this.transpose()
        return
      case 'up':
        this.moveHistory(-1)
        return
      case 'down':
        this.moveHistory(1)
        return
      case 'complete':
        void this.complete()
        return
      case 'clearScreen':
        this.events.onClearScreen?.()
        return
    }
  }

  private kill(from: number, to: number): void {
    if (from === to) return
    this.killed = this.buffer.slice(from, to)
    this.replace(from, to, '')
  }

  private transpose(): void {
    const at = this.cursor === this.buffer.length ? previousBoundary(this.buffer, this.cursor) : this.cursor
    const start = previousBoundary(this.buffer, at)
    if (start === at || at === this.buffer.length) return
    const end = nextBoundary(this.buffer, at)
    this.replace(start, end, this.buffer.slice(at, end) + this.buffer.slice(start, at))
  }

  private async complete(): Promise<void> {
    if (!this.events.onComplete) return
    const stamp = this.stamp
    const result = await this.events.onComplete(this.buffer, this.cursor)
    if (stamp !== this.stamp || !result) return
    const candidates = result.candidates.map((candidate) => printableOnly(stripAnsi(candidate))).filter(Boolean)
    if (candidates.length === 0) return
    const shared = withoutLoneBackslash(commonPrefix(candidates))
    const current = this.buffer.slice(result.from, result.to)
    if (candidates.length === 1) {
      const only = candidates[0] ?? ''
      this.replace(result.from, result.to, only.endsWith('/') ? only : `${only} `)
      return
    }
    if (shared.length > current.length) {
      this.replace(result.from, result.to, shared)
      return
    }
    this.events.onCandidates?.(candidates)
    this.render()
  }

  private replace(
    from: number,
    to: number,
    text: string,
    cursor = from + text.length,
    source: InputSource = 'typed',
  ): void {
    this.buffer = this.buffer.slice(0, from) + text + this.buffer.slice(to)
    this.origins.splice(from, to - from, ...Array.from({ length: text.length }, () => source))
    this.cursor = cursor
    this.render()
  }

  private moveTo(cursor: number): void {
    this.cursor = cursor
    this.render()
  }

  private moveHistory(delta: number): void {
    const current = this.historyIndex === -1 ? this.history.length : this.historyIndex
    const next = current + delta
    if (next < 0 || next > this.history.length || next === current) return
    if (this.historyIndex === -1) {
      this.draft = this.buffer
      this.draftOrigins = this.origins
    } else if (this.buffer === this.history[this.historyIndex]) this.edits.delete(this.historyIndex)
    else this.edits.set(this.historyIndex, this.buffer)
    this.historyIndex = next === this.history.length ? -1 : next
    if (this.historyIndex === -1) {
      this.buffer = this.draft
      this.origins = this.draftOrigins
    } else {
      this.buffer = this.edits.get(next) ?? this.history[next] ?? ''
      this.origins = Array.from({ length: this.buffer.length }, () => 'typed')
    }
    this.cursor = this.buffer.length
    this.render()
  }

  private render(): void {
    this.stamp += 1
    this.events.onRender(this.buffer, this.cursor)
  }
}
