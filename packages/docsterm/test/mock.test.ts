import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockBackend } from '../src/mock/index.js'

afterEach(() => {
  vi.useRealTimers()
})

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

  it('exits 0 when an entry or a custom fallback names no exit code', async () => {
    const backend = createMockBackend({ script: { plain: { output: 'ok' } }, fallback: { output: 'see help' } })
    expect([await backend.run('plain'), await backend.run('other')]).toEqual([
      { output: 'ok', exitCode: 0 },
      { output: 'see help', exitCode: 0 },
    ])
  })

  it('respects delayMs before resolving', async () => {
    vi.useFakeTimers()
    const backend = createMockBackend({
      script: { slow: { output: 'done', delayMs: 30 } },
    })
    let result: unknown = null
    const running = backend.run('slow').then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(29)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await running
    expect(result).toEqual({ output: 'done', exitCode: 0 })
  })

  it('stops a delayed entry with 130 at once when the run is aborted, and clears its timer', async () => {
    vi.useFakeTimers()
    const backend = createMockBackend({ script: { slow: { output: 'done', delayMs: 10_000 } } })
    const controller = new AbortController()
    const running = backend.run('slow', { write: () => {}, signal: controller.signal, columns: 80, rows: 24 })
    await vi.advanceTimersByTimeAsync(20)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await expect(running).resolves.toEqual({ output: '', exitCode: 130 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not run an entry whose signal is already aborted', async () => {
    const backend = createMockBackend({ script: { now: { output: 'ran' } } })
    const controller = new AbortController()
    controller.abort()
    await expect(
      backend.run('now', { write: () => {}, signal: controller.signal, columns: 80, rows: 24 }),
    ).resolves.toEqual({ output: '', exitCode: 130 })
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
