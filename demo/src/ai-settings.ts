import { keyStore } from 'docsterm'
import { ANTHROPIC_KEY_NAME } from 'docsterm/anthropic'
import type { PageStrings } from './i18n'

export function setupAiSettings(container: HTMLElement, strings: PageStrings): void {
  const status = document.createElement('div')
  status.id = 'ai-status'
  const input = document.createElement('input')
  input.type = 'password'
  input.placeholder = strings.aiKeyPlaceholder
  input.id = 'ai-key-input'
  input.autocomplete = 'off'
  const save = document.createElement('button')
  save.textContent = strings.aiSave
  save.id = 'ai-key-save'
  const clear = document.createElement('button')
  clear.textContent = strings.aiClear
  clear.id = 'ai-key-clear'

  const refresh = () => {
    const hasKey = keyStore.get(ANTHROPIC_KEY_NAME) !== null
    status.textContent = hasKey ? strings.aiStatusSet : strings.aiStatusEmpty
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
