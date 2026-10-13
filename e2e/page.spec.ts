import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Request } from '@playwright/test'
import {
  CONFIRM,
  SHELL,
  collectConsole,
  hasHorizontalScroll,
  readScreen,
  runCommand,
  waitForOutput,
  waitForPrompt,
} from './helpers'

const HERO = '#terminal-mock'
const RUN = '#terminal-run'

const manifest = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../packages/docsterm/package.json'), 'utf8'),
) as { version: string; exports: Record<string, unknown> }

const ENTRIES = Object.keys(manifest.exports)
  .filter((key) => key !== './package.json')
  .map((key) => (key === '.' ? 'docsterm' : `docsterm/${key.slice(2)}`))

const rowColor = (page: Page, slot: string) =>
  page.locator(`${slot} .xterm-rows`).evaluate((element) => getComputedStyle(element).color)

const storedKeys = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('docsterm:')).sort())

test.describe('page copy and languages', () => {
  test('english copy, version and entry points come from the package', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('docsterm - an embeddable AI terminal for documentation')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('h1')).toHaveText(/Documentation\s+your readers\s+can run\./)
    await expect(page.locator('#hero-eyebrow')).toHaveText(`open source · MIT · v${manifest.version}`)
    expect(ENTRIES).toContain('docsterm/openai')
    expect(ENTRIES).toContain('docsterm/element')
    await expect(page.locator('#packages-title')).toHaveText(`One package, ${ENTRIES.length} entry points`)
    await expect(page.locator('#package-list li')).toHaveCount(ENTRIES.length)
    expect(await page.locator('#package-list li').evaluateAll((items) => items.map((item) => item.dataset.entry))).toEqual(
      ENTRIES,
    )
    await expect(page.locator('#package-list li .pkg-body')).toHaveCount(ENTRIES.length)
    await expect(page.locator('#embed-docs')).toHaveAttribute('href', /docs\/embedding\.md$/)
  })

  test('russian translates the page, the widget and the controls', async ({ page }) => {
    await page.goto('/?locale=ru')
    await expect(page).toHaveTitle('docsterm - встраиваемый AI-терминал для документации')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    await expect(page.locator('h1')).toHaveText(/Документация,\s+которую читатель\s+запускает\./)
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /живой терминал/)
    await expect(page.locator('#hero-eyebrow')).toHaveText(`открытый код · MIT · v${manifest.version}`)
    await expect(page.locator('#packages-title')).toHaveText(`Один пакет, ${ENTRIES.length} входов`)
    await expect(page.locator('#embed-docs')).toHaveAttribute('href', /docs\/embedding\.ru\.md$/)
    await expect(page.locator('#package-list a').first()).toHaveAttribute('href', /README\.ru\.md$/)
    await expect(page.locator('#ai-provider option[value="ollama"]')).toHaveText('Ollama (локально)')
    await expect(page.locator('#ai-status')).toHaveText('выключено: в этом браузере ещё ничего не настроено.')
    await expect(page.locator('#event-log')).toContainText('терминал готов')
    const run = page.locator('#run .docsterm-run').first()
    await expect(run).toHaveText('запустить')
    await expect(run).toHaveAttribute('aria-label', 'запустить в терминале: orbit init')
    const screen = await waitForPrompt(page, RUN, SHELL)
    expect(screen.rows.join(' ')).toContain('orbit 1.4.2 - вымышленные деплои')
  })

  test('the language switch keeps the other parameters and skips the active language', async ({ page }) => {
    await page.goto('/?ai=mock&theme=dark')
    expect(await runCommand(page, HERO, 'echo session-marker')).toEqual(['session-marker'])
    await page.locator('button[data-lang="en"]').click()
    await page.waitForTimeout(300)
    expect(new URL(page.url()).search).toBe('?ai=mock&theme=dark')
    expect((await readScreen(page, HERO)).rows).toContain('session-marker')
    await page.locator('button[data-lang="ru"]').click()
    await expect(page.locator('h1')).toContainText('Документация')
    const params = new URL(page.url()).searchParams
    expect([params.get('locale'), params.get('ai'), params.get('theme')]).toEqual(['ru', 'mock', 'dark'])
    await expect(page.locator('button[data-lang="ru"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#brand-link')).toHaveAttribute('href', `/?${params}`)
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  })

  test('the theme switch applies live to every terminal and is remembered', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, HERO, 'echo session-marker')).toEqual(['session-marker'])
    await waitForPrompt(page, '#terminal-element', '> ')
    expect(await rowColor(page, HERO)).toBe('rgb(15, 17, 20)')
    await page.locator('button[data-theme-set="dark"]').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('button[data-theme-set="dark"]')).toHaveAttribute('aria-pressed', 'true')
    expect(new URL(page.url()).searchParams.get('theme')).toBe('dark')
    for (const slot of [HERO, RUN, '#terminal-js', '#terminal-rust', '#terminal-element']) {
      await expect.poll(() => rowColor(page, slot)).toBe('rgb(233, 234, 236)')
    }
    expect((await readScreen(page, HERO)).rows).toContain('session-marker')
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})

test.describe('browser language', () => {
  test.use({ locale: 'ru-RU' })

  test('decides the page language when the address does not', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    await expect(page.locator('h1')).toContainText('Документация')
  })
})

test.describe('robustness', () => {
  test('the html carries copy, theme and language before any module runs', async ({ page }) => {
    await page.route('**/assets/main-*.js', (route) => route.abort())
    await page.goto('/?theme=dark&locale=ru')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    await expect(page.locator('h1')).toHaveText(/Documentation\s+your readers\s+can run\./)
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(12, 14, 17)')
  })

  test('there is no horizontal scroll from 320 to 414 px', async ({ page }) => {
    for (const locale of ['en', 'ru']) {
      await page.goto(`/?locale=${locale}`)
      for (const width of [320, 360, 375, 390, 414]) {
        await page.setViewportSize({ width, height: 844 })
        await page.waitForTimeout(150)
        expect(await hasHorizontalScroll(page), `${locale} at ${width}px`).toBe(false)
        const widest = await page.locator('.code-card, .terminal-frame, #ai-settings').evaluateAll((nodes) =>
          Math.max(...nodes.map((node) => node.getBoundingClientRect().right)),
        )
        expect(widest, `${locale} at ${width}px`).toBeLessThanOrEqual(width)
      }
    }
  })

  test('helper text reaches 4.5:1 contrast in both themes', async ({ page }) => {
    for (const theme of ['light', 'dark']) {
      await page.goto(`/?theme=${theme}`)
      const ratios = await page.evaluate(() => {
        const channel = (value: number) => {
          const c = value / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        }
        const luminance = (color: string) => {
          const [r = 0, g = 0, b = 0] = (color.match(/\d+(\.\d+)?/g) ?? []).map(Number)
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }
        const ratio = (a: string, b: string) => {
          const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
          return (high + 0.05) / (low + 0.05)
        }
        const probe = document.createElement('span')
        document.body.append(probe)
        const resolve = (variable: string) => {
          probe.style.color = `var(${variable})`
          return getComputedStyle(probe).color
        }
        const faint = resolve('--ink-faint')
        const soft = resolve('--ink-soft')
        const accent = resolve('--accent')
        const paper = resolve('--paper')
        const raised = resolve('--paper-raised')
        probe.remove()
        return [ratio(faint, paper), ratio(faint, raised), ratio(soft, raised), ratio(accent, paper)]
      })
      for (const value of ratios) expect(value, theme).toBeGreaterThanOrEqual(4.5)
    }
    await expect(page.locator('#ai-status')).toHaveAttribute('aria-live', 'polite')
  })

  test('the copy button copies, or selects the text when the clipboard is unavailable', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    await page.locator('#copy-install').click()
    await expect(page.locator('#copy-install')).toHaveText('copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm i docsterm @xterm/xterm')

    const errors = collectConsole(page)
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }))
    await page.goto('/')
    await page.locator('#copy-install').click()
    await expect(page.locator('#copy-note')).toHaveText('selected - press Ctrl+C or ⌘C to copy')
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('npm i docsterm @xterm/xterm')
    expect(errors.filter((message) => message.startsWith('pageerror'))).toEqual([])
  })

  test('a missing xterm chunk shows a localized error in every terminal', async ({ page }) => {
    const errors = collectConsole(page)
    await page.route('**/assets/xterm-*.js', (route) => route.abort())
    await page.goto('/?locale=ru')
    for (const slot of [HERO, RUN, '#terminal-js', '#terminal-rust', '#terminal-element']) {
      const box = page.locator(`${slot} .mount-error`)
      await expect(box).toBeVisible()
      await expect(box).toContainText('Терминал не запустился')
      await expect(box).toContainText('Перезагрузи страницу, чтобы попробовать ещё раз.')
      await expect(box.locator('button')).toHaveText('перезагрузить страницу')
      await expect(page.locator(`${slot} .xterm`)).toHaveCount(0)
    }
    expect(errors.filter((message) => message.startsWith('pageerror'))).toEqual([])
  })

  test('a missing greet.wasm fails the rust terminal at start, not on every run', async ({ page }) => {
    await page.route('**/greet.wasm', (route) => route.abort())
    await page.goto('/')
    const box = page.locator('#terminal-rust .mount-error')
    await box.scrollIntoViewIfNeeded()
    await expect(box).toBeVisible()
    await expect(box).toContainText('This terminal could not start')
    await expect(page.locator('#terminal-rust .xterm')).toHaveCount(0)
  })
})

test.describe('control api on the page', () => {
  test('hero chips run their command through run()', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    const chip = page.locator('#try-items button[data-command="ls"]')
    await expect(chip).toHaveAttribute('aria-label', 'run in the terminal above: ls')
    await chip.click()
    expect(await waitForOutput(page, HERO, `${SHELL}ls`, SHELL)).toEqual(['README.md  regions.csv  src'])
    await expect(page.locator(`${HERO} textarea`)).toBeFocused()
  })

  test('run buttons run their code block and the event log reports it', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, RUN, SHELL)
    const buttons = page.locator('#run .docsterm-run')
    await expect(buttons).toHaveCount(3)
    await expect(buttons.nth(2)).toHaveAttribute('aria-label', 'run in the terminal: orbit status')
    await buttons.nth(0).click()
    expect(await waitForOutput(page, RUN, `${SHELL}orbit init`, SHELL)).toEqual([
      'Created orbit.toml',
      'Project initialized.',
    ])
    await buttons.nth(2).click()
    expect(await waitForOutput(page, RUN, `${SHELL}orbit status`, SHELL)).toEqual([
      'status: RUNNING',
      'region: eu-central',
      'version: 14',
    ])
    const last = page.locator('#event-log li').last()
    await expect(last).toHaveAttribute('data-type', 'command')
    await expect(last).toHaveAttribute('data-source', 'api')
    await expect(last).toHaveAttribute('data-command', 'orbit status')
    await expect(last).toHaveAttribute('data-exit-code', '0')
    await expect(last).toContainText(/orbit status · api · exit 0 · \d+ ms/)
    await expect(page.locator('#event-log li').first()).toHaveAttribute('data-type', 'ready')
  })
})

test.describe('ai settings', () => {
  test('each provider shows its default model and endpoint', async ({ page }) => {
    await page.goto('/')
    const select = page.locator('#ai-provider')
    const values = await select.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))
    expect(values).toEqual([
      'anthropic',
      'openai',
      'openrouter',
      'groq',
      'gemini',
      'deepseek',
      'mistral',
      'xai',
      'ollama',
      'lmstudio',
      'custom',
    ])
    await expect(page.locator('#ai-model')).toHaveValue('claude-opus-5-5')
    await select.selectOption('groq')
    await expect(page.locator('#ai-model')).toHaveValue('openai/gpt-oss-20b')
    await expect(page.locator('#ai-endpoint')).toHaveText('https://api.groq.com/openai/v1')
    await select.selectOption('ollama')
    await expect(page.locator('#ai-key-input')).toBeHidden()
    await expect(page.locator('#ai-endpoint')).toHaveText('http://localhost:11434/v1')
    await select.selectOption('custom')
    await expect(page.locator('#ai-base-url')).toBeVisible()
    await expect(page.locator('#ai-key-input')).toBeVisible()
    await expect(page.locator('#ai-model')).toHaveValue('')
  })

  test('the status follows the saved configuration and models stay per provider', async ({ page }) => {
    await page.goto('/')
    const status = page.locator('#ai-status')
    await expect(status).toHaveAttribute('data-state', 'off')
    await page.locator('#ai-provider').selectOption('ollama')
    await expect(status).toHaveAttribute('data-state', 'off')
    await expect(status).toContainText('The form has changes that are not saved yet.')
    await page.locator('#ai-key-save').click()
    await expect(status).toHaveText('on: Ollama (local) · llama3.2 answers in every terminal on this page.')

    await page.locator('#ai-provider').selectOption('openai')
    await page.locator('#ai-model').fill('my-openai-model')
    await page.locator('#ai-key-save').click()
    await expect(status).toHaveText('off: add an API key for OpenAI to turn AI on.')
    await page.locator('#ai-key-input').fill('sk-test-1')
    await page.locator('#ai-key-save').click()
    await expect(status).toHaveText('on: OpenAI · my-openai-model answers in every terminal on this page.')
    await expect(page.locator('#ai-key-input')).toHaveValue('')
    await expect(page.locator('#ai-key-input')).toHaveAttribute('placeholder', 'a key is saved - leave empty to keep it')

    await page.locator('#ai-provider').selectOption('ollama')
    await expect(page.locator('#ai-model')).toHaveValue('llama3.2')
    await page.locator('#ai-provider').selectOption('openai')
    await expect(page.locator('#ai-model')).toHaveValue('my-openai-model')
    await page.reload()
    await expect(status).toHaveText('on: OpenAI · my-openai-model answers in every terminal on this page.')
  })

  test('clear removes every saved key, model and endpoint', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.setItem('docsterm:provider', 'custom')
      localStorage.setItem('docsterm:key:openai', 'sk-openai')
      localStorage.setItem('docsterm:key:custom', 'sk-custom')
      localStorage.setItem('docsterm:anthropic-key', 'sk-ant')
      localStorage.setItem('docsterm:model:custom', 'x')
      localStorage.setItem('docsterm:baseurl', 'https://gateway.test/v1')
      localStorage.setItem('docsterm-demo:theme', 'light')
    })
    await page.reload()
    await expect(page.locator('#ai-status')).toHaveAttribute('data-state', 'active')
    await page.locator('#ai-key-clear').click()
    expect(await storedKeys(page)).toEqual([])
    expect(await page.evaluate(() => localStorage.getItem('docsterm-demo:theme'))).toBe('light')
    await expect(page.locator('#ai-status')).toHaveText(
      'off: nothing is configured in this browser yet. Every saved key, model and endpoint was removed from this browser.',
    )
  })

  test('saving a provider applies to every terminal without a reload', async ({ page }) => {
    const requests: Request[] = []
    await page.route('https://fake-ai.test/v1/chat/completions', async (route) => {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      }
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors })
        return
      }
      requests.push(route.request())
      await route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ command: 'orbit status', explanation: 'Shows the deployment status.' }),
              },
            },
          ],
        }),
      })
    })
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await page.evaluate(() => Object.assign(window, { pageMarker: 'still here' }))

    await page.locator('#ai-provider').selectOption('custom')
    await page.locator('#ai-base-url').fill('https://fake-ai.test/v1')
    await page.locator('#ai-model').fill('test-model')
    await page.locator('#ai-key-input').fill('sk-test')
    await page.locator('#ai-key-save').click()
    await expect(page.locator('#ai-status')).toHaveText(
      'on: Custom endpoint · test-model answers in every terminal on this page.',
    )

    for (const slot of [HERO, RUN]) {
      const suggestion = await runCommand(page, slot, '#is it running?', { next: CONFIRM })
      expect(suggestion.join('\n')).toContain('suggested command: orbit status')
      expect(await runCommand(page, slot, 'y', { prompt: CONFIRM, next: SHELL })).toEqual([
        'status: RUNNING',
        'region: eu-central',
        'version: 14',
      ])
    }
    expect(requests).toHaveLength(2)
    const body = requests[0]?.postDataJSON() as { model: string }
    expect(body.model).toBe('test-model')
    expect(await requests[0]?.headerValue('authorization')).toBe('Bearer sk-test')
    expect(await page.evaluate(() => (window as unknown as { pageMarker?: string }).pageMarker)).toBe('still here')
  })
})
