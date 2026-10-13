// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import * as xterm from '@xterm/xterm'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRef, StrictMode, type ForwardRefExoticComponent, type RefAttributes } from 'react'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { DocsTerminal as RealDocsTerminal } from '../src/docs-terminal.js'
import { createMockBackend } from '../src/mock/index.js'
import type { AIProvider, Backend, BackendHost, DocsTerminalEvent, DocsTerminalOptions, RunReport } from '../src/types.js'

type WidgetSurface = Pick<RealDocsTerminal, 'mount' | 'dispose' | 'setOptions' | 'run' | 'insert' | 'focus' | 'clear'>
type LiveOptions = Parameters<RealDocsTerminal['setOptions']>[0]

const { FakeWidget, widgetMode } = vi.hoisted(() => {
  class FakeWidget implements WidgetSurface {
    static readonly instances: FakeWidget[] = []
    readonly calls: Array<[string, unknown]> = []
    element: HTMLElement | null = null
    disposed = false
    private settle: { resolve: () => void; reject: (error: unknown) => void } | null = null

    constructor(readonly options: DocsTerminalOptions) {
      FakeWidget.instances.push(this)
    }

    mount(element: HTMLElement): Promise<void> {
      if (this.element) throw new Error('DocsTerminal is already mounted')
      this.element = element
      return new Promise<void>((resolve, reject) => {
        this.settle = { resolve, reject }
      })
    }

    finishMount(): void {
      this.settle?.resolve()
    }

    failMount(error: unknown): void {
      this.settle?.reject(error)
    }

    dispose(): void {
      this.disposed = true
      this.calls.push(['dispose', undefined])
      this.settle?.reject(new DOMException('disposed', 'AbortError'))
    }

    setOptions(patch: LiveOptions): void {
      this.calls.push(['setOptions', patch])
    }

    run(text: string): Promise<RunReport> {
      this.calls.push(['run', text])
      return Promise.resolve({ exitCode: 0, output: `fake ${text}` })
    }

    insert(text: string): void {
      this.calls.push(['insert', text])
    }

    focus(): void {
      this.calls.push(['focus', undefined])
    }

    clear(): void {
      this.calls.push(['clear', undefined])
    }
  }
  return { FakeWidget, widgetMode: { real: false } }
})

vi.mock('../src/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/index.js')>()
  function DocsTerminal(options: DocsTerminalOptions) {
    return widgetMode.real ? new actual.DocsTerminal(options) : new FakeWidget(options)
  }
  return { ...actual, DocsTerminal }
})

import { DocsTerminal, type DocsTerminalHandle, type DocsTerminalProps } from '../src/react/index.js'

const resolveExport = <T,>(module: unknown, name: string): T => {
  const loaded = module as Record<string, unknown> & { default?: Record<string, unknown> }
  return (loaded[name] ?? loaded.default?.[name]) as T
}

const TerminalClass = resolveExport<typeof xterm.Terminal>(xterm, 'Terminal')

const backend: Backend = {
  id: 'fake',
  prompt: '$ ',
  init: async () => {},
  run: async () => ({ output: '', exitCode: 0 }),
  dispose: () => {},
}

const otherBackend: Backend = { ...backend, id: 'other' }

const ai: AIProvider = {
  id: 'fake-ai',
  suggestCommand: async () => ({ command: 'ls', explanation: 'list files' }),
  explainError: async () => 'explained',
}

const instances = FakeWidget.instances
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const settle = () => sleep(0)

const until = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(2)
  }
}

const attributes = (element: Element | null) =>
  Object.fromEntries(Array.from(element?.attributes ?? [], (attribute) => [attribute.name, attribute.value]))

const screen = (term: xterm.Terminal) => {
  const buffer = term.buffer.active
  const rows: string[] = []
  for (let index = 0; index < buffer.length; index += 1) rows.push(buffer.getLine(index)?.translateToString(true) ?? '')
  while (rows.length > 0 && rows.at(-1) === '') rows.pop()
  return rows
}

beforeEach(() => {
  instances.length = 0
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(async () => {
  cleanup()
  await settle()
  process.off('unhandledRejection', onUnhandled)
  vi.restoreAllMocks()
})

describe('DocsTerminal react component', () => {
  it('mounts one widget into its container div and hands it only the widget options', () => {
    const { container } = render(
      <DocsTerminal
        backend={backend}
        theme="dark"
        locale="ru"
        welcome="hello"
        ariaLabel="Python terminal"
        className="term"
      />,
    )
    expect(instances).toHaveLength(1)
    expect(instances[0]?.element).toBe(container.firstElementChild)
    expect(instances[0]?.options).toEqual({
      backend,
      theme: 'dark',
      locale: 'ru',
      welcome: 'hello',
      ariaLabel: 'Python terminal',
    })
    expect(instances[0]?.calls).toEqual([])
  })

  it('passes id, title, role, aria-* and data-* props to the container div', () => {
    const { container } = render(
      <DocsTerminal
        backend={backend}
        id="python"
        title="Python playground"
        role="group"
        aria-describedby="python-hint"
        data-testid="python-terminal"
        className="term"
        style={{ height: 320 }}
      />,
    )
    expect(attributes(container.firstElementChild)).toEqual({
      id: 'python',
      title: 'Python playground',
      role: 'group',
      'aria-describedby': 'python-hint',
      'data-testid': 'python-terminal',
      class: 'term',
      style: 'height: 320px;',
    })
    expect(instances[0]?.options).toEqual({ backend })
  })

  it('labels the terminal, not the container div, with aria-label', () => {
    const view = render(<DocsTerminal backend={backend} aria-label="Python terminal" aria-describedby="python-hint" />)
    expect(attributes(view.container.firstElementChild)).toEqual({ 'aria-describedby': 'python-hint' })
    expect(instances[0]?.options).toEqual({ backend, ariaLabel: 'Python terminal' })
    view.rerender(<DocsTerminal backend={backend} aria-label="Shell" aria-describedby="python-hint" />)
    expect(attributes(view.container.firstElementChild)).toEqual({ 'aria-describedby': 'python-hint' })
    expect(instances).toHaveLength(1)
    expect(instances[0]?.calls).toStrictEqual([['setOptions', { ariaLabel: 'Shell' }]])
  })

  it('prefers the ariaLabel option over aria-label when both are given', () => {
    render(<DocsTerminal backend={backend} ariaLabel="From option" aria-label="From attribute" />)
    expect(instances[0]?.options).toEqual({ backend, ariaLabel: 'From option' })
  })

  it('applies every live prop change through setOptions without remounting', () => {
    const view = render(<DocsTerminal backend={backend} theme="light" locale="en" />)
    const widget = instances[0]
    widget?.finishMount()
    view.rerender(<DocsTerminal backend={backend} theme="dark" locale="en" />)
    view.rerender(<DocsTerminal backend={backend} theme="dark" locale="ru" />)
    view.rerender(<DocsTerminal backend={backend} theme="dark" locale="ru" ai={ai} />)
    view.rerender(<DocsTerminal backend={backend} theme="dark" locale="ru" ai={ai} pageContext={{ title: 'Install' }} />)
    view.rerender(
      <DocsTerminal
        backend={backend}
        theme="dark"
        locale="ru"
        ai={ai}
        pageContext={{ title: 'Install' }}
        fontFamily="Iosevka"
        fontSize={16}
      />,
    )
    view.rerender(
      <DocsTerminal
        backend={backend}
        theme="dark"
        locale="ru"
        ai={ai}
        pageContext={{ title: 'Install' }}
        fontFamily="Iosevka"
        fontSize={16}
        ariaLabel="Shell"
        screenReaderMode
      />,
    )
    view.rerender(<DocsTerminal backend={backend} />)
    expect(instances).toHaveLength(1)
    expect(widget?.calls).toStrictEqual([
      ['setOptions', { theme: 'dark' }],
      ['setOptions', { locale: 'ru' }],
      ['setOptions', { ai }],
      ['setOptions', { pageContext: { title: 'Install' } }],
      ['setOptions', { fontFamily: 'Iosevka', fontSize: 16 }],
      ['setOptions', { ariaLabel: 'Shell', screenReaderMode: true }],
      [
        'setOptions',
        {
          theme: undefined,
          locale: undefined,
          ai: undefined,
          pageContext: undefined,
          fontFamily: undefined,
          fontSize: undefined,
          ariaLabel: undefined,
          screenReaderMode: undefined,
        },
      ],
    ])
  })

  it('forwards prop changes that arrive while the widget is still mounting', async () => {
    const onReady = vi.fn()
    const view = render(<DocsTerminal backend={backend} theme="light" onReady={onReady} />)
    view.rerender(<DocsTerminal backend={backend} theme="dark" onReady={onReady} />)
    expect(instances[0]?.calls).toStrictEqual([['setOptions', { theme: 'dark' }]])
    instances[0]?.finishMount()
    await settle()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('keeps welcome a mount-time option', () => {
    const view = render(<DocsTerminal backend={backend} welcome="first welcome" />)
    view.rerender(<DocsTerminal backend={backend} welcome="second welcome" />)
    expect(instances).toHaveLength(1)
    expect(instances[0]?.options.welcome).toBe('first welcome')
    expect(instances[0]?.calls).toEqual([])
  })

  it('compares theme and page context by value, so only real changes reach the widget', () => {
    const view = render(
      <DocsTerminal backend={backend} ai={ai} theme={{ background: '#000000' }} pageContext={{ title: 'Install' }} />,
    )
    view.rerender(
      <DocsTerminal backend={backend} ai={ai} theme={{ background: '#000000' }} pageContext={{ title: 'Install' }} />,
    )
    expect(instances).toHaveLength(1)
    expect(instances[0]?.calls).toEqual([])
    view.rerender(
      <DocsTerminal backend={backend} ai={ai} theme={{ background: '#ffffff' }} pageContext={{ title: 'Install' }} />,
    )
    expect(instances[0]?.calls).toStrictEqual([['setOptions', { theme: { background: '#ffffff' } }]])
  })

  it('remounts with the latest props when the backend changes', async () => {
    const view = render(<DocsTerminal backend={backend} theme="light" />)
    view.rerender(<DocsTerminal backend={otherBackend} theme="dark" />)
    await settle()
    expect(instances).toHaveLength(2)
    const [first, second] = instances
    expect(first?.calls).toEqual([['dispose', undefined]])
    expect(second?.options).toEqual({ backend: otherBackend, theme: 'dark' })
    expect(second?.element).toBe(first?.element)
    expect(second?.calls).toEqual([])
    expect(unhandled).toEqual([])
  })

  it('keeps exactly one live widget under StrictMode and swallows the AbortError of the first one', async () => {
    const onReady = vi.fn()
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <StrictMode>
        <DocsTerminal backend={backend} onReady={onReady} onError={onError} />
      </StrictMode>,
    )
    expect(instances).toHaveLength(2)
    const [first, second] = instances
    expect(first?.calls).toEqual([['dispose', undefined]])
    expect(second?.disposed).toBe(false)
    expect(second?.element).toBe(first?.element)
    await settle()
    expect(unhandled).toEqual([])
    expect(onError).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    second?.finishMount()
    await settle()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady.mock.calls[0]?.[0]).toBe(second)
  })

  it('calls the latest onReady once the mount resolves', async () => {
    const stale = vi.fn()
    const latest = vi.fn()
    const view = render(<DocsTerminal backend={backend} onReady={stale} />)
    view.rerender(<DocsTerminal backend={backend} onReady={latest} />)
    instances[0]?.finishMount()
    await settle()
    expect(stale).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
    expect(latest.mock.calls[0]?.[0]).toBe(instances[0])
  })

  it('calls the latest onError once the mount fails', async () => {
    const stale = vi.fn()
    const latest = vi.fn()
    const view = render(<DocsTerminal backend={backend} onError={stale} />)
    view.rerender(<DocsTerminal backend={backend} onError={latest} />)
    const failure = new Error('cannot connect to wss://sandbox.example/shell')
    instances[0]?.failMount(failure)
    await settle()
    expect(stale).not.toHaveBeenCalled()
    expect(latest.mock.calls).toEqual([[failure]])
    expect(unhandled).toEqual([])
  })

  it('does not report a mount that settles after the component unmounted', async () => {
    const onReady = vi.fn()
    const view = render(<DocsTerminal backend={backend} onReady={onReady} />)
    instances[0]?.finishMount()
    view.unmount()
    await settle()
    expect(onReady).not.toHaveBeenCalled()
    expect(instances[0]?.calls).toEqual([['dispose', undefined]])
  })

  it('reports a failed mount to onError and leaves no unhandled rejection', async () => {
    const onReady = vi.fn()
    const onError = vi.fn()
    render(<DocsTerminal backend={backend} onReady={onReady} onError={onError} />)
    const failure = new Error('cannot connect to wss://sandbox.example/shell')
    instances[0]?.failMount(failure)
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBe(failure)
    expect(onReady).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  })

  it('logs a failed mount with console.error when no onError is given', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<DocsTerminal backend={backend} />)
    const failure = new Error('environment failed to start')
    instances[0]?.failMount(failure)
    await settle()
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError.mock.calls[0]?.[0]).toBe(failure)
    expect(unhandled).toEqual([])
  })

  it('logs an exception thrown by onReady instead of leaving an unhandled rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bug = new Error('onReady bug')
    const onError = vi.fn()
    render(
      <DocsTerminal
        backend={backend}
        onReady={() => {
          throw bug
        }}
        onError={onError}
      />,
    )
    instances[0]?.finishMount()
    await settle()
    await settle()
    expect(unhandled).toEqual([])
    expect(consoleError.mock.calls).toEqual([[bug]])
    expect(onError).not.toHaveBeenCalled()
  })

  it('logs an exception thrown by onError instead of leaving an unhandled rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bug = new Error('onError bug')
    const onError = vi.fn(() => {
      throw bug
    })
    render(<DocsTerminal backend={backend} onError={onError} />)
    const failure = new Error('environment failed to start')
    instances[0]?.failMount(failure)
    await settle()
    await settle()
    expect(unhandled).toEqual([])
    expect(onError.mock.calls).toEqual([[failure]])
    expect(consoleError.mock.calls).toEqual([[bug]])
  })

  it('disposes a widget that is still mounting on unmount without reporting its AbortError', async () => {
    const onError = vi.fn()
    const view = render(<DocsTerminal backend={backend} onError={onError} />)
    view.unmount()
    await settle()
    expect(instances[0]?.calls).toEqual([['dispose', undefined]])
    expect(onError).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  })

  it("starts with the 'use client' directive", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/react/index.tsx'), 'utf8')
    expect(source.split('\n')[0]).toBe("'use client'")
  })

  it('is a forwardRef component typed with types every @types/react version has', () => {
    expectTypeOf(DocsTerminal).toEqualTypeOf<
      ForwardRefExoticComponent<DocsTerminalProps & RefAttributes<DocsTerminalHandle>>
    >()
    expectTypeOf<DocsTerminalHandle>().toEqualTypeOf<{
      run(text: string): Promise<RunReport>
      insert(text: string): void
      focus(): void
      clear(): void
    }>()
  })

  it('exposes run, insert, focus and clear through a ref', async () => {
    const ref = createRef<DocsTerminalHandle>()
    render(<DocsTerminal ref={ref} backend={backend} />)
    const report = ref.current?.run('ls')
    ref.current?.insert('git status')
    ref.current?.focus()
    ref.current?.clear()
    expect(instances[0]?.calls).toEqual([
      ['run', 'ls'],
      ['insert', 'git status'],
      ['focus', undefined],
      ['clear', undefined],
    ])
    await expect(report).resolves.toEqual({ exitCode: 0, output: 'fake ls' })
  })

  it('points the ref at the new widget after a remount', async () => {
    const ref = createRef<DocsTerminalHandle>()
    const view = render(<DocsTerminal ref={ref} backend={backend} />)
    view.rerender(<DocsTerminal ref={ref} backend={otherBackend} />)
    await settle()
    ref.current?.insert('ls')
    expect(instances.map((instance) => instance.calls)).toEqual([[['dispose', undefined]], [['insert', 'ls']]])
  })

  it('sends later prop changes to the widget of a remount, measured against its mount options', async () => {
    const view = render(<DocsTerminal backend={backend} theme="light" locale="en" />)
    view.rerender(<DocsTerminal backend={otherBackend} theme="dark" locale="en" />)
    await settle()
    const [first, second] = instances
    expect(first?.calls).toEqual([['dispose', undefined]])
    expect(second?.options).toEqual({ backend: otherBackend, theme: 'dark', locale: 'en' })
    view.rerender(<DocsTerminal backend={otherBackend} theme="dark" locale="en" />)
    view.rerender(<DocsTerminal backend={otherBackend} theme="light" locale="en" />)
    view.rerender(<DocsTerminal backend={otherBackend} theme="light" locale="ru" />)
    expect(second?.calls).toStrictEqual([
      ['setOptions', { theme: 'light' }],
      ['setOptions', { locale: 'ru' }],
    ])
    expect(first?.calls).toEqual([['dispose', undefined]])
  })

  it('keeps the ref handle safe after unmount', async () => {
    const ref = createRef<DocsTerminalHandle>()
    const view = render(<DocsTerminal ref={ref} backend={backend} />)
    const handle = ref.current as DocsTerminalHandle
    view.unmount()
    expect(ref.current).toBeNull()
    await expect(handle.run('ls')).rejects.toMatchObject({ name: 'AbortError', message: 'DocsTerminal is not mounted' })
    handle.insert('ls')
    handle.focus()
    handle.clear()
    expect(instances[0]?.calls).toEqual([['dispose', undefined]])
  })

  it('passes onEvent to the widget and forwards a new listener live', () => {
    const first = vi.fn()
    const second = vi.fn()
    const view = render(<DocsTerminal backend={backend} onEvent={first} />)
    expect(instances[0]?.options).toEqual({ backend, onEvent: first })
    view.rerender(<DocsTerminal backend={backend} onEvent={first} />)
    view.rerender(<DocsTerminal backend={backend} onEvent={second} />)
    expect(instances).toHaveLength(1)
    expect(instances[0]?.calls).toStrictEqual([['setOptions', { onEvent: second }]])
  })

  it('constructs the fake widget exactly like the real one', () => {
    expectTypeOf(FakeWidget).constructorParameters.toEqualTypeOf<ConstructorParameters<typeof RealDocsTerminal>>()
    expectTypeOf<InstanceType<typeof FakeWidget>>().toExtend<WidgetSurface>()
  })
})

describe('DocsTerminal react component with the real widget', () => {
  beforeEach(() => {
    widgetMode.real = true
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }))
  })

  afterEach(() => {
    cleanup()
    widgetMode.real = false
    vi.unstubAllGlobals()
  })

  it('opens one terminal under StrictMode, never initialises the backend for the discarded widget, and runs a command', async () => {
    const events: string[] = []
    const mock = createMockBackend({ script: { hello: { output: 'hi from mock' } } })
    const tracked: Backend = {
      ...mock,
      init: async (host: BackendHost) => {
        events.push('backend.init')
        await mock.init(host)
      },
      dispose: () => {
        events.push('backend.dispose')
        mock.dispose()
      },
    }
    const disposeWidget = RealDocsTerminal.prototype.dispose
    vi.spyOn(RealDocsTerminal.prototype, 'dispose').mockImplementation(function (this: RealDocsTerminal) {
      events.push('widget.dispose')
      disposeWidget.call(this)
    })
    const open = vi.spyOn(TerminalClass.prototype, 'open')
    const onReady = vi.fn()
    const onError = vi.fn()
    const view = render(
      <StrictMode>
        <DocsTerminal backend={tracked} welcome="welcome" onReady={onReady} onError={onError} />
      </StrictMode>,
    )
    await until(() => onReady.mock.calls.length > 0, 'onReady')
    expect(view.container.querySelectorAll('.xterm')).toHaveLength(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['widget.dispose', 'backend.init'])
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady.mock.calls[0]?.[0]).toBeInstanceOf(RealDocsTerminal)
    const term = open.mock.contexts[0] as xterm.Terminal
    term.input('hello\r')
    await until(() => screen(term).length === 5 && screen(term).at(-1) === '$ ', 'the command output')
    expect(screen(term)).toEqual(['welcome', 'loading environment...', '$ hello', 'hi from mock', '$ '])
    view.unmount()
    await sleep(20)
    expect(events).toEqual(['widget.dispose', 'backend.init', 'widget.dispose', 'backend.dispose'])
    expect(view.container.querySelectorAll('.xterm')).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  })

  it('reports command durations from the performance clock', async () => {
    let clock = 0
    const timed: Backend = {
      id: 'timed',
      prompt: '$ ',
      init: async () => {},
      run: async () => {
        clock += 75
        return { output: 'ok', exitCode: 0 }
      },
      dispose: () => {},
    }
    const ref = createRef<DocsTerminalHandle>()
    const events: DocsTerminalEvent[] = []
    const onReady = vi.fn()
    const view = render(<DocsTerminal ref={ref} backend={timed} onReady={onReady} onEvent={(event) => events.push(event)} />)
    await until(() => onReady.mock.calls.length > 0, 'onReady')
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      expect(await ref.current?.run('build')).toEqual({ exitCode: 0, output: 'ok' })
    } finally {
      now.mockRestore()
    }
    expect(events.at(-1)).toEqual({ type: 'command', command: 'build', source: 'api', exitCode: 0, durationMs: 75 })
    view.unmount()
  })

  it('runs a command through the ref and sends events to the latest onEvent', async () => {
    const mock = createMockBackend({ script: { hello: { output: 'hi from mock' } } })
    const ref = createRef<DocsTerminalHandle>()
    const first: DocsTerminalEvent[] = []
    const second: DocsTerminalEvent[] = []
    const onReady = vi.fn()
    const open = vi.spyOn(TerminalClass.prototype, 'open')
    const view = render(
      <DocsTerminal ref={ref} backend={mock} welcome="welcome" onReady={onReady} onEvent={(event) => first.push(event)} />,
    )
    await until(() => onReady.mock.calls.length > 0, 'onReady')
    expect(await ref.current?.run('hello')).toEqual({ exitCode: 0, output: 'hi from mock' })
    view.rerender(
      <DocsTerminal ref={ref} backend={mock} welcome="welcome" onReady={onReady} onEvent={(event) => second.push(event)} />,
    )
    expect(await ref.current?.run('hello')).toEqual({ exitCode: 0, output: 'hi from mock' })
    const command = { type: 'command', command: 'hello', source: 'api', exitCode: 0, durationMs: expect.any(Number) }
    expect(first).toEqual([{ type: 'ready' }, command])
    expect(second).toEqual([command])
    const term = open.mock.contexts[0] as xterm.Terminal
    await until(() => screen(term).length === 7, 'the second prompt')
    expect(screen(term)).toEqual(['welcome', 'loading environment...', '$ hello', 'hi from mock', '$ hello', 'hi from mock', '$ '])
    view.unmount()
  })
})
