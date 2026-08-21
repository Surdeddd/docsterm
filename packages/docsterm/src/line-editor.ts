export interface CompletionResult {
  from: number
  to: number
  candidates: string[]
}

export interface LineEditorEvents {
  onRender(buffer: string, cursor: number): void
  onSubmit(line: string): void
  onInterrupt(): void
  onComplete?(buffer: string, cursor: number): Promise<CompletionResult | null>
  onCandidates?(candidates: string[]): void
}

const HISTORY_CAP = 200

const KEY = {
  enter: '\r',
  newline: '\n',
  backspace: '\x7f',
  delete: '\x1b[3~',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  homeAlt: '\x1b[1~',
  end: '\x1b[F',
  endAlt: '\x1b[4~',
  ctrlA: '\x01',
  ctrlC: '\x03',
  ctrlE: '\x05',
  ctrlK: '\x0b',
  ctrlU: '\x15',
  ctrlW: '\x17',
  altLeft: '\x1bb',
  altRight: '\x1bf',
} as const

export function commonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0] ?? ''
  for (const value of values.slice(1)) {
    let index = 0
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1
    prefix = prefix.slice(0, index)
    if (prefix === '') break
  }
  return prefix
}

export class LineEditor {
  private buffer = ''
  private cursor = 0
  private history: string[] = []
  private historyIndex = -1
  private draft = ''

  constructor(private readonly events: LineEditorEvents) {}

  get value(): string {
    return this.buffer
  }

  get position(): number {
    return this.cursor
  }

  handleKey(data: string): void {
    switch (data) {
      case KEY.enter:
      case KEY.newline: {
        const line = this.buffer
        this.buffer = ''
        this.cursor = 0
        this.historyIndex = -1
        this.events.onSubmit(line)
        return
      }
      case KEY.ctrlC:
        this.buffer = ''
        this.cursor = 0
        this.historyIndex = -1
        this.events.onInterrupt()
        return
      case KEY.backspace:
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor)
          this.cursor -= 1
          this.render()
        }
        return
      case KEY.delete:
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1)
          this.render()
        }
        return
      case KEY.left:
        if (this.cursor > 0) {
          this.cursor -= 1
          this.render()
        }
        return
      case KEY.right:
        if (this.cursor < this.buffer.length) {
          this.cursor += 1
          this.render()
        }
        return
      case KEY.home:
      case KEY.homeAlt:
      case KEY.ctrlA:
        this.cursor = 0
        this.render()
        return
      case KEY.end:
      case KEY.endAlt:
      case KEY.ctrlE:
        this.cursor = this.buffer.length
        this.render()
        return
      case KEY.ctrlU:
        this.buffer = this.buffer.slice(this.cursor)
        this.cursor = 0
        this.render()
        return
      case KEY.ctrlK:
        this.buffer = this.buffer.slice(0, this.cursor)
        this.render()
        return
      case KEY.ctrlW: {
        const head = this.buffer.slice(0, this.cursor)
        const trimmed = head.replace(/\S+\s*$/, '')
        this.buffer = trimmed + this.buffer.slice(this.cursor)
        this.cursor = trimmed.length
        this.render()
        return
      }
      case KEY.altLeft: {
        const head = this.buffer.slice(0, this.cursor)
        const match = /\S+\s*$/.exec(head)
        this.cursor = match ? match.index : 0
        this.render()
        return
      }
      case KEY.altRight: {
        const tail = this.buffer.slice(this.cursor)
        const match = /^\s*\S+/.exec(tail)
        this.cursor += match ? match[0].length : tail.length
        this.render()
        return
      }
      case KEY.up:
        this.moveHistory(-1)
        return
      case KEY.down:
        this.moveHistory(1)
        return
      case KEY.tab:
        void this.complete()
        return
      default:
        break
    }

    if (data.startsWith('\x1b')) return
    const printable = [...data].filter((char) => char >= ' ' && char !== KEY.backspace).join('')
    if (printable === '') return
    this.buffer = this.buffer.slice(0, this.cursor) + printable + this.buffer.slice(this.cursor)
    this.cursor += printable.length
    this.render()
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
    this.historyIndex = -1
  }

  private async complete(): Promise<void> {
    if (!this.events.onComplete) return
    const result = await this.events.onComplete(this.buffer, this.cursor)
    if (!result || result.candidates.length === 0) return
    const shared = commonPrefix(result.candidates)
    const current = this.buffer.slice(result.from, result.to)
    if (result.candidates.length === 1) {
      const only = result.candidates[0] ?? ''
      this.replaceRange(result.from, result.to, only.endsWith('/') ? only : `${only} `)
      return
    }
    if (shared.length > current.length) {
      this.replaceRange(result.from, result.to, shared)
      return
    }
    this.events.onCandidates?.(result.candidates)
    this.render()
  }

  private replaceRange(from: number, to: number, text: string): void {
    this.buffer = this.buffer.slice(0, from) + text + this.buffer.slice(to)
    this.cursor = from + text.length
    this.render()
  }

  private moveHistory(delta: number): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      if (delta > 0) return
      this.draft = this.buffer
      this.historyIndex = this.history.length - 1
    } else {
      const next = this.historyIndex + delta
      if (next >= this.history.length) {
        this.historyIndex = -1
        this.buffer = this.draft
        this.cursor = this.buffer.length
        this.render()
        return
      }
      if (next < 0) return
      this.historyIndex = next
    }
    this.buffer = this.history[this.historyIndex] ?? ''
    this.cursor = this.buffer.length
    this.render()
  }

  private render(): void {
    this.events.onRender(this.buffer, this.cursor)
  }
}
