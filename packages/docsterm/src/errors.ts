export type AIErrorCode = 'key-missing' | 'refused' | 'truncated' | 'empty' | 'invalid' | 'http' | 'network'

export class AIProviderError extends Error {
  readonly code: AIErrorCode
  readonly status?: number

  constructor(code: AIErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AIProviderError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
  }
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'APIUserAbortError'
}
