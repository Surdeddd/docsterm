import type { DocsTerminalEvent } from 'docsterm'
import { fill, type PageStrings } from './i18n'

const MAX_ENTRIES = 6

export function describeEvent(event: DocsTerminalEvent, strings: PageStrings): string {
  switch (event.type) {
    case 'ready':
      return strings.eventReady
    case 'command':
      return fill(strings.eventCommand, {
        command: event.command,
        source: strings.eventSources[event.source],
        exitCode: event.exitCode,
        duration: Math.round(event.durationMs),
      })
    case 'interrupt':
      return event.command === undefined
        ? strings.eventInterruptAi
        : fill(strings.eventInterrupt, { command: event.command })
    case 'ai-suggest': {
      if (event.command === undefined) return fill(strings.eventSuggestFailed, { request: event.request })
      const text = fill(strings.eventSuggest, { command: event.command, request: event.request })
      if (event.accepted === undefined) return text
      return `${text} · ${event.accepted ? strings.eventSuggestAccepted : strings.eventSuggestDeclined}`
    }
    case 'ai-explain':
      return fill(strings.eventExplain, { command: event.command })
    case 'error':
      return fill(strings.eventError, { phase: strings.eventPhases[event.phase], message: event.message })
  }
}

export function createEventLog(list: HTMLElement, strings: PageStrings): (event: DocsTerminalEvent) => void {
  const empty = document.createElement('li')
  empty.className = 'event-empty'
  empty.textContent = strings.eventsEmpty
  list.replaceChildren(empty)
  return (event) => {
    empty.remove()
    const item = document.createElement('li')
    item.dataset.type = event.type
    if (event.type === 'command') {
      item.dataset.source = event.source
      item.dataset.exitCode = String(event.exitCode)
      item.dataset.command = event.command
    }
    const type = document.createElement('span')
    type.className = 'event-type'
    type.textContent = event.type
    const text = document.createElement('span')
    text.className = 'event-text'
    text.textContent = describeEvent(event, strings)
    item.append(type, text)
    list.append(item)
    while (list.children.length > MAX_ENTRIES) list.firstElementChild?.remove()
  }
}
