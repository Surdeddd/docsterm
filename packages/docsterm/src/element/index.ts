import { DocsTerminal } from '../docs-terminal.js'
import { formatMessage, getMessages, resolveLocale } from '../messages.js'
import { sanitizeProse } from '../text.js'
import type { AIProvider, Backend, DocsTerminalEvent, Locale, PageContext, RunReport, ThemePreference } from '../types.js'

export type BuiltInBackend = 'shell' | 'javascript' | 'pyodide' | 'websocket'

export interface DocsTerminalElementEventMap {
  'docsterm-ready': CustomEvent<Extract<DocsTerminalEvent, { type: 'ready' }>>
  'docsterm-error': CustomEvent<Extract<DocsTerminalEvent, { type: 'error' }>>
  'docsterm-event': CustomEvent<DocsTerminalEvent>
}

export interface DocsTerminalElement extends HTMLElement {
  backend: Backend | undefined
  ai: AIProvider | undefined
  pageContext: Partial<PageContext> | undefined
  onEvent: ((event: DocsTerminalEvent) => void) | undefined
  theme: ThemePreference | undefined
  readonly terminal: DocsTerminal | null
  run(text: string): Promise<RunReport>
  insert(text: string): void
  clear(): void
  focus(options?: FocusOptions): void
  addEventListener<K extends keyof DocsTerminalElementEventMap>(
    type: K,
    listener: (this: DocsTerminalElement, event: DocsTerminalElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void
  addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: DocsTerminalElement, event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void
  removeEventListener<K extends keyof DocsTerminalElementEventMap>(
    type: K,
    listener: (this: DocsTerminalElement, event: DocsTerminalElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void
  removeEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: DocsTerminalElement, event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void
}

declare global {
  interface HTMLElementTagNameMap {
    'docs-terminal': DocsTerminalElement
  }
}

interface Early {
  apply(terminal: DocsTerminal): void
  fail(error: unknown): void
}

interface Loaded {
  readonly key: string
  readonly backend: Backend
}

const MARK = 'docsterm-element'

const ATTRIBUTES = ['backend', 'url', 'locale', 'theme', 'font-size', 'font-family', 'aria-label', 'welcome']

const PROPERTIES = ['backend', 'ai', 'pageContext', 'onEvent', 'theme'] as const

const THEMES = new Set(['light', 'dark', 'auto'])

const loaders: Record<BuiltInBackend, (url: string) => Promise<Backend>> = {
  shell: async () => (await import('../shell/index.js')).createShellBackend(),
  javascript: async () => (await import('../javascript/index.js')).createJavaScriptBackend(),
  pyodide: async () => (await import('../pyodide/index.js')).createPyodideBackend(),
  websocket: async (url) => (await import('../websocket/index.js')).createWebSocketBackend({ url }),
}

const isBuiltIn = (name: string): name is BuiltInBackend => Object.hasOwn(loaders, name)

const abortError = () => new DOMException('disposed', 'AbortError')

const errorText = (error: unknown) => sanitizeProse(error instanceof Error ? error.message : String(error))

function createElementClass(): CustomElementConstructor {
  return class extends HTMLElement implements DocsTerminalElement {
    static readonly docsterm = MARK

    static get observedAttributes(): string[] {
      return ATTRIBUTES
    }

    #backend: Backend | undefined
    #ai: AIProvider | undefined
    #pageContext: Partial<PageContext> | undefined
    #onEvent: ((event: DocsTerminalEvent) => void) | undefined
    #themeProperty: ThemePreference | undefined
    #widget: DocsTerminal | null = null
    #mounted: Backend | null = null
    #loaded: Loaded | null = null
    #loading: string | null = null
    #early: Early[] = []
    #closed = false
    #failure: { error: unknown } | null = null

    constructor() {
      super()
      for (const name of PROPERTIES) {
        if (!Object.hasOwn(this, name)) continue
        const value: unknown = Reflect.get(this, name)
        Reflect.deleteProperty(this, name)
        Reflect.set(this, name, value)
      }
    }

    get backend(): Backend | undefined {
      return this.#backend
    }

    set backend(value: Backend | undefined) {
      if (value === this.#backend) return
      this.#backend = value ?? undefined
      this.#update()
    }

    get ai(): AIProvider | undefined {
      return this.#ai
    }

    set ai(value: AIProvider | undefined) {
      this.#ai = value
      this.#widget?.setOptions({ ai: value })
    }

    get theme(): ThemePreference | undefined {
      return this.#themeProperty
    }

    set theme(value: ThemePreference | undefined) {
      if (value === this.#themeProperty) return
      this.#themeProperty = value ?? undefined
      this.#widget?.setOptions({ theme: this.#theme() })
    }

    get pageContext(): Partial<PageContext> | undefined {
      return this.#pageContext
    }

    set pageContext(value: Partial<PageContext> | undefined) {
      this.#pageContext = value
      this.#widget?.setOptions({ pageContext: value })
    }

    get onEvent(): ((event: DocsTerminalEvent) => void) | undefined {
      return this.#onEvent
    }

    set onEvent(value: ((event: DocsTerminalEvent) => void) | undefined) {
      this.#onEvent = value
    }

    get terminal(): DocsTerminal | null {
      return this.#widget
    }

    connectedCallback(): void {
      this.#closed = false
      if (this.style.display === '' && ['', 'inline'].includes(getComputedStyle(this).display)) {
        this.style.display = 'block'
      }
      this.#update()
    }

    disconnectedCallback(): void {
      queueMicrotask(() => {
        if (!this.isConnected) this.#close()
      })
    }

    attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
      if (previous === next) return
      const widget = this.#widget
      if (name === 'backend' || name === 'url') {
        if (this.#backend === undefined) this.#update()
      } else if (name === 'locale') widget?.setOptions({ locale: this.#locale() })
      else if (name === 'theme') {
        if (this.#themeProperty === undefined) widget?.setOptions({ theme: this.#theme() })
      } else if (name === 'font-size') widget?.setOptions({ fontSize: this.#fontSize() })
      else if (name === 'font-family') widget?.setOptions({ fontFamily: this.#fontFamily() })
      else if (name === 'aria-label') widget?.setOptions({ ariaLabel: next ?? undefined })
    }

    run(text: string): Promise<RunReport> {
      const widget = this.#widget
      if (widget) return widget.run(text)
      if (this.#closed) return Promise.reject(abortError())
      if (this.#failure) return Promise.reject(this.#failure.error)
      return new Promise<RunReport>((resolve, reject) => {
        this.#early.push({ apply: (terminal) => terminal.run(text).then(resolve, reject), fail: reject })
      })
    }

    insert(text: string): void {
      this.#later((terminal) => terminal.insert(text))
    }

    clear(): void {
      this.#later((terminal) => terminal.clear())
    }

    focus(options?: FocusOptions): void {
      if (this.#widget) this.#widget.focus()
      else super.focus(options)
    }

    #later(action: (terminal: DocsTerminal) => void): void {
      const widget = this.#widget
      if (widget) action(widget)
      else if (!this.#closed && !this.#failure) this.#early.push({ apply: action, fail: () => {} })
    }

    #update(): void {
      if (!this.isConnected) return
      this.#failure = null
      const backend = this.#backend ?? this.#builtIn()
      if (backend === this.#mounted) return
      this.#unmount()
      if (backend) this.#mount(backend)
    }

    #builtIn(): Backend | null {
      const name = this.getAttribute('backend')
      if (name === null) return null
      const url = this.getAttribute('url') ?? ''
      const key = `${name}\n${url}`
      if (this.#loaded?.key === key) return this.#loaded.backend
      if (this.#loading !== key) this.#load(name, url, key)
      return null
    }

    #load(name: string, url: string, key: string): void {
      const messages = getMessages(resolveLocale(this.#locale()))
      this.#loading = null
      if (!isBuiltIn(name)) {
        this.#fail(formatMessage(messages.elementUnknownBackend, { name }))
        return
      }
      if (name === 'websocket' && url.trim() === '') {
        this.#fail(messages.elementNeedsUrl)
        return
      }
      this.#loading = key
      loaders[name](url).then(
        (backend) => {
          if (this.#loading !== key) return
          this.#loading = null
          this.#loaded = { key, backend }
          this.#update()
        },
        (error: unknown) => {
          if (this.#loading !== key) return
          this.#loading = null
          this.#fail(`${messages.backendFailed}: ${errorText(error)}`, error)
        },
      )
    }

    #mount(backend: Backend): void {
      const widget: DocsTerminal = new DocsTerminal({
        backend,
        ai: this.#ai,
        pageContext: this.#pageContext,
        locale: this.#locale(),
        theme: this.#theme(),
        fontSize: this.#fontSize(),
        fontFamily: this.#fontFamily(),
        ariaLabel: this.getAttribute('aria-label') ?? undefined,
        welcome: this.getAttribute('welcome') ?? undefined,
        onEvent: (event) => {
          if (this.#widget === widget) this.#emit(event)
        },
      })
      this.#widget = widget
      this.#mounted = backend
      for (const item of this.#early.splice(0)) item.apply(widget)
      widget.mount(this).catch(() => undefined)
    }

    #unmount(): void {
      const widget = this.#widget
      this.#widget = null
      this.#mounted = null
      widget?.dispose()
    }

    #close(): void {
      this.#closed = true
      this.#unmount()
      const error = abortError()
      for (const item of this.#early.splice(0)) item.fail(error)
    }

    #fail(message: string, cause?: unknown): void {
      const error = cause instanceof Error ? cause : new Error(message)
      this.#failure = { error }
      for (const item of this.#early.splice(0)) item.fail(error)
      this.#emit({ type: 'error', phase: 'init', message })
    }

    #emit(event: DocsTerminalEvent): void {
      try {
        this.#onEvent?.(event)
      } catch (error) {
        console.error(error)
      }
      const init = { detail: event, bubbles: true, composed: true }
      this.dispatchEvent(new CustomEvent('docsterm-event', init))
      if (event.type === 'ready') this.dispatchEvent(new CustomEvent('docsterm-ready', init))
      if (event.type === 'error') this.dispatchEvent(new CustomEvent('docsterm-error', init))
    }

    #locale(): Locale | undefined {
      const value = this.getAttribute('locale')
      return value === null || value.trim() === '' ? undefined : resolveLocale(value)
    }

    #theme(): ThemePreference | undefined {
      if (this.#themeProperty !== undefined) return this.#themeProperty
      const value = this.getAttribute('theme')
      return value !== null && THEMES.has(value) ? (value as ThemePreference) : undefined
    }

    #fontFamily(): string | undefined {
      const value = this.getAttribute('font-family')?.trim()
      return value === undefined || value === '' ? undefined : value
    }

    #fontSize(): number | undefined {
      const value = Number(this.getAttribute('font-size') ?? Number.NaN)
      return Number.isFinite(value) && value > 0 ? value : undefined
    }
  }
}

export function defineDocsTerminal(tagName = 'docs-terminal'): void {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return
  const existing = customElements.get(tagName) as (CustomElementConstructor & { docsterm?: unknown }) | undefined
  if (existing?.docsterm === MARK) return
  if (existing) {
    throw new Error(`<${tagName}> is already defined by another element; pass a different name to defineDocsTerminal()`)
  }
  customElements.define(tagName, createElementClass())
}
