import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { entryPoints, footprint, prepackProblems, typeCheckSource } from './pack-probe.mjs'

const PROBE = fileURLToPath(new URL('./pack-probe.mjs', import.meta.url))
const SYNC = fileURLToPath(new URL('./sync-readme.mjs', import.meta.url))
const ROOT = join(dirname(PROBE), '..')
const PACKAGE_DIR = join(ROOT, 'packages/docsterm')
const NPM_START_MS = 20_000

const temp = mkdtempSync(join(tmpdir(), 'docsterm-pack-probe-'))
after(() => rmSync(temp, { recursive: true, force: true }))

test('pack-probe: --dist without a path is a usage error, not an unknown argument', () => {
  const bare = spawnSync(process.execPath, [PROBE, '--dist'], { cwd: ROOT, encoding: 'utf8' })
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [1, '', 'pack-probe: --dist needs a path: --dist <dir>\n'])
  const unknown = spawnSync(process.execPath, [PROBE, '--bogus'], { cwd: ROOT, encoding: 'utf8' })
  assert.deepEqual([unknown.status, unknown.stdout, unknown.stderr], [1, '', 'pack-probe: unknown argument: --bogus\n'])
})

test('pack-probe: every subpath gets its own valid identifier in check.ts', () => {
  const entries = entryPoints({
    name: 'docsterm',
    exports: {
      '.': {},
      './shell': {},
      './react': {},
      './web-component': {},
      './web_component': {},
      './package.json': './package.json',
    },
  })
  assert.deepEqual(entries, [
    { name: 'root', specifier: 'docsterm', id: 'entry_root' },
    { name: 'shell', specifier: 'docsterm/shell', id: 'entry_shell' },
    { name: 'react', specifier: 'docsterm/react', id: 'entry_react' },
    { name: 'web-component', specifier: 'docsterm/web-component', id: 'entry_web_component' },
    { name: 'web_component', specifier: 'docsterm/web_component', id: 'entry_web_component_2' },
  ])
  assert.equal(
    typeCheckSource(entries),
    [
      "import * as entry_root from 'docsterm'",
      "import * as entry_shell from 'docsterm/shell'",
      "import * as entry_react from 'docsterm/react'",
      "import * as entry_web_component from 'docsterm/web-component'",
      "import * as entry_web_component_2 from 'docsterm/web_component'",
      "import * as React from 'react'",
      '',
      'type IsAny<T> = 0 extends 1 & T ? true : false',
      'type AnyExports<M> = { [K in keyof M]: IsAny<M[K]> extends true ? K : never }[keyof M]',
      'export const noAnyExports: [AnyExports<typeof entry_root> | AnyExports<typeof entry_shell> | AnyExports<typeof entry_react> | AnyExports<typeof entry_web_component> | AnyExports<typeof entry_web_component_2>] extends [never] ? true : false = true',
      'export const terminal = new entry_root.DocsTerminal({ backend: entry_shell.createShellBackend() })',
      'export const element: React.ReactElement = React.createElement(entry_react.DocsTerminal, { backend: entry_shell.createShellBackend() })',
      'export const componentIsTyped: IsAny<typeof entry_react.DocsTerminal> = false',
      'export const handleIsTyped: IsAny<entry_react.DocsTerminalHandle> = false',
      '',
    ].join('\n'),
  )
})

test('pack-probe: the prepack script and every script it runs point at existing files', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.deepEqual(prepackProblems(manifest, PACKAGE_DIR), [])
  assert.deepEqual(
    prepackProblems(
      {
        scripts: {
          prepack: 'pnpm run build && node ../../scripts/missing.mjs',
          build: 'pnpm run clean && tsc -p tsconfig.missing.json',
        },
      },
      PACKAGE_DIR,
    ),
    [
      'prepack: ../../scripts/missing.mjs does not exist',
      'build: no script named clean',
      'build: tsconfig.missing.json does not exist',
    ],
  )
  assert.deepEqual(prepackProblems({ scripts: {} }, PACKAGE_DIR), ['no prepack script'])
})

test('pack-probe: a docsterm-only install may hold @xterm/* and acorn and nothing else', () => {
  assert.deepEqual(
    footprint({
      packages: {
        '': {},
        'node_modules/docsterm': {},
        'node_modules/@xterm/xterm': {},
        'node_modules/@xterm/addon-fit': {},
        'node_modules/acorn': {},
      },
    }),
    { installed: ['@xterm/addon-fit', '@xterm/xterm', 'acorn', 'docsterm'], unexpected: [] },
  )
  assert.deepEqual(
    footprint({
      packages: {
        '': {},
        'node_modules/docsterm': {},
        'node_modules/acorn-walk': {},
        'node_modules/@xterm-tools/x': {},
        'node_modules/react': {},
        'node_modules/docsterm/node_modules/scheduler': {},
      },
    }),
    {
      installed: ['@xterm-tools/x', 'acorn-walk', 'docsterm', 'react', 'scheduler'],
      unexpected: ['@xterm-tools/x', 'acorn-walk', 'react', 'scheduler'],
    },
  )
})

const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const checkout = (work) => {
  const root = join(work, 'checkout')
  for (const dir of ['packages/docsterm', 'docs', 'scripts']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'docs/guide.md'), 'x')
  writeFileSync(join(root, 'README.md'), '# widget\n\nSee [the guide](./docs/guide.md).\n')
  writeFileSync(
    join(root, 'packages/docsterm/package.json'),
    JSON.stringify({
      name: 'docsterm',
      repository: { url: 'git+https://github.com/acme/widget.git' },
      exports: { '.': './dist/index.js' },
    }),
  )
  for (const script of [PROBE, SYNC]) copyFileSync(script, join(root, 'scripts', basename(script)))
  return { root, probe: join(root, 'scripts', basename(PROBE)) }
}

async function readPid(marker, closed, output) {
  let exited = null
  void closed.then(([code, signal]) => {
    exited = `exited with code ${code} and signal ${signal}`
  })
  const deadline = Date.now() + NPM_START_MS
  while (exited === null && Date.now() < deadline) {
    const pid = existsSync(marker) ? Number.parseInt(readFileSync(marker, 'utf8'), 10) : Number.NaN
    if (Number.isInteger(pid)) return pid
    await sleep(20)
  }
  throw new Error(`pack-probe ${exited ?? `did not start npm within ${NPM_START_MS} ms`}\n${output()}`)
}

async function interruptProbe(signal) {
  const work = mkdtempSync(join(temp, 'probe-'))
  const bin = join(work, 'bin')
  const scratch = join(work, 'tmp')
  const dist = join(work, 'dist')
  const marker = join(work, 'npm.pid')
  for (const dir of [bin, scratch, dist]) mkdirSync(dir)
  writeFileSync(join(dist, 'index.js'), 'export {}\n')
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho $$ > "${marker}"\nexec sleep 60\n`)
  chmodSync(join(bin, 'npm'), 0o755)
  const { root, probe } = checkout(work)
  const child = spawn(process.execPath, [probe, '--dist', dist], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: scratch },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  const closed = once(child, 'close')
  let pid = Number.NaN
  try {
    pid = await readPid(marker, closed, () => `stdout:\n${stdout}\nstderr:\n${stderr}`)
    child.kill(signal)
    const [code] = await Promise.race([closed, sleep(10_000, ['still running'], { ref: false })])
    return { code, stdout, stderr, leftovers: readdirSync(scratch), npmAlive: isAlive(pid) }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (Number.isInteger(pid) && isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`pack-probe: ${signal} stops the running npm, removes the temp dir and exits ${code}`, async () => {
    assert.deepEqual(await interruptProbe(signal), {
      code,
      stdout: '',
      stderr: `probe: staging the package (prepack README sync included)\nprobe: packing\npack-probe: interrupted by ${signal}\n`,
      leftovers: [],
      npmAlive: false,
    })
  })
}
