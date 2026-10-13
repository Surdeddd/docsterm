import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(ROOT, 'packages/docsterm')
const REF = 'main'
const BANNER = '<!-- Generated from README.md at the repository root by scripts/sync-readme.mjs. Edit that file instead. -->'

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const IMAGE = /\.(?:apng|avif|gif|jpe?g|png|svg|webp)$/i
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^ *(?:[-+*]|\d{1,9}[.)])(?: {1,4}(?=\S)|$)/
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g
const INLINE = /\]\(([ \t]*)(<[^>\n]*>|[^)\s]+)/g
const REFERENCE = /^( {0,3}\[(?!\^)[^\]]+\]:[ \t]*)(<[^>\n]*>|\S+)/
const TAG = /<(?:a|img|source)\b[^>]*>/gi
const ATTRIBUTE = /\b(href|src|srcset)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/gi

export function githubRepository(manifest) {
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? '')
  if (!match) throw new Error(`package.json repository is not a GitHub URL: ${url}`)
  return match[1]
}

export function createLinkResolver({ repository, root = ROOT, ref = REF }) {
  return (target, kind) => {
    if (target === '' || target.startsWith('#') || target.startsWith('//') || SCHEME.test(target)) return target
    const cut = target.search(/[?#]/)
    const path = cut === -1 ? target : target.slice(0, cut)
    const suffix = cut === -1 ? '' : target.slice(cut)
    const normalized = posix.normalize(path.replace(/^\/+/, ''))
    if (normalized === '..' || normalized.startsWith('../')) throw new Error(`link leaves the repository: ${target}`)
    const file = join(root, decodeURIComponent(normalized))
    if (!existsSync(file)) throw new Error(`link points at a missing file: ${target}`)
    const location = normalized === '.' || normalized === './' ? '' : `/${normalized}`
    if (kind === 'image') return `https://raw.githubusercontent.com/${repository}/${ref}${location}${suffix}`
    const view = statSync(file).isDirectory() ? 'tree' : 'blob'
    return `https://github.com/${repository}/${view}/${ref}${location}${suffix}`
  }
}

function openingBracket(text, close) {
  let depth = 0
  for (let index = close; index >= 0; index -= 1) {
    if (text[index - 1] === '\\') continue
    if (text[index] === ']') depth += 1
    if (text[index] === '[' && --depth === 0) return index
  }
  return -1
}

function replaceDestination(destination, kind, resolveLink) {
  if (destination.startsWith('<') && destination.endsWith('>')) {
    return `<${resolveLink(destination.slice(1, -1), kind)}>`
  }
  return resolveLink(destination, kind)
}

function rewriteInline(text, resolveLink) {
  return text.replace(INLINE, (_match, space, destination, offset) => {
    const open = openingBracket(text, offset)
    const kind = open > 0 && text[open - 1] === '!' ? 'image' : 'link'
    return `](${space}${replaceDestination(destination, kind, resolveLink)}`
  })
}

function rewriteAttribute(name, value, resolveLink) {
  if (name.toLowerCase() === 'href') return resolveLink(value, 'link')
  if (name.toLowerCase() === 'src') return resolveLink(value, 'image')
  return value.replace(/(^|,)(\s*)([^\s,]+)/g, (_match, comma, space, url) => `${comma}${space}${resolveLink(url, 'image')}`)
}

function rewriteTags(text, resolveLink) {
  return text.replace(TAG, (tag) =>
    tag.replace(ATTRIBUTE, (_match, name, equals, quoted) => {
      const quote = quoted[0] === '"' || quoted[0] === "'" ? quoted[0] : ''
      const value = quote ? quoted.slice(1, -1) : quoted
      return `${name}${equals}${quote}${rewriteAttribute(name, value, resolveLink)}${quote}`
    }),
  )
}

function rewriteOutsideCode(line, code, resolveLink) {
  const rewrite = (text) => rewriteTags(rewriteInline(text, resolveLink), resolveLink)
  let output = ''
  let last = 0
  for (const [from, to] of code) {
    output += rewrite(line.slice(last, from)) + line.slice(from, to)
    last = to
  }
  return output + rewrite(line.slice(last))
}

function rewriteLine(line, code, resolveLink) {
  const reference = REFERENCE.exec(line)
  if (!reference || (code.length > 0 && code[0][0] < reference[0].length)) {
    return rewriteOutsideCode(line, code, resolveLink)
  }
  const [whole, lead, destination] = reference
  const bare = destination.replace(/^<|>$/g, '')
  const kind = IMAGE.test(bare.replace(/[?#].*$/, '')) ? 'image' : 'link'
  return `${lead}${replaceDestination(destination, kind, resolveLink)}${line.slice(whole.length)}`
}

function rewriteBlock(lines, resolveLink) {
  const text = lines.join('\n')
  const spans = Array.from(text.matchAll(CODE_SPAN), (span) => [span.index, span.index + span[0].length])
  let start = 0
  return lines.map((line) => {
    const end = start + line.length
    const code = spans
      .filter(([from, to]) => from < end && to > start)
      .map(([from, to]) => [Math.max(from - start, 0), Math.min(to - start, line.length)])
    start = end + 1
    return rewriteLine(line, code, resolveLink)
  })
}

function indentation(line) {
  let width = 0
  for (const char of line) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4 - (width % 4)
    else break
  }
  return width
}

export function rewriteMarkdown(markdown, resolveLink) {
  const output = []
  let block = []
  let fence = null
  let container = 0
  const flush = () => {
    output.push(...rewriteBlock(block, resolveLink))
    block = []
  }
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
      output.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      output.push(line)
      continue
    }
    const indent = indentation(line)
    const item = LIST_ITEM.exec(line)
    if (block.length === 0 && indent >= container + 4) {
      output.push(line)
      continue
    }
    if (marker) {
      flush()
      fence = marker
      output.push(line)
      continue
    }
    if (item) {
      flush()
      container = item[0].length
    } else if (block.length === 0 && indent < container) {
      container = indent
    }
    block.push(line)
    if (HEADING.test(line)) flush()
  }
  flush()
  return output.join('\n')
}

export function displayPath(path, cwd = process.cwd()) {
  const shown = relative(cwd, path)
  const outside = shown === '' || shown === '..' || shown.startsWith(`..${sep}`) || isAbsolute(shown)
  return outside ? path : shown
}

export function renderPackageReadme({ root = ROOT } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/docsterm/package.json'), 'utf8'))
  const resolveLink = createLinkResolver({ repository: githubRepository(manifest), root })
  return `${BANNER}\n\n${rewriteMarkdown(readFileSync(join(root, 'README.md'), 'utf8'), resolveLink)}`
}

function parseArguments(argv) {
  const options = { out: join(PACKAGE_DIR, 'README.md'), check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') options.check = true
    else if (argument !== '--out') throw new Error(`unknown argument: ${argument}`)
    else if (argv[index + 1]) options.out = resolve(argv[++index])
    else throw new Error('--out needs a path: --out <file>')
  }
  return options
}

function main(argv) {
  const { out, check } = parseArguments(argv)
  const readme = renderPackageReadme()
  const current = existsSync(out) ? readFileSync(out, 'utf8') : null
  const name = displayPath(out)
  if (check) {
    if (current === readme) return 0
    console.error(`${name} is out of date: run node scripts/sync-readme.mjs`)
    return 1
  }
  if (current !== readme) writeFileSync(out, readme)
  console.log(current === readme ? `${name} is up to date` : `wrote ${name}`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`sync-readme: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
