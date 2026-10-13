import type { ITerminalAddon, Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { getMessages, resolveLocale } from './messages.js'
import { collectPageContext } from './page-context.js'
import { TerminalSession } from './terminal-session.js'
import { sanitizeProse } from './text.js'
import { resolveTheme, watchTheme } from './theme.js'
import type {
  AIProvider,
  DocsTerminalEvent,
  DocsTerminalOptions,
  Locale,
  PageContext,
  RunReport,
  ThemePreference,
} from './types.js'
import { loadXtermCodePointWidth, type CodePointWidth } from './width.js'

interface XtermModules {
  Terminal: typeof Terminal
  FitAddon: typeof FitAddon
  Unicode11Addon: new () => ITerminalAddon
  width: CodePointWidth
}

interface View {
  term: Terminal
  fit: FitAddon
  session: TerminalSession
  host: HTMLDivElement
  cleanups: Array<() => void>
  stopTheme: () => void
}

interface Early {
  apply(session: TerminalSession): void
  fail(error: unknown): void
}

export type DocsTerminalLiveOptions = Partial<
  Pick<
    DocsTerminalOptions,
    | 'theme'
    | 'locale'
    | 'ai'
    | 'pageContext'
    | 'fontFamily'
    | 'fontSize'
    | 'ariaLabel'
    | 'screenReaderMode'
    | 'onEvent'
  >
>

const DEFAULT_FONT_FAMILY = 'monospace'
const DEFAULT_FONT_SIZE = 14
const ESCAPE_WINDOW_MS = 1500
const KEY_C = 67
const KEY_V = 86
const BROWSER_SHORTCUT_KEYS = new Set([70, 71, 80, 83])

function pick<T>(module: unknown, name: string): T {
  const loaded = module as Record<string, unknown> & { default?: Record<string, unknown> }
  const value = loaded[name] ?? loaded.default?.[name]
  if (typeof value !== 'function') throw new TypeError(`${name} is not exported by its package`)
  return value as T
}

async function loadXterm(): Promise<XtermModules> {
  const [xterm, fit, unicode, width] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-unicode11'),
    loadXtermCodePointWidth(),
  ])
  return {
    Terminal: pick(xterm, 'Terminal'),
    FitAddon: pick(fit, 'FitAddon'),
    Unicode11Addon: pick(unicode, 'Unicode11Addon'),
    width,
  }
}

const disposedError = () => new DOMException('disposed', 'AbortError')

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(disposedError())
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(signal.aborted ? disposedError() : error)
      },
    )
  })
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

const errorMessage = (error: unknown) => sanitizeProse(error instanceof Error ? error.message : String(error))

export class DocsTerminal {
  private readonly options: DocsTerminalOptions
  private abort: AbortController | null = null
  private view: View | null = null
  private initialised = false
  private disposed = false
  private failure: { error: unknown } | null = null
  private early: Early[] = []
  private escapeAt = Number.NEGATIVE_INFINITY

  constructor(options: DocsTerminalOptions) {
    this.options = { ...options }
  }

  get element(): HTMLElement | null {
    return this.view?.host ?? null
  }

  mount(element: HTMLElement): Promise<void> {
    if (this.abort) throw new Error('DocsTerminal is already mounted')
    const abort = new AbortController()
    this.abort = abort
    this.disposed = false
    this.failure = null
    return this.open(element, abort.signal).catch((error: unknown) => {
      if (!abort.signal.aborted) {
        this.failure = { error }
        this.failEarly(error)
        this.notify({ type: 'error', phase: 'init', message: errorMessage(error) })
      }
      throw error
    })
  }

  run(text: string): Promise<RunReport> {
    if (this.disposed) return Promise.reject(disposedError())
    if (this.failure) return Promise.reject(this.failure.error)
    const session = this.view?.session
    if (session) return session.run(text)
    return new Promise<RunReport>((resolve, reject) => {
      this.early.push({ apply: (next) => next.run(text).then(resolve, reject), fail: reject })
    })
  }

  insert(text: string): void {
    this.later((session) => session.insert(text))
  }

  clear(): void {
    this.later((session) => session.clear())
  }

  focus(): void {
    this.view?.term.focus()
  }

  setOnEvent(onEvent: DocsTerminalOptions['onEvent']): void {
    this.options.onEvent = onEvent
  }

  setOptions(patch: DocsTerminalLiveOptions): void {
    const has = (name: keyof DocsTerminalLiveOptions) => Object.hasOwn(patch, name)
    if (has('theme')) this.setTheme(patch.theme)
    if (has('locale')) this.setLocale(patch.locale)
    if (has('ai')) this.setAI(patch.ai)
    if (has('pageContext')) this.setPageContext(patch.pageContext)
    if (has('onEvent')) this.setOnEvent(patch.onEvent)
    if (has('ariaLabel')) this.options.ariaLabel = patch.ariaLabel
    if (has('screenReaderMode')) this.options.screenReaderMode = patch.screenReaderMode
    if (has('fontFamily')) this.options.fontFamily = patch.fontFamily
    if (has('fontSize')) this.options.fontSize = patch.fontSize
    const view = this.view
    if (!view) return
    if (has('ariaLabel')) this.label(view)
    if (has('screenReaderMode')) view.term.options.screenReaderMode = this.options.screenReaderMode ?? false
    if (!has('fontFamily') && !has('fontSize')) return
    view.term.options.fontFamily = this.options.fontFamily ?? DEFAULT_FONT_FAMILY
    view.term.options.fontSize = this.options.fontSize ?? DEFAULT_FONT_SIZE
    this.refit(view)
    this.refitAfterFonts(view)
  }

  setTheme(theme?: ThemePreference): void {
    this.options.theme = theme
    if (this.view) this.followTheme(this.view)
  }

  setLocale(locale?: Locale): void {
    this.options.locale = locale
    if (!this.view) return
    const resolved = resolveLocale(locale)
    this.view.session.setMessages(getMessages(resolved), resolved)
    this.label(this.view)
  }

  setAI(ai: AIProvider | undefined): void {
    this.options.ai = ai
    this.view?.session.setAI(ai)
  }

  setPageContext(context?: Partial<PageContext>): void {
    this.options.pageContext = context
    this.view?.session.setPageContext(collectPageContext(context))
  }

  dispose(): void {
    this.disposed = true
    this.failEarly(disposedError())
    const abort = this.abort
    if (!abort) return
    this.abort = null
    abort.abort()
    const view = this.view
    this.view = null
    if (view) {
      view.session.dispose()
      view.stopTheme()
      for (const cleanup of view.cleanups.splice(0)) cleanup()
      view.term.dispose()
      view.host.remove()
    }
    if (this.initialised) {
      this.initialised = false
      this.options.backend.dispose()
    }
  }

  private async open(element: HTMLElement, signal: AbortSignal): Promise<void> {
    const modules = await loadXterm()
    if (signal.aborted) throw disposedError()
    const locale = resolveLocale(this.options.locale)
    const messages = getMessages(locale)
    const term = new modules.Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: this.options.fontSize ?? DEFAULT_FONT_SIZE,
      fontFamily: this.options.fontFamily ?? DEFAULT_FONT_FAMILY,
      minimumContrastRatio: 4.5,
      screenReaderMode: this.options.screenReaderMode ?? false,
      theme: resolveTheme(this.options.theme ?? 'auto'),
    })
    const session = new TerminalSession({
      terminal: term,
      backend: this.options.backend,
      ai: this.options.ai,
      messages,
      locale,
      pageContext: collectPageContext(this.options.pageContext),
      welcome: this.options.welcome ?? (this.options.ai ? messages.welcome : messages.welcomeNoAi),
      width: modules.width,
      onEvent: (event) => this.notify(event),
    })
    const host = element.ownerDocument.createElement('div')
    const fit = new modules.FitAddon()
    const view: View = { term, fit, session, host, cleanups: [], stopTheme: () => {} }
    this.view = view
    host.style.width = '100%'
    host.style.height = '100%'
    element.append(host)
    term.loadAddon(fit)
    term.loadAddon(new modules.Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(host)
    fit.fit()
    this.label(view)
    this.followTheme(view)
    if (signal.aborted) throw disposedError()
    term.attachCustomKeyEventHandler((event) => this.handleKey(view, event))
    const data = term.onData((text) => session.input(text))
    const resize = term.onResize(({ cols, rows }) => session.resize(cols, rows))
    view.cleanups.push(
      () => data.dispose(),
      () => resize.dispose(),
    )
    this.observeSize(view)
    this.refitAfterFonts(view)
    this.initialised = true
    for (const item of this.early.splice(0)) item.apply(session)
    await untilAborted(session.start(), signal)
  }

  private later(action: (session: TerminalSession) => void): void {
    if (this.disposed || this.failure) return
    const session = this.view?.session
    if (session) action(session)
    else this.early.push({ apply: action, fail: () => {} })
  }

  private failEarly(error: unknown): void {
    for (const item of this.early.splice(0)) item.fail(error)
  }

  private notify(event: DocsTerminalEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch (error) {
      console.error(error)
    }
  }

  private label(view: View): void {
    const text = this.options.ariaLabel ?? getMessages(resolveLocale(this.options.locale)).ariaLabel
    view.term.textarea?.setAttribute('aria-label', text)
    view.host.setAttribute('role', 'region')
    view.host.setAttribute('aria-label', text)
  }

  private followTheme(view: View): void {
    view.stopTheme()
    view.stopTheme = watchTheme(this.options.theme ?? 'auto', (next) => {
      view.term.options.theme = next
    })
  }

  private observeSize(view: View): void {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => this.refit(view))
    observer.observe(view.host)
    view.cleanups.push(() => observer.disconnect())
  }

  private refit(view: View): void {
    const proposed = view.fit.proposeDimensions()
    if (!proposed) return
    const { cols, rows } = proposed
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
    if (cols === view.term.cols && rows === view.term.rows) return
    view.fit.fit()
  }

  private refitAfterFonts(view: View): void {
    const fonts: FontFaceSet | undefined = view.host.ownerDocument.fonts
    if (!fonts || fonts.status === 'loaded') return
    void fonts.ready.then(() => {
      if (this.view !== view) return
      const size = view.term.options.fontSize ?? DEFAULT_FONT_SIZE
      view.term.options.fontSize = size + 1
      view.term.options.fontSize = size
      view.fit.fit()
    })
  }

  private handleKey(view: View, event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true
    const interactive = view.session.isInteractive
    const escaped = Date.now() - this.escapeAt <= ESCAPE_WINDOW_MS
    this.escapeAt = event.key === 'Escape' && !interactive ? Date.now() : Number.NEGATIVE_INFINITY
    const modifiers = event.ctrlKey || event.altKey || event.metaKey
    if (event.key === 'Tab' && !modifiers && !interactive && (event.shiftKey || escaped)) return false
    if (!event.ctrlKey || event.altKey || event.metaKey) return true
    if (event.shiftKey && event.keyCode === KEY_V) return false
    if (event.shiftKey && event.keyCode === KEY_C) {
      event.preventDefault()
      this.copySelection(view)
      return false
    }
    if (event.keyCode === KEY_C && !isMac() && view.term.hasSelection()) {
      setTimeout(() => this.clearSelection(view), 0)
      return false
    }
    return !(BROWSER_SHORTCUT_KEYS.has(event.keyCode) && !event.shiftKey && !interactive && !isMac())
  }

  private copySelection(view: View): void {
    if (!view.term.hasSelection()) return
    const fallback = () => {
      if (this.view !== view) return
      view.host.ownerDocument.execCommand('copy')
      this.clearSelection(view)
    }
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard?.writeText) {
      fallback()
      return
    }
    clipboard.writeText(view.term.getSelection()).then(() => this.clearSelection(view), fallback)
  }

  private clearSelection(view: View): void {
    if (this.view === view) view.term.clearSelection()
  }
}
