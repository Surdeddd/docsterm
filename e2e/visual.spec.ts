import { expect, test, type Page } from '@playwright/test'
import { SHELL, hasHorizontalScroll, runCommand, waitForPrompt } from './helpers'

const VARIANTS = [
  { name: 'light', query: '?ai=mock&theme=light' },
  { name: 'dark', query: '?ai=mock&theme=dark' },
  { name: 'ru', query: '?ai=mock&theme=light&locale=ru' },
]

const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready)
  await page.locator('#run .docsterm-run').nth(2).click()
  await waitForPrompt(page, '#terminal-js', '> ')
  await waitForPrompt(page, '#terminal-rust', 'wasm $ ')
  await waitForPrompt(page, '#terminal-element', '> ')
  await runCommand(page, '#terminal-mock', 'ls')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)
}

test.describe('visual capture', () => {
  for (const variant of VARIANTS) {
    test(`page in ${variant.name}`, async ({ page }, info) => {
      await page.goto(`/${variant.query}`)
      await waitForPrompt(page, '#terminal-mock', SHELL)
      await settle(page)
      expect(await hasHorizontalScroll(page)).toBe(false)
      await page.screenshot({ path: `e2e/screenshots/${info.project.name}-${variant.name}.png`, fullPage: true, scale: 'css' })
    })
  }

  test('react page', async ({ page }, info) => {
    await page.goto('/react.html?theme=dark')
    await waitForPrompt(page, '#react-terminal', SHELL)
    await page.evaluate(() => document.fonts.ready)
    expect(await hasHorizontalScroll(page)).toBe(false)
    await page.screenshot({ path: `e2e/screenshots/${info.project.name}-react.png`, fullPage: true, scale: 'css' })
  })
})
