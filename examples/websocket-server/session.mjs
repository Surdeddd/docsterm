import {
  createBoundaryScanner,
  createNonce,
  hasForbiddenControls,
  initScript,
  normalizeCommand,
  promptFor,
  recoveryLine,
  runLine,
} from './boundary.mjs'
import { createLogLimiter, createTokenBucket } from './limits.mjs'
import { formatBytes, formatDuration, formatSeconds, localeOf, noticeText } from './notices.mjs'
import { createSandbox } from './sandbox.mjs'

export const PROTOCOL = 2
export const FEATURES = ['pty', 'resize', 'prompt', 'ping']

const EXIT_BUSY = 1
const EXIT_REJECTED = 2
const EXIT_TIMED_OUT = 124
const EXIT_UNAVAILABLE = 125
const EXIT_INTERRUPTED = 130
const INTERRUPT = '\u0003'
const PROMPT_WAIT_MS = 1000
const INIT_FALLBACK_MS = 3000
const SIZE_LIMIT = 1000
const SMALL_STDIN = 16
const PONG_INTERVAL_MS = 500
const RESIZE_COALESCE_MS = 50

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isId = (value) => Number.isSafeInteger(value) && value >= 0
const isDimension = (value) => Number.isInteger(value) && value >= 1 && value <= SIZE_LIMIT

const encodedLength = (text) => Buffer.byteLength(JSON.stringify(text)) - 2

const truncateEncoded = (text, budget) => {
  let used = 0
  let end = 0
  for (const char of text) {
    const cost = encodedLength(char)
    if (used + cost > budget) break
    used += cost
    end += char.length
  }
  return text.slice(0, end)
}

export function createSession({ config, send, close, log, authenticated, verifyToken }) {
  let size = { columns: 80, rows: 24 }
  let sandbox = null
  let scanner = null
  let shell = 'down'
  let home = ''
  let pwd = ''
  let seq = 0
  let active = null
  let queued = null
  let isAuthenticated = authenticated
  let disposed = false
  let disposing = null
  let booting = null
  let booted = false
  let idleTimer
  let authTimer
  let promptTimer
  let readyTimer
  let resizeTimer
  let resizePending = false
  let throttled = false
  let lastPong = 0
  let creation = null
  const destroyings = new Set()
  const stdinBucket = createTokenBucket({ capacity: config.stdinBurstBytes, perSecond: config.stdinBytesPerSecond })
  const messageBucket = createTokenBucket({ capacity: config.messageBurst, perSecond: config.messagesPerSecond })
  const limitedLog = createLogLimiter(log, { perWindow: 1, windowMs: 10_000 })

  const currentPrompt = () => promptFor(pwd || home, home)

  const clearRunTimers = (run) => {
    clearTimeout(run.timeout)
    clearTimeout(run.escalation)
    clearTimeout(run.reset)
  }

  const armTimeout = (run) => {
    clearTimeout(run.timeout)
    run.timeout = setTimeout(() => interrupt('timeout'), config.commandTimeoutMs)
  }

  const armIdle = () => {
    clearTimeout(idleTimer)
    if (disposed || active) return
    idleTimer = setTimeout(() => {
      if (active) return
      log('idle-close')
      close(1000, 'idle limit reached')
    }, config.idleTimeoutMs)
  }

  const output = (run, chunk) => {
    if (!chunk) return
    run.atLineStart = chunk.endsWith('\n')
    send({ type: 'output', id: run.id, chunk })
  }

  const notice = (run, key, params) => {
    output(run, `${run.atLineStart ? '' : '\r\n'}${noticeText(run.locale, key, params)}\r\n`)
  }

  const answer = (request, key, params, code) => {
    send({ type: 'output', id: request.id, chunk: `${noticeText(request.locale, key, params)}\r\n` })
    const exit = { type: 'exit', id: request.id, code }
    send(booted ? { ...exit, prompt: currentPrompt() } : exit)
  }

  const forward = (text) => {
    const run = active
    if (!run || run.discarding) return
    const bytes = encodedLength(text)
    if (run.bytes + bytes <= config.outputLimitBytes) {
      run.bytes += bytes
      output(run, text)
      return
    }
    output(run, truncateEncoded(text, config.outputLimitBytes - run.bytes))
    run.bytes = config.outputLimitBytes
    run.discarding = true
    notice(run, 'outputLimit', { size: formatBytes(config.outputLimitBytes, run.locale) })
    interrupt('limit')
  }

  const finish = (code) => {
    const run = active
    if (!run) return
    active = null
    clearRunTimers(run)
    const exitCode =
      run.reason === 'cancel' ? EXIT_INTERRUPTED : run.reason === 'timeout' ? EXIT_TIMED_OUT : code
    send({ type: 'exit', id: run.id, code: exitCode, prompt: currentPrompt() })
    armIdle()
    startQueued()
  }

  const startRun = (request) => {
    seq += 1
    const run = {
      id: request.id,
      locale: request.locale,
      seq,
      bytes: 0,
      atLineStart: true,
      discarding: false,
      reason: null,
      timeout: undefined,
      escalation: undefined,
      reset: undefined,
    }
    active = run
    shell = 'running'
    clearTimeout(idleTimer)
    flushResize()
    armTimeout(run)
    sandbox.write(runLine({ command: request.command, seq, columns: size.columns, rows: size.rows }))
    if (request.input) sandbox.write(request.input)
  }

  const startQueued = () => {
    if (active || !queued || shell !== 'prompt') return
    const request = queued
    queued = null
    startRun(request)
  }

  const enterPromptWait = () => {
    shell = 'prompt-wait'
    clearTimeout(promptTimer)
    promptTimer = setTimeout(() => {
      if (shell !== 'prompt-wait') return
      shell = 'prompt'
      startQueued()
    }, PROMPT_WAIT_MS)
  }

  const interrupt = (reason) => {
    const run = active
    if (!run || run.reason) return
    run.reason = reason
    log('interrupt', { id: run.id, reason })
    if (reason === 'timeout') notice(run, 'timedOut', { seconds: formatSeconds(config.commandTimeoutMs, run.locale) })
    if (shell !== 'running' && shell !== 'recovering') return
    if (shell === 'running') sandbox.write(INTERRUPT)
    run.escalation = setTimeout(async () => {
      if (active !== run || !sandbox) return
      log('kill-foreground', { id: run.id })
      await sandbox.killForeground()
      if (active !== run) return
      run.reset = setTimeout(() => {
        if (active === run) restart(run, 'notStopped', {}, EXIT_INTERRUPTED)
      }, config.cancelGraceMs)
    }, config.cancelGraceMs)
  }

  const onPrompt = () => {
    if (shell === 'prompt-wait') {
      clearTimeout(promptTimer)
      shell = 'prompt'
      startQueued()
    } else if (shell === 'running' && active) {
      shell = 'recovering'
      sandbox.write(recoveryLine(active.seq))
    } else if (shell === 'recovering' && active) {
      restart(active, 'lostBoundary', {}, EXIT_INTERRUPTED)
    }
  }

  const onBoundary = (event) => {
    if (shell === 'starting') {
      if (event.seq !== 0) return
      pwd = event.pwd
      enterPromptWait()
      const done = booting
      booting = null
      done?.resolve()
      return
    }
    if (!active || event.seq !== active.seq || (shell !== 'running' && shell !== 'recovering')) return
    pwd = event.pwd
    enterPromptWait()
    finish(event.code)
  }

  const onData = (data) => {
    for (const event of scanner.push(data)) {
      if (event.kind === 'data') {
        if (shell === 'running') forward(event.text)
      } else if (event.kind === 'prompt') onPrompt()
      else onBoundary(event)
    }
  }

  const teardown = () => {
    const current = sandbox
    sandbox = null
    scanner = null
    shell = 'down'
    clearTimeout(promptTimer)
    if (!current) return Promise.resolve()
    const destroying = current.destroy().catch(() => undefined)
    destroyings.add(destroying)
    destroying.finally(() => destroyings.delete(destroying))
    return destroying
  }

  const onExit = (box, code) => {
    if (disposed || box !== sandbox) return
    const rest = scanner?.flush() ?? ''
    if (shell === 'running' && rest) forward(rest)
    if (booting) {
      log('sandbox-failed', { code })
      const failed = booting
      booting = null
      teardown()
      failed.reject(new Error(`sandbox exited with code ${code} during startup`))
      return
    }
    if (active) {
      log('shell-exit', { code })
      restart(active, 'shellExited', { code }, code)
      return
    }
    log('shell-exit', { code })
    teardown()
    close(1011, 'sandbox ended')
  }

  const create = async () => {
    const made = createSandbox(config, size).then(
      async (box) => {
        if (disposed) await box.destroy().catch(() => undefined)
        return box
      },
      () => null,
    )
    creation = made
    const box = await made
    if (creation === made) creation = null
    if (!box) throw new Error('the sandbox could not be created')
    if (disposed) throw new Error('session closed')
    if (throttled) box.pause()
    return box
  }

  const boot = async () => {
    if (config.sandbox === 'local' && config.localStartDelayMs > 0) {
      await delay(config.localStartDelayMs)
      if (disposed) throw new Error('session closed')
    }
    const box = await create()
    return new Promise((resolve, reject) => {
      const nonce = createNonce()
      sandbox = box
      scanner = createBoundaryScanner(nonce)
      home = box.home
      pwd = box.home
      shell = 'starting'
      let initWritten = false
      const writeInit = () => {
        if (initWritten || box !== sandbox) return
        initWritten = true
        box.write(initScript(nonce))
      }
      const fallback = setTimeout(writeInit, INIT_FALLBACK_MS)
      const deadline = setTimeout(() => {
        if (booting?.box !== box) return
        booting = null
        log('sandbox-timeout')
        teardown()
        reject(new Error('sandbox start timed out'))
      }, config.startTimeoutMs)
      booting = {
        box,
        resolve: () => {
          clearTimeout(fallback)
          clearTimeout(deadline)
          resolve()
        },
        reject: (error) => {
          clearTimeout(fallback)
          clearTimeout(deadline)
          reject(error)
        },
      }
      box.onData((data) => {
        if (box !== sandbox || disposed) return
        writeInit()
        onData(data)
      })
      box.onExit((code) => onExit(box, code))
      log('sandbox-start', { sandbox: box.name })
    })
  }

  const restart = async (run, key, params, code) => {
    log('sandbox-restart', { id: run.id })
    clearRunTimers(run)
    await teardown()
    if (disposed) return
    try {
      await boot()
    } catch {
      if (active === run) {
        notice(run, 'restartFailed')
        active = null
        send({ type: 'exit', id: run.id, code, prompt: currentPrompt() })
      }
      close(1011, 'sandbox unavailable')
      return
    }
    if (disposed || active !== run) return
    notice(run, key, params)
    finish(code)
  }

  let readySent = false
  const sendReady = () => {
    clearTimeout(readyTimer)
    if (readySent || disposed) return
    readySent = true
    const ready = { type: 'ready', protocol: PROTOCOL, features: FEATURES }
    if (booted) ready.prompt = currentPrompt()
    if (config.banner) ready.banner = config.banner
    send(ready)
  }

  const start = async () => {
    readyTimer = setTimeout(sendReady, config.readyWaitMs)
    try {
      await boot()
    } catch {
      if (disposed) return
      log('sandbox-unavailable')
      clearTimeout(readyTimer)
      if (queued) {
        const request = queued
        queued = null
        answer(request, 'startFailed', {}, EXIT_UNAVAILABLE)
      }
      close(1011, 'sandbox unavailable')
      return
    }
    if (disposed) return
    booted = true
    sendReady()
    armIdle()
  }

  const flushResize = () => {
    clearTimeout(resizeTimer)
    if (!resizePending) return
    resizePending = false
    sandbox?.resize(size.columns, size.rows)
  }

  const applySize = (columns, rows) => {
    size = { columns, rows }
    resizePending = true
    flushResize()
  }

  const throttle = (on) => {
    if (throttled === on) return
    throttled = on
    if (on) sandbox?.pause()
    else sandbox?.resume()
  }

  const commandProblem = (command) => {
    if (typeof command !== 'string') return ['notString', {}]
    if (command.length > config.maxCommandLength) return ['tooLong', { limit: config.maxCommandLength }]
    if (hasForbiddenControls(normalizeCommand(command))) return ['controls', {}]
    return null
  }

  const onRun = (message) => {
    const { id, command } = message
    if (!isId(id) || active?.id === id || queued?.id === id) return
    if (isDimension(message.columns) && isDimension(message.rows)) applySize(message.columns, message.rows)
    armIdle()
    const locale = localeOf(message.locale)
    const problem = commandProblem(command)
    if (problem) {
      answer({ id, locale }, problem[0], problem[1], EXIT_REJECTED)
      return
    }
    const request = { id, locale, command: normalizeCommand(command), input: '' }
    if (!active && !queued && shell === 'prompt') {
      startRun(request)
      return
    }
    if (!queued && (!active || active.reason)) {
      queued = request
      return
    }
    answer(request, 'busy', {}, EXIT_BUSY)
  }

  const onCancel = ({ id }) => {
    if (!isId(id)) return
    if (queued?.id === id) {
      queued = null
      const exit = { type: 'exit', id, code: EXIT_INTERRUPTED }
      send(booted ? { ...exit, prompt: currentPrompt() } : exit)
      return
    }
    if (active?.id === id) interrupt('cancel')
  }

  const onStdin = ({ id, data }) => {
    if (!isId(id) || typeof data !== 'string' || data.length > config.maxStdinLength || !data) return
    if (data.length > SMALL_STDIN && !stdinBucket.take(Buffer.byteLength(data))) {
      limitedLog('stdin-dropped', { id })
      return
    }
    if (queued?.id === id) {
      if (queued.input.length + data.length <= config.maxStdinLength) queued.input += data
      return
    }
    if (!active || active.id !== id || shell !== 'running') return
    flushResize()
    if (!active.reason) armTimeout(active)
    sandbox.write(data)
  }

  const onResize = ({ columns, rows }) => {
    if (!isDimension(columns) || !isDimension(rows)) return
    size = { columns, rows }
    if (resizePending) return
    resizePending = true
    resizeTimer = setTimeout(flushResize, RESIZE_COALESCE_MS)
  }

  const onPing = () => {
    const now = Date.now()
    if (now - lastPong < PONG_INTERVAL_MS) return
    lastPong = now
    send({ type: 'pong' })
  }

  const onAuth = (message) => {
    clearTimeout(authTimer)
    if (message?.type !== 'auth' || !verifyToken(message.token)) {
      log('auth-failed')
      close(1008, 'unauthorized')
      return
    }
    isAuthenticated = true
    start()
  }

  const handle = (data, isBinary) => {
    if (disposed) return
    if (!messageBucket.take()) {
      limitedLog('messages-dropped')
      return
    }
    if (isBinary || data.length > config.maxMessageBytes) {
      if (!isAuthenticated) close(1008, 'unauthorized')
      return
    }
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      message = null
    }
    const valid = typeof message === 'object' && message !== null && !Array.isArray(message)
    if (!isAuthenticated) {
      onAuth(valid ? message : null)
      return
    }
    if (!valid || typeof message.type !== 'string') return
    if (message.type === 'run') onRun(message)
    else if (message.type === 'cancel') onCancel(message)
    else if (message.type === 'stdin') onStdin(message)
    else if (message.type === 'resize') onResize(message)
    else if (message.type === 'ping') onPing()
  }

  const dispose = () => {
    if (disposing) return disposing
    disposed = true
    clearTimeout(idleTimer)
    clearTimeout(authTimer)
    clearTimeout(promptTimer)
    clearTimeout(readyTimer)
    clearTimeout(resizeTimer)
    clearTimeout(lifeTimer)
    if (active) clearRunTimers(active)
    active = null
    queued = null
    if (booting) {
      const pending = booting
      booting = null
      pending.reject(new Error('session closed'))
    }
    teardown()
    disposing = Promise.allSettled([...destroyings, creation].filter(Boolean)).then(() => undefined)
    return disposing
  }

  const lifeTimer = setTimeout(() => {
    if (active) notice(active, 'sessionLimit', { duration: formatDuration(config.maxSessionMs, active.locale) })
    log('session-limit')
    close(1000, 'session limit reached')
  }, config.maxSessionMs)

  if (isAuthenticated) start()
  else {
    authTimer = setTimeout(() => {
      log('auth-timeout')
      close(1008, 'authentication timed out')
    }, config.authTimeoutMs)
  }

  return { handle, dispose, throttle }
}
