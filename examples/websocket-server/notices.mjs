const PREFIX = 'docsterm-server: '

const CATALOG = {
  en: {
    busy: () => 'another command is still running',
    notString: () => 'the command must be a string',
    tooLong: ({ limit }) => `the command is longer than ${limit} characters`,
    controls: () => 'the command contains control characters',
    timedOut: ({ seconds }) => `command timed out after ${seconds} without input`,
    outputLimit: ({ size }) => `output limit of ${size} reached; the rest is discarded`,
    shellExited: ({ code }) => `the shell exited with code ${code}; started a fresh sandbox`,
    notStopped: () => 'the command did not stop; started a fresh sandbox',
    lostBoundary: () => 'the shell lost its command boundary; started a fresh sandbox',
    restartFailed: () => 'the sandbox could not be restarted',
    startFailed: () => 'the sandbox could not be started',
    sessionLimit: ({ duration }) => `session time limit of ${duration} reached`,
  },
  ru: {
    busy: () => 'другая команда ещё выполняется',
    notString: () => 'команда должна быть строкой',
    tooLong: ({ limit }) => `команда длиннее допустимого (${limit})`,
    controls: () => 'команда содержит управляющие символы',
    timedOut: ({ seconds }) => `команда остановлена: ${seconds} без ввода`,
    outputLimit: ({ size }) => `достигнут лимит вывода ${size}; остальное отброшено`,
    shellExited: ({ code }) => `оболочка завершилась с кодом ${code}; запущена новая песочница`,
    notStopped: () => 'команда не остановилась; запущена новая песочница',
    lostBoundary: () => 'оболочка потеряла границу команды; запущена новая песочница',
    restartFailed: () => 'не удалось перезапустить песочницу',
    startFailed: () => 'не удалось запустить песочницу',
    sessionLimit: ({ duration }) => `достигнут лимит длительности сессии (${duration})`,
  },
}

const UNITS = {
  en: { second: 's', minute: 'min', byte: 'bytes', kilobyte: 'KB', megabyte: 'MB' },
  ru: { second: 'с', minute: 'мин', byte: 'байт', kilobyte: 'КБ', megabyte: 'МБ' },
}

const MEGABYTE = 1024 * 1024
const MINUTE = 60_000

export const localeOf = (value) =>
  typeof value === 'string' && value.length <= 35 && /^ru(?:[-_]|$)/i.test(value) ? 'ru' : 'en'

const number = (value, locale) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 3, useGrouping: false }).format(value)

export const formatSeconds = (ms, locale) => `${number(ms / 1000, locale)} ${UNITS[locale].second}`

export const formatDuration = (ms, locale) =>
  ms >= MINUTE && ms % MINUTE === 0 ? `${number(ms / MINUTE, locale)} ${UNITS[locale].minute}` : formatSeconds(ms, locale)

export const formatBytes = (bytes, locale) => {
  const units = UNITS[locale]
  if (bytes >= MEGABYTE && bytes % MEGABYTE === 0) return `${number(bytes / MEGABYTE, locale)} ${units.megabyte}`
  if (bytes >= 1024 && bytes % 1024 === 0) return `${number(bytes / 1024, locale)} ${units.kilobyte}`
  return `${number(bytes, locale)} ${units.byte}`
}

export const noticeText = (locale, key, params = {}) => `${PREFIX}${CATALOG[locale][key](params)}`
