export const keyStore = {
  get(name: string): string | null {
    try {
      return globalThis.localStorage?.getItem(name) ?? null
    } catch {
      return null
    }
  },
  set(name: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(name, value)
    } catch {
      return
    }
  },
  clear(name: string): void {
    try {
      globalThis.localStorage?.removeItem(name)
    } catch {
      return
    }
  },
}
