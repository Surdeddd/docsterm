import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCompleteSource, transformSource } from '../src/javascript/transform.js'

async function repl() {
  const evaluate = runInContext('eval', createContext({})) as (code: string) => unknown
  return async (source: string): Promise<unknown> => {
    const result = await transformSource(source)
    if (!result.ok) throw new Error(result.error)
    if (result.declarations !== '') evaluate(result.declarations)
    return await evaluate(result.code)
  }
}

async function asyncFlag(source: string): Promise<boolean | string> {
  const result = await transformSource(source)
  return result.ok ? result.async : result.error
}

describe('preloadTransform', () => {
  afterEach(() => {
    vi.doUnmock('acorn')
    vi.resetModules()
  })

  const freshTransform = async (fail: (load: number) => boolean) => {
    vi.resetModules()
    const loads = { count: 0 }
    vi.doMock('acorn', async () => {
      loads.count += 1
      if (fail(loads.count)) throw new TypeError('Failed to fetch dynamically imported module: acorn.js')
      return await vi.importActual('acorn')
    })
    return { loads, transform: await import('../src/javascript/transform.js') }
  }

  it('starts loading the parser at once, before any command needs it', async () => {
    const { loads, transform } = await freshTransform(() => false)
    transform.preloadTransform()
    await vi.waitFor(() => expect(loads.count).toBe(1))
    expect(await transform.transformSource('1')).toEqual({ ok: true, code: '1', declarations: '', async: false })
  })

  it('swallows a parser that cannot load, so the next transform loads it again', async () => {
    const { loads, transform } = await freshTransform((load) => load === 1)
    transform.preloadTransform()
    await vi.waitFor(() => expect(loads.count).toBe(1))
    expect(await transform.transformSource('1')).toEqual({ ok: true, code: '1', declarations: '', async: false })
    expect(loads.count).toBe(2)
  })

  it('needs no preload to transform', async () => {
    expect(await transformSource('1')).toEqual({ ok: true, code: '1', declarations: '', async: false })
  })
})

describe('transformSource', () => {
  it("reports the parser's error with its position", async () => {
    expect(await transformSource('1 +')).toEqual({ ok: false, error: 'SyntaxError: Unexpected token (1:3)' })
    expect(await transformSource('return 1')).toEqual({
      ok: false,
      error: "SyntaxError: 'return' outside of function (1:0)",
    })
    expect(await transformSource("import x from 'y'")).toEqual({
      ok: false,
      error: "SyntaxError: 'import' and 'export' may appear only with 'sourceType: module' (1:0)",
    })
  })

  it('reports the error of the original input when the object-literal retry fails too', async () => {
    expect(await transformSource('{ a: 1, }}')).toEqual({ ok: false, error: 'SyntaxError: Unexpected token (1:8)' })
  })

  it('uses an async wrapper only for top-level await', async () => {
    expect(await asyncFlag('await 1')).toBe(true)
    expect(await asyncFlag('for await (const item of []) {}')).toBe(true)
    expect(await asyncFlag('const later = await Promise.resolve(1)')).toBe(true)
    expect(await asyncFlag('async function f() { await 1 }')).toBe(false)
    expect(await asyncFlag('const f = async () => await 1')).toBe(false)
    expect(await asyncFlag('1 + 1')).toBe(false)
  })

  it('leaves code without top-level await unwrapped, so eval returns its completion value [review: completion values]', async () => {
    expect(await transformSource('if (true) { 5 }')).toEqual({ ok: true, code: 'if (true) { 5 }', declarations: '', async: false })
    expect(await transformSource("'use strict'; let a = 1, b\nclass C {}\nfunction f() {}")).toEqual({
      ok: true,
      code: "'use strict'; var {} = [this.f = f]; var {} = [ (a = 1), (b = undefined)];\nvar {} = [C = class C {}];\nfunction f() {}",
      declarations: 'var a, b, C; function f() {}',
      async: false,
    })
    expect(await transformSource('var x, y = 2; for (var i = 0; i < 1; i++) {}')).toEqual({
      ok: true,
      code: 'var {} = [ x, (y = 2)]; for ( i = 0; i < 1; i++) {}',
      declarations: 'var x, y, i;',
      async: false,
    })
  })

  it('wraps code with top-level await and returns its last expression statement', async () => {
    expect(await transformSource('const v = await p; v')).toEqual({
      ok: true,
      code: '(async () => {\nvar {} = [ (v = await p)]; return (v)\n})()',
      declarations: 'var v;',
      async: true,
    })
    expect(await transformSource('#!/usr/bin/env node\nawait 1')).toEqual({
      ok: true,
      code: '(async () => {\n///usr/bin/env node\nreturn (await 1)\n})()',
      declarations: '',
      async: true,
    })
  })

  it('turns a hashbang line into a comment before anything else, so eval never sees one [review: hashbang]', async () => {
    expect(await transformSource('#!/usr/bin/env node\n1 + 1')).toEqual({
      ok: true,
      code: '///usr/bin/env node\n1 + 1',
      declarations: '',
      async: false,
    })
    expect(await transformSource('#!/usr/bin/env node\nconst x = 1')).toEqual({
      ok: true,
      code: '///usr/bin/env node\nvar {} = [ (x = 1)];',
      declarations: 'var x;',
      async: false,
    })
    expect(await transformSource('#!/usr/bin/env node\n1 +')).toEqual({ ok: false, error: 'SyntaxError: Unexpected token (2:3)' })
  })

  it('exports sloppy-mode functions declared in blocks out of the async wrapper [review: Annex B]', async () => {
    expect(await transformSource('await null; { function f() {} }')).toEqual({
      ok: true,
      code: '(async () => {\nawait null; { function f() {} this.f = f; }\n})()',
      declarations: 'var f;',
      async: true,
    })
    expect(await transformSource('await null; if (ok) function g() {} else h()')).toEqual({
      ok: true,
      code: '(async () => {\nawait null; if (ok) { function g() {} this.g = g; } else h()\n})()',
      declarations: 'var g;',
      async: true,
    })
    expect(await transformSource('await null; switch (1) { case 1: label: function k() {} }')).toEqual({
      ok: true,
      code: '(async () => {\nawait null; switch (1) { case 1: label: function k() {} this.k = k; }\n})()',
      declarations: 'var k;',
      async: true,
    })
  })

  it('guards block functions named like a top-level let, const or class, so they stay in their block [review: Annex B shadow]', async () => {
    expect(await transformSource('let shadow = 1; { function shadow() {} } typeof shadow')).toEqual({
      ok: true,
      code: 'var {} = [ (shadow = 1)]; { let shadow; { function shadow() {} } } typeof shadow',
      declarations: 'var shadow;',
      async: false,
    })
    expect(await transformSource('const c = 2; await null; if (true) function c() {}')).toEqual({
      ok: true,
      code: '(async () => {\nvar {} = [ (c = 2)]; await null; if (true) { let c; { function c() {} } }\n})()',
      declarations: 'var c;',
      async: true,
    })
    expect(await transformSource('class K {}\nawait null; switch (1) { case 1: function K() {} }')).toEqual({
      ok: true,
      code: '(async () => {\nvar {} = [K = class K {}];\nawait null; { let K; switch (1) { case 1: function K() {} } }\n})()',
      declarations: 'var K;',
      async: true,
    })
    expect(await transformSource('let a = 1, b = 2; await null; { function a() {} function b() {} function c() {} }')).toEqual({
      ok: true,
      code: '(async () => {\nvar {} = [ (a = 1), (b = 2)]; await null; { let a, b; { function a() {} function b() {} function c() {} this.c = c; } }\n})()',
      declarations: 'var a, b, c;',
      async: true,
    })
    expect(await transformSource("'use strict'; let s = 1; { function s() {} }")).toEqual({
      ok: true,
      code: "'use strict'; var {} = [ (s = 1)]; { function s() {} }",
      declarations: 'var s;',
      async: false,
    })
  })

  it('defines a placeholder for each top-level function and binds the real one before the code runs [review: accessor globals]', async () => {
    expect(await transformSource("await null; function name() { return 'mine' }")).toEqual({
      ok: true,
      code: "(async () => {\nvar {} = [this.name = name]; await null; function name() { return 'mine' }\n})()",
      declarations: 'function name() {}',
      async: true,
    })
    expect(await transformSource("'use strict'\n'another directive'; let a = 1\nfunction f() {}\nasync function* g() {}")).toEqual({
      ok: true,
      code: "'use strict'\n'another directive'; var {} = [this.f = f, this.g = g]; var {} = [ (a = 1)];\nfunction f() {}\nasync function* g() {}",
      declarations: 'var a; function f() {} function g() {}',
      async: false,
    })
  })

  it('leaves block-level functions alone where a script would not hoist them [review: Annex B]', async () => {
    const unchanged = async (source: string) => {
      const result = await transformSource(source)
      return result.ok ? [result.code === `(async () => {\n${source}\n})()`, result.declarations] : result.error
    }
    expect(await unchanged("'use strict'; await null; { function f() {} }")).toEqual([true, ''])
    expect(await unchanged('await null; { let f; { function f() {} } }')).toEqual([true, ''])
    expect(await unchanged('await null; for (const f of []) { function f() {} }')).toEqual([true, ''])
    expect(await unchanged('await null; try {} catch ({ f }) { { function f() {} } }')).toEqual([true, ''])
    expect(await unchanged('await null; { function* f() {} async function g() {} }')).toEqual([true, ''])
    expect(await unchanged('await null; { (() => { { function f() {} } })() }')).toEqual([true, ''])
    expect(await transformSource('{ function f() {} }')).toEqual({ ok: true, code: '{ function f() {} }', declarations: '', async: false })
  })
})

describe('transformed code', () => {
  it('returns the value of the last expression statement', async () => {
    const run = await repl()
    expect(await run('1 + 1')).toBe(2)
    expect(await run('1;;')).toBe(1)
    expect(await run('1 + 1 // two')).toBe(2)
    expect(await run('const x = 1')).toBeUndefined()
    expect(await run('')).toBeUndefined()
    expect(await run('// only a comment')).toBeUndefined()
    expect(await run('x = 5')).toBe(5)
  })

  it('retries {...} as an object literal first and falls back to a block', async () => {
    const run = await repl()
    expect(JSON.stringify(await run('{a: 1}'))).toBe('{"a":1}')
    expect(JSON.stringify(await run('{a: 1, b: 2}'))).toBe('{"a":1,"b":2}')
    expect(await run('{ let inner = 1; inner }')).toBe(1)
    expect(await run('typeof inner')).toBe('undefined')
  })

  it('returns the completion value of any statement, and declarations do not replace it [review: completion values]', async () => {
    const run = await repl()
    expect(await run('if (true) { 5 }')).toBe(5)
    expect(await run('let total = 0; for (let i = 1; i <= 3; i++) { total += i }')).toBe(6)
    expect(await run('1; let y = 2')).toBe(1)
    expect(await run('2; class K {}; function k() {}')).toBe(2)
    expect(await run('3; if (true) { var nested = 4 }')).toBeUndefined()
    expect(JSON.stringify(await run('[y, typeof K, typeof k, nested]'))).toBe('[2,"function","function",4]')
  })

  it('keeps the declarations of strict-mode code [review: completion values]', async () => {
    const run = await repl()
    expect(await run("'use strict'; if (true) { var w = 5 }; 1; var s = 2; let t = 3; function u() { return 4 }")).toBe(1)
    expect(JSON.stringify(await run('[s, t, u(), w]'))).toBe('[2,3,4,5]')
  })

  it('keeps every top-level declaration across commands [js-5]', async () => {
    const run = await repl()
    await run('const a = 1; let b = 2; var c = 3; class D {}; function e() { return 5 }')
    expect(JSON.stringify(await run('[a, b, c, typeof D, e()]'))).toBe('[1,2,3,"function",5]')
  })

  it('keeps names bound by destructuring', async () => {
    const run = await repl()
    await run('const { a, b: [c], ...rest } = { a: 1, b: [2], d: 4 }')
    expect(JSON.stringify(await run('[a, c, rest]'))).toBe('[1,2,{"d":4}]')
    await run('const [x = 5, , y] = [undefined, 0, 9]')
    expect(JSON.stringify(await run('[x, y]'))).toBe('[5,9]')
  })

  it('keeps var declared inside blocks and loop heads', async () => {
    const run = await repl()
    await run('for (var i = 0; i < 3; i++) {}')
    expect(await run('i')).toBe(3)
    await run('if (true) { var z = 1 }')
    expect(await run('z')).toBe(1)
    await run('for (var k in { p: 1 }) {}')
    expect(await run('k')).toBe('p')
    await run('for (var [m, n] of [[1, 2]]) {}')
    expect(await run('m + n')).toBe(3)
  })

  it('keeps loop-scoped and nested declarations local [js-15]', async () => {
    const run = await repl()
    const loop = ['const fns = []', 'for (let i = 0; i < 3; i++) {', '  fns.push(() => i)', '}', 'fns.map((f) => f())']
    expect(JSON.stringify(await run(loop.join('\n')))).toBe('[0,1,2]')
    await run('function outer() { const hidden = 1; return hidden }')
    expect(await run('typeof hidden')).toBe('undefined')
    await run('for (let j = 0; j < 1; j++) {}')
    expect(await run('typeof j')).toBe('undefined')
  })

  it('does not touch text inside strings and template literals [js-15]', async () => {
    const run = await repl()
    await run('const t = `a\nlet b = 1`')
    expect(await run('t')).toBe('a\nlet b = 1')
    expect(await run('typeof b')).toBe('undefined')
  })

  it('keeps declarations made with await and returns the awaited value [js-2, docs-js-1]', async () => {
    const run = await repl()
    expect(await run('const v = await Promise.resolve(5)')).toBeUndefined()
    expect(await run('v')).toBe(5)
    expect(await run('await Promise.resolve(42)')).toBe(42)
  })

  it('returns a promise value as it is, for the runtime to await', async () => {
    const evaluate = runInContext('eval', createContext({})) as (code: string) => unknown
    const result = await transformSource('Promise.resolve(8)')
    if (!result.ok) throw new Error(result.error)
    const completion = evaluate(result.code) as Promise<number>
    expect(typeof completion.then).toBe('function')
    expect(await completion).toBe(8)
  })

  it('keeps classes that refer to themselves', async () => {
    const run = await repl()
    await run('class Tree { static make() { return new Tree() } }')
    expect(await run('Tree.make() instanceof Tree')).toBe(true)
  })

  it('does not glue a class to a following line that starts with a parenthesis', async () => {
    const run = await repl()
    expect(await run('class A {}\n(1)')).toBe(1)
    expect(await run('typeof A')).toBe('function')
  })

  it('can call a function declared later in the same command', async () => {
    const run = await repl()
    await run('const r = later(); function later() { return 7 }')
    expect(await run('r')).toBe(7)
    await run('async function af() { return 1 }\nfunction* g() { yield 2 }')
    expect(await run('typeof af + typeof g')).toBe('functionfunction')
  })

  it('honours a use strict directive', async () => {
    const run = await repl()
    await expect(run("'use strict'; undeclaredVariable = 1")).rejects.toThrow('undeclaredVariable is not defined')
    expect(await run("'use strict'")).toBe('use strict')
  })

  it('allows a declaration to be repeated, as a REPL does', async () => {
    const run = await repl()
    await run('let q = 1')
    await run('let q')
    expect(await run('q')).toBeUndefined()
    await run('var kept = 1')
    await run('var kept; if (true) { var kept }')
    expect(await run('kept')).toBe(1)
    await run('const w = 1')
    await run('const w = 2')
    expect(await run('w')).toBe(2)
  })

  it('keeps sloppy-mode block-level functions of code with top-level await, as eval keeps them without it [review: Annex B]', async () => {
    const run = await repl()
    await run("await null; if (true) { function inBlock() { return 'block' } }")
    await run("if (true) { function syncBlock() { return 'sync' } }")
    await run("await null; { function twice() { return 'outer' } { function twice() { return 'inner' } } }")
    expect(JSON.stringify(await run('[inBlock(), syncBlock(), twice()]'))).toBe('["block","sync","inner"]')
  })

  it('executes a command once, even when it throws a SyntaxError at runtime [js-6]', async () => {
    const run = await repl()
    await run('counter = 0')
    await expect(run("counter++; JSON.parse('{')")).rejects.toMatchObject({ name: 'SyntaxError' })
    expect(await run('counter')).toBe(1)
  })
})

describe('isCompleteSource', () => {
  it.each<[string, boolean]>([
    ['1 + 1', true],
    ['', true],
    [')', true],
    ["'abc", true],
    ['let a; let a;', true],
    ['1 +', false],
    ['function f() {', false],
    ['if (x) {\n  y()', false],
    ['if (x) {\n  y()\n}', true],
    ['{', false],
    ['{ a: 1, b: 2,', false],
    ['`abc', false],
    ['/* note', false],
    ['[1, 2', false],
    ['foo(', false],
    ["'abc\\", false],
    ['x = await', false],
  ])('%j is complete: %s', async (source, expected) => {
    expect(await isCompleteSource(source)).toBe(expected)
  })
})
