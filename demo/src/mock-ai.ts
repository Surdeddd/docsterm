import { createMockAIProvider, type AIProvider, type CommandSuggestion, type Locale } from 'docsterm'

export type TerminalKind = 'shell' | 'javascript' | 'python' | 'rust'

interface ScriptedSuggestion {
  keys: string[]
  command: string
  explanation: Record<Locale, string>
}

const TABLES: Record<TerminalKind, ScriptedSuggestion[]> = {
  shell: [
    {
      keys: ['deploy', 'задепл', 'депло'],
      command: 'orbit deploy',
      explanation: {
        en: 'Deploys the current app to the orbit cloud.',
        ru: 'Деплоит текущее приложение в облако orbit.',
      },
    },
    {
      keys: ['status', 'статус', 'состояни'],
      command: 'orbit status',
      explanation: { en: 'Shows the current deployment status.', ru: 'Показывает состояние деплоя.' },
    },
    {
      keys: ['init', 'инициал', 'создай проект'],
      command: 'orbit init',
      explanation: { en: 'Initializes an orbit project here.', ru: 'Создаёт orbit-проект в этой папке.' },
    },
    {
      keys: ['build', 'собер', 'сборк'],
      command: 'build',
      explanation: { en: 'Builds the app and prints each step.', ru: 'Собирает приложение и печатает каждый шаг.' },
    },
    {
      keys: ['files', 'list', 'файл', 'список'],
      command: 'ls -l',
      explanation: { en: 'Lists the files in the current folder.', ru: 'Показывает файлы в текущей папке.' },
    },
  ],
  javascript: [
    {
      keys: ['sum', 'сумм', 'слож'],
      command: '[1, 2, 3, 4].reduce((total, n) => total + n, 0)',
      explanation: { en: 'Adds the numbers of an array with reduce.', ru: 'Складывает числа массива через reduce.' },
    },
    {
      keys: ['time', 'date', 'время', 'дат'],
      command: 'new Date().toISOString()',
      explanation: { en: 'Prints the current time in ISO format.', ru: 'Печатает текущее время в формате ISO.' },
    },
  ],
  python: [
    {
      keys: ['sum', 'сумм', 'слож'],
      command: 'sum(range(1, 11))',
      explanation: { en: 'Adds the numbers from 1 to 10.', ru: 'Складывает числа от 1 до 10.' },
    },
    {
      keys: ['version', 'верси'],
      command: 'import sys; sys.version',
      explanation: { en: 'Shows the Python version.', ru: 'Показывает версию Python.' },
    },
  ],
  rust: [
    {
      keys: ['greet', 'hello', 'поздоров', 'привет'],
      command: 'greet world',
      explanation: { en: 'Runs the Rust binary with one argument.', ru: 'Запускает Rust-бинарник с одним аргументом.' },
    },
  ],
}

export function createDemoMockAI(kind: TerminalKind, locale: Locale): AIProvider {
  const suggestions: Record<string, CommandSuggestion> = {}
  for (const entry of TABLES[kind]) {
    for (const key of entry.keys) {
      suggestions[key] = { command: entry.command, explanation: entry.explanation[locale] }
    }
  }
  return createMockAIProvider({ suggestions, locale, delayMs: 250 })
}
