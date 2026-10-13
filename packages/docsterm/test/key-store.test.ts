import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyStore } from '../src/key-store.js'

const memoryStorage = () => {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  }
}

const denied = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('keyStore', () => {
  it('saves, reads and clears a key in localStorage', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    expect(keyStore.get('docsterm:key')).toBeNull()
    keyStore.set('docsterm:key', 'sk-1')
    keyStore.set('docsterm:other', 'sk-2')
    expect([keyStore.get('docsterm:key'), [...storage.items]]).toEqual([
      'sk-1',
      [
        ['docsterm:key', 'sk-1'],
        ['docsterm:other', 'sk-2'],
      ],
    ])
    keyStore.clear('docsterm:key')
    expect([keyStore.get('docsterm:key'), [...storage.items]]).toEqual([null, [['docsterm:other', 'sk-2']]])
  })

  it('reads nothing and stores nothing without localStorage', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => keyStore.set('docsterm:key', 'sk-1')).not.toThrow()
    expect(() => keyStore.clear('docsterm:key')).not.toThrow()
    expect(keyStore.get('docsterm:key')).toBeNull()
  })

  it('treats a storage that throws on every call like a missing one', () => {
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied })
    expect(() => keyStore.set('docsterm:key', 'sk-1')).not.toThrow()
    expect(() => keyStore.clear('docsterm:key')).not.toThrow()
    expect(keyStore.get('docsterm:key')).toBeNull()
  })

  it('treats a localStorage that cannot even be reached like a missing one', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: denied })
    try {
      expect(() => keyStore.set('docsterm:key', 'sk-1')).not.toThrow()
      expect(() => keyStore.clear('docsterm:key')).not.toThrow()
      expect(keyStore.get('docsterm:key')).toBeNull()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})
