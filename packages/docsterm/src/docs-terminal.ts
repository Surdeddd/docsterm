import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { LineEditor } from './line-editor'
import { getMessages, resolveLocale } from './messages'
import { collectPageContext } from './page-context'
import { SessionController, type SessionIO } from './session-controller'
import { normalizeOutput as normalize } from './text'
import { resolveTheme } from './theme'
import type { DocsTerminalOptions } from './types'

export class DocsTerminal {
  private term: Terminal | null = null
  private controller: SessionController | null = null
  private observer: ResizeObserver | null = null
  private busy = false

  constructor(private readonly options: DocsTerminalOptions) {}

  async mount(element: HTMLElement): Promise<void> {
    if (this.term) throw new Error('DocsTerminal is already mounted')
    const { backend } = this.options
    const locale = resolveLocale(this.options.locale)
    const messages = getMessages(locale)
    const term = new Terminal({
      cursorBlink: true,
      fontSize: this.options.fontSize ?? 14,
      fontFamily: this.options.fontFamily ?? 'monospace',
      theme: resolveTheme(this.options.theme ?? 'auto'),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    fit.fit()
    this.term = term

    const write = (text: string) => term.write(text)
    const io: SessionIO = {
      write: (text) => write(normalize(text)),
      print: (line) => write(`${normalize(line)}\r\n`),
      printPrompt: () => write(promptText()),
      clearScreen: () => term.clear(),
      setBusy: (busy) => {
        this.busy = busy
      },
    }
    const controller = new SessionController({
      backend,
      ai: this.options.ai,
      messages,
      io,
      pageContext: collectPageContext(this.options.pageContext),
    })
    this.controller = controller
    const promptText = () => (controller.isConfirming ? '' : backend.prompt)

    const editor = new LineEditor({
      onRender: (buffer) => write(`\r\x1b[2K${promptText()}${buffer}`),
      onSubmit: (line) => {
        write('\r\n')
        if (line.trim().length > 0) editor.pushHistory(line)
        void controller.submit(line)
      },
      onInterrupt: () => {
        write(`${messages.interrupted}\r\n`)
        io.printPrompt()
      },
    })
    term.onData((data) => {
      if (!this.busy) editor.handleKey(data)
    })

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        const proposed = fit.proposeDimensions()
        if (!proposed) return
        const { cols, rows } = proposed
        if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
        if (cols === term.cols && rows === term.rows) return
        fit.fit()
      })
      this.observer.observe(element)
    }

    io.print(this.options.welcome ?? messages.welcome)
    io.print(messages.backendLoading)
    await backend.init({ write: (text) => write(normalize(text)) })
    io.printPrompt()
  }

  dispose(): void {
    this.observer?.disconnect()
    this.observer = null
    this.options.backend.dispose()
    this.term?.dispose()
    this.term = null
    this.controller = null
  }
}
