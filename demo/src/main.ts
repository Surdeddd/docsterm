import './fonts'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { attachRunButtons, type AIProvider, type DocsTerminalOptions, type TerminalTheme } from 'docsterm'
import { defineDocsTerminal, type DocsTerminalElement, type DocsTerminalElementEventMap } from 'docsterm/element'
import { createJavaScriptBackend } from 'docsterm/javascript'
import { createWasiBackend } from 'docsterm/wasi'
import { buildConfiguredProvider, setupAiSettings } from './ai-settings'
import { createEventLog } from './event-log'
import { fill, getPageStrings, plural, type PageStrings } from './i18n'
import { createDemoMockAI, type TerminalKind } from './mock-ai'
import { createOrbitBackend } from './orbit'
import {
  LOCALE_KEY,
  pageLocale,
  pageTheme,
  remember,
  TERMINAL_FONT,
  TERMINAL_FONT_SIZE,
  terminalThemes,
  THEME_KEY,
  type PageTheme,
} from './page'
import { liveTerminals, mountTerminal, showMountError } from './terminals'

const params = new URLSearchParams(location.search)
const mockAI = params.get('ai') === 'mock'
const locale = pageLocale()
const strings = getPageStrings(locale)
let theme = pageTheme()

const aiFor = (kind: TerminalKind): AIProvider | undefined =>
  mockAI ? createDemoMockAI(kind, locale) : buildConfiguredProvider()

type TerminalOptions = Pick<DocsTerminalOptions, 'backend'> & Partial<DocsTerminalOptions>

const terminalOptions = (kind: TerminalKind, rest: TerminalOptions): DocsTerminalOptions => ({
  ai: aiFor(kind),
  locale,
  theme: terminalThemes[theme],
  fontFamily: TERMINAL_FONT,
  fontSize: TERMINAL_FONT_SIZE,
  ...rest,
})

const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null

const element = (tag: string, className: string, text: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function applyStrings(text: PageStrings): void {
  document.title = text.documentTitle
  document.querySelector('meta[name="description"]')?.setAttribute('content', text.documentDescription)
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = text[node.dataset.i18n as keyof PageStrings]
    if (typeof value === 'string') node.textContent = value
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-step]')) {
    const step = text.runSteps[Number(node.dataset.step)]
    if (step) node.textContent = node.classList.contains('step-title') ? step.title : step.body
  }
  const eyebrow = byId('hero-eyebrow')
  if (eyebrow) eyebrow.textContent = fill(text.heroEyebrow, { version: __DOCSTERM_VERSION__ })
  byId('embed-docs')?.setAttribute('href', text.embedDocsHref)

  byId('why-grid')?.replaceChildren(
    ...text.whyItems.map((item, index) => {
      const article = element('article', 'why-item', '')
      article.append(
        element('span', 'index', String(index + 1).padStart(2, '0')),
        element('h3', '', item.title),
        element('p', '', item.body),
      )
      return article
    }),
  )

  const entries = __DOCSTERM_ENTRIES__
  const title = byId('packages-title')
  if (title) {
    const [before = '', after = ''] = fill(text.packagesTitle, {
      unit: plural(locale, entries.length, text.packagesUnit),
    }).split('{count}')
    title.replaceChildren(before, element('span', 'count', String(entries.length)), after)
  }
  byId('package-list')?.replaceChildren(
    ...entries.map((name) => {
      const item = document.createElement('li')
      item.dataset.entry = name
      const link = document.createElement('a')
      link.href = text.packagesHref
      link.append(element('span', 'pkg-name', name))
      const body = text.packageBodies[name]
      if (body) link.append(element('span', 'pkg-body', body))
      item.append(link)
      return item
    }),
  )
}

function setupSwitches(): void {
  const keep = new URLSearchParams(location.search)
  keep.delete('isolated')
  const brand = byId<HTMLAnchorElement>('brand-link')
  const query = keep.toString()
  if (brand) brand.href = `${import.meta.env.BASE_URL}${query ? `?${query}` : ''}`

  const langButtons = document.querySelectorAll<HTMLButtonElement>('[data-lang]')
  for (const button of langButtons) {
    const value = button.dataset.lang === 'ru' ? 'ru' : 'en'
    button.setAttribute('aria-pressed', String(value === locale))
    button.addEventListener('click', () => {
      if (value === locale) return
      remember(LOCALE_KEY, value)
      const next = new URLSearchParams(location.search)
      next.set('locale', value)
      location.search = next.toString()
    })
  }

  const themeButtons = document.querySelectorAll<HTMLButtonElement>('[data-theme-set]')
  const showTheme = () => {
    for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.themeSet === theme))
  }
  showTheme()
  for (const button of themeButtons) {
    button.addEventListener('click', () => {
      const value: PageTheme = button.dataset.themeSet === 'dark' ? 'dark' : 'light'
      if (value === theme) return
      theme = value
      remember(THEME_KEY, value)
      document.documentElement.dataset.theme = value
      const next = new URLSearchParams(location.search)
      next.set('theme', value)
      history.replaceState(history.state, '', `${location.pathname}?${next}${location.hash}`)
      showTheme()
      liveTerminals.setTheme(terminalThemes[value])
    })
  }
}

function setupCopy(): void {
  const button = byId<HTMLButtonElement>('copy-install')
  const code = byId('install-code')
  const note = byId('copy-note')
  if (!button || !code || !note) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = (copied: boolean) => {
    clearTimeout(timer)
    button.textContent = copied ? strings.heroCopied : strings.heroCopy
    if (copied) button.dataset.copied = 'true'
    note.textContent = copied ? '' : strings.heroCopyFallback
    timer = setTimeout(() => {
      button.textContent = strings.heroCopy
      delete button.dataset.copied
      note.textContent = ''
    }, copied ? 1600 : 4000)
  }
  const selectCode = () => {
    const selection = getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(code)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  button.addEventListener('click', () => {
    const text = code.textContent ?? ''
    const clipboard = navigator.clipboard as Clipboard | undefined
    if (!clipboard?.writeText) {
      selectCode()
      settle(false)
      return
    }
    clipboard.writeText(text).then(
      () => settle(true),
      () => {
        selectCode()
        settle(false)
      },
    )
  })
}

function setupHero(): void {
  const slot = byId('terminal-mock')
  if (!slot) return
  const { terminal } = mountTerminal(
    slot,
    terminalOptions('shell', { backend: createOrbitBackend(strings.shellBanner) }),
    strings,
  )
  const items = byId('try-items')
  if (!items) return
  const commands = strings.heroTryCommands.map((command) => {
    const chip = element('button', 'chip', command) as HTMLButtonElement
    chip.type = 'button'
    chip.dataset.command = command
    chip.setAttribute('aria-label', fill(strings.heroTryButtonLabel, { command }))
    chip.addEventListener('click', () => {
      terminal.focus()
      terminal.run(command).catch(() => undefined)
    })
    return chip
  })
  const hints = strings.heroTryHints.map((hint) => element('span', 'chip-hint', hint))
  items.replaceChildren(...commands, ...hints)
}

function setupRunSection(): void {
  const slot = byId('terminal-run')
  const section = byId('run')
  if (!slot || !section) return
  const log = byId('event-log')
  const onEvent = log ? createEventLog(log, strings) : undefined
  const { terminal } = mountTerminal(
    slot,
    terminalOptions('shell', { backend: createOrbitBackend(strings.shellBanner), onEvent }),
    strings,
  )
  attachRunButtons(section, terminal, { locale })
}

function setupJavaScript(): void {
  const slot = byId('terminal-js')
  if (!slot) return
  mountTerminal(
    slot,
    terminalOptions('javascript', { backend: createJavaScriptBackend({ banner: strings.jsBanner, timeoutMs: 5000 }) }),
    strings,
  )
}

function setupRust(): void {
  const slot = byId('terminal-rust')
  if (!slot) return
  mountTerminal(
    slot,
    terminalOptions('rust', {
      backend: createWasiBackend({
        url: `${import.meta.env.BASE_URL}greet.wasm`,
        program: 'greet',
        prompt: 'wasm $ ',
        banner: strings.rustBanner,
        usage: 'greet <name...>',
      }),
    }),
    strings,
  )
}

function setupPython(): void {
  const button = byId<HTMLButtonElement>('python-boot')
  const slot = byId('terminal-python')
  const frame = byId('python-frame')
  if (!button || !slot || !frame) return
  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = strings.pythonBooting
    frame.hidden = false
    slot.replaceChildren()
    try {
      const { createPyodideBackend } = await import('docsterm/pyodide')
      const { terminal, ready } = mountTerminal(
        slot,
        terminalOptions('python', { backend: createPyodideBackend() }),
        strings,
      )
      if (await ready) {
        button.remove()
        terminal.focus()
        return
      }
    } catch (error) {
      showMountError(slot, error, strings)
    }
    button.disabled = false
    button.textContent = strings.pythonRetry
  })
}

function setupElement(): void {
  const host = document.querySelector<DocsTerminalElement>('docs-terminal#terminal-element')
  if (!host) return
  host.setAttribute('locale', locale)
  host.setAttribute('theme', theme)
  host.ai = aiFor('javascript')
  const target = {
    setAI: (ai: AIProvider | undefined) => {
      host.ai = ai
    },
    setTheme: (next: TerminalTheme) => {
      host.setAttribute('theme', theme)
      host.terminal?.setTheme(next)
    },
  }
  liveTerminals.add(target)
  host.addEventListener('docsterm-ready', () => {
    host.terminal?.setOptions({ theme: terminalThemes[theme], fontFamily: TERMINAL_FONT })
  })
  host.addEventListener('docsterm-error', (event) => {
    const { detail } = event as DocsTerminalElementEventMap['docsterm-error']
    if (detail.phase === 'init') showMountError(host, new Error(detail.message), strings)
  })
  defineDocsTerminal()
}

applyStrings(strings)
setupSwitches()
setupCopy()

const mockLink = byId<HTMLAnchorElement>('ai-mock-link')
if (mockLink) {
  const query = new URLSearchParams(location.search)
  query.set('ai', 'mock')
  mockLink.href = `?${query}`
  mockLink.hidden = mockAI
}

const settings = byId('ai-settings')
if (settings) {
  setupAiSettings(settings, strings, {
    mock: mockAI,
    onApply: (provider) => liveTerminals.setAI(provider),
  })
}

setupHero()
setupRunSection()
setupJavaScript()
setupRust()
setupPython()
setupElement()
