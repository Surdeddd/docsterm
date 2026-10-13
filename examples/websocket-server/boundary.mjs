import { randomBytes } from 'node:crypto'

export const MAX_LINE_BYTES = 384
export const MAX_MARKER_LENGTH = 8192

const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/
const BODY = /^X(\d{1,15});(\d{1,3});([\s\S]*)$/
const PROMPT_MARKER = '${__dt_a}${__dt_n}P${__dt_n}${__dt_b}'

export const createNonce = () => randomBytes(16).toString('hex')

export const markersFor = (nonce) => ({ start: `\u001e${nonce}`, end: `${nonce}\u001f` })

export function initScript(nonce) {
  return [
    'stty -echo 2>/dev/null',
    `PS2=''; unset HISTFILE ENV; __dt_n=${nonce}`,
    'set +o emacs 2>/dev/null',
    'set +o vi 2>/dev/null',
    'set -o ignoreeof 2>/dev/null',
    `__dt_a=$(printf '\\036'); __dt_b=$(printf '\\037'); PS1='${PROMPT_MARKER}'`,
    `__dt_end() { __dt_c=$1; stty -echo -icanon min 0 time 0 2>/dev/null; dd of=/dev/null bs=4096 count=64 2>/dev/null; stty icanon isig iexten icrnl opost onlcr 2>/dev/null; PS1='${PROMPT_MARKER}'; printf '%s%sX%s;%s;%s%s%s' "$__dt_a" "$__dt_n" "$2" "$__dt_c" "$PWD" "$__dt_n" "$__dt_b"; }`,
    '__dt_end 0 0',
    '',
  ].join('\n')
}

export const normalizeCommand = (command) => command.replace(/\r\n?/g, '\n')

export const hasForbiddenControls = (command) => FORBIDDEN_CONTROLS.test(command)

export function quoteForShell(text, maxLineBytes = MAX_LINE_BYTES) {
  let out = "'"
  let lineBytes = 1
  for (const char of text) {
    const piece = char === "'" ? "'\\''" : char
    const bytes = Buffer.byteLength(piece)
    if (char !== '\n' && lineBytes + bytes + 2 > maxLineBytes) {
      out += "'\\\n'"
      lineBytes = 1
    }
    out += piece
    lineBytes = char === '\n' ? 0 : lineBytes + bytes
  }
  return `${out}'`
}

export function runLine({ command, seq, columns, rows }) {
  const size = columns && rows ? ` rows ${rows} cols ${columns}` : ''
  return `stty echo${size} 2>/dev/null; eval ${quoteForShell(command)}; __dt_end $? ${seq}\n`
}

export const recoveryLine = (seq) => `__dt_end $? ${seq}\n`

const partialSuffix = (text, marker) => {
  for (let length = Math.min(text.length, marker.length - 1); length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

const parseBody = (body) => {
  if (body === 'P') return { kind: 'prompt' }
  const match = BODY.exec(body)
  if (!match) return null
  return {
    kind: 'exit',
    seq: Number(match[1]),
    code: Number(match[2]),
    pwd: match[3].replace(/\r\n/g, '\n'),
  }
}

export function createBoundaryScanner(nonce, maxMarkerLength = MAX_MARKER_LENGTH) {
  const { start, end } = markersFor(nonce)
  let pending = ''

  const push = (chunk) => {
    const events = []
    const emit = (text) => {
      if (!text) return
      const last = events[events.length - 1]
      if (last?.kind === 'data') last.text += text
      else events.push({ kind: 'data', text })
    }
    let text = pending + chunk
    pending = ''
    for (;;) {
      const at = text.indexOf(start)
      if (at === -1) {
        const keep = partialSuffix(text, start)
        emit(text.slice(0, text.length - keep))
        pending = text.slice(text.length - keep)
        break
      }
      emit(text.slice(0, at))
      const close = text.indexOf(end, at + start.length)
      if (close === -1) {
        if (text.length - at > maxMarkerLength) {
          emit(start)
          text = text.slice(at + start.length)
          continue
        }
        pending = text.slice(at)
        break
      }
      const event = parseBody(text.slice(at + start.length, close))
      if (event) events.push(event)
      else emit(text.slice(at, close + end.length))
      text = text.slice(close + end.length)
    }
    return events
  }

  const flush = () => {
    const rest = pending
    pending = ''
    return rest
  }

  return { push, flush }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function promptFor(pwd, home) {
  const clean = pwd.replace(CONTROL_CHARS, '?')
  let shown = clean
  if (home && clean === home) shown = '~'
  else if (home && clean.startsWith(`${home}/`)) shown = `~${clean.slice(home.length)}`
  if (shown.length > 40) {
    const parts = shown.split('/').filter(Boolean)
    shown = `\u2026/${parts.slice(-2).join('/')}`
    if (shown.length > 40) shown = `\u2026${shown.slice(-39)}`
  }
  return `sandbox:${shown}$ `
}
