import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'

export const SHELL = '/project $ '
export const JS = '> '
export const PYTHON = '>>> '
export const WASM = 'wasm $ '
export const CONFIRM = 'run it? [y/N] '

export interface Screen {
  rows: string[]
  cursor: number
}

export interface RunOptions {
  prompt?: string
  next?: string
  timeout?: number
  fresh?: boolean
}

const compact = (text: string) => text.replace(/\s+/g, '')

const LINE_START = /^(\/\S* \$ |> |>>> |\.\.\. |wasm \$ |run it\? |выполнить\? )/

interface RawRow {
  text: string
  full: boolean
  cursor: boolean
}

export async function readScreen(page: Page, slot: string): Promise<Screen> {
  const rows = page.locator(`${slot} .xterm-rows`)
  await rows.scrollIntoViewIfNeeded()
  const raw: RawRow[] = await rows.evaluate((element) => {
    const children = Array.from(element.children) as HTMLElement[]
    const measure = element.closest('.xterm')?.querySelector('.xterm-char-measure-element')
    const cell = measure ? measure.getBoundingClientRect().width / (measure.textContent ?? 'W').length : 0
    const width = Number.parseFloat(children[0]?.style.width ?? '')
    const columns = cell > 0 && width > 0 ? Math.round(width / cell) : Number.POSITIVE_INFINITY
    return children.map((row) => {
      const text = (row.textContent ?? '').replace(/\u00a0/g, ' ')
      return { text, full: text.length >= columns, cursor: row.querySelector('.xterm-cursor') !== null }
    })
  })
  const lines: string[] = []
  let cursor = -1
  raw.forEach((row, index) => {
    const continues = index > 0 && raw[index - 1]?.full === true && !row.cursor && !LINE_START.test(row.text)
    if (continues && lines.length > 0) lines[lines.length - 1] += row.text
    else lines.push(row.text)
    if (row.cursor) cursor = lines.length - 1
  })
  return { rows: lines.map((line) => line.trimEnd()), cursor }
}

const restAfter = (row: string, needle: string): string | null => {
  let matched = 0
  for (let index = 0; index < row.length; index += 1) {
    if (/\s/.test(row[index] ?? '')) continue
    if (row[index] !== needle[matched]) return null
    matched += 1
    if (matched === needle.length) return row.slice(index + 1)
  }
  return null
}

export function outputAfter(screen: Screen, echo: string): string[] | null {
  const target = compact(echo)
  for (let start = screen.cursor - 1; start >= 0; start -= 1) {
    let joined = ''
    for (let end = start; end < screen.cursor; end += 1) {
      const row = screen.rows[end] ?? ''
      const before = joined
      joined += compact(row)
      if (joined === target) return screen.rows.slice(end + 1, screen.cursor)
      if (joined.startsWith(target)) {
        const rest = restAfter(row, target.slice(before.length))
        if (rest !== null) return [rest, ...screen.rows.slice(end + 1, screen.cursor)]
      }
      if (!target.startsWith(joined)) break
    }
  }
  return null
}

export function joinProse(lines: string[], text: string): string[] {
  for (let start = 0; start < lines.length; start += 1) {
    for (let end = start + 1; end <= lines.length; end += 1) {
      const joined = lines.slice(start, end).join(' ')
      if (joined === text) return [...lines.slice(0, start), text, ...lines.slice(end)]
      if (!text.startsWith(joined)) break
    }
  }
  return lines
}

const atPrompt = (screen: Screen, prompt: string) =>
  screen.cursor >= 0 && screen.rows[screen.cursor] === prompt.trimEnd()

export async function waitForPrompt(page: Page, slot: string, prompt: string, timeout = 30_000): Promise<Screen> {
  await focusTerminal(page, slot, timeout)
  let last: Screen = { rows: [], cursor: -1 }
  await expect
    .poll(
      async () => {
        last = await readScreen(page, slot)
        return atPrompt(last, prompt)
      },
      { timeout, message: `prompt "${prompt}" in ${slot}` },
    )
    .toBe(true)
  return last
}

export async function focusTerminal(page: Page, slot: string, timeout = 30_000): Promise<void> {
  const input = page.locator(`${slot} textarea.xterm-helper-textarea`)
  await input.focus({ timeout })
  await expect(input).toBeFocused()
}

export async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 12 })
}

export async function runCommand(page: Page, slot: string, line: string, options: RunOptions = {}): Promise<string[]> {
  const prompt = options.prompt ?? SHELL
  const next = options.next ?? prompt
  await waitForPrompt(page, slot, prompt)
  if (options.fresh) {
    await page.keyboard.press('Control+l')
    await expect.poll(async () => (await readScreen(page, slot)).cursor).toBe(0)
  }
  await typeText(page, line)
  await page.keyboard.press('Enter')
  return waitForOutput(page, slot, prompt + line, next, options.timeout)
}

export async function waitForOutput(
  page: Page,
  slot: string,
  echo: string,
  next: string,
  timeout = 30_000,
): Promise<string[]> {
  let output: string[] | null = null
  let last: Screen = { rows: [], cursor: -1 }
  await expect
    .poll(
      async () => {
        last = await readScreen(page, slot)
        output = atPrompt(last, next) ? outputAfter(last, echo) : null
        return output !== null
      },
      { timeout, message: `"${echo}" followed by "${next}" in ${slot}` },
    )
    .toBe(true)
  return output ?? []
}

export async function pasteInto(page: Page, slot: string, text: string): Promise<void> {
  await focusTerminal(page, slot)
  await page.locator(`${slot} textarea.xterm-helper-textarea`).evaluate((element, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

export async function quietFor(page: Page, slot: string, ms: number): Promise<Screen> {
  const before = await readScreen(page, slot)
  await page.waitForTimeout(ms)
  const after = await readScreen(page, slot)
  expect(after).toEqual(before)
  return after
}

export async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
}

const PYODIDE_DIR = path.resolve(import.meta.dirname, '../packages/docsterm/node_modules/pyodide')
export const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/**'

const CONTENT_TYPES: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.zip': 'application/zip',
}

const CROSS_ORIGIN = {
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
}

export async function servePyodide(context: BrowserContext, options: { network?: boolean } = {}): Promise<void> {
  await context.route(PYODIDE_CDN, async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname)
    const file = path.join(PYODIDE_DIR, name)
    if (name !== '' && existsSync(file)) {
      await route.fulfill({
        status: 200,
        body: await readFile(file),
        headers: { ...CROSS_ORIGIN, 'content-type': CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream' },
      })
      return
    }
    if (options.network) {
      await route.continue()
      return
    }
    await route.fulfill({ status: 404, body: 'not served offline', headers: CROSS_ORIGIN })
  })
}

const NETWORK_PROBES = [
  'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide-lock.json',
  'https://pypi.org/pypi/snowballstemmer/json',
]

const reachable = async (url: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      if (response.ok) return true
    } catch {
      continue
    }
  }
  return false
}

export async function isOnline(): Promise<boolean> {
  const results = await Promise.all(NETWORK_PROBES.map(reachable))
  return results.every(Boolean)
}

export function collectConsole(page: Page): string[] {
  const messages: string[] = []
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`))
  return messages
}
