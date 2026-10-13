import { createWasiHost } from './host.js'

export const WASI_WORKER_SOURCE = `'use strict'
const createWasiHost = ${createWasiHost.toString()}
let compiled = null
self.onmessage = (event) => {
  const message = event.data
  if (message.type === 'module') {
    compiled = message.module
    self.postMessage({ type: 'ready' })
    return
  }
  if (message.type !== 'run' || compiled === null) return
  const id = message.id
  const host = createWasiHost({
    argv: message.argv,
    env: message.env,
    stdin: message.stdin,
    imports: WebAssembly.Module.imports(compiled),
    outputLimit: message.outputLimit,
    write: (text) => self.postMessage({ type: 'output', id, text }),
    truncated: () => self.postMessage({ type: 'truncated', id }),
  })
  let exit
  try {
    exit = host.run(new WebAssembly.Instance(compiled, host.imports))
  } catch (error) {
    exit = host.fail(error)
  }
  self.postMessage({ type: 'exit', id, code: exit.code, error: exit.error })
}
`
