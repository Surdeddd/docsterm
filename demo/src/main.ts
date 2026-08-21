import '@xterm/xterm/css/xterm.css'
import './style.css'
import {
  DocsTerminal,
  createMockAIProvider,
  keyStore,
  type AIProvider,
  type Locale,
} from 'docsterm'
import { createMockBackend } from 'docsterm-backend-mock'
import { createPyodideBackend } from 'docsterm-backend-pyodide'
import { ANTHROPIC_KEY_NAME, createAnthropicProvider } from 'docsterm-ai-anthropic'
import { setupAiSettings } from './ai-settings'

const params = new URLSearchParams(location.search)

const rawLocale = params.get('locale')
const locale: Locale | undefined = rawLocale === 'ru' ? 'ru' : rawLocale === 'en' ? 'en' : undefined

const rawTheme = params.get('theme')
const theme: 'light' | 'dark' | 'auto' =
  rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : 'auto'

const prefersDark =
  theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
document.body.dataset.theme = prefersDark ? 'dark' : 'light'

const setParam = (name: string, value: string) => {
  const next = new URLSearchParams(location.search)
  if (value === '') next.delete(name)
  else next.set(name, value)
  location.search = next.toString()
}

const localeSelect = document.querySelector<HTMLSelectElement>('#locale-select')
if (localeSelect) {
  localeSelect.value = locale ?? 'en'
  localeSelect.addEventListener('change', () => setParam('locale', localeSelect.value))
}

const themeSelect = document.querySelector<HTMLSelectElement>('#theme-select')
if (themeSelect) {
  themeSelect.value = theme
  themeSelect.addEventListener('change', () =>
    setParam('theme', themeSelect.value === 'auto' ? '' : themeSelect.value),
  )
}

const settings = document.querySelector<HTMLElement>('#ai-settings')
if (settings) setupAiSettings(settings)

const makeAi = (): AIProvider | undefined => {
  if (params.get('ai') === 'mock') {
    return createMockAIProvider({
      suggestions: {
        deploy: { command: 'orbit deploy', explanation: 'Deploys the current app to the orbit cloud.' },
        status: { command: 'orbit status', explanation: 'Shows the current deployment status.' },
        init: { command: 'orbit init', explanation: 'Initializes an orbit project here.' },
      },
    })
  }
  if (keyStore.get(ANTHROPIC_KEY_NAME) !== null) return createAnthropicProvider()
  return undefined
}

const mockSlot = document.querySelector<HTMLElement>('#terminal-mock')
if (mockSlot) {
  const backend = createMockBackend({
    prompt: 'orbit$ ',
    banner: 'orbit 1.4.2 - fictional deploys for tiny apps',
    script: {
      'orbit init': { output: 'Created orbit.toml\nProject initialized.' },
      'orbit deploy': {
        output: 'Uploading bundle... done\nDeployed to https://demo.orbit.app',
        delayMs: 250,
      },
      'orbit status': { output: 'status: RUNNING\nregion: eu-central\nversion: 14' },
      'orbit destroy': {
        output: 'error: refusing to destroy a RUNNING deployment (use --force)',
        exitCode: 1,
      },
      'orbit destroy --force': { output: 'Deployment destroyed.' },
      'orbit help': { output: 'commands: init, deploy, status, destroy [--force], help' },
    },
  })
  void new DocsTerminal({ backend, ai: makeAi(), locale, theme }).mount(mockSlot)
}

const bootButton = document.querySelector<HTMLButtonElement>('#python-boot')
const pySlot = document.querySelector<HTMLElement>('#terminal-python')
if (bootButton && pySlot) {
  bootButton.addEventListener('click', () => {
    bootButton.disabled = true
    bootButton.textContent = 'Loading Python...'
    const backend = createPyodideBackend()
    void new DocsTerminal({ backend, ai: makeAi(), locale, theme })
      .mount(pySlot)
      .then(() => bootButton.remove())
      .catch((error: unknown) => {
        bootButton.disabled = false
        bootButton.textContent = 'Start Python environment'
        pySlot.textContent = `failed to load pyodide: ${String(error)}`
      })
  })
}
