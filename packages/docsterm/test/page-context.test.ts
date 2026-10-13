// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectPageContext } from '../src/page-context.js'

beforeEach(() => {
  document.head.innerHTML = '<meta name="description" content="Deploy with orbit">'
  document.title = 'Orbit docs'
  document.body.innerHTML = '<h1>Getting started</h1><h4>ignored</h4><h2> Deploy </h2><h3>Rollback</h3><h5>also ignored</h5>'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('collectPageContext', () => {
  it('reads title, url, description and the h1 to h3 headings in document order', () => {
    expect(collectPageContext()).toEqual({
      title: 'Orbit docs',
      url: location.href,
      description: 'Deploy with orbit',
      headings: ['Getting started', 'Deploy', 'Rollback'],
    })
    expect(location.href).toMatch(/^http/)
  })

  it('drops empty headings and keeps at most the first 30', () => {
    const many = Array.from({ length: 40 }, (_, index) => `<h${(index % 3) + 1}>part ${index}</h${(index % 3) + 1}>`)
    document.body.innerHTML = `<h2>   </h2><h1></h1>${many.join('')}`
    document.head.innerHTML = ''
    const context = collectPageContext()
    expect([context.headings.length, context.headings[0], context.headings.at(-1), context.description]).toEqual([
      30,
      'part 0',
      'part 29',
      '',
    ])
  })

  it('returns empty fields when there is no document or location', () => {
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('location', undefined)
    expect(collectPageContext()).toEqual({ title: '', url: '', description: '', headings: [] })
    expect(collectPageContext({ title: 'Given' })).toEqual({ title: 'Given', url: '', description: '', headings: [] })
  })

  it('lets explicit overrides win and keeps page values for undefined ones', () => {
    expect(collectPageContext({ title: 'Custom', headings: ['One'], description: undefined, url: undefined })).toEqual({
      title: 'Custom',
      url: location.href,
      description: 'Deploy with orbit',
      headings: ['One'],
    })
  })
})
