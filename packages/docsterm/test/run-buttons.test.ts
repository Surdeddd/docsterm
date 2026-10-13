// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachRunButtons as attach, type RunButtonsTarget } from '../src/run-buttons.js'
import type { RunReport } from '../src/types.js'

const attached: Array<() => void> = []

const attachRunButtons = (...args: Parameters<typeof attach>) => {
  const cleanup = attach(...args)
  attached.push(cleanup)
  return cleanup
}

interface PendingRun {
  text: string
  finish(report?: RunReport): void
  fail(error: unknown): void
}

const fakeTerminal = () => {
  const calls: string[] = []
  const runs: PendingRun[] = []
  const element = document.createElement('div')
  const scrollIntoView = vi.fn(() => {
    calls.push('scroll')
  })
  element.scrollIntoView = scrollIntoView
  const terminal: RunButtonsTarget = {
    element,
    focus: () => {
      calls.push('focus')
    },
    run: (text) => {
      calls.push(`run:${text}`)
      return new Promise<RunReport>((resolve, reject) => {
        runs.push({ text, finish: (report = { exitCode: 0, output: '' }) => resolve(report), fail: reject })
      })
    },
  }
  return { terminal, calls, runs, scrollIntoView }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

let root: HTMLElement
let unhandled: unknown[]
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
  document.documentElement.lang = 'en'
  root = document.createElement('main')
  document.body.append(root)
})

afterEach(() => {
  for (const cleanup of attached.splice(0)) cleanup()
  process.off('unhandledRejection', onUnhandled)
  root.remove()
  document.documentElement.removeAttribute('lang')
  expect(document.querySelectorAll('style[data-docsterm-run-styles]')).toHaveLength(0)
})

const buttons = (scope: ParentNode = root) => Array.from(scope.querySelectorAll<HTMLButtonElement>('button.docsterm-run'))

const describeButton = (button: HTMLButtonElement) => [
  button.parentElement?.tagName,
  button.getAttribute('type'),
  button.textContent,
  button.getAttribute('aria-label'),
]

const styles = () => document.querySelectorAll('style[data-docsterm-run-styles]')

describe('attachRunButtons', () => {
  it('adds a button to every marked block and to nothing else', () => {
    root.innerHTML = [
      '<pre data-docsterm-run><code>$ orbit status\nok\n$ orbit deploy</code></pre>',
      '<p>Then run <code data-docsterm-run>ls -la</code>.</p>',
      '<pre><code>not marked</code></pre>',
      '<pre data-docsterm-run><code>echo hi\n</code></pre>',
    ].join('')
    const cleanup = attachRunButtons(root, fakeTerminal().terminal)
    expect(buttons().map(describeButton)).toEqual([
      ['SPAN', 'button', 'run', 'run in the terminal: orbit status'],
      ['P', 'button', 'run', 'run in the terminal: ls -la'],
      ['SPAN', 'button', 'run', 'run in the terminal: echo hi'],
    ])
    expect(buttons().map((button) => button.parentElement?.parentElement?.tagName)).toEqual(['PRE', 'MAIN', 'PRE'])
    expect(root.querySelector('p')?.innerHTML).toBe(
      'Then run <code data-docsterm-run="">ls -la</code><button type="button" class="docsterm-run" aria-label="run in the terminal: ls -la">run</button>.',
    )
    cleanup()
  })

  it('runs only the prompt lines of a console block, without their prompt, after scrolling and focusing', () => {
    root.innerHTML =
      '<pre data-docsterm-run><code>$ orbit init\nProject initialized.\n% orbit deploy --prod\nDeployed.\n$ \n</code></pre>'
    const { terminal, calls, scrollIntoView } = fakeTerminal()
    attachRunButtons(root, terminal)
    buttons()[0]?.click()
    expect(calls).toEqual(['scroll', 'focus', 'run:orbit init\norbit deploy --prod'])
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('runs a block without prompts as it is, minus the surrounding blank lines', () => {
    root.innerHTML = '<pre data-docsterm-run><code>\nfor f in *.md; do\n  echo "$f"\n\ndone\n\n</code></pre>'
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal)
    buttons()[0]?.click()
    expect(calls.at(-1)).toBe('run:for f in *.md; do\n  echo "$f"\n\ndone')
    expect(buttons()[0]?.getAttribute('aria-label')).toBe('run in the terminal: for f in *.md; do')
  })

  it('shows a busy, disabled button while the command runs and restores it however the run ends', async () => {
    root.innerHTML = '<pre data-docsterm-run><code>orbit status</code></pre>'
    const { terminal, runs } = fakeTerminal()
    attachRunButtons(root, terminal)
    const button = buttons()[0] as HTMLButtonElement
    button.click()
    expect([button.disabled, button.getAttribute('aria-busy')]).toEqual([true, 'true'])
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(runs).toHaveLength(1)
    runs[0]?.finish({ exitCode: 2, output: 'boom' })
    await tick()
    expect([button.disabled, button.hasAttribute('aria-busy')]).toEqual([false, false])
    button.click()
    runs[1]?.fail(new DOMException('disposed', 'AbortError'))
    await tick()
    expect([button.disabled, button.hasAttribute('aria-busy')]).toEqual([false, false])
    expect(unhandled).toEqual([])
  })

  it('labels buttons in the language of the block, or in the locale option', () => {
    document.documentElement.lang = 'ru'
    root.innerHTML = [
      '<pre data-docsterm-run><code>$ orbit status</code></pre>',
      '<div lang="en"><pre data-docsterm-run><code>ls</code></pre></div>',
    ].join('')
    const cleanup = attachRunButtons(root, fakeTerminal().terminal)
    expect(buttons().map(describeButton)).toEqual([
      ['SPAN', 'button', 'запустить', 'запустить в терминале: orbit status'],
      ['SPAN', 'button', 'run', 'run in the terminal: ls'],
    ])
    cleanup()
    attachRunButtons(root, fakeTerminal().terminal, { locale: 'ru' })
    expect(buttons().map((button) => button.textContent)).toEqual(['запустить', 'запустить'])
  })

  it('decorates the blocks a custom selector finds', () => {
    root.innerHTML = [
      '<pre><code class="language-bash">npm test</code></pre>',
      '<pre><code class="language-js">console.log(1)</code></pre>',
      '<pre data-docsterm-run><code>ls</code></pre>',
    ].join('')
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal, { selector: 'pre > code.language-bash' })
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual(['run in the terminal: npm test'])
    buttons()[0]?.click()
    expect(calls.at(-1)).toBe('run:npm test')
  })

  it('keeps its own label out of the text when the selector matches the pre itself', () => {
    root.innerHTML = '<pre class="shell">$ ls\nREADME.md\n</pre>'
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal, { selector: 'pre.shell' })
    buttons()[0]?.click()
    expect(calls.at(-1)).toBe('run:ls')
  })

  it('injects one stylesheet for all attachments and removes it with the last cleanup', () => {
    root.innerHTML = '<pre data-docsterm-run><code>a</code></pre><section><pre data-docsterm-run><code>b</code></pre></section>'
    const section = root.querySelector('section') as HTMLElement
    const first = attachRunButtons(section, fakeTerminal().terminal)
    const second = attachRunButtons(root, fakeTerminal().terminal)
    expect(styles()).toHaveLength(1)
    expect(styles()[0]?.parentElement).toBe(document.head)
    first()
    expect(styles()).toHaveLength(1)
    second()
    expect(styles()).toHaveLength(0)
    const plain = attachRunButtons(root, fakeTerminal().terminal, { styles: false })
    expect([styles().length, buttons().length]).toEqual([0, 2])
    plain()
  })

  it('removes its buttons, listeners and host markers on cleanup and can attach again', () => {
    root.innerHTML = '<pre data-docsterm-run><code>orbit status</code></pre>'
    const pre = root.querySelector('pre') as HTMLElement
    const { terminal, calls } = fakeTerminal()
    const cleanup = attachRunButtons(root, terminal)
    const button = buttons()[0] as HTMLButtonElement
    expect(pre.hasAttribute('data-docsterm-run-host')).toBe(true)
    cleanup()
    cleanup()
    expect(buttons()).toEqual([])
    expect(pre.hasAttribute('data-docsterm-run-host')).toBe(false)
    expect(pre.outerHTML).toBe('<pre data-docsterm-run=""><code>orbit status</code></pre>')
    button.click()
    expect(calls).toEqual([])
    attachRunButtons(root, terminal)
    expect(buttons()).toHaveLength(1)
  })

  it('never puts a second button on a block that already has one', () => {
    root.innerHTML = '<pre data-docsterm-run><code>ls</code></pre>'
    const first = attachRunButtons(root, fakeTerminal().terminal)
    const second = attachRunButtons(root, fakeTerminal().terminal)
    expect(buttons()).toHaveLength(1)
    second()
    expect(buttons()).toHaveLength(1)
    first()
    expect(buttons()).toHaveLength(0)
  })

  it('reads lines from Docusaurus, Expressive Code and Shiki markup', () => {
    root.innerHTML = [
      '<pre data-docsterm-run class="prism-code"><code class="codeBlockLines">',
      '<span class="token-line"><span class="token plain">$ npm install</span><br></span>',
      '<span class="token-line"><span class="token plain">added 1 package</span><br></span>',
      '<span class="token-line"><span class="token plain">$ npm test</span><br></span>',
      '</code></pre>',
      '<pre data-docsterm-run><code>',
      '<div class="ec-line"><div class="code"><span>for i in 1 2; do</span></div></div>',
      '<div class="ec-line"><div class="code"><span>  echo $i</span></div></div>',
      '<div class="ec-line"><div class="code"></div></div>',
      '<div class="ec-line"><div class="code"><span>done</span></div></div>',
      '</code></pre>',
      '<pre data-docsterm-run><code><span class="line"><span>$ ls</span></span>\n<span class="line"><span>a.txt</span></span>\n<span class="line"><span>$ pwd</span></span></code></pre>',
    ].join('')
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal)
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'run in the terminal: npm install',
      'run in the terminal: for i in 1 2; do',
      'run in the terminal: ls',
    ])
    for (const button of buttons()) button.click()
    expect(calls.filter((call) => call.startsWith('run:'))).toEqual([
      'run:npm install\nnpm test',
      'run:for i in 1 2; do\n  echo $i\n\ndone',
      'run:ls\npwd',
    ])
  })

  it('keeps continuation lines of console commands and strips their > prompt', () => {
    root.innerHTML = [
      '<pre data-docsterm-run><code>$ docker run \\\n    -it alpine sh\n/ # </code></pre>',
      '<pre data-docsterm-run><code>$ for i in 1 2; do\n>   echo $i\n> done\n1\n2\n$ echo a \\\n> b\na b</code></pre>',
      '<pre data-docsterm-run><code>$ echo a\\\\\nnot a command\n> not a continuation</code></pre>',
    ].join('')
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal)
    for (const button of buttons()) button.click()
    expect(calls.filter((call) => call.startsWith('run:'))).toEqual([
      'run:docker run \\\n    -it alpine sh',
      'run:for i in 1 2; do\n  echo $i\ndone\necho a \\\nb',
      'run:echo a\\\\',
    ])
  })

  it('takes only the prompts given in the options', () => {
    root.innerHTML = '<pre class="matlab"><code>% compute the sum\nx = 1 + 2</code></pre>'
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal, { selector: 'pre.matlab code', prompts: ['$ '] })
    buttons()[0]?.click()
    expect(calls.at(-1)).toBe('run:% compute the sum\nx = 1 + 2')
  })

  it('skips blocks that hold no command', () => {
    root.innerHTML = [
      '<pre data-docsterm-run><code>\n  \n</code></pre>',
      '<pre data-docsterm-run><code>$ \nonly output</code></pre>',
      '<pre data-docsterm-run><code>ls</code></pre>',
    ].join('')
    attachRunButtons(root, fakeTerminal().terminal)
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual(['run in the terminal: ls'])
  })

  it('shares one bar and one host marker between the buttons of a block until the last one goes', () => {
    root.innerHTML = '<pre><code class="first">ls</code><code class="second">pwd</code></pre>'
    const pre = root.querySelector('pre') as HTMLElement
    const first = attachRunButtons(root, fakeTerminal().terminal, { selector: 'code.first' })
    const second = attachRunButtons(root, fakeTerminal().terminal, { selector: 'code.second' })
    const bars = () => Array.from(pre.querySelectorAll('.docsterm-run-bar'))
    expect([bars().length, bars()[0]?.querySelectorAll('button').length, pre.hasAttribute('data-docsterm-run-host')]).toEqual([
      1,
      2,
      true,
    ])
    first()
    expect([bars().length, buttons().length, pre.hasAttribute('data-docsterm-run-host')]).toEqual([1, 1, true])
    second()
    expect(pre.outerHTML).toBe('<pre><code class="first">ls</code><code class="second">pwd</code></pre>')
  })

  it('runs only the text the page shows', () => {
    root.innerHTML = [
      '<pre data-docsterm-run><code>$ ls',
      '<span style="display:none">; echo HIDDEN</span>',
      '<span hidden>; echo HIDDEN2</span>',
      '<span aria-hidden="true">; echo HIDDEN3</span>',
      '<span style="visibility:hidden">; echo HIDDEN4</span>',
      ' -la</code></pre>',
    ].join('')
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal)
    expect(buttons()[0]?.getAttribute('aria-label')).toBe('run in the terminal: ls -la')
    buttons()[0]?.click()
    expect(calls.at(-1)).toBe('run:ls -la')
  })

  it('asks checkVisibility about nodes inside a block that is itself shown', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'checkVisibility')
    Object.defineProperty(Element.prototype, 'checkVisibility', {
      configurable: true,
      value(this: Element) {
        return !this.classList.contains('clipped') && this.closest('.collapsed') === null
      },
    })
    try {
      root.innerHTML = [
        '<pre data-docsterm-run><code>$ pwd<span class="clipped">; echo CLIPPED</span></code></pre>',
        '<div class="collapsed"><pre data-docsterm-run><code>$ whoami<span class="clipped">; id</span></code></pre></div>',
      ].join('')
      const { terminal, calls } = fakeTerminal()
      attachRunButtons(root, terminal)
      for (const button of buttons()) button.click()
      expect(calls.filter((call) => call.startsWith('run:'))).toEqual(['run:pwd', 'run:whoami; id'])
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'checkVisibility', descriptor)
      else Reflect.deleteProperty(Element.prototype, 'checkVisibility')
    }
  })

  it('puts its stylesheet into the shadow root it decorates', () => {
    const shadowHost = document.createElement('div')
    root.append(shadowHost)
    const shadow = shadowHost.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<pre data-docsterm-run><code>ls</code></pre>'
    const first = attachRunButtons(shadow, fakeTerminal().terminal)
    const second = attachRunButtons(shadow, fakeTerminal().terminal, { selector: 'pre' })
    expect([shadow.querySelectorAll('style[data-docsterm-run-styles]').length, styles().length]).toEqual([1, 0])
    expect(shadow.querySelectorAll('button.docsterm-run')).toHaveLength(2)
    first()
    expect(shadow.querySelectorAll('style[data-docsterm-run-styles]')).toHaveLength(1)
    second()
    expect(shadow.querySelectorAll('style[data-docsterm-run-styles]')).toHaveLength(0)
  })

  it('does nothing when the block holds no command any more at click time', () => {
    root.innerHTML = '<pre data-docsterm-run><code>ls</code></pre>'
    const { terminal, calls } = fakeTerminal()
    attachRunButtons(root, terminal)
    const code = root.querySelector('code') as HTMLElement
    code.textContent = '  \n'
    const button = buttons()[0] as HTMLButtonElement
    button.click()
    expect([calls, button.disabled]).toEqual([[], false])
  })

  it('scrolls a terminal that is itself an element, like the web component', () => {
    root.innerHTML = '<pre data-docsterm-run><code>ls</code></pre>'
    const host = Object.assign(document.createElement('docs-terminal-test'), {
      run: vi.fn(async () => ({ exitCode: 0, output: '' })),
    })
    const scroll = vi.fn()
    host.scrollIntoView = scroll
    const focus = vi.spyOn(host, 'focus')
    attachRunButtons(root, host)
    buttons()[0]?.click()
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    expect(focus).toHaveBeenCalledTimes(1)
    expect(host.run).toHaveBeenCalledWith('ls')
  })
})
