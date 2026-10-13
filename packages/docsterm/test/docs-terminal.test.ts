// @vitest-environment jsdom
import * as xterm from '@xterm/xterm'
import * as fitAddon from '@xterm/addon-fit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocsTerminal } from '../src/docs-terminal.js'
import { darkTheme, lightTheme } from '../src/theme.js'
import type {
  AIProvider,
  Backend,
  BackendHost,
  DocsTerminalEvent,
  DocsTerminalOptions,
  RunContext,
  SuggestInput,
} from '../src/types.js'

type XTerm = xterm.Terminal

const resolveExport = <T>(module: unknown, name: string): T => {
  const loaded = module as Record<string, unknown> & { default?: Record<string, unknown> }
  return (loaded[name] ?? loaded.default?.[name]) as T
}

const TerminalClass = resolveExport<typeof xterm.Terminal>(xterm, 'Terminal')
const FitAddonClass = resolveExport<typeof fitAddon.FitAddon>(fitAddon, 'FitAddon')

interface Scheme {
  matches: boolean
  listeners: Set<() => void>
}

let scheme: Scheme
let element: HTMLElement
let openSpy: ReturnType<typeof vi.spyOn>

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const flipScheme = (dark: boolean) => {
  scheme.matches = dark
  for (const listener of scheme.listeners) listener()
}

beforeEach(() => {
  scheme = { matches: false, listeners: new Set() }
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('prefers-color-scheme') ? scheme.matches : false
    },
    addEventListener: (_type: string, listener: () => void) => scheme.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => scheme.listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
  }))
  element = document.createElement('div')
  document.body.append(element)
  openSpy = vi.spyOn(TerminalClass.prototype, 'open')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  element.remove()
})

const terminals = () => openSpy.mock.contexts as XTerm[]
const lastTerminal = () => {
  const term = terminals().at(-1)
  if (!term) throw new Error('no terminal was opened')
  return term
}

const flush = (term: XTerm) => new Promise<void>((resolve) => term.write('', resolve))

const screen = (term: XTerm) => {
  const buffer = term.buffer.active
  const rows: string[] = []
  for (let index = 0; index < buffer.length; index += 1) rows.push(buffer.getLine(index)?.translateToString(true) ?? '')
  while (rows.length > 0 && rows.at(-1) === '') rows.pop()
  return rows
}

const until = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(2)
  }
}

const settleScreen = async (term: XTerm, last: string) => {
  await until(() => screen(term).at(-1) === last, `a last row of ${JSON.stringify(last)}`)
  await flush(term)
}

const backend = (overrides: Partial<Backend> = {}): Backend => ({
  id: 'test',
  prompt: '$ ',
  init: vi.fn(async () => {}),
  run: vi.fn(async (command: string) => ({ output: `ran ${command}`, exitCode: 0 })),
  dispose: vi.fn(),
  ...overrides,
})

const key = (term: XTerm, init: KeyboardEventInit & { keyCode?: number }) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  term.textarea?.dispatchEvent(event)
  return event
}

const nativeCopy = (term: XTerm) => {
  const copied = new Map<string, string>()
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (type: string, value: string) => copied.set(type, value) },
  })
  term.textarea?.dispatchEvent(event)
  return copied.get('text/plain')
}

const hostCapture = () => {
  const capture: { host?: BackendHost } = {}
  const init = vi.fn(async (value: BackendHost) => {
    capture.host = value
  })
  return { capture, init }
}

const mounted = async (options: Partial<DocsTerminalOptions> = {}) => {
  const target = options.backend ?? backend()
  const widget = new DocsTerminal({ welcome: 'welcome', ...options, backend: target })
  await widget.mount(element)
  const term = lastTerminal()
  await settleScreen(term, '$ ')
  return { widget, term, backend: target }
}

describe('DocsTerminal mount', () => {
  it('opens the real xterm in an inner host that fills the element', async () => {
    const { widget } = await mounted()
    const host = element.firstElementChild as HTMLElement
    expect(element.children.length).toBe(1)
    expect([host.tagName, host.style.width, host.style.height]).toEqual(['DIV', '100%', '100%'])
    expect(host.querySelectorAll('.xterm').length).toBe(1)
    widget.dispose()
    expect(element.children.length).toBe(0)
  })

  it('throws synchronously on a second mount while the first is still loading', async () => {
    const target = backend()
    const widget = new DocsTerminal({ backend: target })
    const first = widget.mount(element)
    expect(() => widget.mount(element)).toThrow('DocsTerminal is already mounted')
    await first
    expect(element.querySelectorAll('.xterm').length).toBe(1)
    expect(target.init).toHaveBeenCalledTimes(1)
    widget.dispose()
  })

  it('leaves no terminal and never initialises the backend when disposed during the import', async () => {
    const target = backend()
    const widget = new DocsTerminal({ backend: target })
    const pending = widget.mount(element)
    widget.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'disposed' })
    await sleep(20)
    expect(element.querySelector('.xterm')).toBeNull()
    expect(target.init).not.toHaveBeenCalled()
  })

  it('rejects, removes the terminal and disposes the backend when disposed during init', async () => {
    const target = backend({ init: vi.fn(() => new Promise<void>(() => {})) })
    const widget = new DocsTerminal({ backend: target })
    const pending = widget.mount(element)
    await until(() => (target.init as ReturnType<typeof vi.fn>).mock.calls.length === 1, 'init')
    widget.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(element.querySelector('.xterm')).toBeNull()
    expect(target.dispose).toHaveBeenCalledTimes(1)
  })

  it('mounts again on the same instance after dispose with the same backend', async () => {
    const target = backend()
    const widget = new DocsTerminal({ backend: target, welcome: 'welcome' })
    await widget.mount(element)
    widget.dispose()
    await widget.mount(element)
    const term = lastTerminal()
    await settleScreen(term, '$ ')
    term.input('echo hi\r')
    await settleScreen(term, '$ ')
    expect(screen(term)).toEqual(['welcome', 'loading environment...', '$ echo hi', 'ran echo hi', '$ '])
    expect(target.init).toHaveBeenCalledTimes(2)
    expect(target.dispose).toHaveBeenCalledTimes(1)
    expect(element.querySelectorAll('.xterm').length).toBe(1)
    widget.dispose()
  })

  it('answers immediately after a remount even while the old command never finishes', async () => {
    const commands: string[] = []
    const target = backend({
      run: vi.fn(async (command: string) => {
        commands.push(command)
        if (command === 'hang') return new Promise<never>(() => {})
        return { output: `ran ${command}`, exitCode: 0 }
      }),
    })
    const { widget, term } = await mounted({ backend: target })
    term.input('hang\r')
    await until(() => commands.length === 1, 'the hanging command')
    widget.dispose()
    await widget.mount(element)
    const next = lastTerminal()
    await settleScreen(next, '$ ')
    next.input('echo hi\r')
    await settleScreen(next, '$ ')
    expect(commands).toEqual(['hang', 'echo hi'])
    widget.dispose()
  })

  it('aborts the running command on dispose', async () => {
    let context: RunContext | undefined
    const target = backend({
      run: vi.fn((_command: string, value?: RunContext) => {
        context = value
        return new Promise<never>(() => {})
      }),
    })
    const { widget, term } = await mounted({ backend: target })
    term.input('hang\r')
    await until(() => context !== undefined, 'the run')
    widget.dispose()
    expect(context?.signal.aborted).toBe(true)
  })

  it('reports an init failure in the terminal, keeps input disabled and rejects mount', async () => {
    const target = backend({ init: vi.fn(async () => Promise.reject(new Error('cannot connect'))) })
    const widget = new DocsTerminal({ backend: target, welcome: 'welcome' })
    await expect(widget.mount(element)).rejects.toThrow('cannot connect')
    const term = lastTerminal()
    term.input('ls\r')
    await flush(term)
    expect(target.run).not.toHaveBeenCalled()
    expect(screen(term)).toEqual([
      'welcome',
      'loading environment...',
      'environment failed to start: cannot connect',
      'reload the page to try again.',
    ])
    widget.dispose()
  })

  it('leaves nothing in the element when xterm cannot open', async () => {
    vi.stubGlobal('matchMedia', undefined)
    const target = backend()
    const widget = new DocsTerminal({ backend: target })
    await expect(widget.mount(element)).rejects.toThrow('matchMedia')
    widget.dispose()
    expect(element.children.length).toBe(0)
    expect(target.init).not.toHaveBeenCalled()
    expect(target.dispose).not.toHaveBeenCalled()
  })

  it('replays a command typed during a slow init after the prompt', async () => {
    let initDone = false
    const runs: Array<[string, boolean]> = []
    const target = backend({
      init: vi.fn(async () => {
        await sleep(40)
        initDone = true
      }),
      run: vi.fn(async (command: string) => {
        runs.push([command, initDone])
        return { output: `ran ${command}`, exitCode: 0 }
      }),
    })
    const widget = new DocsTerminal({ backend: target, welcome: 'welcome' })
    const pending = widget.mount(element)
    await until(() => terminals().length === 1, 'the terminal')
    lastTerminal().input('ls\r')
    await pending
    await settleScreen(lastTerminal(), '$ ')
    expect(runs).toEqual([['ls', true]])
    widget.dispose()
  })
})

describe('DocsTerminal module interop', () => {
  afterEach(() => {
    vi.doUnmock('@xterm/xterm')
    vi.doUnmock('@xterm/addon-fit')
  })

  it('mounts when the xterm packages expose their classes only on default, as in plain Node', async () => {
    vi.doMock('@xterm/xterm', () => ({ Terminal: undefined, default: { Terminal: TerminalClass } }))
    vi.doMock('@xterm/addon-fit', () => ({ FitAddon: undefined, default: { FitAddon: FitAddonClass } }))
    const { widget } = await mounted()
    expect(element.querySelectorAll('.xterm').length).toBe(1)
    widget.dispose()
  })
})

describe('DocsTerminal options', () => {
  it('copies the options and never mutates the caller object', async () => {
    const target = backend()
    const options: DocsTerminalOptions = { backend: target }
    const widget = new DocsTerminal(options)
    const ai: AIProvider = { id: 'x', suggestCommand: async () => ({ command: 'ls', explanation: '' }), explainError: async () => '' }
    widget.setAI(ai)
    widget.setLocale('ru')
    widget.setTheme('dark')
    widget.setPageContext({ title: 'Other' })
    await widget.mount(element)
    widget.setAI(undefined)
    widget.setLocale('en')
    expect(options).toEqual({ backend: target })
    widget.dispose()
  })

  it('welcomes without AI hints when no AI is configured', async () => {
    const widget = new DocsTerminal({ backend: backend() })
    await widget.mount(element)
    const term = lastTerminal()
    await settleScreen(term, '$ ')
    expect(screen(term)).toEqual([
      'docsterm ready. Type a command. Builtins: help, clear, history.',
      'loading environment...',
      '$ ',
    ])
    widget.dispose()
  })

  it('welcomes with AI hints when AI is configured', async () => {
    const ai: AIProvider = { id: 'x', suggestCommand: async () => ({ command: 'ls', explanation: '' }), explainError: async () => '' }
    const widget = new DocsTerminal({ backend: backend(), ai })
    await widget.mount(element)
    const term = lastTerminal()
    await settleScreen(term, '$ ')
    expect(screen(term)).toEqual([
      'docsterm ready. Type a command, or start with # to ask AI. Builtins: help,',
      'clear, history, explain.',
      'loading environment...',
      '$ ',
    ])
    widget.dispose()
  })

  it('uses Unicode 11 widths and enforces a 4.5:1 minimum contrast', async () => {
    const { widget, term } = await mounted()
    expect(term.unicode.activeVersion).toBe('11')
    expect(term.options.minimumContrastRatio).toBe(4.5)
    widget.dispose()
  })
})

describe('DocsTerminal live options', () => {
  it('applies setOptions given before mount', async () => {
    const widget = new DocsTerminal({ backend: backend(), welcome: 'welcome' })
    widget.setOptions({
      fontSize: 17,
      fontFamily: 'Fira Code',
      ariaLabel: 'Docs shell',
      screenReaderMode: true,
      theme: 'dark',
      locale: 'ru',
    })
    await widget.mount(element)
    const term = lastTerminal()
    await settleScreen(term, '$ ')
    expect([term.options.fontSize, term.options.fontFamily, term.options.screenReaderMode]).toEqual([
      17,
      'Fira Code',
      true,
    ])
    expect(term.options.theme?.background).toBe(darkTheme.background)
    expect(term.textarea?.getAttribute('aria-label')).toBe('Docs shell')
    expect(screen(term)).toEqual(['welcome', 'загружаю окружение...', '$ '])
    widget.dispose()
  })

  it('changes the font live and fits the terminal to the new cell size', async () => {
    const { widget, term } = await mounted({ fontSize: 15 })
    vi.spyOn(FitAddonClass.prototype, 'proposeDimensions').mockReturnValue({ cols: 61, rows: 19 })
    widget.setOptions({ fontSize: 18, fontFamily: 'Fira Code' })
    expect([term.options.fontSize, term.options.fontFamily]).toEqual([18, 'Fira Code'])
    expect([term.cols, term.rows]).toEqual([61, 19])
    widget.setOptions({ fontSize: undefined, fontFamily: undefined })
    expect([term.options.fontSize, term.options.fontFamily]).toEqual([14, 'monospace'])
    widget.dispose()
  })

  it('measures again once a web font chosen after mount finishes loading', async () => {
    const { widget, term } = await mounted({ fontSize: 15 })
    let loaded: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      loaded = resolve
    })
    Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading', ready } })
    try {
      widget.setOptions({ fontFamily: 'Fira Code' })
      const setFontSize = vi.spyOn(term.options, 'fontSize', 'set')
      loaded()
      await sleep(10)
      expect(setFontSize.mock.calls).toEqual([[16], [15]])
      widget.dispose()
    } finally {
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('relabels the terminal and switches the screen reader mode live', async () => {
    const { widget, term } = await mounted()
    const host = element.firstElementChild as HTMLElement
    widget.setOptions({ ariaLabel: 'Docs shell', screenReaderMode: true })
    expect(term.textarea?.getAttribute('aria-label')).toBe('Docs shell')
    expect(host.getAttribute('aria-label')).toBe('Docs shell')
    expect(term.options.screenReaderMode).toBe(true)
    expect(element.querySelector('.xterm-accessibility')).not.toBeNull()
    widget.setOptions({ ariaLabel: undefined, screenReaderMode: undefined })
    expect(term.textarea?.getAttribute('aria-label')).toBe('Terminal')
    expect(host.getAttribute('aria-label')).toBe('Terminal')
    expect(term.options.screenReaderMode).toBe(false)
    widget.dispose()
  })

  it('passes theme, locale, AI and page context to their setters and leaves absent keys alone', async () => {
    const suggest = vi.fn(async (_input: SuggestInput) => ({ command: 'ls', explanation: '' }))
    const ai: AIProvider = { id: 'x', suggestCommand: suggest, explainError: async () => '' }
    const { capture, init } = hostCapture()
    const { widget, term } = await mounted({ backend: backend({ init }), theme: 'dark', fontSize: 15 })
    widget.setOptions({ locale: 'ru', ai, pageContext: { title: 'Orbit' } })
    expect(capture.host?.locale).toBe('ru')
    expect(term.textarea?.getAttribute('aria-label')).toBe('Терминал')
    expect([term.options.theme?.background, term.options.fontSize]).toEqual([darkTheme.background, 15])
    term.input('#list files\r')
    await until(() => suggest.mock.calls.length === 1, 'the AI request')
    expect(suggest.mock.calls[0]?.[0]).toMatchObject({ request: 'list files', locale: 'ru', context: { title: 'Orbit' } })
    widget.setOptions({ theme: 'light' })
    expect(term.options.theme?.background).toBe(lightTheme.background)
    widget.dispose()
  })

  it('gives the backend a host whose locale follows setLocale, back to the browser locale on undefined', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ru-RU')
    const { capture, init } = hostCapture()
    const { widget, term } = await mounted({ backend: backend({ init }), locale: 'en' })
    expect(capture.host?.locale).toBe('en')
    widget.setLocale('ru')
    expect(capture.host?.locale).toBe('ru')
    widget.setLocale('en')
    expect(capture.host?.locale).toBe('en')
    widget.setLocale(undefined)
    expect(capture.host?.locale).toBe('ru')
    expect(term.textarea?.getAttribute('aria-label')).toBe('Терминал')
    widget.dispose()
  })

  it('goes back to the automatic theme on setTheme(undefined)', async () => {
    const { widget, term } = await mounted({ theme: 'dark' })
    widget.setTheme(undefined)
    expect(term.options.theme?.background).toBe(lightTheme.background)
    flipScheme(true)
    expect(term.options.theme?.background).toBe(darkTheme.background)
    widget.dispose()
  })
})

describe('DocsTerminal theme', () => {
  it('follows the colour scheme in auto mode until disposed', async () => {
    const { widget, term } = await mounted()
    expect(term.options.theme?.background).toBe(lightTheme.background)
    flipScheme(true)
    expect(term.options.theme?.background).toBe(darkTheme.background)
    widget.dispose()
    expect(scheme.listeners.size).toBe(0)
  })

  it('applies setTheme before and after mount', async () => {
    const widget = new DocsTerminal({ backend: backend() })
    widget.setTheme('dark')
    await widget.mount(element)
    const term = lastTerminal()
    expect(term.options.theme?.background).toBe(darkTheme.background)
    widget.setTheme({ background: '#ffffff' })
    expect(term.options.theme).toEqual({ ...lightTheme, background: '#ffffff' })
    flipScheme(true)
    expect(term.options.theme?.background).toBe('#ffffff')
    widget.dispose()
  })
})

describe('DocsTerminal accessibility', () => {
  it('labels the input and the region in the page language', async () => {
    const { widget, term } = await mounted({ locale: 'ru' })
    const host = element.firstElementChild as HTMLElement
    expect(term.textarea?.getAttribute('aria-label')).toBe('Терминал')
    expect([host.getAttribute('role'), host.getAttribute('aria-label')]).toEqual(['region', 'Терминал'])
    widget.setLocale('en')
    expect(term.textarea?.getAttribute('aria-label')).toBe('Terminal')
    expect(host.getAttribute('aria-label')).toBe('Terminal')
    widget.dispose()
  })

  it('prefers an explicit aria label', async () => {
    const { widget, term } = await mounted({ ariaLabel: 'Python sandbox' })
    expect(term.textarea?.getAttribute('aria-label')).toBe('Python sandbox')
    widget.dispose()
  })

  it('turns on the screen reader mode on request', async () => {
    const { widget, term } = await mounted({ screenReaderMode: true })
    expect(term.options.screenReaderMode).toBe(true)
    expect(element.querySelector('.xterm-accessibility')).not.toBeNull()
    widget.dispose()
  })

  it('lets Shift+Tab leave the terminal', async () => {
    const { widget, term } = await mounted()
    const event = key(term, { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    widget.dispose()
  })

  it('lets Tab leave the terminal right after Escape but completes otherwise', async () => {
    const { widget, term } = await mounted()
    expect(key(term, { key: 'Tab', code: 'Tab', keyCode: 9 }).defaultPrevented).toBe(true)
    key(term, { key: 'Escape', code: 'Escape', keyCode: 27 })
    expect(key(term, { key: 'Tab', code: 'Tab', keyCode: 9 }).defaultPrevented).toBe(false)
    expect(key(term, { key: 'Tab', code: 'Tab', keyCode: 9 }).defaultPrevented).toBe(true)
    widget.dispose()
  })
})

describe('DocsTerminal key policy', () => {
  const stubClipboard = (writeText: (text: string) => Promise<void>) =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

  const stubExecCommand = (term: XTerm) => {
    const copies: string[] = []
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn((command: string) => {
        copies.push(`${command}:${term.getSelection()}`)
        return true
      }),
    })
    return copies
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    Reflect.deleteProperty(document, 'execCommand')
  })

  it.each([
    ['find', 'f', 'KeyF', 70],
    ['print', 'p', 'KeyP', 80],
    ['save', 's', 'KeyS', 83],
    ['find next', 'g', 'KeyG', 71],
  ])('leaves Ctrl+%s to the browser', async (_name, letter, code, keyCode) => {
    const { widget, term } = await mounted()
    const event = key(term, { key: letter, code, keyCode, ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    widget.dispose()
  })

  it('leaves Ctrl+C with a selection to the native copy and clears the selection on the next tick', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const { widget, term } = await mounted()
    term.input('echo copy-me')
    await flush(term)
    term.select(7, 2, 7)
    const event = key(term, { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(nativeCopy(term)).toBe('copy-me')
    expect(writeText).not.toHaveBeenCalled()
    await sleep(5)
    expect(term.hasSelection()).toBe(false)
    await flush(term)
    expect(screen(term).at(-1)).toBe('$ echo copy-me')
    widget.dispose()
  })

  it('copies with Ctrl+Shift+C through execCommand when the clipboard API is missing', async () => {
    const { widget, term } = await mounted()
    const copies = stubExecCommand(term)
    term.input('echo copy-me')
    await flush(term)
    term.select(2, 2, 4)
    const event = key(term, { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(copies).toEqual(['copy:echo'])
    expect(term.hasSelection()).toBe(false)
    widget.dispose()
  })

  it('copies with Ctrl+Shift+C through execCommand when the clipboard API rejects', async () => {
    const writeText = vi.fn(async (_text: string) => {
      throw new DOMException('blocked by permissions policy', 'NotAllowedError')
    })
    stubClipboard(writeText)
    const { widget, term } = await mounted()
    const copies = stubExecCommand(term)
    term.input('echo copy-me')
    await flush(term)
    term.select(2, 2, 4)
    key(term, { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true })
    expect(writeText).toHaveBeenCalledWith('echo')
    await sleep(5)
    expect(copies).toEqual(['copy:echo'])
    expect(term.hasSelection()).toBe(false)
    widget.dispose()
  })

  it('copies nothing without a selection and skips the fallback once the widget is gone', async () => {
    let reject: (error: unknown) => void = () => {}
    const writeText = vi.fn(
      (_text: string) =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    stubClipboard(writeText)
    const { widget, term } = await mounted()
    const copies = stubExecCommand(term)
    key(term, { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true })
    expect(writeText).not.toHaveBeenCalled()
    term.input('echo copy-me')
    await flush(term)
    term.select(2, 2, 4)
    key(term, { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true })
    expect(writeText).toHaveBeenCalledWith('echo')
    widget.dispose()
    reject(new DOMException('blocked by permissions policy', 'NotAllowedError'))
    await writeText.mock.results[0]?.value.catch(() => undefined)
    await flush(term)
    expect(copies).toEqual([])
  })

  it('leaves Ctrl+F to the browser on a Russian layout, where the key types а', async () => {
    const { widget, term } = await mounted()
    const event = key(term, { key: 'а', code: 'KeyF', keyCode: 70, ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    widget.dispose()
  })

  it('kills the line with Ctrl+U on Dvorak, where U sits on the physical F key', async () => {
    const { widget, term } = await mounted()
    term.input('echo abc')
    const event = key(term, { key: 'u', code: 'KeyF', keyCode: 85, ctrlKey: true })
    await flush(term)
    expect(event.defaultPrevented).toBe(true)
    expect(screen(term).at(-1)).toBe('$ ')
    widget.dispose()
  })

  it('copies with Ctrl+C on Dvorak, where C sits on the physical I key', async () => {
    const { widget, term } = await mounted()
    term.input('echo copy-me')
    await flush(term)
    term.select(7, 2, 7)
    const event = key(term, { key: 'c', code: 'KeyI', keyCode: 67, ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(nativeCopy(term)).toBe('copy-me')
    await flush(term)
    expect(screen(term).at(-1)).toBe('$ echo copy-me')
    widget.dispose()
  })

  it('copies with Ctrl+Shift+C and leaves Ctrl+Shift+V to the browser paste', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const { widget, term } = await mounted()
    term.input('echo copy-me')
    await flush(term)
    term.select(2, 2, 4)
    key(term, { key: 'C', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true })
    expect(writeText).toHaveBeenCalledWith('echo')
    const paste = key(term, { key: 'V', code: 'KeyV', keyCode: 86, ctrlKey: true, shiftKey: true })
    await flush(term)
    expect(paste.defaultPrevented).toBe(false)
    expect(screen(term).at(-1)).toBe('$ echo copy-me')
    widget.dispose()
  })

  it('still interrupts with Ctrl+C when nothing is selected', async () => {
    const { widget, term } = await mounted()
    term.input('echo abc')
    key(term, { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true })
    await settleScreen(term, '$ ')
    expect(screen(term).slice(-2)).toEqual(['$ echo abc^C', '$ '])
    widget.dispose()
  })
})

describe('DocsTerminal with keys as xterm encodes real key presses', () => {
  it('jumps words with Alt+Left and Ctrl+Left', async () => {
    const { widget, term } = await mounted()
    term.input('echo one two three')
    key(term, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, altKey: true })
    key(term, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, ctrlKey: true })
    term.input('X')
    key(term, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, altKey: true })
    term.input('Y')
    await flush(term)
    expect(screen(term).at(-1)).toBe('$ echo one XtwoY three')
    widget.dispose()
  })

  it('deletes words with Ctrl+Backspace and Alt+Backspace', async () => {
    const { widget, term } = await mounted()
    term.input('echo one two three')
    key(term, { key: 'Backspace', code: 'Backspace', keyCode: 8, ctrlKey: true })
    await flush(term)
    expect(screen(term).at(-1)).toBe('$ echo one two ')
    key(term, { key: 'Backspace', code: 'Backspace', keyCode: 8, altKey: true })
    await flush(term)
    expect(screen(term).at(-1)).toBe('$ echo one ')
    widget.dispose()
  })
})

describe('DocsTerminal control API', () => {
  const duration = expect.any(Number) as number

  it('queues run and insert given before mount until the backend is ready', async () => {
    const target = backend({
      init: vi.fn(async () => {
        await sleep(20)
      }),
    })
    const events: DocsTerminalEvent[] = []
    const widget = new DocsTerminal({ backend: target, welcome: 'welcome', onEvent: (event) => events.push(event) })
    const report = widget.run('echo early')
    widget.insert('ls -la')
    const pending = widget.mount(element)
    expect(await report).toEqual({ exitCode: 0, output: 'ran echo early' })
    await pending
    const term = lastTerminal()
    await settleScreen(term, '$ ls -la')
    expect(screen(term)).toEqual(['welcome', 'loading environment...', '$ echo early', 'ran echo early', '$ ls -la'])
    expect(target.run).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'command', command: 'echo early', source: 'api', exitCode: 0, durationMs: duration },
    ])
    widget.dispose()
  })

  it('rejects runs with an AbortError on dispose, before mount too, and until it is mounted again', async () => {
    const widget = new DocsTerminal({ backend: backend() })
    const early = widget.run('echo early')
    widget.dispose()
    await expect(early).rejects.toMatchObject({ name: 'AbortError' })
    await expect(widget.run('echo late')).rejects.toMatchObject({ name: 'AbortError' })
    await widget.mount(element)
    expect(await widget.run('echo again')).toEqual({ exitCode: 0, output: 'ran echo again' })
    widget.dispose()
  })

  it('rejects a run whose command is still running when the widget is disposed', async () => {
    const target = backend({ run: vi.fn(() => new Promise<never>(() => {})) })
    const { widget } = await mounted({ backend: target })
    const report = widget.run('hang')
    await until(() => (target.run as ReturnType<typeof vi.fn>).mock.calls.length === 1, 'the run')
    widget.dispose()
    await expect(report).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects queued runs with the error of a mount that fails', async () => {
    vi.stubGlobal('matchMedia', undefined)
    const widget = new DocsTerminal({ backend: backend() })
    const early = widget.run('echo early')
    const failure = widget.mount(element)
    await expect(failure).rejects.toThrow('matchMedia')
    await expect(early).rejects.toThrow('matchMedia')
    widget.dispose()
  })

  it('emits ready and commands to the listener from options, setOnEvent or setOptions', async () => {
    const first: DocsTerminalEvent[] = []
    const second: DocsTerminalEvent[] = []
    const third: DocsTerminalEvent[] = []
    const { widget, term } = await mounted({ onEvent: (event) => first.push(event) })
    term.input('echo a\r')
    await until(() => first.length === 2, 'the typed command')
    widget.setOnEvent((event) => second.push(event))
    await widget.run('echo b')
    widget.setOptions({ onEvent: (event) => third.push(event) })
    await widget.run('echo c')
    widget.setOnEvent(undefined)
    await widget.run('echo d')
    expect(first).toEqual([
      { type: 'ready' },
      { type: 'command', command: 'echo a', source: 'typed', exitCode: 0, durationMs: duration },
    ])
    expect(second).toEqual([{ type: 'command', command: 'echo b', source: 'api', exitCode: 0, durationMs: duration }])
    expect(third).toEqual([{ type: 'command', command: 'echo c', source: 'api', exitCode: 0, durationMs: duration }])
    widget.dispose()
  })

  it('emits an init error without the control sequences of the message', async () => {
    const events: DocsTerminalEvent[] = []
    const target = backend({ init: vi.fn(async () => Promise.reject(new Error('cannot \x1b[31mconnect\x1b[0m'))) })
    const widget = new DocsTerminal({ backend: target, onEvent: (event) => events.push(event) })
    await expect(widget.mount(element)).rejects.toThrow('cannot')
    expect(events).toEqual([{ type: 'error', phase: 'init', message: 'cannot connect' }])
    widget.dispose()
  })

  it('logs an exception thrown by onEvent and keeps working', async () => {
    const bug = new Error('listener bug')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { widget } = await mounted({
      onEvent: () => {
        throw bug
      },
    })
    expect(await widget.run('echo ok')).toEqual({ exitCode: 0, output: 'ran echo ok' })
    expect(consoleError.mock.calls).toEqual([[bug], [bug]])
    widget.dispose()
  })

  it('times commands on the performance clock', async () => {
    let clock = 100
    const events: DocsTerminalEvent[] = []
    const target = backend({
      run: vi.fn(async (command: string) => {
        clock += 42
        return { output: `ran ${command}`, exitCode: 0 }
      }),
    })
    const { widget } = await mounted({ backend: target, onEvent: (event) => events.push(event) })
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      await widget.run('ls')
    } finally {
      now.mockRestore()
    }
    expect(events.slice(1)).toEqual([{ type: 'command', command: 'ls', source: 'api', exitCode: 0, durationMs: 42 }])
    widget.dispose()
  })

  it('rejects the mount when it is disposed while the terminal is being set up', async () => {
    const target = backend()
    const widget = new DocsTerminal({ backend: target })
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => widget.dispose(),
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }))
    await expect(widget.mount(element)).rejects.toMatchObject({ name: 'AbortError', message: 'disposed' })
    expect(element.children.length).toBe(0)
    expect(target.init).not.toHaveBeenCalled()
    await expect(widget.run('ls')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('focuses the terminal, clears it and exposes its region element', async () => {
    const { widget, term } = await mounted()
    expect(widget.element).toBe(element.firstElementChild)
    widget.focus()
    expect(document.activeElement).toBe(term.textarea)
    term.input('ab')
    widget.clear()
    await until(() => screen(term).length === 1, 'the cleared screen')
    await settleScreen(term, '$ ab')
    expect(screen(term)).toEqual(['$ ab'])
    widget.dispose()
    expect(widget.element).toBeNull()
  })
})

describe('DocsTerminal layout', () => {
  it('measures the cells again once web fonts finish loading', async () => {
    let loaded: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      loaded = resolve
    })
    Object.defineProperty(document, 'fonts', { configurable: true, value: { status: 'loading', ready } })
    const fitSpy = vi.spyOn(FitAddonClass.prototype, 'fit')
    try {
      const { widget, term } = await mounted({ fontSize: 13 })
      const setFontSize = vi.spyOn(term.options, 'fontSize', 'set')
      const before = fitSpy.mock.calls.length
      loaded()
      await sleep(10)
      expect(setFontSize.mock.calls).toEqual([[14], [13]])
      expect(fitSpy.mock.calls.length).toBe(before + 1)
      expect(fitSpy.mock.invocationCallOrder.at(-1)).toBeGreaterThan(setFontSize.mock.invocationCallOrder.at(-1) ?? 0)
      expect(term.options.fontSize).toBe(13)
      widget.dispose()
    } finally {
      Reflect.deleteProperty(document, 'fonts')
    }
  })
})
