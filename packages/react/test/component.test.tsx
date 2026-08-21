// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Backend } from 'docsterm'

const mountSpy = vi.fn(async (_el: HTMLElement) => {})
const disposeSpy = vi.fn()

vi.mock('docsterm', () => ({
  DocsTerminal: class {
    constructor(public readonly options: unknown) {}
    mount = mountSpy
    dispose = disposeSpy
  },
}))

import { DocsTerminal } from '../src/index'

const backend: Backend = {
  id: 'fake',
  prompt: '$ ',
  init: async () => {},
  run: async () => ({ output: '', exitCode: 0 }),
  dispose: () => {},
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DocsTerminal react component', () => {
  it('renders a container div and mounts the widget into it', () => {
    const { container } = render(<DocsTerminal backend={backend} className="term" />)
    const div = container.querySelector('div.term')
    expect(div).not.toBeNull()
    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(mountSpy.mock.calls[0]?.[0]).toBe(div)
  })

  it('disposes the widget on unmount', () => {
    const { unmount } = render(<DocsTerminal backend={backend} />)
    unmount()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })
})
