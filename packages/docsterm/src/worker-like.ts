interface WorkerEvents {
  message(event: { data: unknown }): void
  error(event: unknown): void
}

export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: WorkerEvents['message'] | null
  onerror: WorkerEvents['error'] | null
}
