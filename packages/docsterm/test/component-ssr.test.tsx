// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DocsTerminal } from '../src/react/index.js'
import type { Backend } from '../src/types.js'

const trackedBackend = () =>
  ({
    id: 'ssr',
    prompt: '$ ',
    init: vi.fn(async () => {}),
    run: vi.fn(async () => ({ output: '', exitCode: 0 })),
    dispose: vi.fn(),
  }) satisfies Backend

describe('DocsTerminal react component on the server', () => {
  it('runs without a DOM', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
  })

  it('renders only the container div with its host attributes and never touches the backend', () => {
    const backend = trackedBackend()
    const html = renderToString(
      <DocsTerminal
        backend={backend}
        id="python"
        data-testid="python-terminal"
        className="term"
        style={{ height: 320 }}
        aria-label="Python terminal"
        aria-describedby="python-hint"
        theme="dark"
        locale="ru"
        welcome="hello"
        pageContext={{ title: 'Install' }}
      />,
    )
    expect(html).toBe(
      '<div id="python" data-testid="python-terminal" class="term" style="height:320px" aria-describedby="python-hint"></div>',
    )
    expect(backend.init).not.toHaveBeenCalled()
    expect(backend.run).not.toHaveBeenCalled()
    expect(backend.dispose).not.toHaveBeenCalled()
  })

  it('renders the same markup under StrictMode', () => {
    const backend = trackedBackend()
    const html = renderToString(
      <StrictMode>
        <DocsTerminal backend={backend} className="term" />
      </StrictMode>,
    )
    expect(html).toBe('<div class="term"></div>')
    expect(backend.init).not.toHaveBeenCalled()
  })
})
