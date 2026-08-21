import '@xterm/xterm/css/xterm.css'
import './style.css'
import {
  DocsTerminal,
  createMockAIProvider,
  type AIProvider,
  type Backend,
  type Locale,
  type TerminalTheme,
} from 'docsterm'
import { createShellBackend, type ShellCommand } from 'docsterm/shell'
import { createJavaScriptBackend } from 'docsterm/javascript'
import { createPyodideBackend } from 'docsterm/pyodide'
import { createWasiBackend } from 'docsterm/wasi'
import { buildConfiguredProvider, setupAiSettings } from './ai-settings'
import { getPageStrings, type PageStrings } from './i18n'

const params = new URLSearchParams(location.search)

const rawLocale = params.get('locale')
const locale: Locale = rawLocale === 'ru' ? 'ru' : 'en'
const strings = getPageStrings(locale)

const rawTheme = params.get('theme')
const prefersDark =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
const theme: 'light' | 'dark' = rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : prefersDark ? 'dark' : 'light'

document.documentElement.dataset.theme = theme
document.documentElement.lang = locale

const TERMINAL_FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"

const lightTerminal: TerminalTheme = {
  background: '#f1f2f3',
  foreground: '#0f1114',
  cursor: '#d3300d',
  selectionBackground: 'rgba(211, 48, 13, 0.22)',
  black: '#0f1114',
  red: '#d3300d',
  green: '#256d4a',
  yellow: '#8a6100',
  blue: '#1f4fa8',
  magenta: '#8d3a86',
  cyan: '#1c6b74',
  white: '#5c626b',
  brightBlack: '#8b9099',
  brightRed: '#e8452a',
  brightGreen: '#2f8759',
  brightYellow: '#a97a12',
  brightBlue: '#2a63c4',
  brightMagenta: '#a3499b',
  brightCyan: '#248591',
  brightWhite: '#0f1114',
}

const darkTerminal: TerminalTheme = {
  background: '#14171c',
  foreground: '#e9eaec',
  cursor: '#ff4f2b',
  selectionBackground: 'rgba(255, 79, 43, 0.26)',
  black: '#31363d',
  red: '#ff4f2b',
  green: '#5fd08a',
  yellow: '#e7b75a',
  blue: '#78a8ff',
  magenta: '#cf9bf0',
  cyan: '#63cbd6',
  white: '#b9bfc7',
  brightBlack: '#666d77',
  brightRed: '#ff7658',
  brightGreen: '#84e0a7',
  brightYellow: '#f3cd83',
  brightBlue: '#9cc0ff',
  brightMagenta: '#dfb4fa',
  brightCyan: '#8adfe8',
  brightWhite: '#ffffff',
}

const terminalTheme = theme === 'dark' ? darkTerminal : lightTerminal

const applyStrings = (text: PageStrings) => {
  document.title = text.documentTitle
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute('content', text.documentDescription)

  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n as keyof PageStrings
    const value = text[key]
    if (typeof value === 'string') node.textContent = value
  }

  const tryItems = document.querySelector('#try-items')
  if (tryItems) {
    tryItems.replaceChildren(
      ...text.heroTryItems.map((item) => {
        const code = document.createElement('code')
        code.textContent = item
        return code
      }),
    )
  }

  const whyGrid = document.querySelector('#why-grid')
  if (whyGrid) {
    whyGrid.replaceChildren(
      ...text.whyItems.map((item, index) => {
        const article = document.createElement('article')
        article.className = 'why-item'
        const idx = document.createElement('span')
        idx.className = 'index'
        idx.textContent = String(index + 1).padStart(2, '0')
        const title = document.createElement('h3')
        title.textContent = item.title
        const body = document.createElement('p')
        body.textContent = item.body
        article.append(idx, title, body)
        return article
      }),
    )
  }

  const packageList = document.querySelector('#package-list')
  if (packageList) {
    packageList.replaceChildren(
      ...text.packages.map((pkg) => {
        const li = document.createElement('li')
        const link = document.createElement('a')
        link.href = 'https://www.npmjs.com/package/docsterm'
        const name = document.createElement('span')
        name.className = 'pkg-name'
        name.textContent = pkg.name
        const body = document.createElement('span')
        body.className = 'pkg-body'
        body.textContent = pkg.body
        link.append(name, body)
        li.append(link)
        return li
      }),
    )
  }
}

applyStrings(strings)

const setParam = (name: string, value: string) => {
  const next = new URLSearchParams(location.search)
  if (value === '') next.delete(name)
  else next.set(name, value)
  location.search = next.toString()
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
  const value = button.dataset.lang ?? 'en'
  button.setAttribute('aria-pressed', String(value === locale))
  button.addEventListener('click', () => setParam('locale', value))
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-set]')) {
  const value = button.dataset.themeSet ?? 'light'
  button.setAttribute('aria-pressed', String(value === theme))
  button.addEventListener('click', () => setParam('theme', value))
}

const copyButton = document.querySelector<HTMLButtonElement>('#copy-install')
const installCode = document.querySelector<HTMLElement>('#install-code')
if (copyButton && installCode) {
  copyButton.addEventListener('click', () => {
    void navigator.clipboard.writeText(installCode.textContent ?? '').then(() => {
      copyButton.textContent = strings.heroCopied
      copyButton.dataset.copied = 'true'
      setTimeout(() => {
        copyButton.textContent = strings.heroCopy
        delete copyButton.dataset.copied
      }, 1600)
    })
  })
}

const settings = document.querySelector<HTMLElement>('#ai-settings')
if (settings) setupAiSettings(settings, strings)

const makeAi = (): AIProvider | undefined => {
  if (params.get('ai') === 'mock') {
    return createMockAIProvider({
      suggestions:
        locale === 'ru'
          ? {
              задепл: { command: 'orbit deploy', explanation: 'Деплоит текущее приложение в облако orbit.' },
              статус: { command: 'orbit status', explanation: 'Показывает состояние деплоя.' },
              инициал: { command: 'orbit init', explanation: 'Создаёт orbit-проект в этой папке.' },
              deploy: { command: 'orbit deploy', explanation: 'Деплоит текущее приложение в облако orbit.' },
            }
          : {
              deploy: { command: 'orbit deploy', explanation: 'Deploys the current app to the orbit cloud.' },
              status: { command: 'orbit status', explanation: 'Shows the current deployment status.' },
              init: { command: 'orbit init', explanation: 'Initializes an orbit project here.' },
            },
      explanation:
        locale === 'ru'
          ? 'Команда завершилась с ненулевым кодом. Проверь аргументы и попробуй ещё раз.'
          : 'The command exited with a non-zero code. Check the arguments and try again.',
    })
  }
  return buildConfiguredProvider()
}

const mountTerminal = (slot: HTMLElement, backend: Backend) => {
  void new DocsTerminal({
    backend,
    ai: makeAi(),
    locale,
    theme: terminalTheme,
    fontFamily: TERMINAL_FONT,
    fontSize: 13,
  })
    .mount(slot)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      slot.insertAdjacentHTML('beforeend', `<pre class="mount-error">terminal failed to start: ${message}</pre>`)
      console.error('docsterm mount failed', error)
    })
}

const orbitCommand: ShellCommand = (ctx) => {
  const [, sub, ...rest] = ctx.argv
  switch (sub) {
    case 'init':
      ctx.fs.write(ctx.fs.resolve(ctx.cwd, 'orbit.toml'), 'name = "demo"\nregion = "eu-central"\n')
      return 'Created orbit.toml\nProject initialized.\n'
    case 'deploy':
      return 'Uploading bundle... done\nDeployed to https://demo.orbit.app\n'
    case 'status':
      return 'status: RUNNING\nregion: eu-central\nversion: 14\n'
    case 'destroy':
      return rest.includes('--force')
        ? 'Deployment destroyed.\n'
        : {
            stderr: 'error: refusing to destroy a RUNNING deployment (use --force)\n',
            exitCode: 1,
          }
    case 'help':
    case undefined:
      return 'commands: init, deploy, status, destroy [--force], help\n'
    default:
      return { stderr: `orbit: unknown command '${sub}'\n`, exitCode: 2 }
  }
}

const shellSlot = document.querySelector<HTMLElement>('#terminal-mock')
if (shellSlot) {
  const backend = createShellBackend({
    banner: 'orbit 1.4.2 - fictional deploys for tiny apps. Try: ls, cat README.md, orbit help',
    cwd: '/project',
    env: { PROJECT: 'orbit' },
    prompt: (cwd) => `${cwd} $ `,
    files: {
      project: {
        'README.md': '# demo app\n\nDeployed with the orbit CLI.\nRun `orbit help` to start.\n',
        'regions.csv': 'name,region\nalpha,eu-central\nbeta,us-east\ngamma,eu-west\n',
        src: {
          'index.ts': "export const handler = () => 'hello from orbit'\n",
          'config.ts': 'export const region = "eu-central"\n',
        },
      },
    },
    commands: { orbit: orbitCommand },
  })
  void new DocsTerminal({
    backend,
    ai: makeAi(),
    locale,
    theme: terminalTheme,
    fontFamily: TERMINAL_FONT,
    fontSize: 13,
  }).mount(shellSlot)
}

const jsSlot = document.querySelector<HTMLElement>('#terminal-js')
if (jsSlot) {
  void new DocsTerminal({
    backend: createJavaScriptBackend({
      banner: 'javascript - variables persist between commands, top-level await works',
      timeoutMs: 5000,
    }),
    ai: makeAi(),
    locale,
    theme: terminalTheme,
    fontFamily: TERMINAL_FONT,
    fontSize: 13,
  }).mount(jsSlot)
}

const rustSlot = document.querySelector<HTMLElement>('#terminal-rust')
if (rustSlot) {
  mountTerminal(
    rustSlot,
    createWasiBackend({
      url: '/greet.wasm',
      program: 'greet',
      prompt: 'wasm $ ',
      banner: 'greet - rust, compiled to wasm32-wasip1 (55 KB)',
    }),
  )
}

const bootButton = document.querySelector<HTMLButtonElement>('#python-boot')
const pySlot = document.querySelector<HTMLElement>('#terminal-python')
const pyFrame = document.querySelector<HTMLElement>('#python-frame')
if (bootButton && pySlot) {
  bootButton.addEventListener('click', () => {
    bootButton.disabled = true
    bootButton.textContent = strings.pythonBooting
    if (pyFrame) pyFrame.hidden = false
    const backend = createPyodideBackend()
    void new DocsTerminal({
      backend,
      ai: makeAi(),
      locale,
      theme: terminalTheme,
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
    })
      .mount(pySlot)
      .then(() => bootButton.remove())
      .catch((error: unknown) => {
        bootButton.disabled = false
        bootButton.textContent = strings.pythonBoot
        if (pyFrame) pyFrame.hidden = true
        pySlot.textContent = `failed to load pyodide: ${String(error)}`
      })
  })
}
