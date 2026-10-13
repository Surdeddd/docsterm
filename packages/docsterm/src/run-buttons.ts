import { formatMessage, getMessages, resolveLocale } from './messages.js'
import type { Locale } from './types.js'

export interface RunButtonsTarget {
  run(text: string): Promise<unknown>
  focus(): void
  readonly element?: Element | null
}

export interface RunButtonsOptions {
  selector?: string
  styles?: boolean
  locale?: Locale
  prompts?: readonly string[]
}

interface Sheet {
  readonly element: HTMLStyleElement
  users: number
}

interface Bar {
  readonly element: HTMLElement
  readonly marked: boolean
  buttons: number
}

const DEFAULT_SELECTOR = 'pre[data-docsterm-run] code, code[data-docsterm-run]'
const DEFAULT_PROMPTS = ['$ ', '% ']
const CONTINUATION_PROMPT = '> '
const BUTTON_CLASS = 'docsterm-run'
const BAR_CLASS = 'docsterm-run-bar'
const HOST_ATTRIBUTE = 'data-docsterm-run-host'
const STYLE_ATTRIBUTE = 'data-docsterm-run-styles'
const EDGE_BLANK_LINES = /^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g
const LINE_CLASSES = ['token-line', 'ec-line', 'line']
const LINE_TAGS = new Set(['DIV', 'P', 'LI'])
const TEXT_NODE = 3
const ELEMENT_NODE = 1

const STYLES = [
  `:where([${HOST_ATTRIBUTE}]){position:relative}`,
  `:where(.${BAR_CLASS}){position:absolute;inset-block-start:.5em;inset-inline-end:.5em;display:flex;gap:.375em;background:inherit;user-select:none;-webkit-user-select:none}`,
  `:where(.${BUTTON_CLASS}){font:inherit;font-size:.75em;line-height:1.2;min-height:24px;min-width:24px;margin-inline-start:.5em;padding:.3em .75em;border:1px solid currentColor;border-radius:.4em;background:transparent;color:inherit;opacity:.75;cursor:pointer;user-select:none;-webkit-user-select:none;vertical-align:middle}`,
  `:where(.${BAR_CLASS}>.${BUTTON_CLASS}){margin:0;background:inherit}`,
  `:where(.${BUTTON_CLASS}:hover,.${BUTTON_CLASS}:focus-visible){opacity:1}`,
  `:where(.${BUTTON_CLASS}:focus-visible){outline:2px solid currentColor;outline-offset:2px}`,
  `:where(.${BUTTON_CLASS}:disabled){cursor:progress;opacity:.45}`,
  `@media (prefers-reduced-motion:no-preference){:where(.${BUTTON_CLASS}){transition:opacity .15s ease-out}}`,
].join('\n')

const sheets = new WeakMap<Node, Sheet>()
const bars = new WeakMap<Element, Bar>()
const decorated = new WeakSet<Element>()

const documentOf = (node: Node): Document => node.ownerDocument ?? (node as Document)

const isShadowRoot = (node: Node): node is ShadowRoot => 'host' in node && node.nodeType === 11

const scrollTarget = (terminal: RunButtonsTarget): Element | null => {
  if (terminal.element) return terminal.element
  const self = terminal as Partial<Element>
  return typeof self.scrollIntoView === 'function' && typeof self.getRootNode === 'function' ? (self as Element) : null
}

const endsWithBackslash = (line: string): boolean => (/\\+$/.exec(line)?.[0].length ?? 0) % 2 === 1

const endsLine = (element: Element): boolean =>
  LINE_TAGS.has(element.tagName) || LINE_CLASSES.some((name) => element.classList.contains(name))

type Visibility = (element: Element) => boolean

const checkVisibilityOf = (element: Element): ((this: Element, options?: object) => boolean) | null => {
  const check = (element as Element & { checkVisibility?: (this: Element, options?: object) => boolean }).checkVisibility
  return typeof check === 'function' ? check : null
}

function shownInside(root: Element): Visibility {
  const view = root.ownerDocument.defaultView
  const style = (element: Element) => (typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(element) : null)
  const check = checkVisibilityOf(root)
  const useCheck = check !== null && check.call(root, { visibilityProperty: true }) !== false
  const rootHidden = style(root)?.visibility === 'hidden'
  return (element) => {
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false
    if (useCheck && check?.call(element, { visibilityProperty: true }) === false) return false
    const computed = style(element)
    if (!computed) return true
    if (computed.display === 'none') return false
    return rootHidden || (computed.visibility !== 'hidden' && computed.visibility !== 'collapse')
  }
}

function commandsOf(text: string, prompts: readonly string[]): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const promptOf = (line: string) => prompts.find((prompt) => prompt !== '' && line.startsWith(prompt))
  if (!lines.some((line) => promptOf(line) !== undefined)) return lines.join('\n').replace(EDGE_BLANK_LINES, '')
  const commands: string[] = []
  let inCommand = false
  let continued = false
  for (const line of lines) {
    const prompt = promptOf(line)
    let command: string
    if (inCommand && line.startsWith(CONTINUATION_PROMPT)) command = line.slice(CONTINUATION_PROMPT.length)
    else if (continued) command = line
    else if (prompt !== undefined) {
      command = line.slice(prompt.length)
      if (command.trim() === '') continue
    } else {
      inCommand = false
      continued = false
      continue
    }
    inCommand = true
    continued = endsWithBackslash(command)
    commands.push(command)
  }
  return commands.join('\n')
}

function textOf(root: Element, skip: Element | null): string {
  let text = ''
  const shown = shownInside(root)
  const visit = (node: Node) => {
    if (node === skip) return
    if (node.nodeType === TEXT_NODE) {
      text += node.nodeValue ?? ''
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    const element = node as Element
    if (element !== root && !shown(element)) return
    if (element.tagName === 'BR') {
      text += '\n'
      return
    }
    const start = text.length
    for (const child of Array.from(element.childNodes)) visit(child)
    if (element === root || !endsLine(element)) return
    const ended = text.length > start && text.endsWith('\n')
    const next = element.nextSibling
    const newlineFollows = next?.nodeType === TEXT_NODE && (next.nodeValue ?? '').startsWith('\n')
    if (!ended && !newlineFollows) text += '\n'
  }
  visit(root)
  return text
}

function retainStyles(root: Node): () => void {
  const scope = root.getRootNode()
  const owner = isShadowRoot(scope) ? scope : documentOf(root)
  let sheet = sheets.get(owner)
  if (!sheet) {
    const doc = documentOf(root)
    const element = doc.createElement('style')
    element.setAttribute(STYLE_ATTRIBUTE, '')
    element.textContent = STYLES
    if (isShadowRoot(owner)) owner.append(element)
    else (doc.head ?? doc.documentElement).append(element)
    sheet = { element, users: 0 }
    sheets.set(owner, sheet)
  }
  const entry = sheet
  entry.users += 1
  return () => {
    entry.users -= 1
    if (entry.users > 0) return
    entry.element.remove()
    sheets.delete(owner)
  }
}

function retainBar(host: Element): { element: HTMLElement; release(): void } {
  let bar = bars.get(host)
  if (!bar) {
    const element = documentOf(host).createElement('span')
    element.className = BAR_CLASS
    const marked = !host.hasAttribute(HOST_ATTRIBUTE)
    if (marked) host.setAttribute(HOST_ATTRIBUTE, '')
    host.append(element)
    bar = { element, marked, buttons: 0 }
    bars.set(host, bar)
  }
  const entry = bar
  entry.buttons += 1
  return {
    element: entry.element,
    release: () => {
      entry.buttons -= 1
      if (entry.buttons > 0) return
      entry.element.remove()
      if (entry.marked) host.removeAttribute(HOST_ATTRIBUTE)
      bars.delete(host)
    },
  }
}

function decorate(
  element: Element,
  terminal: RunButtonsTarget,
  first: string,
  options: RunButtonsOptions,
  prompts: readonly string[],
): () => void {
  const doc = documentOf(element)
  const locale = options.locale ?? resolveLocale(element.closest('[lang]')?.getAttribute('lang') || undefined)
  const messages = getMessages(locale)
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = BUTTON_CLASS
  button.setAttribute('aria-label', formatMessage(messages.runButtonLabel, { command: first }))
  button.textContent = messages.runButton
  const host = element.tagName === 'PRE' ? element : element.closest('pre')
  const bar = host ? retainBar(host) : null
  if (bar) bar.element.append(button)
  else element.after(button)
  let live = true
  let busy = false
  const setBusy = (value: boolean) => {
    busy = value
    button.disabled = value
    if (value) button.setAttribute('aria-busy', 'true')
    else button.removeAttribute('aria-busy')
  }
  const onClick = () => {
    if (busy) return
    const text = commandsOf(textOf(element, bar?.element ?? button), prompts)
    if (text.trim() === '') return
    const target = scrollTarget(terminal)
    if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
    terminal.focus()
    setBusy(true)
    const done = () => {
      if (live) setBusy(false)
    }
    new Promise((resolve) => resolve(terminal.run(text))).then(done, done)
  }
  button.addEventListener('click', onClick)
  decorated.add(element)
  return () => {
    live = false
    button.removeEventListener('click', onClick)
    button.remove()
    bar?.release()
    decorated.delete(element)
  }
}

export function attachRunButtons(
  root: ParentNode,
  terminal: RunButtonsTarget,
  options: RunButtonsOptions = {},
): () => void {
  const selector = options.selector ?? DEFAULT_SELECTOR
  const prompts = options.prompts ?? DEFAULT_PROMPTS
  const self = 'matches' in root && (root as Element).matches(selector) ? [root as Element] : []
  const cleanups: Array<() => void> = []
  for (const element of [...self, ...Array.from(root.querySelectorAll(selector))]) {
    if (decorated.has(element)) continue
    const first = commandsOf(textOf(element, null), prompts).split('\n')[0]?.trim() ?? ''
    if (first === '') continue
    cleanups.push(decorate(element, terminal, first, options, prompts))
  }
  const releaseStyles = options.styles === false ? () => {} : retainStyles(root)
  let attached = true
  return () => {
    if (!attached) return
    attached = false
    for (const cleanup of cleanups) cleanup()
    releaseStyles()
  }
}
