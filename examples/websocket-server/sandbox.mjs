import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const DOCKER_HOME = '/work'
const DETACH_KEYS = 'ctrl-^,ctrl-_'
const RM_ATTEMPTS = 4
const STALE_CONTAINER_MS = 60_000
const LIVE_STATES = new Set(['running', 'paused', 'restarting'])
const INSPECT_FORMAT = '{{.Id}} {{.State.Status}} {{.Created}} {{index .Config.Labels "docsterm.owner"}}'
const LOCAL_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const FOREGROUND_KILL = 'read -r s < /proc/1/stat; s=${s##*")"}; set -- $s; [ "${6:-0}" -gt 1 ] && kill -9 "-$6"'

const LOCAL_PREFIX = 'docsterm-sandbox-'
const LOCAL_OWNED = /^docsterm-sandbox-(\d+)-/
const LOCAL_UNTAGGED = /^docsterm-sandbox-[A-Za-z0-9]{6}$/
const UNTAGGED_STALE_MS = 10 * 60 * 1000

let ptyModule = null

const modifiedAt = (path) => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return Date.now()
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function sweepLocalSandboxes() {
  let entries
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return []
  }
  const swept = []
  const now = Date.now()
  for (const name of entries) {
    const path = join(tmpdir(), name)
    const owner = Number(LOCAL_OWNED.exec(name)?.[1])
    const stale = Number.isSafeInteger(owner)
      ? owner > 0 && owner !== process.pid && !isAlive(owner)
      : LOCAL_UNTAGGED.test(name) && now - modifiedAt(path) > UNTAGGED_STALE_MS
    if (!stale) continue
    rmSync(path, { recursive: true, force: true })
    swept.push(name)
  }
  return swept
}

export function ensureSpawnHelper() {
  const root = dirname(require.resolve('node-pty/package.json'))
  const candidates = [
    'build/Release/spawn-helper',
    'build/Debug/spawn-helper',
    `prebuilds/${process.platform}-${process.arch}/spawn-helper`,
  ]
  const fixed = []
  for (const relative of candidates) {
    const file = join(root, relative)
    if (!existsSync(file)) continue
    const { mode } = statSync(file)
    if ((mode & 0o111) === 0o111) continue
    chmodSync(file, mode | 0o755)
    fixed.push(relative)
  }
  return fixed
}

const loadPty = () => {
  ptyModule ??= require('node-pty')
  return ptyModule
}

const run = (file, args, timeout = 10_000) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const killGroup = (group) => {
  if (group === null) return
  try {
    process.kill(-group, 'SIGKILL')
  } catch {
    return
  }
}

export async function checkDockerImage(image) {
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'])
  if (!version.ok) return { ok: false, reason: 'docker is not available (docker version failed)' }
  if ((await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image])).ok) return { ok: true, pulled: false }
  const pulled = await run('docker', ['pull', image], 300_000)
  return pulled.ok ? { ok: true, pulled: true } : { ok: false, reason: `could not pull image ${image}` }
}

const removeContainer = async (ref) => {
  for (let attempt = 1; attempt <= RM_ATTEMPTS; attempt += 1) {
    const removed = await run('docker', ['rm', '-f', ref], 15_000)
    if (removed.ok || /no such container/i.test(removed.stderr)) return true
    await delay(500 * attempt)
  }
  return false
}

export async function sweepDockerSandboxes() {
  const listed = await run('docker', ['ps', '-aq', '--no-trunc', '--filter', 'label=docsterm.sandbox=1'])
  const ids = listed.stdout.split(/\s+/).filter(Boolean)
  if (!listed.ok || ids.length === 0) return []
  const inspected = await run('docker', ['inspect', '--format', INSPECT_FORMAT, ...ids], 30_000)
  const stale = []
  for (const line of inspected.stdout.split('\n')) {
    const [id, status, created, owner = ''] = line.trim().split(' ')
    if (!id || !created) continue
    const age = Date.now() - Date.parse(created.replace(/(\.\d{3})\d+/, '$1'))
    const [ownerHost, ownerPid] = owner.split('/')
    const pid = Number(ownerPid)
    const orphaned =
      ownerHost === hostname() && Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid)
    const leftover = !LIVE_STATES.has(status) && age > STALE_CONTAINER_MS
    if (orphaned || leftover) stale.push(id)
  }
  for (const id of stale) await removeContainer(id)
  return stale
}

export async function dockerSecurityWarnings() {
  const info = await run('docker', ['info', '--format', '{{json .SecurityOptions}}'])
  let options = []
  try {
    options = JSON.parse(info.stdout)
  } catch {
    return []
  }
  if (!Array.isArray(options)) return []
  const seccomp = options.find((option) => String(option).includes('name=seccomp'))
  if (seccomp && !String(seccomp).includes('profile=unconfined')) return []
  return [
    'the docker daemon runs containers without a seccomp profile; enable seccomp, or use gVisor (runsc) or userns-remap, before exposing this server',
  ]
}

const dockerCreateArgs = (config, name) => {
  const [uid, gid] = config.sandboxUser.split(':')
  return [
    'create',
    '--rm',
    '-i',
    '-t',
    '--pull',
    'never',
    '--network',
    'none',
    '--memory',
    config.memory,
    '--memory-swap',
    config.memory,
    '--cpus',
    config.cpus,
    '--pids-limit',
    String(config.pidsLimit),
    '--read-only',
    '--tmpfs',
    `/work:rw,exec,size=${config.workSize},uid=${uid},gid=${gid},mode=0700`,
    '--tmpfs',
    `/tmp:rw,size=${config.tmpSize},uid=${uid},gid=${gid},mode=1777`,
    '-w',
    DOCKER_HOME,
    '--user',
    config.sandboxUser,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-e',
    `HOME=${DOCKER_HOME}`,
    '-e',
    'TERM=xterm-256color',
    '--label',
    'docsterm.sandbox=1',
    '--label',
    `docsterm.owner=${hostname()}/${process.pid}`,
    '--name',
    name,
    config.image,
    'sh',
  ]
}

const childEnv = () => {
  const env = { ...process.env }
  delete env.TOKEN
  return env
}

function wrap(term, extra) {
  let disposed = false
  const dataListeners = []
  const exitListeners = []
  term.onData((data) => {
    if (!disposed) for (const listener of dataListeners) listener(data)
  })
  term.onExit(({ exitCode, signal }) => {
    if (disposed) return
    disposed = true
    const code = signal ? 128 + signal : exitCode
    for (const listener of exitListeners) listener(code)
  })
  return {
    ...extra,
    pid: term.pid,
    write: (data) => {
      if (!disposed) term.write(data)
    },
    resize: (columns, rows) => {
      if (disposed) return
      try {
        term.resize(columns, rows)
      } catch {
        return
      }
    },
    pause: () => {
      if (!disposed) term.pause()
    },
    resume: () => {
      if (!disposed) term.resume()
    },
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    detach: () => {
      disposed = true
    },
    killTerm: (signal) => {
      try {
        term.kill(signal)
      } catch {
        return
      }
    },
  }
}

async function createDockerSandbox(config, size) {
  const name = `docsterm-${randomBytes(6).toString('hex')}`
  const created = await run('docker', dockerCreateArgs(config, name), 30_000)
  const id = created.stdout.trim()
  if (!created.ok || !/^[0-9a-f]{12,64}$/.test(id)) {
    await removeContainer(name)
    throw new Error('docker create failed')
  }
  let term
  try {
    term = loadPty().spawn('docker', ['start', '--attach', '--interactive', '--detach-keys', DETACH_KEYS, id], {
      name: 'xterm-256color',
      cols: size.columns,
      rows: size.rows,
      cwd: process.cwd(),
      env: childEnv(),
    })
  } catch (error) {
    await removeContainer(id)
    throw error
  }
  const sandbox = wrap(term, { kind: 'docker', name, home: DOCKER_HOME })
  sandbox.killForeground = async () => {
    await run('docker', ['exec', id, 'sh', '-c', FOREGROUND_KILL], 5000)
  }
  sandbox.destroy = async () => {
    sandbox.detach()
    sandbox.killTerm()
    await removeContainer(id)
  }
  return sandbox
}

function createLocalSandbox(config, size) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `${LOCAL_PREFIX}${process.pid}-`)))
  const env = { PATH: LOCAL_PATH, HOME: home, TERM: 'xterm-256color' }
  if (process.env.LANG) env.LANG = process.env.LANG
  let term
  try {
    term = loadPty().spawn(config.localShell, [], {
      name: 'xterm-256color',
      cols: size.columns,
      rows: size.rows,
      cwd: home,
      env,
    })
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
  const sandbox = wrap(term, { kind: 'local', name: `local-${term.pid}`, home })
  const foreground = async () => {
    const { ok, stdout } = await run('ps', ['-o', 'tpgid=', '-p', String(term.pid)], 5000)
    const group = ok ? Number.parseInt(stdout.trim(), 10) : Number.NaN
    return Number.isSafeInteger(group) && group > 1 && group !== term.pid ? group : null
  }
  sandbox.killForeground = async () => {
    killGroup(await foreground())
  }
  sandbox.destroy = async () => {
    const group = await foreground()
    sandbox.detach()
    killGroup(group)
    sandbox.killTerm('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
  return sandbox
}

export async function createSandbox(config, size) {
  return config.sandbox === 'local' ? createLocalSandbox(config, size) : createDockerSandbox(config, size)
}
