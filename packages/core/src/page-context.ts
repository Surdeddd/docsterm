import type { PageContext } from './types'

const MAX_HEADINGS = 30

export function collectPageContext(overrides: Partial<PageContext> = {}): PageContext {
  const doc = typeof document === 'undefined' ? null : document
  const headings = doc
    ? Array.from(doc.querySelectorAll('h1, h2, h3'))
        .map((el) => el.textContent?.trim() ?? '')
        .filter((text) => text.length > 0)
        .slice(0, MAX_HEADINGS)
    : []
  const base: PageContext = {
    title: doc?.title ?? '',
    url: typeof location === 'undefined' ? '' : location.href,
    description: doc?.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
    headings,
  }
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined))
  return { ...base, ...defined } as PageContext
}
