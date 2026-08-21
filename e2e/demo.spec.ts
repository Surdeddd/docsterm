import { expect, test, type Page } from '@playwright/test'

const clickCentered = async (page: Page, selector: string) => {
  const target = page.locator(selector)
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await target.click()
}

const typeInTerminal = async (page: Page, slot: string, text: string) => {
  await clickCentered(page, `${slot} .xterm`)
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

test.describe('bilingual page', () => {
  test('english is the default and drives title, headings and lang', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/embeddable AI terminal for documentation/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('h1')).toContainText('Documentation')
    await expect(page.locator('#why')).toContainText('Why a terminal in the docs')
    await expect(page.locator('#packages')).toContainText('One package, five doors')
    await expect(page.locator('#packages')).toContainText('docsterm/pyodide')
    await expect(page.locator('#install-code')).toHaveText('npm i docsterm @xterm/xterm')
  })

  test('russian switches the whole page, not just the widget', async ({ page }) => {
    await page.goto('/?locale=ru')
    await expect(page).toHaveTitle(/встраиваемый AI-терминал/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    await expect(page.locator('h1')).toContainText('Документация')
    await expect(page.locator('#why')).toContainText('Зачем терминал в доках')
    await expect(page.locator('#packages')).toContainText('Один пакет, пять входов')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /живой терминал/,
    )
  })

  test('the language switch navigates between locales', async ({ page }) => {
    await page.goto('/')
    await page.click('button[data-lang="ru"]')
    await expect(page.locator('h1')).toContainText('Документация')
    await expect(page.locator('button[data-lang="ru"]')).toHaveAttribute('aria-pressed', 'true')
    await page.click('button[data-lang="en"]')
    await expect(page.locator('h1')).toContainText('Documentation')
  })
})

test.describe('python terminal', () => {
  test('boots pyodide and executes python for real', async ({ page }) => {
    await page.goto('/')
    await clickCentered(page, '#python-boot')
    const slot = '#terminal-python'
    await expect(page.locator(slot)).toContainText('Python 3', { timeout: 150_000 })
    await typeInTerminal(page, slot, 'print("sum:", 6 * 7)')
    await expect(page.locator(slot)).toContainText('sum: 42')
    await typeInTerminal(page, slot, '1 / 0')
    await expect(page.locator(slot)).toContainText('ZeroDivisionError')
  })
})

test.describe('visual check', () => {
  test('captures light, dark and russian screenshots', async ({ page }) => {
    await page.goto('/?ai=mock&theme=light')
    await expect(page.locator('#terminal-mock')).toContainText('docsterm ready')
    await page.waitForTimeout(900)
    await page.screenshot({ path: 'e2e/screenshots/demo-light.png', fullPage: true })
    await page.goto('/?ai=mock&theme=dark')
    await expect(page.locator('#terminal-mock')).toContainText('docsterm ready')
    await page.waitForTimeout(900)
    await page.screenshot({ path: 'e2e/screenshots/demo-dark.png', fullPage: true })
    await page.goto('/?ai=mock&theme=dark&locale=ru')
    await expect(page.locator('#terminal-mock')).toContainText('docsterm готов')
    await page.waitForTimeout(900)
    await page.screenshot({ path: 'e2e/screenshots/demo-ru.png', fullPage: true })
  })
})
