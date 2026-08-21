import type { BackendRunResult, InteractiveRun, RunContext } from '../types.js'

const CLEAR_SCREEN = '\x1b[2J\x1b[H'
const INVERSE = '\x1b[7m'
const RESET = '\x1b[0m'

export interface PagerView {
  lines: string[]
  offset: number
  height: number
  title: string
}

export function renderPage(view: PagerView): string {
  const body = view.lines.slice(view.offset, view.offset + view.height)
  const padded = [...body, ...Array.from({ length: view.height - body.length }, () => '')]
  const last = Math.min(view.offset + view.height, view.lines.length)
  const percent = view.lines.length === 0 ? 100 : Math.round((last / view.lines.length) * 100)
  const status = `${INVERSE} ${view.title} ${last}/${view.lines.length} (${percent}%) - space/j/k/g/G, q to quit ${RESET}`
  return `${CLEAR_SCREEN}${padded.join('\r\n')}\r\n${status}`
}

export function nextOffset(view: PagerView, key: string): number | 'quit' {
  const maxOffset = Math.max(view.lines.length - view.height, 0)
  const clamp = (value: number) => Math.min(Math.max(value, 0), maxOffset)
  switch (key) {
    case 'q':
    case '\x03':
      return 'quit'
    case ' ':
    case 'f':
    case '\x1b[6~':
      return clamp(view.offset + view.height)
    case 'b':
    case '\x1b[5~':
      return clamp(view.offset - view.height)
    case 'j':
    case '\x1b[B':
    case '\r':
      return clamp(view.offset + 1)
    case 'k':
    case '\x1b[A':
      return clamp(view.offset - 1)
    case 'g':
    case '\x1b[H':
      return 0
    case 'G':
    case '\x1b[F':
      return maxOffset
    default:
      return view.offset
  }
}

export function createPager(text: string, title: string, ctx: RunContext): InteractiveRun {
  const view: PagerView = {
    lines: text.replace(/\n$/, '').split('\n'),
    offset: 0,
    height: Math.max(ctx.rows - 2, 3),
    title,
  }

  let finish: (result: BackendRunResult) => void = () => {}
  const done = new Promise<BackendRunResult>((resolve) => {
    finish = resolve
  })

  ctx.write(renderPage(view))

  return {
    onKey(data: string): void {
      const target = nextOffset(view, data)
      if (target === 'quit') {
        ctx.write(CLEAR_SCREEN)
        finish({ output: '', exitCode: 0 })
        return
      }
      if (target === view.offset) return
      view.offset = target
      ctx.write(renderPage(view))
    },
    done,
  }
}
