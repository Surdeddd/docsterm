import type { Locale } from './types'

export interface Messages {
  welcome: string
  aiNotConfigured: string
  aiThinking: string
  suggestionLabel: string
  confirmRun: string
  cancelled: string
  errorHint: string
  explainHeader: string
  nothingToExplain: string
  aiError: string
  backendError: string
  helpText: string
  keyMissing: string
  interrupted: string
  backendLoading: string
}

const en: Messages = {
  welcome: 'docsterm ready. Type a command, or start with # to ask AI. Builtins: help, clear, explain.',
  aiNotConfigured: 'AI is not configured for this terminal.',
  aiThinking: 'thinking...',
  suggestionLabel: 'suggested command',
  confirmRun: 'run it? [y/N] ',
  cancelled: 'cancelled.',
  errorHint: "command failed. Type 'explain' to get an AI explanation.",
  explainHeader: 'explanation',
  nothingToExplain: 'nothing to explain yet - no failed command recorded.',
  aiError: 'AI request failed',
  backendError: 'backend error',
  helpText: 'builtins: help - this text; clear - clear screen; explain - explain the last error; #<request> - ask AI for a command.',
  keyMissing: 'no API key configured. Open AI settings to add one.',
  interrupted: '^C',
  backendLoading: 'loading environment...',
}

const ru: Messages = {
  welcome: 'docsterm готов. Введи команду или начни с # чтобы спросить AI. Встроенные: help, clear, explain.',
  aiNotConfigured: 'AI для этого терминала не настроен.',
  aiThinking: 'думаю...',
  suggestionLabel: 'предложенная команда',
  confirmRun: 'выполнить? [y/N] ',
  cancelled: 'отменено.',
  errorHint: "команда завершилась с ошибкой. Введи 'explain' для объяснения от AI.",
  explainHeader: 'объяснение',
  nothingToExplain: 'объяснять нечего - ошибок пока не было.',
  aiError: 'запрос к AI не удался',
  backendError: 'ошибка окружения',
  helpText: 'встроенные: help - эта справка; clear - очистить экран; explain - объяснить последнюю ошибку; #<запрос> - попросить AI составить команду.',
  keyMissing: 'API-ключ не задан. Добавь его в настройках AI.',
  interrupted: '^C',
  backendLoading: 'загружаю окружение...',
}

const catalogs: Record<Locale, Messages> = { en, ru }

export function resolveLocale(input?: string): Locale {
  const raw = input ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)
  return raw.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

export function getMessages(locale: Locale): Messages {
  return catalogs[locale]
}
