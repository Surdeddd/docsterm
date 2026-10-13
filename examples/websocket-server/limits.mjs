import { isIPv6 } from 'node:net'

export function createTokenBucket({ capacity, perSecond, now = Date.now }) {
  let tokens = capacity
  let updated = now()
  const refill = () => {
    const current = now()
    tokens = Math.min(capacity, tokens + ((current - updated) / 1000) * perSecond)
    updated = current
  }
  return {
    take(amount = 1) {
      refill()
      if (tokens < amount) return false
      tokens -= amount
      return true
    },
    full() {
      refill()
      return tokens >= capacity
    },
  }
}

const expandIPv6 = (address) => {
  const [head, tail] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail === undefined ? [] : tail ? tail.split(':') : []
  const missing = tail === undefined ? 0 : 8 - left.length - right.length
  return [...left, ...Array(Math.max(missing, 0)).fill('0'), ...right]
}

export function clientKey(address) {
  if (typeof address !== 'string' || address === '') return 'unknown'
  const plain = address.replace(/%.*$/, '').toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain)
  if (mapped) return mapped[1]
  if (!isIPv6(plain)) return plain
  const groups = expandIPv6(plain).map((group) => (Number.parseInt(group, 16) || 0).toString(16))
  return `${groups.slice(0, 4).join(':')}::/64`
}

export function createLogLimiter(log, { perWindow = 10, windowMs = 10_000, now = Date.now } = {}) {
  const windows = new Map()
  return (event, fields) => {
    const current = now()
    let window = windows.get(event)
    if (!window || current - window.started >= windowMs) {
      if (window?.suppressed) log(`${event}-suppressed`, { count: window.suppressed })
      window = { started: current, logged: 0, suppressed: 0 }
      windows.set(event, window)
    }
    if (window.logged < perWindow) {
      window.logged += 1
      log(event, fields)
    } else {
      window.suppressed += 1
    }
  }
}
