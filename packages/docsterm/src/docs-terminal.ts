import type { Terminal } from '@xterm/xterm'
import { LineEditor } from './line-editor.js'
import { moveToBlockEnd, renderLine } from './line-render.js'
import { getMessages, resolveLocale } from './messages.js'
import { collectPageContext } from './page-context.js'
import { SessionController, type SessionIO } from './session-controller.js'
import { normalizeOutput as normalize } from './text.js'
import { resolveTheme } from './theme.js'
import type { DocsTerminalOptions } from './types.js'

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
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
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
    let block = { row: 0, rows: 0 }
    const leaveLine = () => {
      write(moveToBlockEnd(block.row, block.rows))
      block = { row: 0, rows: 0 }
    }
    const io: SessionIO = {
      write: (text) => write(normalize(text)),
      print: (line) => write(`${normalize(line)}\r\n`),
      printPrompt: () => {
        block = { row: 0, rows: 0 }
        write(promptText())
      },
      clearScreen: () => term.clear(),
      setBusy: (busy) => {
        this.busy = busy
      },
      size: () => ({ columns: term.cols, rows: term.rows }),
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
      onRender: (buffer, cursor) => {
        const frame = renderLine({
          prompt: promptText(),
          buffer,
          cursor,
          columns: term.cols,
          previousRow: block.row,
        })
        block = { row: frame.row, rows: frame.rows }
        write(frame.text)
      },
      onSubmit: (line) => {
        leaveLine()
        write('\r\n')
        if (line.trim().length > 0) editor.pushHistory(line)
        void controller.submit(line)
      },
      onInterrupt: () => {
        leaveLine()
        write(`${messages.interrupted}\r\n`)
        io.printPrompt()
      },
      onComplete: (buffer, cursor) => controller.complete(buffer, cursor),
      onCandidates: (candidates) => {
        leaveLine()
        write(`\r\n${candidates.join('  ')}\r\n`)
      },
    })

    term.onData((data) => {
      if (controller.isInteractive) {
        controller.handleInteractiveKey(data)
        return
      }
      if (this.busy) {
        if (data === '\x03') controller.interrupt()
        return
      }
      editor.handleKey(data)
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
