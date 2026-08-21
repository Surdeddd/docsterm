import { describe, expect, it } from 'vitest'
import { createMockBackend } from '../src/index'

describe('createMockBackend', () => {
  it('returns the scripted entry for a known command', async () => {
    const backend = createMockBackend({
      script: { 'orbit init': { output: 'initialized', exitCode: 0 } },
    })
    await expect(backend.run(' orbit init ')).resolves.toEqual({
      output: 'initialized',
      exitCode: 0,
    })
  })

  it('falls back to command-not-found with exit 127', async () => {
    const backend = createMockBackend({ script: {} })
    await expect(backend.run('nope')).resolves.toEqual({
      output: 'command not found: nope',
      exitCode: 127,
    })
  })

  it('uses a custom fallback when provided', async () => {
    const backend = createMockBackend({
      script: {},
      fallback: { output: 'try help', exitCode: 1 },
    })
    await expect(backend.run('x')).resolves.toEqual({ output: 'try help', exitCode: 1 })
  })

  it('respects delayMs before resolving', async () => {
    const backend = createMockBackend({
      script: { slow: { output: 'done', delayMs: 30 } },
    })
    const start = Date.now()
    await backend.run('slow')
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  })

  it('writes the banner during init', async () => {
    const backend = createMockBackend({ script: {}, banner: 'orbit demo shell' })
    const writes: string[] = []
    await backend.init({ write: (text) => writes.push(text) })
    expect(writes).toEqual(['orbit demo shell\n'])
  })

  it('exposes id and default prompt', () => {
    const backend = createMockBackend({ script: {} })
    expect(backend.id).toBe('mock')
    expect(backend.prompt).toBe('$ ')
  })
})
