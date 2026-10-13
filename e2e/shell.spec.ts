import { expect, test } from '@playwright/test'
import {
  CONFIRM,
  SHELL,
  joinProse,
  outputAfter,
  pasteInto,
  quietFor,
  readScreen,
  runCommand,
  typeText,
  waitForOutput,
  waitForPrompt,
} from './helpers'

const HERO = '#terminal-mock'
const RUN = '#terminal-run'
const BUILD_STEPS = [
  '[1/5] resolving manifest...',
  '[2/5] bundling 42 modules...',
  '[3/5] optimising assets...',
  '[4/5] writing sourcemaps...',
  '[5/5] uploading...',
]
const ERROR_HINT = "command failed. Type 'explain' to get an AI explanation."

test.describe('shell commands', () => {
  test('runs the orbit cli and reports exit codes', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, HERO, 'orbit init')).toEqual(['Created orbit.toml', 'Project initialized.'])
    expect(await runCommand(page, HERO, 'cat orbit.toml')).toEqual(['name = "demo"', 'region = "eu-central"'])
    expect(await runCommand(page, HERO, 'teleport now; echo $?')).toEqual(['teleport: command not found', '127'])
  })

  test('files, pipes, redirects and a prompt that follows cd', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, HERO, 'ls')).toEqual(['README.md  regions.csv  src'])
    expect(await runCommand(page, HERO, 'cat regions.csv | grep eu | wc -l')).toEqual(['2'])
    expect(await runCommand(page, HERO, 'echo hi > note.txt && cat note.txt')).toEqual(['hi'])
    expect(await runCommand(page, HERO, 'cd src', { next: '/project/src $ ' })).toEqual([])
    expect(await runCommand(page, HERO, 'ls', { prompt: '/project/src $ ' })).toEqual(['config.ts  index.ts'])
  })

  test('expands double-quoted variables and drops stderr sent to /dev/null', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, HERO, 'echo "Deploying $PROJECT"')).toEqual(['Deploying orbit'])
    expect(await runCommand(page, HERO, "echo '$PROJECT'")).toEqual(['$PROJECT'])
    expect(await runCommand(page, HERO, 'ls missing 2>/dev/null; echo $?')).toEqual(['1'])
  })

  test('history lists the commands of this session', async ({ page }) => {
    await page.goto('/')
    await runCommand(page, HERO, 'echo a')
    await runCommand(page, HERO, 'echo b')
    expect(await runCommand(page, HERO, 'history')).toEqual(['    1  echo a', '    2  echo b', '    3  history'])
  })
})

test.describe('long-running commands', () => {
  test('build streams every step and then prints its result', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, HERO, 'build', { fresh: true })).toEqual([...BUILD_STEPS, 'build complete in 3.5s'])
  })

  test('Ctrl+C cancels build, nothing arrives later, and the next command runs', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await page.keyboard.press('Control+l')
    await typeText(page, 'build')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readScreen(page, HERO)).rows).toContain(BUILD_STEPS[1])
    await page.keyboard.press('Control+c')
    const output = await waitForOutput(page, HERO, `${SHELL}build`, SHELL)
    expect(output.slice(0, 2)).toEqual(BUILD_STEPS.slice(0, 2))
    expect(output.at(-1)).toMatch(/\^C$/)
    expect(output.join('\n')).not.toContain('build complete')
    await quietFor(page, HERO, 1500)
    expect(await runCommand(page, HERO, 'echo still alive')).toEqual(['still alive'])
  })

  test('keys typed while a command runs are replayed after its prompt', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await page.keyboard.press('Control+l')
    await typeText(page, 'build')
    await page.keyboard.press('Enter')
    await typeText(page, 'echo after')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}echo after`, SHELL, 20_000)).toEqual(['after'])
    const screen = await readScreen(page, HERO)
    expect(outputAfter({ ...screen, cursor: screen.rows.indexOf(`${SHELL}echo after`) }, `${SHELL}build`)).toEqual([
      ...BUILD_STEPS,
      'build complete in 3.5s',
    ])
  })

  test('a multi-line paste runs line by line with its own prompts', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await pasteInto(page, HERO, 'echo one\necho two\n')
    expect(await waitForOutput(page, HERO, `${SHELL}echo two`, SHELL)).toEqual(['two'])
    const screen = await readScreen(page, HERO)
    expect(outputAfter(screen, `${SHELL}echo one`)).toEqual(['one', `${SHELL}echo two`, 'two'])
  })

  test('the pager takes the screen and gives it back on q', async ({ page }) => {
    await page.goto('/')
    expect(await runCommand(page, HERO, 'echo before', { fresh: true })).toEqual(['before'])
    await typeText(page, 'less README.md')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readScreen(page, HERO)).rows[0]).toBe('# demo app')
    await expect.poll(async () => (await readScreen(page, HERO)).rows.join('\n')).toMatch(/ README\.md 4\/4 \(100%\) - space/)
    await page.keyboard.press('q')
    expect(await waitForOutput(page, HERO, `${SHELL}less README.md`, SHELL)).toEqual([])
    const screen = await readScreen(page, HERO)
    expect(screen.rows.slice(0, 2)).toEqual([`${SHELL}echo before`, 'before'])
  })
})

test.describe('line editor', () => {
  test('arrows and Ctrl+W edit inside the line', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await typeText(page, 'echo wrld')
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('o')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}echo world`, SHELL)).toEqual(['world'])
    await typeText(page, 'echo keep this away')
    await page.keyboard.press('Control+w')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}echo keep this `, SHELL)).toEqual(['keep this'])
  })

  test('Ctrl and Alt arrows jump by words', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await typeText(page, 'echo two')
    await page.keyboard.press('Control+ArrowLeft')
    await typeText(page, 'one ')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}echo one two`, SHELL)).toEqual(['one two'])

    await typeText(page, 'echo b c')
    await page.keyboard.press('Alt+ArrowLeft')
    await page.keyboard.press('Alt+ArrowLeft')
    await typeText(page, 'a ')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}echo a b c`, SHELL)).toEqual(['a b c'])

    await typeText(page, 'echo x z')
    await page.keyboard.press('Home')
    await page.keyboard.press('Control+ArrowRight')
    await page.keyboard.press('Alt+ArrowRight')
    await typeText(page, ' y')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}echo x y z`, SHELL)).toEqual(['x y z'])
  })

  test('Tab completes commands and file names', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await typeText(page, 'cat REA')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}cat README.md`, SHELL)).toEqual([
      '# demo app',
      '',
      'Deployed with the orbit CLI.',
      'Run `orbit help` to start.',
    ])
    await typeText(page, 'orb')
    await page.keyboard.press('Tab')
    await typeText(page, 'status')
    await page.keyboard.press('Enter')
    expect(await waitForOutput(page, HERO, `${SHELL}orbit status`, SHELL)).toEqual([
      'status: RUNNING',
      'region: eu-central',
      'version: 14',
    ])
  })

  test('a line wider than the terminal is drawn once and runs intact', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await page.keyboard.press('Control+l')
    const payload = 'ab'.repeat(90)
    await page.keyboard.type(`cho ${payload}`, { delay: 2 })
    await page.keyboard.press('Home')
    await page.keyboard.type('e')
    await expect
      .poll(async () => (await readScreen(page, HERO)).rows.join('').replace(/\s+/g, ''))
      .toBe(`${SHELL}echo ${payload}`.replace(/\s+/g, ''))
    await page.keyboard.press('Enter')
    const output = await waitForOutput(page, HERO, `${SHELL}echo ${payload}`, SHELL)
    expect(output.join('')).toBe(payload)
  })

  test('Shift+Tab moves focus out of the terminal', async ({ page }) => {
    await page.goto('/')
    await waitForPrompt(page, HERO, SHELL)
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator(`${HERO} textarea`)).not.toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.closest('#terminal-mock') === null)).toBe(true)
  })
})

test.describe('ai assistant (mock)', () => {
  test('suggests, confirms with y, runs, then explains an error', async ({ page }) => {
    await page.goto('/?ai=mock')
    const suggestion = await runCommand(page, HERO, '#deploy the app', { next: CONFIRM })
    expect(suggestion.join('\n')).toContain('suggested command: orbit deploy')
    expect(await runCommand(page, HERO, 'y', { prompt: CONFIRM, next: SHELL })).toEqual([
      'Uploading bundle... done',
      'Deployed to https://demo.orbit.app',
    ])
    expect(joinProse(await runCommand(page, HERO, 'orbit destroy'), ERROR_HINT)).toEqual([
      'error: refusing to destroy a RUNNING deployment (use --force)',
      ERROR_HINT,
    ])
    const explanation = await runCommand(page, HERO, 'explain')
    expect(explanation.join(' ')).toContain('The command exited with a non-zero code.')
  })

  test('n declines the suggestion and nothing runs', async ({ page }) => {
    await page.goto('/?ai=mock')
    await runCommand(page, HERO, '#check the status', { next: CONFIRM })
    expect(await runCommand(page, HERO, 'n', { prompt: CONFIRM, next: SHELL })).toEqual(['cancelled.'])
  })

  test('Ctrl+C at the y/N question cancels and the next command runs normally', async ({ page }) => {
    await page.goto('/?ai=mock')
    await runCommand(page, HERO, '#check the status', { next: CONFIRM })
    await page.keyboard.press('Control+c')
    const screen = await waitForPrompt(page, HERO, SHELL)
    expect(screen.rows[screen.cursor - 1]).toBe('cancelled.')
    expect(await runCommand(page, HERO, 'echo next')).toEqual(['next'])
  })

  test('typed # asks the AI, pasted # goes to the shell as a comment', async ({ page }) => {
    await page.goto('/?ai=mock')
    await waitForPrompt(page, RUN, SHELL)
    await pasteInto(page, RUN, '# deploy the app\n')
    expect(await waitForOutput(page, RUN, `${SHELL}# deploy the app`, SHELL)).toEqual([])
    const log = page.locator('#event-log')
    await expect(log.locator('li[data-type="command"]').last()).toHaveAttribute('data-source', 'paste')
    await expect(log.locator('li[data-type="ai-suggest"]')).toHaveCount(0)

    const suggestion = await runCommand(page, RUN, '#deploy the app', { next: CONFIRM })
    expect(suggestion.join('\n')).toContain('suggested command: orbit deploy')
    expect(await runCommand(page, RUN, 'n', { prompt: CONFIRM, next: SHELL })).toEqual(['cancelled.'])
    await expect(log.locator('li[data-type="ai-suggest"]')).toHaveCount(1)
    await expect(log.locator('li[data-type="ai-suggest"]')).toContainText(
      'AI suggested orbit deploy for "deploy the app" · declined',
    )
  })

  test('russian locale switches widget messages', async ({ page }) => {
    await page.goto('/?ai=mock&locale=ru')
    const screen = await waitForPrompt(page, HERO, SHELL)
    expect(screen.rows.join(' ')).toContain('docsterm готов. Введи команду')
    expect(screen.rows.join(' ')).toContain('orbit 1.4.2 - вымышленные деплои')
  })
})
