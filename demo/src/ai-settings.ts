import { keyStore } from 'docsterm'
import { ANTHROPIC_KEY_NAME } from 'docsterm-ai-anthropic'

export function setupAiSettings(container: HTMLElement): void {
  const status = document.createElement('div')
  status.id = 'ai-status'
  const input = document.createElement('input')
  input.type = 'password'
  input.placeholder = 'sk-ant-... (Anthropic API key)'
  input.id = 'ai-key-input'
  const save = document.createElement('button')
  save.textContent = 'Save key'
  save.id = 'ai-key-save'
  const clear = document.createElement('button')
  clear.textContent = 'Clear key'
  clear.id = 'ai-key-clear'

  const refresh = () => {
    const hasKey = keyStore.get(ANTHROPIC_KEY_NAME) !== null
    status.textContent = hasKey
      ? 'API key is set (stored only in this browser). Reload the page to apply.'
      : 'No API key set - AI features are off unless ?ai=mock is used.'
  }

  save.addEventListener('click', () => {
    const value = input.value.trim()
    if (value.length > 0) {
      keyStore.set(ANTHROPIC_KEY_NAME, value)
      input.value = ''
    }
    refresh()
  })
  clear.addEventListener('click', () => {
    keyStore.clear(ANTHROPIC_KEY_NAME)
    refresh()
  })

  container.append(input, save, clear, status)
  refresh()
}
