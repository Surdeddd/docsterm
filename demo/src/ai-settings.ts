import { keyStore, type AIProvider } from 'docsterm'
import { ANTHROPIC_KEY_NAME, createAnthropicProvider } from 'docsterm/anthropic'
import { createOpenAIProvider, OPENAI_PRESETS, type OpenAIPreset } from 'docsterm/openai'
import type { PageStrings } from './i18n'

const PROVIDER_KEY = 'docsterm:provider'
const MODEL_KEY = 'docsterm:model'
const BASE_URL_KEY = 'docsterm:baseurl'

interface ProviderChoice {
  id: string
  label: string
  defaultModel: string
  keyless?: boolean
  custom?: boolean
}

export const PROVIDER_CHOICES: ProviderChoice[] = [
  { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-opus-5' },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4.1-mini' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openai/gpt-4.1-mini' },
  { id: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile' },
  { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-2.0-flash' },
  { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'mistral', label: 'Mistral', defaultModel: 'mistral-small-latest' },
  { id: 'xai', label: 'xAI', defaultModel: 'grok-3-mini' },
  { id: 'ollama', label: 'Ollama (local)', defaultModel: 'llama3.1', keyless: true },
  { id: 'lmstudio', label: 'LM Studio (local)', defaultModel: 'local-model', keyless: true },
  { id: 'custom', label: 'Custom endpoint', defaultModel: '', custom: true },
]

const choiceOf = (id: string): ProviderChoice =>
  PROVIDER_CHOICES.find((choice) => choice.id === id) ?? PROVIDER_CHOICES[0]!

const keyNameFor = (id: string): string =>
  id === 'anthropic' ? ANTHROPIC_KEY_NAME : `docsterm:key:${id}`

export function buildConfiguredProvider(): AIProvider | undefined {
  const id = keyStore.get(PROVIDER_KEY) ?? 'anthropic'
  const choice = choiceOf(id)
  const key = keyStore.get(keyNameFor(id))
  const model = keyStore.get(MODEL_KEY) ?? choice.defaultModel
  if (!key && !choice.keyless) return undefined
  if (id === 'anthropic') return createAnthropicProvider({ model })
  if (choice.custom) {
    const baseURL = keyStore.get(BASE_URL_KEY)
    if (!baseURL || !model) return undefined
    return createOpenAIProvider({ baseURL, model, keyName: keyNameFor(id), id: 'custom' })
  }
  return createOpenAIProvider({
    preset: id as OpenAIPreset,
    model,
    keyName: keyNameFor(id),
  })
}

export function setupAiSettings(container: HTMLElement, strings: PageStrings): void {
  const providerField = document.createElement('label')
  providerField.className = 'field'
  const providerLabel = document.createElement('span')
  providerLabel.textContent = strings.aiProviderLabel
  const providerSelect = document.createElement('select')
  providerSelect.id = 'ai-provider'
  for (const choice of PROVIDER_CHOICES) {
    const option = document.createElement('option')
    option.value = choice.id
    option.textContent = choice.id === 'custom' ? strings.aiProviderCustom : choice.label
    providerSelect.append(option)
  }
  providerField.append(providerLabel, providerSelect)

  const modelField = document.createElement('label')
  modelField.className = 'field'
  const modelLabel = document.createElement('span')
  modelLabel.textContent = strings.aiModelLabel
  const modelInput = document.createElement('input')
  modelInput.type = 'text'
  modelInput.id = 'ai-model'
  modelInput.autocomplete = 'off'
  modelField.append(modelLabel, modelInput)

  const baseField = document.createElement('label')
  baseField.className = 'field'
  const baseLabel = document.createElement('span')
  baseLabel.textContent = strings.aiBaseUrlLabel
  const baseInput = document.createElement('input')
  baseInput.type = 'text'
  baseInput.id = 'ai-base-url'
  baseInput.placeholder = 'https://my-gateway.example.com/v1'
  baseInput.autocomplete = 'off'
  baseField.append(baseLabel, baseInput)

  const keyField = document.createElement('label')
  keyField.className = 'field'
  const keyLabel = document.createElement('span')
  keyLabel.textContent = strings.aiKeyLabel
  const keyInput = document.createElement('input')
  keyInput.type = 'password'
  keyInput.id = 'ai-key-input'
  keyInput.placeholder = strings.aiKeyPlaceholder
  keyInput.autocomplete = 'off'
  keyField.append(keyLabel, keyInput)

  const save = document.createElement('button')
  save.type = 'button'
  save.textContent = strings.aiSave
  save.id = 'ai-key-save'
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.textContent = strings.aiClear
  clear.id = 'ai-key-clear'

  const status = document.createElement('div')
  status.id = 'ai-status'

  const hint = document.createElement('div')
  hint.id = 'ai-endpoint'

  const currentChoice = () => choiceOf(providerSelect.value)

  const syncFields = () => {
    const choice = currentChoice()
    baseField.hidden = !choice.custom
    keyField.hidden = Boolean(choice.keyless)
    const savedModel = keyStore.get(MODEL_KEY)
    const savedProvider = keyStore.get(PROVIDER_KEY)
    modelInput.value =
      savedProvider === choice.id && savedModel ? savedModel : choice.defaultModel
    hint.textContent = choice.custom
      ? strings.aiEndpointCustom
      : choice.id === 'anthropic'
        ? 'https://api.anthropic.com'
        : OPENAI_PRESETS[choice.id as OpenAIPreset]
  }

  const refresh = () => {
    const choice = currentChoice()
    const hasKey = keyStore.get(keyNameFor(choice.id)) !== null
    status.textContent = hasKey || choice.keyless ? strings.aiStatusSet : strings.aiStatusEmpty
  }

  providerSelect.addEventListener('change', () => {
    syncFields()
    refresh()
  })

  save.addEventListener('click', () => {
    const choice = currentChoice()
    keyStore.set(PROVIDER_KEY, choice.id)
    if (modelInput.value.trim() !== '') keyStore.set(MODEL_KEY, modelInput.value.trim())
    if (choice.custom && baseInput.value.trim() !== '') {
      keyStore.set(BASE_URL_KEY, baseInput.value.trim())
    }
    if (keyInput.value.trim() !== '') {
      keyStore.set(keyNameFor(choice.id), keyInput.value.trim())
      keyInput.value = ''
    }
    refresh()
  })

  clear.addEventListener('click', () => {
    const choice = currentChoice()
    keyStore.clear(keyNameFor(choice.id))
    keyStore.clear(PROVIDER_KEY)
    keyStore.clear(MODEL_KEY)
    keyStore.clear(BASE_URL_KEY)
    refresh()
  })

  providerSelect.value = keyStore.get(PROVIDER_KEY) ?? 'anthropic'
  baseInput.value = keyStore.get(BASE_URL_KEY) ?? ''
  container.append(providerField, modelField, baseField, keyField, save, clear, hint, status)
  syncFields()
  refresh()
}
