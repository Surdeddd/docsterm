import { describe, expect, it } from 'vitest'
import { getMessages, resolveLocale } from '../src/messages'

describe('resolveLocale', () => {
  it('maps russian language tags to ru', () => {
    expect(resolveLocale('ru')).toBe('ru')
    expect(resolveLocale('ru-RU')).toBe('ru')
    expect(resolveLocale('RU-ru')).toBe('ru')
  })

  it('defaults everything else to en', () => {
    expect(resolveLocale('en-US')).toBe('en')
    expect(resolveLocale('de-DE')).toBe('en')
    expect(resolveLocale(undefined)).toBe('en')
  })
})

describe('getMessages', () => {
  it('has identical non-empty key sets for en and ru', () => {
    const en = getMessages('en')
    const ru = getMessages('ru')
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
    for (const catalog of [en, ru]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value, key).toBeTypeOf('string')
        expect(value.length, key).toBeGreaterThan(0)
      }
    }
  })

  it('keeps the two languages distinct', () => {
    expect(getMessages('en').welcome).not.toBe(getMessages('ru').welcome)
  })
})
