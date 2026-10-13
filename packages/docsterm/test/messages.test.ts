import { describe, expect, it } from 'vitest'
import { formatMessage, getMessages, resolveLocale } from '../src/messages.js'

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

  it('uses the same placeholders in both languages', () => {
    const en = getMessages('en') as unknown as Record<string, string>
    const ru = getMessages('ru') as unknown as Record<string, string>
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(en)) {
      expect(placeholders(ru[key] ?? ''), key).toEqual(placeholders(en[key] ?? ''))
    }
  })
})

describe('formatMessage', () => {
  it('fills known placeholders and keeps unknown ones', () => {
    expect(formatMessage('{name}: command not found ({program})', { name: 'ls', program: 'greet' })).toBe(
      'ls: command not found (greet)',
    )
    expect(formatMessage('timed out after {seconds} s', { seconds: 5 })).toBe('timed out after 5 s')
    expect(formatMessage('{missing} stays', {})).toBe('{missing} stays')
    expect(formatMessage('{toString}', {})).toBe('{toString}')
  })
})
