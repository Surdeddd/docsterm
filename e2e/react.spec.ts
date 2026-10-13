import { expect, test } from '@playwright/test'
import { SHELL, collectConsole, readScreen, runCommand, waitForOutput, waitForPrompt } from './helpers'

const SLOT = '#react-terminal'
const BANNER = 'orbit 1.4.2 - fictional deploys for tiny apps. Try: ls, cat README.md, orbit help'

test.describe('react page under StrictMode', () => {
  test('keeps one working terminal and its state across re-renders and theme changes', async ({ page }) => {
    const messages = collectConsole(page)
    await page.goto('/react.html')
    const screen = await waitForPrompt(page, SLOT, SHELL)
    await expect(page.locator(`${SLOT} .xterm`)).toHaveCount(1)
    expect(screen.rows.filter((row) => row === BANNER)).toHaveLength(1)

    expect(await runCommand(page, SLOT, 'export FOO=bar')).toEqual([])
    for (let i = 0; i < 3; i += 1) await page.locator('#react-rerender').click()
    await expect(page.locator('#react-renders')).toHaveAttribute('data-count', '3')
    expect(await runCommand(page, SLOT, 'echo $FOO')).toEqual(['bar'])
    await expect(page.locator(`${SLOT} .xterm`)).toHaveCount(1)

    const color = () => page.locator(`${SLOT} .xterm-rows`).evaluate((element) => getComputedStyle(element).color)
    expect(await color()).toBe('rgb(15, 17, 20)')
    await page.locator('#react-theme').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(color).toBe('rgb(233, 234, 236)')
    expect(await runCommand(page, SLOT, 'echo "$FOO again"')).toEqual(['bar again'])
    await expect(page.locator(`${SLOT} .xterm`)).toHaveCount(1)
    expect((await readScreen(page, SLOT)).rows.filter((row) => row === BANNER)).toHaveLength(1)
    expect(messages.filter((message) => message.startsWith('pageerror') || message.startsWith('error'))).toEqual([])
  })

  test('the ref handle runs a command and onEvent reports it', async ({ page }) => {
    await page.goto('/react.html')
    await waitForPrompt(page, SLOT, SHELL)
    const events = page.locator('#react-events')
    await expect(events).toHaveAttribute('data-count', '1')
    await page.locator('#react-run').click()
    expect(await waitForOutput(page, SLOT, `${SHELL}orbit status`, SHELL)).toEqual([
      'status: RUNNING',
      'region: eu-central',
      'version: 14',
    ])
    await expect(events).toHaveAttribute('data-count', '2')
    await expect(page.locator('#react-last-event')).toHaveText(/^last event: orbit status · api · exit 0 · \d+ ms$/)
  })

  test('speaks russian with the page', async ({ page }) => {
    await page.goto('/react.html?locale=ru')
    await expect(page).toHaveTitle('docsterm - проверка React StrictMode')
    await expect(page.locator('#react-rerender')).toHaveText('перерисовать страницу')
    const screen = await waitForPrompt(page, SLOT, SHELL)
    expect(screen.rows.join(' ')).toContain('docsterm готов')
  })
})
