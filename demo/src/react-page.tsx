import './fonts'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { StrictMode, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DocsTerminalEvent } from 'docsterm'
import { DocsTerminal, type DocsTerminalHandle } from 'docsterm/react'
import { describeEvent } from './event-log'
import { fill, getPageStrings } from './i18n'
import { createOrbitBackend } from './orbit'
import {
  pageLocale,
  pageTheme,
  remember,
  TERMINAL_FONT,
  TERMINAL_FONT_SIZE,
  terminalThemes,
  THEME_KEY,
  type PageTheme,
} from './page'

const locale = pageLocale()
const strings = getPageStrings(locale)

function App() {
  const [backend] = useState(() => createOrbitBackend(strings.shellBanner))
  const [theme, setTheme] = useState<PageTheme>(pageTheme)
  const [renders, setRenders] = useState(0)
  const [events, setEvents] = useState({ count: 0, last: '' })
  const terminal = useRef<DocsTerminalHandle>(null)

  const onEvent = useCallback((event: DocsTerminalEvent) => {
    setEvents((previous) => ({ count: previous.count + 1, last: describeEvent(event, strings) }))
  }, [])

  const toggleTheme = () => {
    const next: PageTheme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    remember(THEME_KEY, next)
    setTheme(next)
  }

  const runStatus = () => {
    terminal.current?.focus()
    terminal.current?.run('orbit status').catch(() => undefined)
  }

  return (
    <main className="react-page">
      <a className="text-link" href={`${import.meta.env.BASE_URL}${location.search}`}>
        {strings.reactBack}
      </a>
      <h1 className="react-title">{strings.reactTitle}</h1>
      <p className="prose">{strings.reactLead}</p>
      <div className="react-controls">
        <button type="button" className="action ghost" id="react-theme" onClick={toggleTheme}>
          {strings.reactThemeToggle}
        </button>
        <button type="button" className="action ghost" id="react-rerender" onClick={() => setRenders((n) => n + 1)}>
          {strings.reactRerender}
        </button>
        <button type="button" className="action ghost" id="react-run" onClick={runStatus}>
          {strings.reactRunStatus}
        </button>
      </div>
      <p className="react-stats">
        <span id="react-renders" data-count={renders}>
          {fill(strings.reactRenders, { count: renders })}
        </span>
        <span id="react-events" data-count={events.count}>
          {fill(strings.reactEvents, { count: events.count })}
        </span>
        {events.last ? <span id="react-last-event">{fill(strings.reactLastEvent, { event: events.last })}</span> : null}
      </p>
      <figure className="terminal-frame">
        <figcaption className="terminal-label">
          <span className="dot" aria-hidden="true" />
          <span>{strings.terminalLabelReact}</span>
        </figcaption>
        <DocsTerminal
          ref={terminal}
          id="react-terminal"
          className="terminal-slot"
          backend={backend}
          locale={locale}
          theme={{ ...terminalThemes[theme] }}
          pageContext={{ title: strings.reactTitle }}
          fontFamily={TERMINAL_FONT}
          fontSize={TERMINAL_FONT_SIZE}
          onEvent={onEvent}
        />
      </figure>
    </main>
  )
}

document.title = strings.reactDocumentTitle
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
