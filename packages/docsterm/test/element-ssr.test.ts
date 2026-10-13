// @vitest-environment node
import { describe, expect, it } from 'vitest'

describe('docsterm/element without a DOM', () => {
  it('imports in bare Node, defines nothing and ignores a define call', async () => {
    const element = await import('../src/element/index.js')
    expect(typeof globalThis.customElements).toBe('undefined')
    expect(typeof globalThis.HTMLElement).toBe('undefined')
    expect(element.defineDocsTerminal()).toBeUndefined()
    expect(element.defineDocsTerminal('docs-terminal')).toBeUndefined()
    expect(Object.keys(element).sort()).toEqual(['defineDocsTerminal'])
  })
})
