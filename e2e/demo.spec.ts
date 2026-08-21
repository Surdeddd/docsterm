import { expect, test, type Page } from '@playwright/test'

const typeInTerminal = async (page: Page, slot: string, text: string) => {
  await page.click(`${slot} .xterm`)
  await page.keyboard.type(text, { delay: 15 })
  await page.keyboard.press('Enter')
}

test.describe('mock terminal', () => {
  test('runs scripted commands and hints about explain on failure', async ({ page }) => {
    await page.goto('/?ai=mock')
    const slot = '#terminal-mock'
    await expect(page.locator(slot)).toContainText('docsterm ready')
    await expect(page.locator(slot)).toContainText('orbit 1.4.2')
    await typeInTerminal(page, slot, 'orbit init')
    await expect(page.locator(slot)).toContainText('Project initialized.')
    await typeInTerminal(page, slot, 'orbit destroy')
    await expect(page.locator(slot)).toContainText("Type 'explain'")
  })

  test('unknown commands fall back to exit 127', async ({ page }) => {
    await page.goto('/?ai=mock')
    const slot = '#terminal-mock'
    await expect(page.locator(slot)).toContainText('docsterm ready')
    await typeInTerminal(page, slot, 'orbit teleport')
    await expect(page.locator(slot)).toContainText('command not found: orbit teleport')
  })

  test('ai flow: suggest, confirm with y, run, then explain an error', async ({ page }) => {
    await page.goto('/?ai=mock')
    const slot = '#terminal-mock'
    await expect(page.locator(slot)).toContainText('docsterm ready')
    await typeInTerminal(page, slot, '#deploy the app')
    await expect(page.locator(slot)).toContainText('suggested command: orbit deploy')
    await typeInTerminal(page, slot, 'y')
    await expect(page.locator(slot)).toContainText('Deployed to https://demo.orbit.app')
    await typeInTerminal(page, slot, 'orbit destroy')
    await expect(page.locator(slot)).toContainText("Type 'explain'")
    await typeInTerminal(page, slot, 'explain')
    await expect(page.locator(slot)).toContainText('non-zero code')
  })

  test('cancelling a suggestion does not run it', async ({ page }) => {
    await page.goto('/?ai=mock')
    const slot = '#terminal-mock'
    await expect(page.locator(slot)).toContainText('docsterm ready')
    await typeInTerminal(page, slot, '#check the status')
    await expect(page.locator(slot)).toContainText('suggested command: orbit status')
    await typeInTerminal(page, slot, 'n')
    await expect(page.locator(slot)).toContainText('cancelled.')
    await expect(page.locator(slot)).not.toContainText('region: eu-central')
  })

  test('russian locale switches widget messages', async ({ page }) => {
    await page.goto('/?ai=mock&locale=ru')
    await expect(page.locator('#terminal-mock')).toContainText('docsterm готов')
  })
})

test.describe('python terminal', () => {
  test('boots pyodide and executes python for real', async ({ page }) => {
    await page.goto('/')
    await page.click('#python-boot')
    const slot = '#terminal-python'
    await expect(page.locator(slot)).toContainText('Python 3', { timeout: 150_000 })
    await typeInTerminal(page, slot, 'print("sum:", 6 * 7)')
    await expect(page.locator(slot)).toContainText('sum: 42')
    await typeInTerminal(page, slot, '1 / 0')
    await expect(page.locator(slot)).toContainText('ZeroDivisionError')
  })
})

test.describe('visual check', () => {
  test('captures light and dark screenshots', async ({ page }) => {
    await page.goto('/?ai=mock&theme=light')
    await expect(page.locator('#terminal-mock')).toContainText('docsterm ready')
    await page.screenshot({ path: 'e2e/screenshots/demo-light.png', fullPage: true })
    await page.goto('/?ai=mock&theme=dark')
    await expect(page.locator('#terminal-mock')).toContainText('docsterm ready')
    await page.screenshot({ path: 'e2e/screenshots/demo-dark.png', fullPage: true })
  })
})
