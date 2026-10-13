const SIZE = /^\d{1,6}[kmg]?$/i
const CPUS = /^(?:\d{1,3})(?:\.\d{1,3})?$/
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/

const integer = (env, name, fallback, min, max) => {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

const matching = (env, name, fallback, pattern) => {
  const value = env[name] === undefined || env[name] === '' ? fallback : env[name]
  if (!pattern.test(value)) throw new Error(`${name} has an invalid value`)
  return value
}

const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, '').toLowerCase()

const parseOrigins = (raw) => {
  if (raw === undefined || raw.trim() === '') return null
  return new Set(raw.split(',').map(normalizeOrigin).filter(Boolean))
}

export function loadConfig(env) {
  const sandbox = env.SANDBOX === undefined || env.SANDBOX === '' ? 'docker' : env.SANDBOX
  if (sandbox !== 'docker' && sandbox !== 'local') throw new Error('SANDBOX must be "docker" or "local"')
  if (sandbox === 'local' && env.NODE_ENV !== 'test') {
    throw new Error(
      'SANDBOX=local runs commands on this machine without any isolation and is only allowed with NODE_ENV=test',
    )
  }
  const token = env.TOKEN === undefined || env.TOKEN === '' ? null : env.TOKEN
  const banner = env.BANNER ? env.BANNER.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 500) : ''
  return {
    port: integer(env, 'PORT', 8080, 0, 65535),
    host: env.HOST === undefined || env.HOST === '' ? '127.0.0.1' : env.HOST,
    sandbox,
    image: matching(env, 'IMAGE', 'alpine:3', IMAGE),
    localShell: env.LOCAL_SHELL || '/bin/sh',
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    token,
    banner,
    commandTimeoutMs: integer(env, 'COMMAND_TIMEOUT_MS', 120_000, 100, 86_400_000),
    cancelGraceMs: integer(env, 'CANCEL_GRACE_MS', 2000, 50, 60_000),
    outputLimitBytes: integer(env, 'OUTPUT_LIMIT_BYTES', 5 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    idleTimeoutMs: integer(env, 'IDLE_TIMEOUT_MS', 600_000, 1000, 86_400_000),
    authTimeoutMs: integer(env, 'AUTH_TIMEOUT_MS', 10_000, 100, 600_000),
    startTimeoutMs: integer(env, 'START_TIMEOUT_MS', 30_000, 1000, 600_000),
    readyWaitMs: integer(env, 'READY_WAIT_MS', 500, 0, 1000),
    localStartDelayMs: sandbox === 'local' ? integer(env, 'LOCAL_START_DELAY_MS', 0, 0, 60_000) : 0,
    maxMessageBytes: integer(env, 'MAX_MESSAGE_BYTES', 65_536, 1024, 16 * 1024 * 1024),
    maxCommandLength: integer(env, 'MAX_COMMAND_LENGTH', 16_384, 1, 1024 * 1024),
    maxStdinLength: integer(env, 'MAX_STDIN_LENGTH', 32_768, 1, 16 * 1024 * 1024),
    maxConnections: integer(env, 'MAX_CONNECTIONS', 20, 1, 100_000),
    maxConnectionsPerIp: integer(env, 'MAX_CONNECTIONS_PER_IP', 4, 1, 100_000),
    connectsPerMinutePerIp: integer(env, 'CONNECTS_PER_MINUTE_PER_IP', 30, 1, 100_000),
    maxSessionMs: integer(env, 'MAX_SESSION_MS', 1_800_000, 1000, 86_400_000),
    stallTimeoutMs: integer(env, 'STALL_TIMEOUT_MS', 30_000, 100, 3_600_000),
    stdinBurstBytes: integer(env, 'STDIN_BURST_BYTES', 262_144, 1024, 64 * 1024 * 1024),
    stdinBytesPerSecond: integer(env, 'STDIN_BYTES_PER_SECOND', 65_536, 1024, 64 * 1024 * 1024),
    messageBurst: integer(env, 'MESSAGE_BURST', 200, 1, 1_000_000),
    messagesPerSecond: integer(env, 'MESSAGES_PER_SECOND', 100, 1, 1_000_000),
    sandboxUser: matching(env, 'SANDBOX_USER', '65534:65534', /^\d{1,10}:\d{1,10}$/),
    memory: matching(env, 'SANDBOX_MEMORY', '256m', SIZE),
    cpus: matching(env, 'SANDBOX_CPUS', '0.5', CPUS),
    pidsLimit: integer(env, 'SANDBOX_PIDS_LIMIT', 128, 8, 100_000),
    workSize: matching(env, 'SANDBOX_WORK_SIZE', '64m', SIZE),
    tmpSize: matching(env, 'SANDBOX_TMP_SIZE', '16m', SIZE),
  }
}

export function originAllowed(origin, allowed) {
  if (origin === undefined) return true
  const normalized = normalizeOrigin(origin)
  if (allowed === null) return LOOPBACK_ORIGIN.test(normalized)
  return allowed.has('*') || allowed.has(normalized)
}
