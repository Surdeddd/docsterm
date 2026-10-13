import { keyStore, type AIProvider } from 'docsterm'
import { ANTHROPIC_KEY_NAME, createAnthropicProvider } from 'docsterm/anthropic'
import { createOpenAIProvider, OPENAI_PRESETS, type OpenAIPreset } from 'docsterm/openai'
import { fill, type PageStrings } from './i18n'

const STORAGE_PREFIX = 'docsterm:'
const PROVIDER_KEY = 'docsterm:provider'
const MODEL_PREFIX = 'docsterm:model:'
const BASE_URL_KEY = 'docsterm:baseurl'
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com'

interface ProviderChoice {
  id: string
  label: string
  defaultModel: string
  keyless?: boolean
  local?: boolean
  custom?: boolean
}

export const PROVIDER_CHOICES: ProviderChoice[] = [
  { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-opus-5-5' },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-6-luna' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openai/gpt-6-luna' },
  { id: 'groq', label: 'Groq', defaultModel: 'openai/gpt-oss-20b' },
  { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-3.5-flash-lite' },
  { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-flash' },
  { id: 'mistral', label: 'Mistral', defaultModel: 'mistral-small-2603' },
  { id: 'xai', label: 'xAI', defaultModel: 'grok-4.20-non-reasoning' },
  { id: 'ollama', label: 'Ollama', defaultModel: 'llama3.2', keyless: true, local: true },
  { id: 'lmstudio', label: 'LM Studio', defaultModel: 'local-model', keyless: true, local: true },
  { id: 'custom', label: '', defaultModel: '', custom: true },
]

export type AiStateKind = 'active' | 'off' | 'needs-key' | 'needs-base-url' | 'needs-model'

export interface AiState {
  kind: AiStateKind
  id: string
  model: string
  provider?: AIProvider
}

const choiceOf = (id: string): ProviderChoice =>
  PROVIDER_CHOICES.find((choice) => choice.id === id) ?? PROVIDER_CHOICES[0]!

const keyNameFor = (id: string): string => (id === 'anthropic' ? ANTHROPIC_KEY_NAME : `docsterm:key:${id}`)

const savedModel = (id: string): string | null => keyStore.get(`${MODEL_PREFIX}${id}`)

const storedKeys = (): string[] => {
  try {
    return Object.keys(localStorage)
  } catch {
    return []
  }
}

function createProvider(choice: ProviderChoice, model: string, baseURL: string | null): AIProvider {
  if (choice.id === 'anthropic') return createAnthropicProvider({ model })
  const keyName = choice.keyless ? undefined : keyNameFor(choice.id)
  if (choice.custom) return createOpenAIProvider({ baseURL: baseURL ?? '', model, keyName, id: 'custom' })
  return createOpenAIProvider({ preset: choice.id as OpenAIPreset, model, keyName })
}

export function readAiConfig(): AiState {
  const saved = keyStore.get(PROVIDER_KEY)
  const choice = choiceOf(saved ?? 'anthropic')
  const model = (savedModel(choice.id) ?? choice.defaultModel).trim()
  const base = { id: choice.id, model }
  if (!choice.keyless && !keyStore.get(keyNameFor(choice.id))) {
    return { ...base, kind: saved === null ? 'off' : 'needs-key' }
  }
  const baseURL = choice.custom ? keyStore.get(BASE_URL_KEY) : null
  if (choice.custom && !baseURL) return { ...base, kind: 'needs-base-url' }
  if (!model) return { ...base, kind: 'needs-model' }
  return { ...base, kind: 'active', provider: createProvider(choice, model, baseURL) }
}

export function buildConfiguredProvider(): AIProvider | undefined {
  return readAiConfig().provider
}

export interface AiSettingsOptions {
  mock: boolean
  onApply(provider: AIProvider | undefined): void
}

const field = (labelText: string, control: HTMLElement): HTMLLabelElement => {
  const label = document.createElement('label')
  label.className = 'field'
  const caption = document.createElement('span')
  caption.textContent = labelText
  label.append(caption, control)
  return label
}

const textInput = (id: string, type: 'text' | 'password' | 'url'): HTMLInputElement => {
  const input = document.createElement('input')
  input.type = type
  input.id = id
  input.autocomplete = 'off'
  input.spellcheck = false
  return input
}

const button = (id: string, text: string): HTMLButtonElement => {
  const element = document.createElement('button')
  element.type = 'button'
  element.id = id
  element.textContent = text
  return element
}

export function setupAiSettings(container: HTMLElement, strings: PageStrings, options: AiSettingsOptions): void {
  const labelOf = (choice: ProviderChoice): string => {
    if (choice.custom) return strings.aiProviderCustom
    return choice.local ? fill(strings.aiProviderLocal, { name: choice.label }) : choice.label
  }

  const providerSelect = document.createElement('select')
  providerSelect.id = 'ai-provider'
  for (const choice of PROVIDER_CHOICES) {
    const option = document.createElement('option')
    option.value = choice.id
    option.textContent = labelOf(choice)
    providerSelect.append(option)
  }
  const modelInput = textInput('ai-model', 'text')
  const baseInput = textInput('ai-base-url', 'url')
  baseInput.placeholder = 'https://my-gateway.example.com/v1'
  const keyInput = textInput('ai-key-input', 'password')

  const providerField = field(strings.aiProviderLabel, providerSelect)
  const modelField = field(strings.aiModelLabel, modelInput)
  const baseField = field(strings.aiBaseUrlLabel, baseInput)
  const keyField = field(strings.aiKeyLabel, keyInput)

  const save = button('ai-key-save', strings.aiSave)
  const clear = button('ai-key-clear', strings.aiClear)
  const actions = document.createElement('div')
  actions.className = 'ai-actions'
  actions.append(save, clear)

  const endpoint = document.createElement('div')
  endpoint.id = 'ai-endpoint'

  const status = document.createElement('p')
  status.id = 'ai-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  const currentChoice = () => choiceOf(providerSelect.value)

  const fillFields = () => {
    const choice = currentChoice()
    baseField.hidden = !choice.custom
    keyField.hidden = Boolean(choice.keyless)
    modelInput.value = savedModel(choice.id) ?? choice.defaultModel
    baseInput.value = choice.custom ? (keyStore.get(BASE_URL_KEY) ?? '') : ''
    keyInput.value = ''
    keyInput.placeholder = keyStore.get(keyNameFor(choice.id)) ? strings.aiKeyStored : strings.aiKeyPlaceholder
    endpoint.textContent = choice.custom
      ? strings.aiEndpointCustom
      : choice.id === 'anthropic'
        ? ANTHROPIC_ENDPOINT
        : OPENAI_PRESETS[choice.id as OpenAIPreset]
  }

  const isDirty = (): boolean => {
    const choice = currentChoice()
    const savedId = keyStore.get(PROVIDER_KEY) ?? 'anthropic'
    if (choice.id !== savedId) return true
    if (modelInput.value.trim() !== (savedModel(choice.id) ?? choice.defaultModel)) return true
    if (choice.custom && baseInput.value.trim() !== (keyStore.get(BASE_URL_KEY) ?? '')) return true
    return keyInput.value.trim() !== ''
  }

  const describe = (state: AiState): string => {
    const provider = labelOf(choiceOf(state.id))
    switch (state.kind) {
      case 'active':
        return fill(strings.aiStatusActive, { provider, model: state.model })
      case 'off':
        return strings.aiStatusOff
      case 'needs-key':
        return fill(strings.aiStatusNeedsKey, { provider })
      case 'needs-base-url':
        return strings.aiStatusNeedsBaseUrl
      case 'needs-model':
        return fill(strings.aiStatusNeedsModel, { provider })
    }
  }

  const refresh = (note?: string) => {
    const state = readAiConfig()
    status.dataset.state = options.mock ? 'mock' : state.kind
    const parts = [options.mock ? strings.aiStatusMock : describe(state)]
    if (note) parts.push(note)
    if (isDirty()) parts.push(strings.aiStatusUnsaved)
    status.textContent = parts.join(' ')
  }

  const apply = () => {
    if (!options.mock) options.onApply(readAiConfig().provider)
  }

  providerSelect.addEventListener('change', () => {
    fillFields()
    refresh()
  })
  for (const input of [modelInput, baseInput, keyInput]) input.addEventListener('input', () => refresh())

  save.addEventListener('click', () => {
    const choice = currentChoice()
    keyStore.set(PROVIDER_KEY, choice.id)
    const model = modelInput.value.trim()
    if (model === '') keyStore.clear(`${MODEL_PREFIX}${choice.id}`)
    else keyStore.set(`${MODEL_PREFIX}${choice.id}`, model)
    if (choice.custom) {
      const baseURL = baseInput.value.trim()
      if (baseURL === '') keyStore.clear(BASE_URL_KEY)
      else keyStore.set(BASE_URL_KEY, baseURL)
    }
    const key = keyInput.value.trim()
    if (key !== '' && !choice.keyless) keyStore.set(keyNameFor(choice.id), key)
    fillFields()
    apply()
    refresh()
  })

  clear.addEventListener('click', () => {
    for (const name of storedKeys()) {
      if (name.startsWith(STORAGE_PREFIX)) keyStore.clear(name)
    }
    providerSelect.value = 'anthropic'
    fillFields()
    apply()
    refresh(strings.aiStatusCleared)
  })

  providerSelect.value = choiceOf(keyStore.get(PROVIDER_KEY) ?? 'anthropic').id
  container.replaceChildren(providerField, modelField, baseField, keyField, actions, endpoint, status)
  fillFields()
  refresh()
}
