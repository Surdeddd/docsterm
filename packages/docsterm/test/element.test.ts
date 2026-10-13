// @vitest-environment jsdom
import type * as xterm from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { DocsTerminal } from '../src/docs-terminal.js'
import { defineDocsTerminal, type DocsTerminalElement, type DocsTerminalElementEventMap } from '../src/element/index.js'
import { attachRunButtons } from '../src/run-buttons.js'
import type { Backend, DocsTerminalEvent, RunReport } from '../src/types.js'

const sockets = vi.hoisted(() => ({ urls: [] as string[] }))

vi.mock('../src/javascript/index.js', () => ({
  createJavaScriptBackend: () => {
    throw new Error('the javascript entry failed to load')
  },
}))

vi.mock('../src/websocket/index.js', () => ({
  createWebSocketBackend: (options: { url: string }) => {
    sockets.urls.push(options.url)
    return {
      id: `websocket ${options.url}`,
      prompt: 'ws$ ',
      init: async () => {},
      run: async (command: string) => ({ output: `remote ${command}`, exitCode: 0 }),
      dispose: () => {},
    }
  },
}))

const TAG = 'docs-terminal'

const duration = expect.any(Number) as number

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(2)
  }
}

const backend = (overrides: Partial<Backend> = {}): Backend => ({
  id: 'test',
  prompt: '$ ',
  init: vi.fn(async () => {}),
  run: vi.fn(async (command: string) => ({ output: `ran ${command}`, exitCode: 0 })),
  dispose: vi.fn(),
  ...overrides,
})

const create = (attributes: Record<string, string> = {}, tag = TAG) => {
  const element = document.createElement(tag) as DocsTerminalElement
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  return element
}

const viewOf = (element: DocsTerminalElement) =>
  (element.terminal as unknown as { view: { term: xterm.Terminal } | null } | null)?.view ?? null

const termOf = (element: DocsTerminalElement): xterm.Terminal => {
  const view = viewOf(element)
  if (!view) throw new Error('no terminal is mounted')
  return view.term
}

const screen = (element: DocsTerminalElement) => {
  if (!viewOf(element)) return []
  const buffer = termOf(element).buffer.active
  const rows: string[] = []
  for (let index = 0; index < buffer.length; index += 1) rows.push(buffer.getLine(index)?.translateToString(true) ?? '')
  while (rows.length > 0 && rows.at(-1) === '') rows.pop()
  return rows
}

const ready = (element: DocsTerminalElement) =>
  new Promise<CustomEvent<DocsTerminalEvent>>((resolve) =>
    element.addEventListener('docsterm-ready', (event) => resolve(event as CustomEvent<DocsTerminalEvent>), {
      once: true,
    }),
  )

const prompt = async (element: DocsTerminalElement, last = '$ ') => {
  await until(() => element.terminal !== null && screen(element).at(-1) === last, `a last row of ${last}`)
}

const record = (target: EventTarget, type: string) => {
  const seen: CustomEvent<DocsTerminalEvent>[] = []
  target.addEventListener(type, (event) => seen.push(event as CustomEvent<DocsTerminalEvent>))
  return seen
}

let host: HTMLElement
let unhandled: unknown[]
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}

beforeAll(() => {
  defineDocsTerminal()
})

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
  sockets.urls.length = 0
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(async () => {
  host.remove()
  await sleep(0)
  process.off('unhandledRejection', onUnhandled)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('defineDocsTerminal', () => {
  it('defines the element once and treats a second call as a no-op', () => {
    const first = customElements.get(TAG)
    defineDocsTerminal()
    defineDocsTerminal(TAG)
    expect(first).toBeDefined()
    expect(customElements.get(TAG)).toBe(first)
  })

  it('throws a clear error when another element owns the name', () => {
    customElements.define('foreign-terminal', class extends HTMLElement {})
    expect(() => defineDocsTerminal('foreign-terminal')).toThrow(
      '<foreign-terminal> is already defined by another element; pass a different name to defineDocsTerminal()',
    )
  })

  it('defines the element under another name too', () => {
    defineDocsTerminal('my-docs-terminal')
    expect(customElements.get('my-docs-terminal')).not.toBe(customElements.get(TAG))
    expect(document.createElement('my-docs-terminal')).toHaveProperty('run')
  })
})

describe('<docs-terminal> mounting', () => {
  it('waits without an error while it has no backend, then mounts when the property is set', async () => {
    const element = create({ welcome: 'welcome' })
    const errors = record(element, 'docsterm-error')
    host.append(element)
    await sleep(20)
    expect([element.terminal, element.querySelector('.xterm'), errors.length]).toEqual([null, null, 0])
    const target = backend()
    const started = ready(element)
    element.backend = target
    await started
    await prompt(element)
    expect(screen(element)).toEqual(['welcome', 'loading environment...', '$ '])
    expect(element.querySelectorAll('.xterm')).toHaveLength(1)
    expect(element.backend).toBe(target)
  })

  it('picks up properties set before the element was defined', async () => {
    const element = document.createElement('late-docs-terminal') as DocsTerminalElement
    const target = backend()
    const seen: DocsTerminalEvent[] = []
    Object.assign(element, { backend: target, onEvent: (event: DocsTerminalEvent) => seen.push(event) })
    host.append(element)
    defineDocsTerminal('late-docs-terminal')
    await until(() => seen.length > 0, 'the ready event')
    expect(seen).toEqual([{ type: 'ready' }])
    expect(element.backend).toBe(target)
    expect(Object.hasOwn(element, 'backend')).toBe(false)
  })

  it('lazily creates the built-in backend named by the attribute', async () => {
    const element = create({ backend: 'shell', welcome: 'welcome' })
    const started = ready(element)
    host.append(element)
    await started
    expect(await element.run('echo hi')).toEqual({ exitCode: 0, output: 'hi\n' })
  })

  it('passes the url attribute to the websocket backend', async () => {
    const element = create({ backend: 'websocket', url: 'wss://sandbox.example/shell' })
    const started = ready(element)
    host.append(element)
    await started
    expect(sockets.urls).toEqual(['wss://sandbox.example/shell'])
    expect(await element.run('ls')).toEqual({ exitCode: 0, output: 'remote ls' })
  })

  it('reports a websocket backend without a url as a localized error and mounts nothing', async () => {
    const element = create({ backend: 'websocket', locale: 'ru' })
    const errors = record(document, 'docsterm-error')
    host.append(element)
    await sleep(10)
    expect(errors.map((event) => event.detail)).toEqual([
      { type: 'error', phase: 'init', message: 'бэкенду websocket нужен атрибут url' },
    ])
    expect([element.terminal, sockets.urls]).toEqual([null, []])
  })

  it('reports an unknown backend name as an error', async () => {
    const element = create({ backend: 'cobol', locale: 'en' })
    const errors = record(element, 'docsterm-error')
    host.append(element)
    await sleep(10)
    expect(errors.map((event) => event.detail)).toEqual([
      {
        type: 'error',
        phase: 'init',
        message: 'unknown backend "cobol": use shell, javascript, pyodide or websocket',
      },
    ])
  })

  it('prefers the backend property over the attribute', async () => {
    const element = create({ backend: 'websocket', url: 'wss://sandbox.example/shell' })
    const target = backend()
    element.backend = target
    const started = ready(element)
    host.append(element)
    await started
    expect(sockets.urls).toEqual([])
    expect(await element.run('ls')).toEqual({ exitCode: 0, output: 'ran ls' })
  })

  it('remounts exactly once for a new backend and reuses nothing of the old one', async () => {
    const mount = vi.spyOn(DocsTerminal.prototype, 'mount')
    const dispose = vi.spyOn(DocsTerminal.prototype, 'dispose')
    const first = backend()
    const second = backend({ prompt: 'next$ ' })
    const element = create()
    element.backend = first
    host.append(element)
    await prompt(element)
    const old = element.terminal
    element.backend = second
    element.backend = second
    await prompt(element, 'next$ ')
    expect([mount.mock.calls.length, dispose.mock.calls.length]).toEqual([2, 1])
    expect(element.terminal).not.toBe(old)
    expect(element.querySelectorAll('.xterm')).toHaveLength(1)
    expect([first.dispose, second.init]).toSatisfy(
      ([disposed, init]) =>
        (disposed as ReturnType<typeof vi.fn>).mock.calls.length === 1 &&
        (init as ReturnType<typeof vi.fn>).mock.calls.length === 1,
    )
  })

  it('remounts when the backend attribute changes', async () => {
    const element = create({ backend: 'websocket', url: 'wss://one.example/' })
    host.append(element)
    await prompt(element, 'ws$ ')
    const old = element.terminal
    element.setAttribute('url', 'wss://two.example/')
    await until(() => element.terminal !== old && element.terminal !== null, 'the new terminal')
    await prompt(element, 'ws$ ')
    expect(sockets.urls).toEqual(['wss://one.example/', 'wss://two.example/'])
    expect(element.querySelectorAll('.xterm')).toHaveLength(1)
  })
})

describe('<docs-terminal> live options', () => {
  it('sends attribute changes to setOptions and keeps welcome for the mount', async () => {
    const element = create({ theme: 'light' })
    element.backend = backend()
    host.append(element)
    await prompt(element)
    const setOptions = vi.spyOn(DocsTerminal.prototype, 'setOptions')
    element.setAttribute('theme', 'dark')
    element.setAttribute('locale', 'ru')
    element.setAttribute('font-size', '16')
    element.setAttribute('aria-label', 'Shell')
    element.setAttribute('welcome', 'ignored')
    element.setAttribute('theme', 'dark')
    element.setAttribute('font-size', 'large')
    element.removeAttribute('theme')
    expect(setOptions.mock.calls).toEqual([
      [{ theme: 'dark' }],
      [{ locale: 'ru' }],
      [{ fontSize: 16 }],
      [{ ariaLabel: 'Shell' }],
      [{ fontSize: undefined }],
      [{ theme: undefined }],
    ])
    expect(termOf(element).options.fontSize).toBe(14)
    expect(termOf(element).textarea?.getAttribute('aria-label')).toBe('Shell')
  })

  it('takes the font family from an attribute, at mount and live', async () => {
    const element = create({ 'font-family': 'Fira Code' })
    element.backend = backend()
    host.append(element)
    await prompt(element)
    expect(termOf(element).options.fontFamily).toBe('Fira Code')
    const setOptions = vi.spyOn(DocsTerminal.prototype, 'setOptions')
    element.setAttribute('font-family', 'Iosevka, monospace')
    element.removeAttribute('font-family')
    expect(setOptions.mock.calls).toEqual([[{ fontFamily: 'Iosevka, monospace' }], [{ fontFamily: undefined }]])
    expect(termOf(element).options.fontFamily).toBe('monospace')
  })

  it('takes a theme object from the property, which wins over the attribute', async () => {
    const custom = { background: '#101820', foreground: '#f2aa4c' }
    const element = create({ theme: 'light' })
    element.theme = custom
    element.backend = backend()
    host.append(element)
    await prompt(element)
    expect(termOf(element).options.theme).toMatchObject(custom)
    const setOptions = vi.spyOn(DocsTerminal.prototype, 'setOptions')
    element.setAttribute('theme', 'dark')
    const other = { background: '#000000' }
    element.theme = other
    element.theme = other
    element.theme = undefined
    expect(setOptions.mock.calls).toEqual([[{ theme: other }], [{ theme: 'dark' }]])
    expect([element.theme, termOf(element).options.theme?.background]).toEqual([undefined, '#0d1117'])
  })

  it('uses the attributes as mount options', async () => {
    const options = vi.spyOn(DocsTerminal.prototype, 'mount')
    const element = create({ theme: 'dark', locale: 'ru-RU', 'font-size': '18', 'aria-label': 'Python', welcome: 'hi' })
    element.backend = backend()
    host.append(element)
    await prompt(element)
    expect(options).toHaveBeenCalledTimes(1)
    expect(screen(element)).toEqual(['hi', 'загружаю окружение...', '$ '])
    expect([termOf(element).options.fontSize, termOf(element).textarea?.getAttribute('aria-label')]).toEqual([
      18,
      'Python',
    ])
  })

  it('sends ai and page context to the widget and calls the latest onEvent', async () => {
    const element = create()
    element.backend = backend()
    host.append(element)
    await prompt(element)
    const setOptions = vi.spyOn(DocsTerminal.prototype, 'setOptions')
    const ai = { id: 'ai', suggestCommand: async () => ({ command: 'ls', explanation: '' }), explainError: async () => '' }
    element.ai = ai
    element.pageContext = { title: 'Install' }
    expect(setOptions.mock.calls).toEqual([[{ ai }], [{ pageContext: { title: 'Install' } }]])
    expect([element.ai, element.pageContext]).toEqual([ai, { title: 'Install' }])
    const seen: DocsTerminalEvent[] = []
    element.onEvent = (event) => seen.push(event)
    await element.run('ls')
    expect(seen).toEqual([{ type: 'command', command: 'ls', source: 'api', exitCode: 0, durationMs: duration }])
  })
})

describe('<docs-terminal> lifecycle', () => {
  it('disposes on disconnect and rejects pending runs with an AbortError', async () => {
    const target = backend({ run: vi.fn(() => new Promise<never>(() => {})) })
    const element = create()
    element.backend = target
    host.append(element)
    await prompt(element)
    const running = element.run('hang')
    const waiting = create()
    host.append(waiting)
    const queued = waiting.run('ls')
    await until(() => (target.run as ReturnType<typeof vi.fn>).mock.calls.length === 1, 'the run')
    element.remove()
    waiting.remove()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    await expect(element.run('ls')).rejects.toMatchObject({ name: 'AbortError' })
    expect([element.terminal, element.querySelector('.xterm'), target.dispose]).toSatisfy(
      ([terminal, xtermNode, dispose]) =>
        terminal === null && xtermNode === null && (dispose as ReturnType<typeof vi.fn>).mock.calls.length === 1,
    )
    expect(unhandled).toEqual([])
  })

  it('keeps one terminal when it is moved to another place in the page', async () => {
    const mount = vi.spyOn(DocsTerminal.prototype, 'mount')
    const dispose = vi.spyOn(DocsTerminal.prototype, 'dispose')
    const element = create()
    element.backend = backend()
    host.append(element)
    await prompt(element)
    const widget = element.terminal
    const other = document.createElement('section')
    host.append(other)
    other.append(element)
    await sleep(10)
    expect(element.terminal).toBe(widget)
    expect([mount.mock.calls.length, dispose.mock.calls.length]).toEqual([1, 0])
    expect(document.querySelectorAll('.xterm')).toHaveLength(1)
    expect(await element.run('ls')).toEqual({ exitCode: 0, output: 'ran ls' })
  })

  it('survives a fast connect, disconnect and connect with one terminal', async () => {
    const element = create()
    element.backend = backend()
    host.append(element)
    element.remove()
    host.append(element)
    await prompt(element)
    element.remove()
    await sleep(0)
    host.append(element)
    await prompt(element)
    expect(document.querySelectorAll('.xterm')).toHaveLength(1)
    expect(unhandled).toEqual([])
  })

  it('queues run, insert and clear until a backend arrives and focuses the terminal', async () => {
    const element = create()
    host.append(element)
    const report = element.run('echo early')
    element.insert('ls')
    element.backend = backend()
    expect(await report).toEqual({ exitCode: 0, output: 'ran echo early' })
    await prompt(element, '$ ls')
    element.focus()
    expect(document.activeElement).toBe(termOf(element).textarea)
  })

  it('shows itself as a block unless the page chose a display', async () => {
    const plain = create()
    const inline = create()
    inline.style.display = 'flex'
    const styled = create({ class: 'grid' })
    const sheet = document.createElement('style')
    sheet.textContent = 'docs-terminal.grid { display: grid }'
    document.head.append(sheet)
    host.append(plain, inline, styled)
    expect([plain.style.display, inline.style.display, styled.style.display]).toEqual(['block', 'flex', ''])
    sheet.remove()
  })
})

describe('<docs-terminal> events', () => {
  it('dispatches bubbling, composed events with the terminal event as detail', async () => {
    const element = create()
    element.backend = backend()
    const all = record(document, 'docsterm-event')
    const readies = record(document, 'docsterm-ready')
    host.append(element)
    await prompt(element)
    await element.run('ls')
    expect(all.map((event) => [event.detail, event.bubbles, event.composed, event.target])).toEqual([
      [{ type: 'ready' }, true, true, element],
      [{ type: 'command', command: 'ls', source: 'api', exitCode: 0, durationMs: duration }, true, true, element],
    ])
    expect(readies.map((event) => event.detail)).toEqual([{ type: 'ready' }])
  })

  it('reports an init failure as docsterm-error and keeps the error out of unhandled rejections', async () => {
    const element = create()
    element.backend = backend({ init: vi.fn(async () => Promise.reject(new Error('cannot connect'))) })
    const errors = record(element, 'docsterm-error')
    host.append(element)
    await until(() => errors.length === 1, 'the error event')
    expect(errors[0]?.detail).toEqual({ type: 'error', phase: 'init', message: 'cannot connect' })
    await expect(element.run('ls')).rejects.toThrow('cannot connect')
    expect(unhandled).toEqual([])
  })
})

describe('<docs-terminal> edge cases', () => {
  const backendOf = (element: DocsTerminalElement) =>
    (element.terminal as unknown as { options: { backend: Backend } } | null)?.options.backend

  it('mounts only the backend of the latest attributes when they change while one is loading', async () => {
    const mount = vi.spyOn(DocsTerminal.prototype, 'mount')
    const element = create({ backend: 'websocket', url: 'wss://one.example/' })
    host.append(element)
    element.setAttribute('backend', 'shell')
    await until(() => element.terminal !== null && screen(element).at(-1) === '/ $ ', 'the shell prompt')
    await until(() => sockets.urls.length === 1, 'the stale websocket load')
    await sleep(10)
    expect(sockets.urls).toEqual(['wss://one.example/'])
    expect(backendOf(element)?.id).toBe('shell')
    expect(mount).toHaveBeenCalledTimes(1)
    expect(element.querySelectorAll('.xterm')).toHaveLength(1)
  })

  it('logs an exception thrown by onEvent and still dispatches the DOM events', async () => {
    const bug = new Error('listener bug')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const element = create()
    element.backend = backend()
    element.onEvent = () => {
      throw bug
    }
    const all = record(element, 'docsterm-event')
    host.append(element)
    await prompt(element)
    expect(await element.run('ls')).toEqual({ exitCode: 0, output: 'ran ls' })
    expect(all.map((event) => event.detail.type)).toEqual(['ready', 'command'])
    expect(consoleError.mock.calls).toEqual([[bug], [bug]])
  })

  it('times commands on the performance clock', async () => {
    let clock = 0
    const element = create()
    element.backend = backend({
      run: vi.fn(async (command: string) => {
        clock += 64
        return { output: `ran ${command}`, exitCode: 0 }
      }),
    })
    const all = record(element, 'docsterm-event')
    host.append(element)
    await prompt(element)
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      await element.run('ls')
    } finally {
      now.mockRestore()
    }
    expect(all.at(-1)?.detail).toEqual({ type: 'command', command: 'ls', source: 'api', exitCode: 0, durationMs: 64 })
  })
})

describe('<docs-terminal> without a usable backend', () => {
  it('rejects queued and later runs with the error, lets Run buttons recover, and retries after a change', async () => {
    host.innerHTML = '<pre data-docsterm-run><code>ls</code></pre>'
    const element = create({ backend: 'cobol', locale: 'en' })
    const early = element.run('ls')
    host.append(element)
    const message = 'unknown backend "cobol": use shell, javascript, pyodide or websocket'
    await expect(early).rejects.toThrow(message)
    await expect(element.run('ls')).rejects.toThrow(message)
    const cleanup = attachRunButtons(host, element)
    const button = host.querySelector<HTMLButtonElement>('button.docsterm-run') as HTMLButtonElement
    button.click()
    expect(button.disabled).toBe(true)
    await sleep(0)
    expect([button.disabled, button.hasAttribute('aria-busy')]).toEqual([false, false])
    element.setAttribute('url', 'wss://sandbox.example/')
    element.setAttribute('backend', 'websocket')
    expect(await element.run('ls')).toEqual({ exitCode: 0, output: 'remote ls' })
    expect(unhandled).toEqual([])
    cleanup()
  })

  it('rejects runs with the error of a failed lazy import', async () => {
    const element = create({ backend: 'javascript' })
    host.append(element)
    const queued = element.run('1 + 1')
    await expect(queued).rejects.toThrow('the javascript entry failed to load')
    expect(unhandled).toEqual([])
  })
})

describe('<docs-terminal> types', () => {
  it('types the default tag and its events', () => {
    expectTypeOf(document.querySelector('docs-terminal')).toEqualTypeOf<DocsTerminalElement | null>()
    expectTypeOf(document.createElement('docs-terminal')).toEqualTypeOf<DocsTerminalElement>()
    const element = create()
    element.addEventListener('docsterm-event', (event) => {
      expectTypeOf(event).toEqualTypeOf<CustomEvent<DocsTerminalEvent>>()
    })
    element.addEventListener('docsterm-error', (event) => {
      expectTypeOf(event.detail).toEqualTypeOf<{ type: 'error'; phase: 'init' | 'run' | 'ai'; message: string }>()
    })
    const readies: unknown[] = []
    const onReady = (event: CustomEvent<{ type: 'ready' }>) => readies.push(event.detail)
    element.addEventListener('docsterm-ready', onReady)
    element.removeEventListener('docsterm-ready', onReady)
    element.dispatchEvent(new CustomEvent('docsterm-ready', { detail: { type: 'ready' } }))
    expect(readies).toEqual([])
    element.addEventListener('click', (event) => {
      expectTypeOf(event).toEqualTypeOf<HTMLElementEventMap['click']>()
    })
    expectTypeOf<DocsTerminalElementEventMap['docsterm-ready']>().toEqualTypeOf<CustomEvent<{ type: 'ready' }>>()
  })
})

describe('Run buttons with <docs-terminal>', () => {
  it('scrolls to the element, focuses its terminal and runs the block', async () => {
    const element = create()
    element.backend = backend()
    host.innerHTML = '<pre data-docsterm-run><code>$ orbit status\nok</code></pre>'
    host.append(element)
    await prompt(element)
    const scroll = vi.fn()
    element.scrollIntoView = scroll
    const cleanup = attachRunButtons(host, element)
    const runs: Promise<RunReport>[] = []
    const run = element.run.bind(element)
    element.run = (text) => {
      const report = run(text)
      runs.push(report)
      return report
    }
    host.querySelector<HTMLButtonElement>('button.docsterm-run')?.click()
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    expect(document.activeElement).toBe(termOf(element).textarea)
    expect(await runs[0]).toEqual({ exitCode: 0, output: 'ran orbit status' })
    await until(() => screen(element).length === 5, 'the command on screen')
    expect(screen(element).slice(-3)).toEqual(['$ orbit status', 'ran orbit status', '$ '])
    cleanup()
  })
})
