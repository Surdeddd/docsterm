import { describe, expect, it } from 'vitest'
import { AIProviderError, isAbortError } from '../src/errors.js'
import {
  ANSI_SOURCE,
  hasInvisible,
  normalizeOutput,
  sanitizeCommand,
  sanitizeProse,
  stripAnsi,
  withoutInvisible,
} from '../src/text.js'

describe('text helpers', () => {
  it('normalizes bare newlines for xterm', () => {
    expect(normalizeOutput('a\nb\r\nc')).toBe('a\r\nb\r\nc')
  })

  it('strips CSI, OSC and other escape sequences', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green')
    expect(stripAnsi('a\x1b]8;;http://x\x07b\x1b]8;;\x07c')).toBe('abc')
    expect(stripAnsi('x\x1b]52;c;ZXZpbA==\x1b\\y')).toBe('xy')
    expect(stripAnsi('\x9b31mred')).toBe('red')
    expect(stripAnsi('\x1b(Bplain')).toBe('plain')
    expect(stripAnsi('a\x1bXsos\x1b\\b')).toBe('ab')
  })

  it('ends an OSC or DCS string at an embedded escape, the way xterm parses it', () => {
    expect(stripAnsi('\x1b]0;a\x1b[?1049hb\x07')).toBe('b\x07')
    expect(new RegExp(ANSI_SOURCE, 'g').exec('\x1b]0;a\x1b[?1049hb')?.[0]).toBe('\x1b]0;a')
    expect(stripAnsi('\x1bPq\x1b[31mred')).toBe('red')
    expect(stripAnsi('a\x1b]0;title')).toBe('a0;title')
  })

  it('stays linear on many unterminated OSC starts', () => {
    const text = '\x1b]x'.repeat(50_000)
    const started = performance.now()
    expect(stripAnsi(text)).toBe('x')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('treats SS2/SS3 as a two-byte escape, the way xterm prints the next character', () => {
    expect(stripAnsi('\x1bOx$ ')).toBe('x$ ')
    expect(stripAnsi('\x1bNy')).toBe('y')
  })

  it('removes control sequences that could disguise a suggested command', () => {
    expect(sanitizeCommand('ls\x1b[8m; rm x\x1b[28m')).toBe('ls; rm x')
    expect(sanitizeCommand('rm -rf docs ; \r\x1b[2Kls -la')).toBe('rm -rf docs ; \nls -la')
    expect(sanitizeCommand('  \x07\x1b[0m  ')).toBe('')
    expect(sanitizeCommand('echo\ta\x00b')).toBe('echo\tab')
  })

  it('finds and strips characters that change how text is shown without being seen', () => {
    const samples = [
      'echo hi⁧⁦; echo PWNED⁩⁦ # note⁩⁩',
      'echo safe‮; rm -rf ~',
      'echo ‪x‬ ‎‏؜',
      'ls rm -rf ~',
      'ls rm',
      'echo a‍b',
      'rm​ -rf',
      'echo \u{e0041}\u{e0042}',
      '﻿ls',
      'echo ­',
      'echo ㅤ ᅟ ᅠ ﾠ',
      'echo \u{50000}',
    ]
    expect(samples.map(hasInvisible)).toEqual(samples.map(() => true))
    expect(samples.map(withoutInvisible)).toEqual([
      'echo hi; echo PWNED # note',
      'echo safe; rm -rf ~',
      'echo x ',
      'lsrm -rf ~',
      'lsrm',
      'echo ab',
      'rm -rf',
      'echo ',
      'ls',
      'echo ',
      'echo    ',
      'echo ',
    ])
    expect(['ls -la', 'echo "привет 世界 😀"', 'printf "a\\tb"', 'echo 👍🏽'].map(hasInvisible)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })

  it('keeps newlines and tabs in prose but drops hyperlinks and clipboard writes', () => {
    expect(sanitizeProse('a\x1b]8;;http://x\x07b\x1b]8;;\x07')).toBe('ab')
    expect(sanitizeProse('line one\r\nline\ttwo\x1b[2J')).toBe('line one\nline\ttwo')
  })
})

describe('AI errors', () => {
  it('carries a code and an optional status', () => {
    const error = new AIProviderError('http', '429: rate limited', { status: 429 })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AIProviderError')
    expect(error.code).toBe('http')
    expect(error.status).toBe(429)
    expect(error.message).toBe('429: rate limited')
  })

  it('recognizes aborts from fetch and the Anthropic SDK', () => {
    expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true)
    expect(isAbortError(Object.assign(new Error('x'), { name: 'APIUserAbortError' }))).toBe(true)
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
