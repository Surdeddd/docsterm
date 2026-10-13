import { expect, test } from '@playwright/test'
import { JS, WASM, joinProse, readScreen, runCommand, typeText, waitForOutput, waitForPrompt } from './helpers'

const JS_SLOT = '#terminal-js'
const RUST = '#terminal-rust'
const ELEMENT = '#terminal-element'
const ERROR_HINT = "command failed. Type 'explain' to get an AI explanation."

test.describe('javascript terminal', () => {
  test('keeps variables between commands and prints awaited values', async ({ page }) => {
    await page.goto('/')
    const run = (line: string) => runCommand(page, JS_SLOT, line, { prompt: JS })
    expect(await run('const users = [1, 2, 3]')).toEqual([])
    expect(await run('users.map(n => n * 2)')).toEqual(['[ 2, 4, 6 ]'])
    expect(await run('console.log("total:", users.length)')).toEqual(['total: 3'])
    expect(await run('await Promise.resolve("awaited")')).toEqual(["'awaited'"])
    expect(await run('const later = await Promise.resolve(5)')).toEqual([])
    expect(await run('later + users.length')).toEqual(['8'])
  })

  test('reports a thrown error with the explain hint', async ({ page }) => {
    await page.goto('/?ai=mock')
    const output = await runCommand(page, JS_SLOT, 'notDefined()', { prompt: JS })
    expect(output[0]).toBe('ReferenceError: notDefined is not defined')
    expect(joinProse(output, ERROR_HINT).at(-1)).toBe(ERROR_HINT)
  })

  test('Ctrl+C stops a runaway loop and the next command answers at once', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, JS_SLOT, 'const keep = 42', { prompt: JS })).toEqual([])
    await typeText(page, 'while (true) {}')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    await page.keyboard.press('Control+c')
    await waitForOutput(page, JS_SLOT, `${JS}while (true) {}`, JS, 3000)
    const started = Date.now()
    expect(await runCommand(page, JS_SLOT, '1 + 1', { prompt: JS })).toEqual(['2'])
    expect(Date.now() - started).toBeLessThan(4000)
    expect(await runCommand(page, JS_SLOT, 'typeof keep', { prompt: JS })).toEqual(["'undefined'"])
  })

  test('a runaway loop without Ctrl+C ends at the timeout', async ({ page }) => {
    await page.goto('/')
    const output = await runCommand(page, JS_SLOT, 'while (true) {}', { prompt: JS, timeout: 20_000 })
    expect(output.join('\n')).toContain('timed out after 5 s')
    expect(await runCommand(page, JS_SLOT, '1 + 1', { prompt: JS })).toEqual(['2'])
  })
})

test.describe('rust terminal (wasi)', () => {
  test('runs the Rust binary with arguments', async ({ page }) => {
    await page.goto('/')
    const screen = await waitForPrompt(page, RUST, WASM)
    expect(screen.rows).toContain('greet - Rust compiled to wasm32-wasip1 (54 KB)')
    expect(await runCommand(page, RUST, 'greet world', { prompt: WASM })).toEqual([
      'Hello, world! This is Rust compiled to WebAssembly.',
    ])
  })

  test('surfaces the binary exit code and stderr', async ({ page }) => {
    await page.goto('/?ai=mock')
    expect(joinProse(await runCommand(page, RUST, 'greet', { prompt: WASM }), ERROR_HINT)).toEqual(['greet: missing a name', ERROR_HINT])
  })

  test('refuses other programs and shell syntax', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, RUST, 'ls', { prompt: WASM })).toEqual([
      'ls: command not found (this terminal runs greet)',
    ])
    expect(await runCommand(page, RUST, 'greet a | wc', { prompt: WASM })).toEqual([
      'pipes, redirects and variables are not supported in this terminal',
    ])
  })
})

test.describe('<docs-terminal> web component', () => {
  test('runs typed javascript and the run() method, and emits DOM events', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, ELEMENT, JS)
    expect(await runCommand(page, ELEMENT, '[1, 2, 3].map(n => n * n)', { prompt: JS })).toEqual(['[ 1, 4, 9 ]'])
    const result = await page.evaluate(async () => {
      const element = document.querySelector('docs-terminal') as HTMLElement & {
        run(text: string): Promise<{ exitCode: number; output: string }>
      }
      const events: unknown[] = []
      element.addEventListener('docsterm-event', (event) => events.push((event as CustomEvent).detail))
      const report = await element.run('6 * 7')
      return { report, events }
    })
    expect(result.report).toEqual({ exitCode: 0, output: '42' })
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'command', command: '6 * 7', source: 'api' }))
    const screen = await readScreen(page, ELEMENT)
    expect(screen.rows.slice(screen.cursor - 2, screen.cursor)).toEqual([`${JS}6 * 7`, '42'])
  })
})
