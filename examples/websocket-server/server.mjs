import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { loadConfig, originAllowed } from './config.mjs'
import { clientKey, createLogLimiter, createTokenBucket } from './limits.mjs'
import {
  checkDockerImage,
  dockerSecurityWarnings,
  ensureSpawnHelper,
  sweepDockerSandboxes,
  sweepLocalSandboxes,
} from './sandbox.mjs'
import { createSession } from './session.mjs'

const SHUTDOWN_LIMIT_MS = 8000
const HIGH_WATER_BYTES = 1024 * 1024
const LOW_WATER_BYTES = 256 * 1024
const HARD_BUFFER_BYTES = 8 * 1024 * 1024
const FLOW_POLL_MS = 25
const DOCKER_SWEEP_MS = 5 * 60 * 1000
const BUCKET_CLEANUP_MS = 60_000
const PARENT_POLL_MS = 1000

const clean = (value) => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 200)

const log = (event, fields = {}) => {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${clean(value)}`)
    .join(' ')
  process.stderr.write(`docsterm-server ${new Date().toISOString()} ${event}${details ? ` ${details}` : ''}\n`)
}

const limitedLog = createLogLimiter(log, { perWindow: 10, windowMs: 10_000 })

let config
try {
  config = loadConfig(process.env)
} catch (error) {
  process.stderr.write(`docsterm-server: ${error.message}\n`)
  process.exit(1)
}

const digest = (value) => createHash('sha256').update(value, 'utf8').digest()
const expected = config.token === null ? null : digest(config.token)
const verifyToken = (candidate) =>
  expected !== null && typeof candidate === 'string' && candidate.length <= 4096 && timingSafeEqual(digest(candidate), expected)

for (const file of ensureSpawnHelper()) log('spawn-helper-fixed', { file })

let sweeping = null
const sweepContainers = () => {
  sweeping ??= sweepDockerSandboxes()
    .then((removed) => {
      if (removed.length > 0) log('swept-stale-containers', { count: removed.length })
    })
    .finally(() => {
      sweeping = null
    })
  return sweeping
}

if (config.sandbox === 'docker') {
  const image = await checkDockerImage(config.image)
  if (!image.ok) {
    process.stderr.write(`docsterm-server: ${image.reason}\n`)
    process.exit(1)
  }
  if (image.pulled) log('image-pulled', { image: config.image })
  for (const warning of await dockerSecurityWarnings()) {
    process.stderr.write(`docsterm-server: WARNING: ${warning}\n`)
    log('security-warning', { message: warning })
  }
  await sweepContainers()
  setInterval(sweepContainers, DOCKER_SWEEP_MS).unref()
} else {
  log('warning', { message: 'SANDBOX=local runs commands on this machine without isolation (tests only)' })
  const swept = sweepLocalSandboxes()
  if (swept.length > 0) log('swept-stale-sandboxes', { count: swept.length })
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) shutdown('parent-exit')
  }, PARENT_POLL_MS).unref()
}

const hardPayloadLimit = Math.max(config.maxMessageBytes * 4, 1024 * 1024)
const wss = new WebSocketServer({ noServer: true, maxPayload: hardPayloadLimit, perMessageDeflate: false })
const sessions = new Set()
const disposals = new Set()
const perClient = new Map()
const connectBuckets = new Map()
let connections = 0
let counter = 0
let shuttingDown = false

setInterval(() => {
  for (const [key, bucket] of connectBuckets) if (bucket.full()) connectBuckets.delete(key)
}, BUCKET_CLEANUP_MS).unref()

const connectAllowed = (key) => {
  let bucket = connectBuckets.get(key)
  if (!bucket) {
    bucket = createTokenBucket({
      capacity: config.connectsPerMinutePerIp,
      perSecond: config.connectsPerMinutePerIp / 60,
    })
    connectBuckets.set(key, bucket)
  }
  return bucket.take()
}

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
}

const refuse = (socket, status, reason, ip) => {
  limitedLog('refused', { ip, status, reason })
  const body = `${STATUS_TEXT[status]}\n`
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
  )
}

const server = createServer((request, response) => {
  response.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' })
  response.end('docsterm websocket server: connect with a WebSocket client\n')
})

server.on('upgrade', (request, socket, head) => {
  socket.on('error', () => socket.destroy())
  const ip = request.socket.remoteAddress ?? 'unknown'
  const key = clientKey(ip)
  if (shuttingDown) return refuse(socket, 503, 'shutting down', ip)
  if (!originAllowed(request.headers.origin, config.allowedOrigins)) return refuse(socket, 403, 'origin', ip)
  let url
  try {
    url = new URL(request.url ?? '/', 'http://localhost')
  } catch {
    return refuse(socket, 400, 'url', ip)
  }
  const queryToken = url.searchParams.get('token')
  if (config.token !== null && queryToken !== null && !verifyToken(queryToken)) {
    return refuse(socket, 401, 'token', ip)
  }
  if (!connectAllowed(key)) return refuse(socket, 429, 'connection rate', ip)
  if (connections >= config.maxConnections) return refuse(socket, 503, 'connection limit', ip)
  if ((perClient.get(key) ?? 0) >= config.maxConnectionsPerIp) return refuse(socket, 429, 'per-ip limit', ip)
  wss.handleUpgrade(request, socket, head, (ws) => {
    const authenticated = config.token === null || queryToken !== null
    accept(ws, ip, key, authenticated)
  })
})

function accept(ws, ip, key, authenticated) {
  const id = (counter += 1)
  connections += 1
  perClient.set(key, (perClient.get(key) ?? 0) + 1)
  log('open', { conn: id, ip })
  let session = null
  let watching = null
  let stalledSince = 0

  const stopWatching = () => {
    clearInterval(watching)
    watching = null
  }

  const watchBuffer = () => {
    if (ws.bufferedAmount > HARD_BUFFER_BYTES) {
      stopWatching()
      log('overflow-close', { conn: id })
      ws.terminate()
      return
    }
    if (watching || ws.bufferedAmount <= HIGH_WATER_BYTES) return
    session?.throttle(true)
    stalledSince = Date.now()
    watching = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        stopWatching()
      } else if (ws.bufferedAmount <= LOW_WATER_BYTES) {
        stopWatching()
        session?.throttle(false)
      } else if (Date.now() - stalledSince > config.stallTimeoutMs) {
        stopWatching()
        log('stalled-close', { conn: id })
        ws.terminate()
      }
    }, FLOW_POLL_MS)
  }

  const send = (message) => {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(message))
    watchBuffer()
  }
  const close = (code, reason) => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason)
  }
  session = createSession({
    config,
    send,
    close,
    authenticated,
    verifyToken,
    log: (event, fields) => log(event, { conn: id, ...fields }),
  })
  sessions.add(session)
  ws.on('message', (data, isBinary) => session.handle(data, isBinary))
  ws.on('error', (error) => log('socket-error', { conn: id, code: error.code ?? 'unknown' }))
  ws.on('close', (code) => {
    stopWatching()
    sessions.delete(session)
    const disposal = session.dispose()
    disposals.add(disposal)
    log('close', { conn: id, code })
    disposal.finally(() => {
      disposals.delete(disposal)
      connections -= 1
      const left = (perClient.get(key) ?? 1) - 1
      if (left > 0) perClient.set(key, left)
      else perClient.delete(key)
    })
  })
}

const shutdown = async (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown', { signal })
  server.close()
  const pending = [...disposals, ...[...sessions].map((session) => session.dispose())]
  for (const client of wss.clients) client.close(1001, 'server shutting down')
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_LIMIT_MS)),
  ])
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

server.on('error', (error) => {
  process.stderr.write(`docsterm-server: cannot listen: ${error.code ?? error.message}\n`)
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  const { address, port } = server.address()
  const host = address.includes(':') ? `[${address}]` : address
  process.stdout.write(`${JSON.stringify({ event: 'listening', host: address, port, url: `ws://${host}:${port}` })}\n`)
  log('listening', { host: address, port, sandbox: config.sandbox })
})
