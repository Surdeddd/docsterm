import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { displayPath, renderPackageReadme } from './sync-readme.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(ROOT, 'packages/docsterm')
const PEERS = ['react', 'react-dom', '@anthropic-ai/sdk']
const TOOLS = ['typescript@~5.9.0', '@types/react', '@types/react-dom']
const NEEDS_PEERS = new Set(['react'])
const RESOLUTIONS = {
  nodenext: { module: 'nodenext', moduleResolution: 'nodenext' },
  bundler: { module: 'esnext', moduleResolution: 'bundler' },
  node10: { module: 'commonjs', moduleResolution: 'node10' },
}
const INSTALL_FLAGS = ['--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline', '--loglevel=error']
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const MODULE_FILE = /\.(?:d\.ts\.map|d\.ts|js\.map|js)$/
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const ALLOWED_DEPENDENCY = /^(?:docsterm|acorn|@xterm\/[^/]+)$/
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn'])
const SHELL_OPERATOR = /&&|\|\||[;|]/
const RUN_TIMEOUT_MS = 600_000
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }

const results = []
let stopSignal = null
let running = null

class Interrupted extends Error {}

const record = (check, consumer, ok, detail = '') => {
  results.push({ check, consumer, ok, detail })
}

const progress = (text) => {
  process.stderr.write(`probe: ${text}\n`)
}

function interrupt(signal) {
  stopSignal ??= signal
  running?.kill('SIGTERM')
}

function run(command, args, cwd) {
  if (stopSignal) return Promise.reject(new Interrupted())
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    running = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      stderr = `${error.message}\n${stderr}`
    })
    const timer = setTimeout(() => {
      stderr = `timed out after ${RUN_TIMEOUT_MS / 1000} s\n${stderr}`
      child.kill('SIGTERM')
    }, RUN_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      running = null
      if (stopSignal) fail(new Interrupted())
      else settle({ ok: code === 0, stdout, stderr })
    })
  })
}

function firstError(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines.find((line) => /error/i.test(line)) ?? lines[0] ?? 'failed').slice(0, 200)
}

function parseArguments(argv) {
  let dist = join(PACKAGE_DIR, 'dist')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--dist') throw new Error(`unknown argument: ${argv[index]}`)
    if (!argv[index + 1]) throw new Error('--dist needs a path: --dist <dir>')
    dist = resolve(argv[++index])
  }
  if (!existsSync(join(dist, 'index.js'))) throw new Error(`no build in ${dist}: run pnpm build or pass --dist <path>`)
  return { dist }
}

function identifier(name, taken) {
  const base = `entry_${name.replace(/[^A-Za-z0-9_$]/g, '_')}`
  let id = base
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}_${suffix}`
  taken.add(id)
  return id
}

export function entryPoints(manifest) {
  const taken = new Set()
  return Object.keys(manifest.exports)
    .filter((key) => key !== './package.json')
    .map((key) => {
      const name = key === '.' ? 'root' : key.slice(2)
      return { name, specifier: key === '.' ? manifest.name : `${manifest.name}/${name}`, id: identifier(name, taken) }
    })
}

const isPathWord = (word) =>
  !/['"`$=]/.test(word) && (/^\.\.?\//.test(word) || /\.(?:[cm]?[jt]s|json)$/.test(word))

function scriptReferences(command) {
  const words = command.trim().split(/\s+/)
  const at = PACKAGE_MANAGERS.has(words[0]) ? words.findIndex((word) => word === 'run' || word === 'run-script') : -1
  const script = at === -1 ? undefined : words.slice(at + 1).find((word) => !word.startsWith('-'))
  return { script, paths: words.filter(isPathWord) }
}

export function prepackProblems(manifest, packageDir) {
  const scripts = manifest.scripts ?? {}
  if (!scripts.prepack) return ['no prepack script']
  const problems = []
  const queue = ['prepack']
  const seen = new Set(queue)
  while (queue.length > 0) {
    const name = queue.shift()
    for (const command of scripts[name].split(SHELL_OPERATOR)) {
      const { script, paths } = scriptReferences(command)
      for (const path of paths) {
        if (!existsSync(resolve(packageDir, path))) problems.push(`${name}: ${path} does not exist`)
      }
      if (script === undefined || seen.has(script)) continue
      seen.add(script)
      if (scripts[script]) queue.push(script)
      else problems.push(`${name}: no script named ${script}`)
    }
  }
  return problems
}

export function footprint(lock) {
  const installed = Object.keys(lock.packages ?? {})
    .filter((path) => path.includes('node_modules/'))
    .map((path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length))
  const unique = [...new Set(installed)].sort()
  return { installed: unique, unexpected: unique.filter((name) => !ALLOWED_DEPENDENCY.test(name)) }
}

function stage(temp, dist) {
  const staged = join(temp, 'package')
  cpSync(PACKAGE_DIR, staged, {
    recursive: true,
    filter: (source) => {
      const top = relative(PACKAGE_DIR, source).split(sep)[0]
      return top !== 'node_modules' && top !== 'dist' && !source.endsWith('.tgz')
    },
  })
  cpSync(dist, join(staged, 'dist'), { recursive: true })
  writeFileSync(join(staged, 'README.md'), renderPackageReadme())
  return staged
}

async function pack(staged, temp) {
  const result = await run('npm', ['pack', staged, '--ignore-scripts', '--json', '--pack-destination', temp], temp)
  if (!result.ok) throw new Error(`npm pack failed: ${firstError(result.stderr)}`)
  const parsed = JSON.parse(result.stdout)
  const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  return { tarball: join(temp, info.filename), files: info.files.map((file) => file.path) }
}

const isFile = (path) => existsSync(path) && statSync(path).isFile()

function checkTarball(files, staged) {
  const tests = files.filter((file) => TEST_FILE.test(file))
  record('tarball has no test files', '-', tests.length === 0, tests.length ? tests.join(', ') : `${files.length} files`)
  const orphans = files.filter((file) => {
    if (!file.startsWith('dist/')) return false
    const base = file.slice('dist/'.length).replace(MODULE_FILE, '')
    return !SOURCE_EXTENSIONS.some((extension) => isFile(join(staged, 'src', `${base}${extension}`)))
  })
  record('every dist module has a src counterpart', '-', orphans.length === 0, orphans.join(', '))
}

function checkPrepack(manifest) {
  const problems = prepackProblems(manifest, PACKAGE_DIR)
  record('prepack script paths exist', '-', problems.length === 0, problems.join('; '))
}

async function install(temp, consumer, packages, label) {
  const dir = join(temp, `consumer-${consumer}`)
  mkdirSync(dir)
  const manifest = { name: `docsterm-probe-${consumer.toLowerCase()}`, private: true, type: 'module' }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  progress(`installing consumer ${consumer} (${label})`)
  const result = await run('npm', ['install', ...packages, ...INSTALL_FLAGS], dir)
  record('npm install', consumer, result.ok, result.ok ? label : firstError(result.stderr))
  return result.ok ? dir : null
}

function checkFootprint(dir, consumer) {
  const lockfile = join(dir, 'package-lock.json')
  const lock = isFile(lockfile) ? JSON.parse(readFileSync(lockfile, 'utf8')) : { packages: {} }
  const { installed, unexpected } = footprint(lock)
  const ok = installed.includes('docsterm') && unexpected.length === 0
  const detail = unexpected.length > 0 ? `unexpected: ${unexpected.join(', ')}` : installed.join(', ')
  record('docsterm alone installs only @xterm/* and acorn', consumer, ok, detail || 'no package-lock.json')
}

async function checkImports(dir, consumer, entries) {
  for (const { specifier } of entries) {
    const code = `const entry = await import(${JSON.stringify(specifier)})\nif (Object.keys(entry).length === 0) throw new Error('no exports')`
    const result = await run(process.execPath, ['--input-type=module', '--eval', code], dir)
    record(`node import ${specifier}`, consumer, result.ok, result.ok ? '' : firstError(result.stderr))
  }
}

function checkUseClient(dir, consumer) {
  const file = join(dir, 'node_modules/docsterm/dist/react/index.js')
  const head = isFile(file) ? readFileSync(file, 'utf8').trimStart().split('\n')[0] : ''
  record("docsterm/react starts with 'use client'", consumer, /^(['"])use client\1;?$/.test(head), head.slice(0, 60))
}

export function typeCheckSource(entries) {
  const ids = new Map(entries.map((entry) => [entry.name, entry.id]))
  const root = ids.get('root')
  const shell = ids.get('shell')
  const react = ids.get('react')
  const lines = entries.map(({ id, specifier }) => `import * as ${id} from '${specifier}'`)
  if (react && shell) lines.push("import * as React from 'react'")
  lines.push(
    '',
    'type IsAny<T> = 0 extends 1 & T ? true : false',
    'type AnyExports<M> = { [K in keyof M]: IsAny<M[K]> extends true ? K : never }[keyof M]',
    `export const noAnyExports: [${entries.map(({ id }) => `AnyExports<typeof ${id}>`).join(' | ')}] extends [never] ? true : false = true`,
  )
  if (root && shell) {
    lines.push(`export const terminal = new ${root}.DocsTerminal({ backend: ${shell}.createShellBackend() })`)
  }
  if (react && shell) {
    lines.push(
      `export const element: React.ReactElement = React.createElement(${react}.DocsTerminal, { backend: ${shell}.createShellBackend() })`,
      `export const componentIsTyped: IsAny<typeof ${react}.DocsTerminal> = false`,
      `export const handleIsTyped: IsAny<${react}.DocsTerminalHandle> = false`,
    )
  }
  return `${lines.join('\n')}\n`
}

async function checkTypes(dir, consumer, entries) {
  writeFileSync(join(dir, 'check.ts'), typeCheckSource(entries))
  const tsc = join(dir, 'node_modules/typescript/bin/tsc')
  const version = (await run(process.execPath, [tsc, '--version'], dir)).stdout.trim()
  for (const [mode, resolution] of Object.entries(RESOLUTIONS)) {
    const config = {
      compilerOptions: {
        ...resolution,
        target: 'es2022',
        lib: ['es2022', 'dom', 'dom.iterable'],
        types: [],
        strict: true,
        skipLibCheck: false,
        noEmit: true,
      },
      files: ['check.ts'],
    }
    writeFileSync(join(dir, `tsconfig.${mode}.json`), `${JSON.stringify(config, null, 2)}\n`)
    const result = await run(process.execPath, [tsc, '-p', `tsconfig.${mode}.json`], dir)
    const errors = result.stdout.split('\n').filter((line) => line.includes('error TS'))
    const detail = result.ok ? version : `${errors.length} errors, first: ${firstError(result.stdout + result.stderr)}`
    record(`tsc --noEmit moduleResolution=${mode}`, consumer, result.ok, detail)
  }
}

async function probe(dist, temp, manifest) {
  const entries = entryPoints(manifest)
  checkPrepack(manifest)
  progress('staging the package (prepack README sync included)')
  const staged = stage(temp, dist)
  progress('packing')
  const { tarball, files } = await pack(staged, temp)
  checkTarball(files, staged)
  const withoutPeers = entries.filter((entry) => !NEEDS_PEERS.has(entry.name))
  const consumerA = await install(temp, 'A', [tarball], 'tarball only')
  if (consumerA) {
    checkFootprint(consumerA, 'A')
    await checkImports(consumerA, 'A', withoutPeers)
  }
  const consumerB = await install(
    temp,
    'B',
    [tarball, ...PEERS, ...TOOLS],
    `tarball + ${PEERS.join(', ')} + ${TOOLS.join(', ')}`,
  )
  if (consumerB) {
    await checkImports(consumerB, 'B', entries)
    if (entries.some((entry) => entry.name === 'react')) checkUseClient(consumerB, 'B')
    await checkTypes(consumerB, 'B', entries)
  }
}

function printTable() {
  const header = ['check', 'consumer', 'result', 'detail']
  const rows = results.map((row) => [row.check, row.consumer, row.ok ? 'PASS' : 'FAIL', row.detail])
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)))
  const format = (row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
      .join('  ')
      .trimEnd()
  console.log(format(header))
  console.log(format(widths.map((width) => '-'.repeat(width))))
  for (const row of rows) console.log(format(row))
  const failed = results.filter((row) => !row.ok).length
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
}

async function main(argv) {
  const { dist } = parseArguments(argv)
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const temp = mkdtempSync(join(tmpdir(), 'docsterm-probe-'))
  process.once('SIGINT', interrupt).once('SIGTERM', interrupt)
  try {
    await probe(dist, temp, manifest)
  } catch (error) {
    if (!(error instanceof Interrupted)) {
      record('stage and pack', '-', false, error instanceof Error ? error.message : String(error))
    }
  } finally {
    process.off('SIGINT', interrupt).off('SIGTERM', interrupt)
    rmSync(temp, { recursive: true, force: true })
  }
  if (stopSignal) {
    console.error(`pack-probe: interrupted by ${stopSignal}`)
    return SIGNAL_EXIT_CODES[stopSignal]
  }
  console.log(`docsterm pack probe: dist ${displayPath(dist)}`)
  console.log(`A = tarball only, B = tarball + ${PEERS.join(', ')} + ${TOOLS.join(', ')}\n`)
  printTable()
  return results.every((row) => row.ok) ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`pack-probe: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
