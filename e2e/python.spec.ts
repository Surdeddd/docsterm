import { expect, test, type Page } from '@playwright/test'
import {
  PYODIDE_CDN,
  PYTHON,
  collectConsole,
  isOnline,
  readScreen,
  runCommand,
  servePyodide,
  typeText,
  waitForOutput,
  waitForPrompt,
} from './helpers'

const SLOT = '#terminal-python'
const BOOT_TIMEOUT = 120_000

const boot = async (page: Page) => {
  const button = page.locator('#python-boot')
  await button.scrollIntoViewIfNeeded()
  await button.click()
  await expect(page.locator(`${SLOT} textarea.xterm-helper-textarea`)).toBeFocused({ timeout: BOOT_TIMEOUT })
  await expect(button).toHaveCount(0)
  return waitForPrompt(page, SLOT, PYTHON, BOOT_TIMEOUT)
}

const python = (page: Page, line: string, timeout?: number) =>
  runCommand(page, SLOT, line, { prompt: PYTHON, timeout })

const interrupt = async (page: Page, line: string, waitMs: number, block = false) => {
  await typeText(page, line)
  await page.keyboard.press('Enter')
  if (block) await page.keyboard.press('Enter')
  await page.waitForTimeout(waitMs)
  await page.keyboard.press('Control+c')
  return waitForOutput(page, SLOT, `${PYTHON}${line}`, PYTHON, 10_000)
}

test.describe('python terminal', () => {
  test('boots, focuses itself and runs python with REPL display', async ({ page, context }) => {
    await servePyodide(context)
    await page.goto('/')
    const screen = await boot(page)
    expect(screen.rows.some((row) => /^Python 3\.\d+\.\d+ \(pyodide 314\.0\.7\)$/.test(row))).toBe(true)
    expect(await python(page, 'print("sum:", 6 * 7)')).toEqual(['sum: 42'])
    expect(await python(page, 'True')).toEqual(['True'])
    expect(await python(page, "'abc'")).toEqual(["'abc'"])
    expect((await python(page, '1 / 0')).at(-1)).toBe('ZeroDivisionError: division by zero')
  })

  test('a def block continues on ... lines and ends with an empty line', async ({ page, context }) => {
    await servePyodide(context)
    await page.goto('/')
    await boot(page)
    expect(await runCommand(page, SLOT, 'def f():', { prompt: PYTHON, next: '... ' })).toEqual([])
    expect(await runCommand(page, SLOT, '    return 41 + 1', { prompt: '... ', next: '... ' })).toEqual([])
    await page.keyboard.press('Enter')
    await waitForPrompt(page, SLOT, PYTHON)
    expect(await python(page, 'f()')).toEqual(['42'])
  })

  test('pip install fetches a wheel through micropip', async ({ page, context }) => {
    test.skip(!(await isOnline()), 'needs network access to the Pyodide CDN and PyPI')
    await servePyodide(context, { network: true })
    await page.goto('/')
    await boot(page)
    const output = await python(page, 'pip install snowballstemmer', 90_000)
    expect(output.join('\n')).toMatch(/snowballstemmer/)
    expect(await python(page, "import snowballstemmer; snowballstemmer.stemmer('english').stemWord('running')")).toEqual([
      "'run'",
    ])
  })

  test('without isolation Ctrl+C on a busy loop restarts the runtime and says so', async ({ page, context }) => {
    await servePyodide(context)
    await page.goto('/')
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false)
    await boot(page)
    expect(await python(page, 'x = 1')).toEqual([])
    expect(await interrupt(page, 'while True: pass', 800, true)).toEqual(['...', '^C'])
    await expect
      .poll(async () => (await readScreen(page, SLOT)).rows, { timeout: 30_000 })
      .toContain('runtime restarted, variables were reset')
    await waitForPrompt(page, SLOT, PYTHON, BOOT_TIMEOUT)
    expect((await python(page, 'x', 60_000)).at(-1)).toBe("NameError: name 'x' is not defined")
  })

  test('a failed download shows a localized error and a retry boots', async ({ page, context }) => {
    await context.route(PYODIDE_CDN, (route) => route.abort())
    await page.goto('/?locale=ru')
    const button = page.locator('#python-boot')
    await button.scrollIntoViewIfNeeded()
    await button.click()
    const error = page.locator(`${SLOT} .mount-error`)
    await expect(error).toBeVisible({ timeout: 30_000 })
    await expect(error).toContainText('Терминал не запустился')
    await expect(error).toContainText('Перезагрузи страницу')
    await expect(button).toHaveText('попробовать ещё раз')
    await expect(button).toBeEnabled()
    await context.unroute(PYODIDE_CDN)
    await servePyodide(context)
    await button.click()
    await waitForPrompt(page, SLOT, PYTHON, BOOT_TIMEOUT)
    expect(await python(page, '6 * 7')).toEqual(['42'])
  })
})

test.describe('python under cross-origin isolation', () => {
  test('Ctrl+C interrupts a busy loop and time.sleep in place and keeps variables', async ({ page, context }) => {
    const messages = collectConsole(page)
    await servePyodide(context)
    await page.goto('/?isolated=1')
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
    await boot(page)
    expect(await python(page, 'x = 41; n = 0')).toEqual([])

    expect(await interrupt(page, 'while True: n += 1', 800, true)).toEqual(['...', '^C'])
    expect(await python(page, 'n > 0, x + 1')).toEqual(['(True, 42)'])

    expect(await python(page, 'import time; started = time.monotonic()')).toEqual([])
    expect(await interrupt(page, 'time.sleep(30)', 800)).toEqual(['^C'])
    expect(await python(page, 'time.monotonic() - started < 10, x')).toEqual(['(True, 41)'])

    const screen = await readScreen(page, SLOT)
    expect(screen.rows.join('\n')).not.toContain('runtime restarted')
    expect(messages.filter((message) => /fatal error/i.test(message))).toEqual([])
  })
})
