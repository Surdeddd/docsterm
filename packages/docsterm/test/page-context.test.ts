// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { collectPageContext } from '../src/page-context.js'

describe('collectPageContext', () => {
  it('reads title, description and headings from the document', () => {
    document.head.innerHTML = '<meta name="description" content="Deploy with orbit">'
    document.title = 'Orbit docs'
    document.body.innerHTML = '<h1>Getting started</h1><h2>Deploy</h2><h4>ignored</h4>'
    const context = collectPageContext()
    expect(context.title).toBe('Orbit docs')
    expect(context.description).toBe('Deploy with orbit')
    expect(context.headings).toEqual(['Getting started', 'Deploy'])
    expect(context.url).toContain('http')
  })

  it('lets explicit overrides win', () => {
    document.title = 'Ignored'
    const context = collectPageContext({ title: 'Custom', headings: ['One'] })
    expect(context.title).toBe('Custom')
    expect(context.headings).toEqual(['One'])
  })
})
