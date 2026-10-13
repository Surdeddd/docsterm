import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLinkResolver, displayPath, githubRepository, renderPackageReadme, rewriteMarkdown } from './sync-readme.mjs'

const SCRIPT = fileURLToPath(new URL('./sync-readme.mjs', import.meta.url))
const PROBE = fileURLToPath(new URL('./pack-probe.mjs', import.meta.url))
const BANNER = '<!-- Generated from README.md at the repository root by scripts/sync-readme.mjs. Edit that file instead. -->'
const BLOB = 'https://github.com/Surdeddd/docsterm/blob/main'
const TREE = 'https://github.com/Surdeddd/docsterm/tree/main'
const RAW = 'https://raw.githubusercontent.com/Surdeddd/docsterm/main'
const WIDGET_BLOB = 'https://github.com/acme/widget/blob/main'
const WIDGET_TREE = 'https://github.com/acme/widget/tree/main'
const WIDGET_RAW = 'https://raw.githubusercontent.com/acme/widget/main'
const WIDGET_README = [
  '# widget',
  '',
  'Russian: [README.ru.md](./README.ru.md). Read [the guide](./docs/guide.md#start) or browse [the docs](./docs/).',
  '',
  '![shot](./docs/shot.png)',
  '',
  '<a href="./docs/guide.md"><img src="./docs/shot.png" alt="shot"></a>',
  '',
  '[guide]: ./docs/guide.md',
  '',
].join('\n')

const temp = mkdtempSync(join(tmpdir(), 'docsterm-sync-readme-'))
after(() => rmSync(temp, { recursive: true, force: true }))

const fixture = join(temp, 'fixture')
mkdirSync(join(fixture, 'docs'), { recursive: true })
for (const file of ['README.ru.md', 'docs/embedding.md', 'docs/shot.png', 'docs/dark.png', 'docs/light.png']) {
  writeFileSync(join(fixture, file), 'x')
}

const resolveLink = createLinkResolver({ repository: 'Surdeddd/docsterm', root: fixture })
const rewrite = (markdown) => rewriteMarkdown(markdown, resolveLink)

const checkout = (name, readme = WIDGET_README) => {
  const root = join(temp, name)
  for (const dir of ['packages/docsterm', 'docs', 'scripts']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['README.ru.md', 'docs/guide.md', 'docs/shot.png']) writeFileSync(join(root, file), 'x')
  writeFileSync(
    join(root, 'packages/docsterm/package.json'),
    JSON.stringify({ repository: { url: 'git+https://github.com/acme/widget.git' } }),
  )
  writeFileSync(join(root, 'README.md'), readme)
  const script = join(root, 'scripts/sync-readme.mjs')
  copyFileSync(SCRIPT, script)
  return { root, script }
}

const cli = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })

test('reads owner/name from the package repository url', () => {
  assert.equal(githubRepository({ repository: { url: 'git+https://github.com/Surdeddd/docsterm.git' } }), 'Surdeddd/docsterm')
  assert.equal(githubRepository({ repository: 'https://github.com/Surdeddd/docsterm' }), 'Surdeddd/docsterm')
  assert.throws(() => githubRepository({ repository: { url: 'https://gitlab.com/a/b.git' } }), /not a GitHub URL/)
})

test('relative links become blob links, anchors and queries kept', () => {
  assert.equal(rewrite('Russian: [README.ru.md](./README.ru.md)'), `Russian: [README.ru.md](${BLOB}/README.ru.md)`)
  assert.equal(rewrite('[CSP](docs/embedding.md#csp)'), `[CSP](${BLOB}/docs/embedding.md#csp)`)
  assert.equal(rewrite('[root-relative](/docs/embedding.md?plain=1)'), `[root-relative](${BLOB}/docs/embedding.md?plain=1)`)
})

test('directory links become tree links', () => {
  assert.equal(rewrite('[docs](./docs/)'), `[docs](${TREE}/docs/)`)
  assert.equal(rewrite('[docs](docs)'), `[docs](${TREE}/docs)`)
})

test('images point at raw.githubusercontent.com, also inside a link', () => {
  assert.equal(rewrite('![shot](./docs/shot.png)'), `![shot](${RAW}/docs/shot.png)`)
  assert.equal(
    rewrite('[![shot](./docs/shot.png)](./docs/embedding.md)'),
    `[![shot](${RAW}/docs/shot.png)](${BLOB}/docs/embedding.md)`,
  )
})

test('angle-bracket destinations and titles survive', () => {
  assert.equal(rewrite('[ru](<./README.ru.md> "Russian")'), `[ru](<${BLOB}/README.ru.md> "Russian")`)
  assert.equal(rewrite('[ru]( ./README.ru.md "Russian")'), `[ru]( ${BLOB}/README.ru.md "Russian")`)
})

test('absolute urls, anchors, mailto and protocol-relative links stay as they are', () => {
  const text = '[demo](https://docsterm.vercel.app) [top](#docsterm) [mail](mailto:a@b.c) [cdn](//cdn.example/x.js)'
  assert.equal(rewrite(text), text)
})

test('fenced code blocks and inline code are left alone', () => {
  const fenced = ['```md', '[x](./README.ru.md)', '```', '~~~', '![y](./docs/shot.png)', '~~~'].join('\n')
  assert.equal(rewrite(fenced), fenced)
  assert.equal(
    rewrite('`[x](./README.ru.md)` and [ru](./README.ru.md) and ``a ` [z](./missing.md) ``'),
    `\`[x](./README.ru.md)\` and [ru](${BLOB}/README.ru.md) and \`\`a \` [z](./missing.md) \`\``,
  )
  assert.equal(
    rewrite('````\n```\n[x](./missing.md)\n````\n[ru](./README.ru.md)'),
    `\`\`\`\`\n\`\`\`\n[x](./missing.md)\n\`\`\`\`\n[ru](${BLOB}/README.ru.md)`,
  )
})

test('indented code blocks are left alone, indented list paragraphs are not', () => {
  const block = ['Example:', '', '    [x](./missing.md)', '    ![y](./missing.png)', '', '[ru](./README.ru.md)'].join('\n')
  assert.equal(rewrite(block), block.replace('[ru](./README.ru.md)', `[ru](${BLOB}/README.ru.md)`))
  assert.equal(rewrite('\t[x](./missing.md)'), '\t[x](./missing.md)')
  assert.equal(rewrite('# Title\n    [x](./missing.md)'), '# Title\n    [x](./missing.md)')
  assert.equal(rewrite('para\n    [ru](./README.ru.md)'), `para\n    [ru](${BLOB}/README.ru.md)`)
  assert.equal(rewrite('- item\n\n    [ru](./README.ru.md)'), `- item\n\n    [ru](${BLOB}/README.ru.md)`)
  assert.equal(rewrite('1. item\n\n       [x](./missing.md)'), '1. item\n\n       [x](./missing.md)')
  assert.equal(
    rewrite('- item\n\nback\n\n    [x](./missing.md)'),
    '- item\n\nback\n\n    [x](./missing.md)',
  )
})

test('inline code that spans lines is left alone', () => {
  assert.equal(
    rewrite('Use `[x](./missing.md)\nmore` and [ru](./README.ru.md)'),
    `Use \`[x](./missing.md)\nmore\` and [ru](${BLOB}/README.ru.md)`,
  )
  assert.equal(
    rewrite('Use `a\n[x](./missing.md)` here'),
    'Use `a\n[x](./missing.md)` here',
  )
  assert.equal(
    rewrite('- open `tick\n- [ru](./README.ru.md) close`'),
    `- open \`tick\n- [ru](${BLOB}/README.ru.md) close\``,
  )
})

test('reference definitions are rewritten, images by extension', () => {
  assert.equal(rewrite('[ru]: ./README.ru.md "Russian"'), `[ru]: ${BLOB}/README.ru.md "Russian"`)
  assert.equal(rewrite('  [shot]: <docs/shot.png>'), `  [shot]: <${RAW}/docs/shot.png>`)
})

test('footnote definitions are prose, not links', () => {
  assert.equal(rewrite('[^1]: Works in Chromium only.'), '[^1]: Works in Chromium only.')
  assert.equal(rewrite('[^csp]: See [CSP](docs/embedding.md#csp).'), `[^csp]: See [CSP](${BLOB}/docs/embedding.md#csp).`)
})

test('html href, src and srcset are rewritten', () => {
  assert.equal(
    rewrite('<a href="docs/embedding.md"><img src=\'./docs/shot.png\' alt="x"></a>'),
    `<a href="${BLOB}/docs/embedding.md"><img src='${RAW}/docs/shot.png' alt="x"></a>`,
  )
  assert.equal(
    rewrite('<source media="(prefers-color-scheme: dark)" srcset="./docs/dark.png 2x, ./docs/light.png">'),
    `<source media="(prefers-color-scheme: dark)" srcset="${RAW}/docs/dark.png 2x, ${RAW}/docs/light.png">`,
  )
})

test('a link to a missing file or outside the repository fails loudly', () => {
  assert.throws(() => rewrite('[x](./missing.md)'), { message: 'link points at a missing file: ./missing.md' })
  assert.throws(() => rewrite('[x](../outside.md)'), { message: 'link leaves the repository: ../outside.md' })
})

test('rewriting is idempotent', () => {
  const text = '[ru](./README.ru.md) ![shot](./docs/shot.png)\n<img src="docs/shot.png">\n[ref]: docs/embedding.md\n'
  assert.equal(rewrite(rewrite(text)), rewrite(text))
})

test('renders the banner and the rewritten root README of a checkout', () => {
  const { root } = checkout('checkout', '# widget\n\nSee [the guide](docs/guide.md) and `[x](./nowhere.md)`.\n')
  assert.equal(
    renderPackageReadme({ root }),
    `${BANNER}\n\n# widget\n\nSee [the guide](${WIDGET_BLOB}/docs/guide.md) and \`[x](./nowhere.md)\`.\n`,
  )
})

test('the generated package README differs from the root README only by the banner and absolute links', () => {
  const { root } = checkout('roundtrip')
  const lines = renderPackageReadme({ root }).split('\n')
  assert.deepEqual(lines.slice(0, 2), [BANNER, ''])
  const body = lines.slice(2).join('\n')
  assert.deepEqual(
    [WIDGET_BLOB, WIDGET_TREE, WIDGET_RAW].map((prefix) => body.split(`${prefix}/`).length - 1),
    [4, 1, 2],
  )
  assert.equal(
    body.replaceAll(`${WIDGET_BLOB}/`, './').replaceAll(`${WIDGET_TREE}/`, './').replaceAll(`${WIDGET_RAW}/`, './'),
    WIDGET_README,
  )
  assert.doesNotMatch(body, /\]\(\.\.?\//)
})

test('displayPath keeps paths below the working directory relative and shows every other path absolute', () => {
  assert.equal(displayPath('/repo/packages/docsterm/README.md', '/repo'), 'packages/docsterm/README.md')
  assert.equal(displayPath('/repo/..notes/README.md', '/repo'), '..notes/README.md')
  assert.equal(displayPath('/repo/README.md', '/repo/packages/docsterm'), '/repo/README.md')
  assert.equal(displayPath('/tmp/out/README.md', '/repo'), '/tmp/out/README.md')
})

test('cli writes --out, is idempotent, and --check reports drift', () => {
  const { root, script } = checkout('cli')
  const out = join(temp, 'README.md')
  execFileSync(process.execPath, [script, '--out', out], { cwd: root })
  const first = readFileSync(out, 'utf8')
  assert.equal(first, renderPackageReadme({ root }))
  execFileSync(process.execPath, [script, '--out', out], { cwd: root })
  assert.equal(readFileSync(out, 'utf8'), first)
  assert.equal(cli(script, ['--check', '--out', out], root).status, 0)
  writeFileSync(out, `${first}\nstale\n`)
  const stale = cli(script, ['--check', '--out', out], root)
  assert.deepEqual(
    [stale.status, stale.stdout, stale.stderr],
    [1, '', `${out} is out of date: run node scripts/sync-readme.mjs\n`],
  )
  assert.equal(readFileSync(out, 'utf8'), `${first}\nstale\n`)
  const unknown = cli(script, ['--bogus'], root)
  assert.deepEqual([unknown.status, unknown.stderr], [1, 'sync-readme: unknown argument: --bogus\n'])
  const bare = cli(script, ['--out'], root)
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [1, '', 'sync-readme: --out needs a path: --out <file>\n'])
})

test('cli names --out relative to the working directory below it and absolute anywhere else', () => {
  const { root, script } = checkout('names')
  const outside = join(temp, 'outside', 'README.md')
  mkdirSync(dirname(outside))
  const wrote = cli(script, ['--out', outside], root)
  assert.deepEqual([wrote.status, wrote.stdout, wrote.stderr], [0, `wrote ${outside}\n`, ''])
  const unchanged = cli(script, ['--out', outside], root)
  assert.deepEqual([unchanged.status, unchanged.stdout, unchanged.stderr], [0, `${outside} is up to date\n`, ''])
  const here = join(temp, 'here')
  mkdirSync(here)
  const local = cli(script, ['--out', 'README.md'], here)
  assert.deepEqual([local.status, local.stdout, local.stderr], [0, 'wrote README.md\n', ''])
  assert.equal(readFileSync(join(here, 'README.md'), 'utf8'), renderPackageReadme({ root }))
})

test('importing either script never runs its cli, whatever argv holds', () => {
  for (const script of [SCRIPT, PROBE]) {
    const code = `await import(${JSON.stringify(pathToFileURL(script).href)}); console.log('imported')`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code, 'not-a-file', 'extra'], {
      cwd: temp,
      encoding: 'utf8',
    })
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, 'imported\n', ''], script)
  }
})
