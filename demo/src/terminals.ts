import { DocsTerminal, isAbortError, type AIProvider, type DocsTerminalOptions, type TerminalTheme } from 'docsterm'
import { fill, type PageStrings } from './i18n'

export interface LiveTarget {
  setAI(ai: AIProvider | undefined): void
  setTheme(theme: TerminalTheme): void
}

const live = new Set<LiveTarget>()

export const liveTerminals = {
  add(target: LiveTarget): () => void {
    live.add(target)
    return () => live.delete(target)
  },
  setAI(ai: AIProvider | undefined): void {
    for (const target of live) target.setAI(ai)
  },
  setTheme(theme: TerminalTheme): void {
    for (const target of live) target.setTheme(theme)
  },
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function showMountError(slot: HTMLElement, error: unknown, strings: PageStrings): HTMLElement {
  const box = document.createElement('div')
  box.className = 'mount-error'
  box.setAttribute('role', 'alert')
  const message = document.createElement('p')
  message.textContent = fill(strings.mountFailed, { reason: reasonOf(error) })
  const hint = document.createElement('p')
  hint.textContent = strings.reloadHint
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = strings.reloadButton
  reload.addEventListener('click', () => location.reload())
  box.append(message, hint, reload)
  slot.replaceChildren(box)
  return box
}

export interface MountedTerminal {
  terminal: DocsTerminal
  ready: Promise<boolean>
}

export function mountTerminal(slot: HTMLElement, options: DocsTerminalOptions, strings: PageStrings): MountedTerminal {
  const terminal = new DocsTerminal(options)
  const forget = liveTerminals.add(terminal)
  const ready = terminal.mount(slot).then(
    () => true,
    (error: unknown) => {
      forget()
      terminal.dispose()
      if (isAbortError(error)) return false
      showMountError(slot, error, strings)
      console.error('docsterm: terminal failed to start', error)
      return false
    },
  )
  return { terminal, ready }
}
