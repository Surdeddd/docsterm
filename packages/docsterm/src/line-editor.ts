export interface LineEditorEvents {
  onRender(buffer: string): void
  onSubmit(line: string): void
  onInterrupt(): void
}

const HISTORY_CAP = 50
const KEY_UP = '\x1b[A'
const KEY_DOWN = '\x1b[B'
const KEY_ENTER = '\r'
const KEY_BACKSPACE = '\x7f'
const KEY_CTRL_C = '\x03'

export class LineEditor {
  private buffer = ''
  private history: string[] = []
  private historyIndex = -1
  private draft = ''

  constructor(private readonly events: LineEditorEvents) {}

  handleKey(data: string): void {
    if (data === KEY_ENTER) {
      const line = this.buffer
      this.buffer = ''
      this.historyIndex = -1
      this.events.onSubmit(line)
      return
    }
    if (data === KEY_BACKSPACE) {
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1)
        this.events.onRender(this.buffer)
      }
      return
    }
    if (data === KEY_CTRL_C) {
      this.buffer = ''
      this.historyIndex = -1
      this.events.onInterrupt()
      return
    }
    if (data === KEY_UP) {
      this.moveHistory(-1)
      return
    }
    if (data === KEY_DOWN) {
      this.moveHistory(1)
      return
    }
    if (data.startsWith('\x1b')) return
    const printable = [...data].filter((ch) => ch >= ' ' && ch !== KEY_BACKSPACE).join('')
    if (printable.length > 0) {
      this.buffer += printable
      this.events.onRender(this.buffer)
    }
  }

  pushHistory(line: string): void {
    if (line.trim() === '') return
    if (this.history[this.history.length - 1] === line) return
    this.history.push(line)
    if (this.history.length > HISTORY_CAP) this.history.shift()
  }

  reset(): void {
    this.buffer = ''
    this.historyIndex = -1
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
        this.events.onRender(this.buffer)
        return
      }
      if (next < 0) return
      this.historyIndex = next
    }
    this.buffer = this.history[this.historyIndex] ?? ''
    this.events.onRender(this.buffer)
  }
}
