import { describe, expect, it } from 'vitest'
import { createShellBackend } from '../src/shell/index.js'
import { codeOrder, collate, compareNames } from '../src/shell/locale.js'

const DECOMPOSED = 'é'
const PRECOMPOSED = 'é'

describe('shell collation', () => {
  it('orders by code units only when the collation sees no difference', () => {
    expect([codeOrder('a', 'b'), codeOrder('b', 'a'), codeOrder('a', 'a'), codeOrder('Z', 'a')]).toEqual([-1, 1, 0, -1])
    expect([collate(DECOMPOSED, PRECOMPOSED), collate('Z', 'a') > 0]).toEqual([0, true])
    expect([compareNames(DECOMPOSED, PRECOMPOSED), compareNames(PRECOMPOSED, DECOMPOSED), compareNames('Z', 'a') > 0]).toEqual([
      -1,
      1,
      true,
    ])
    expect([PRECOMPOSED, 'b', DECOMPOSED, 'A'].sort(compareNames)).toEqual(['A', 'b', DECOMPOSED, PRECOMPOSED])
  })

  it('gives sort and ls one stable order for names the collation calls equal', async () => {
    const shell = createShellBackend({
      files: { list: { [`${PRECOMPOSED}.txt`]: '', [`${DECOMPOSED}.txt`]: '' }, 'names.txt': `${PRECOMPOSED}\n${DECOMPOSED}\n` },
      cwd: '/',
    })
    expect(await shell.run('sort names.txt')).toEqual({ output: `${DECOMPOSED}\n${PRECOMPOSED}`, exitCode: 0 })
    expect(await shell.run('sort -r names.txt')).toEqual({ output: `${PRECOMPOSED}\n${DECOMPOSED}`, exitCode: 0 })
    expect(await shell.run('ls -1 /list')).toEqual({ output: `${DECOMPOSED}.txt\n${PRECOMPOSED}.txt`, exitCode: 0 })
  })
})
