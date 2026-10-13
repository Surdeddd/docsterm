import { inspect as nodeInspect } from 'node:util'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createInspector } from '../src/javascript/inspect.js'

const { inspect, format, table } = createInspector()

class Point {
  x = 1
  y = 2
}

class Empty {}

class Foo {}

class Bar extends Foo {}

describe('inspect: primitives', () => {
  it.each<[string, unknown, string]>([
    ['a string', 'abc', "'abc'"],
    ['a string with an apostrophe', "it's", '"it\'s"'],
    ['a string with both quotes', 'say "hi" it\'s', '`say "hi" it\'s`'],
    ['a newline', 'a\nb', "'a\\nb'"],
    ['a tab', 'tab\there', "'tab\\there'"],
    ['an escape sequence', '\x1b[31m', "'\\x1B[31m'"],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['negative zero', -0, '-0'],
    ['a bigint', 10n, '10n'],
    ['a symbol', Symbol('x'), 'Symbol(x)'],
    ['an empty symbol', Symbol(), 'Symbol()'],
    ['a well-known symbol', Symbol.iterator, 'Symbol(Symbol.iterator)'],
    ['true', true, 'true'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('%s', (_name, value, expected) => {
    expect(inspect(value)).toBe(expected)
  })

  it('cuts strings longer than 10000 characters', () => {
    const shown = inspect('x'.repeat(10005))
    expect(shown).toBe(`'${'x'.repeat(10000)}'... 5 more characters`)
  })

  it('splits a long multi-line string at its newlines', () => {
    expect(
      inspect('line one is here\nline two is here too and long enough to break the eighty character limit'),
    ).toBe(
      "'line one is here\\n' +\n  'line two is here too and long enough to break the eighty character limit'",
    )
  })
})

const sparse = (length: number, items: Record<number, unknown>): unknown[] => {
  const array: unknown[] = []
  array.length = length
  for (const [index, value] of Object.entries(items)) array[Number(index)] = value
  return array
}

describe('inspect: arrays', () => {
  it.each<[string, unknown, string]>([
    ['an empty array', [], '[]'],
    ['nested values', [1, 'a', [2]], "[ 1, 'a', [ 2 ] ]"],
    ['undefined items', [undefined, null], '[ undefined, null ]'],
    ['a hole', sparse(2, { 1: 1 }), '[ <1 empty item>, 1 ]'],
    ['only holes', sparse(3, {}), '[ <3 empty items> ]'],
    ['holes in the middle', sparse(4, { 0: 1, 3: 2 }), '[ 1, <2 empty items>, 2 ]'],
    ['a huge sparse array', sparse(4294967295, { 5: 'x' }), "[ <5 empty items>, 'x', <4294967289 empty items> ]"],
    ['extra properties', Object.assign([1, 2], { extra: true }), '[ 1, 2, extra: true ]'],
    ['nesting deeper than two levels', [[[[1]]]], '[ [ [ [Array] ] ] ]'],
  ])('%s', (_name, value, expected) => {
    expect(inspect(value)).toBe(expected)
  })

  it('groups more than six short items into columns', () => {
    expect(inspect(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe("[\n  'a', 'b', 'c',\n  'd', 'e', 'f',\n  'g'\n]")
    expect(inspect('abcdefghijklmnopqrstuvwxyz'.split(''))).toBe(
      "[\n  'a', 'b', 'c', 'd', 'e', 'f',\n  'g', 'h', 'i', 'j', 'k', 'l',\n  'm', 'n', 'o', 'p', 'q', 'r',\n  's', 't', 'u', 'v', 'w', 'x',\n  'y', 'z'\n]",
    )
    expect(
      inspect(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']),
    ).toBe(
      "[\n  'alpha',   'beta',\n  'gamma',   'delta',\n  'epsilon', 'zeta',\n  'eta',     'theta',\n  'iota',    'kappa'\n]",
    )
  })

  it('shows the first 100 items of a long array and counts the rest', () => {
    expect(inspect(Array.from({ length: 120 }, (_, index) => index))).toBe(
      [
        '[',
        '   0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11,',
        '  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,',
        '  24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,',
        '  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,',
        '  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,',
        '  60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71,',
        '  72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,',
        '  84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,',
        '  96, 97, 98, 99,',
        '  ... 20 more items',
        ']',
      ].join('\n'),
    )
    expect(inspect(Array.from({ length: 200_000 }, () => 0)).endsWith('  ... 199900 more items\n]')).toBe(true)
  })

  it('puts one object per line when they do not fit on one', () => {
    const users = Array.from({ length: 4 }, (_, id) => ({ id, name: `user number ${id}`, active: id % 2 === 0 }))
    expect(inspect(users)).toBe(
      [
        '[',
        "  { id: 0, name: 'user number 0', active: true },",
        "  { id: 1, name: 'user number 1', active: false },",
        "  { id: 2, name: 'user number 2', active: true },",
        "  { id: 3, name: 'user number 3', active: false }",
        ']',
      ].join('\n'),
    )
  })
})

describe('inspect: objects', () => {
  it.each<[string, unknown, string]>([
    ['an empty object', {}, '{}'],
    ['keys that need quotes and symbol keys', { a: 1, 'b-c': 2, [Symbol('s')]: 3 }, "{ a: 1, 'b-c': 2, Symbol(s): 3 }"],
    ['nesting deeper than two levels', { a: { b: { c: { d: 1 } } } }, '{ a: { b: { c: [Object] } } }'],
    ['an empty null-prototype object', Object.create(null), '[Object: null prototype] {}'],
    ['a null-prototype object', Object.assign(Object.create(null), { a: 1 }), '[Object: null prototype] { a: 1 }'],
    ['a class instance', new Point(), 'Point { x: 1, y: 2 }'],
    ['an empty class instance', new Empty(), 'Empty {}'],
    ['a method', { f() {} }, '{ f: [Function: f] }'],
    ['an arrow function property', { arrow: () => 1 }, '{ arrow: [Function: arrow] }'],
    ['an own toStringTag', { [Symbol.toStringTag]: 'Custom' }, "{ Symbol(Symbol.toStringTag): 'Custom' }"],
    ['an object inside an array', [{ a: 1, b: { c: { d: 1 } } }], '[ { a: 1, b: { c: [Object] } } ]'],
  ])('%s', (_name, value, expected) => {
    expect(inspect(value)).toBe(expected)
  })

  it('shows accessors without calling them', () => {
    let calls = 0
    const value = {
      get a() {
        calls += 1
        return 1
      },
      set b(_next: number) {},
      get c() {
        calls += 1
        return 1
      },
      set c(_next: number) {},
    }
    expect(inspect(value)).toBe('{ a: [Getter], b: [Setter], c: [Getter/Setter] }')
    expect(calls).toBe(0)
  })

  it('marks circular references', () => {
    const self: Record<string, unknown> = { name: 'a' }
    self.self = self
    expect(inspect(self)).toBe("<ref *1> { name: 'a', self: [Circular *1] }")
    const parent: { x: Record<string, unknown> } = { x: {} }
    parent.x.parent = parent
    expect(inspect(parent)).toBe('<ref *1> { x: { parent: [Circular *1] } }')
    const lonely = Object.create(null) as Record<string, unknown>
    lonely.self = lonely
    expect(inspect(lonely)).toBe('<ref *1> [Object: null prototype] { self: [Circular *1] }')
  })

  it('breaks an object over several lines when it is wider than the break length', () => {
    const value = { alpha: 'x'.repeat(30), beta: 'y'.repeat(30), gamma: 'z'.repeat(30) }
    expect(inspect(value)).toBe(
      `{\n  alpha: '${'x'.repeat(30)}',\n  beta: '${'y'.repeat(30)}',\n  gamma: '${'z'.repeat(30)}'\n}`,
    )
    const narrow = { alpha: 'x'.repeat(10), beta: 'y'.repeat(10) }
    expect(inspect(narrow)).toBe("{ alpha: 'xxxxxxxxxx', beta: 'yyyyyyyyyy' }")
    expect(inspect(narrow, { breakLength: 40 })).toBe("{\n  alpha: 'xxxxxxxxxx',\n  beta: 'yyyyyyyyyy'\n}")
  })
})

describe('inspect: functions and classes', () => {
  it.each<[string, unknown, string]>([
    ['a named function', function named() {}, '[Function: named]'],
    ['an anonymous function', (() => () => {})(), '[Function (anonymous)]'],
    ['an async function', async function af() {}, '[AsyncFunction: af]'],
    ['a generator function', function* gen() {}, '[GeneratorFunction: gen]'],
    ['an async generator function', async function* ag() {}, '[AsyncGeneratorFunction: ag]'],
    ['a class', Foo, '[class Foo]'],
    ['a subclass', Bar, '[class Bar extends Foo]'],
    ['an anonymous class', (() => class {})(), '[class (anonymous)]'],
    ['a function with properties', Object.assign(function tagged() {}, { meta: 1 }), '[Function: tagged] { meta: 1 }'],
  ])('%s', (_name, value, expected) => {
    expect(inspect(value)).toBe(expected)
  })
})

describe('inspect: built-in objects', () => {
  it.each<[string, unknown, string]>([
    ['an empty Map', new Map(), 'Map(0) {}'],
    ['a Map', new Map<string, unknown>([['a', 1], ['b', { c: 2 }]]), "Map(2) { 'a' => 1, 'b' => { c: 2 } }"],
    ['a Map with object keys', new Map([[{ k: 1 }, [1, 2]]]), 'Map(1) { { k: 1 } => [ 1, 2 ] }'],
    ['a Set', new Set<unknown>(['x', 1]), "Set(2) { 'x', 1 }"],
    ['a WeakMap', new WeakMap(), 'WeakMap { <items unknown> }'],
    ['a WeakSet', new WeakSet(), 'WeakSet { <items unknown> }'],
    ['a Date', new Date(0), '1970-01-01T00:00:00.000Z'],
    ['an invalid Date', new Date(Number.NaN), 'Invalid Date'],
    ['a RegExp', /a+b/gi, '/a+b/gi'],
    ['a typed array', new Uint8Array([1, 2]), 'Uint8Array(2) [ 1, 2 ]'],
    ['an empty typed array', new Float64Array(0), 'Float64Array(0) []'],
    ['a bigint typed array', new BigInt64Array([1n]), 'BigInt64Array(1) [ 1n ]'],
    ['an ArrayBuffer', new ArrayBuffer(2), 'ArrayBuffer { [Uint8Contents]: <00 00>, [byteLength]: 2 }'],
    ['a boxed number', Object(3), '[Number: 3]'],
    ['a boxed string', Object('ab'), "[String: 'ab']"],
    ['a boxed boolean', Object(false), '[Boolean: false]'],
    ['a boxed bigint', Object(1n), '[BigInt: 1n]'],
    ['a boxed symbol', Object(Symbol('q')), '[Symbol: Symbol(q)]'],
    ['a promise, whose state cannot be read synchronously', Promise.resolve(1), 'Promise {}'],
  ])('%s', (_name, value, expected) => {
    expect(inspect(value)).toBe(expected)
  })

  it('prints an error as its name and message, in brackets when nested', () => {
    expect(inspect(new Error('boom'))).toBe('Error: boom')
    expect(inspect({ e: new TypeError('bad') })).toBe('{ e: [TypeError: bad] }')
    expect(inspect(Object.assign(new Error('x'), { code: 'E_X' }))).toBe("Error: x { code: 'E_X' }")
    expect(inspect(new RangeError())).toBe('RangeError')
  })
})

describe('format: console.log arguments', () => {
  it.each<[string, unknown[], string]>([
    ['%s and %d', ['%s has %d items', 'cart', 3], 'cart has 3 items'],
    ['%s with an object at depth 0', ['%s', { a: { b: 1 } }], '{ a: [Object] }'],
    ['%s with a nested array', ['%s', [1, [2, [3]]]], '[ 1, [Array] ]'],
    ['%s with a bigint', ['%s', 5n], '5n'],
    ['%s with negative zero', ['%s', -0], '-0'],
    ['%s with a Date', ['%s', new Date(0)], '1970-01-01T00:00:00.000Z'],
    ['%s with a custom toString', ['%s', { toString: () => 'custom' }], 'custom'],
    ['%d with a numeric string', ['%d', '42'], '42'],
    ['%d with text', ['%d', 'x'], 'NaN'],
    ['%d with a bigint', ['%d', 1n], '1n'],
    ['%i', ['%i', 3.9], '3'],
    ['%i with a symbol', ['%i', Symbol('s')], 'NaN'],
    ['%f', ['%f', '2.5abc'], '2.5'],
    ['%j', ['%j', { a: [1] }], '{"a":[1]}'],
    ['%O', ['%O', { a: { b: { c: { d: { e: 1 } } } } }], '{ a: { b: { c: [Object] } } }'],
    ['%o, four levels deep', ['%o', { a: { b: { c: { d: { e: 1 } } } } }], '{\n  a: {\n    b: { c: { d: { e: 1 } } }\n  }\n}'],
    ['%c is dropped', ['%c styled', 'color: red'], ' styled'],
    ['a lone percent sign', ['100%', 5], '100% 5'],
    ['an escaped percent sign', ['%%s', 1], '%s 1'],
    ['an unknown placeholder', ['%x', 1], '%x 1'],
    ['a placeholder without an argument', ['%s and %s', 'one'], 'one and %s'],
    ['a single string', ['%s'], '%s'],
    ['a non-string first argument', [{ a: 1 }, 'text', 2], '{ a: 1 } text 2'],
    ['no arguments', [], ''],
    ['plain strings', ['a', 'b'], 'a b'],
  ])('%s', (_name, args, expected) => {
    expect(format(args)).toBe(expected)
  })

  it('prints a circular object for %j', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(format(['%j', circular])).toBe('[Circular]')
  })
})

describe('table', () => {
  it('renders rows of objects', () => {
    expect(table([{ a: 1, b: 'Y' }, { a: 'Z', b: 2 }])).toBe(
      [
        '┌─────────┬─────┬─────┐',
        '│ (index) │ a   │ b   │',
        '├─────────┼─────┼─────┤',
        "│ 0       │ 1   │ 'Y' │",
        "│ 1       │ 'Z' │ 2   │",
        '└─────────┴─────┴─────┘',
      ].join('\n'),
    )
  })

  it('renders an object of objects, primitives and a property filter', () => {
    expect(table({ x: { v: 1 }, y: { v: 22 } })).toBe(
      ['┌─────────┬────┐', '│ (index) │ v  │', '├─────────┼────┤', '│ x       │ 1  │', '│ y       │ 22 │', '└─────────┴────┘'].join(
        '\n',
      ),
    )
    expect(table([1, 'two'])).toBe(
      [
        '┌─────────┬────────┐',
        '│ (index) │ Values │',
        '├─────────┼────────┤',
        '│ 0       │ 1      │',
        "│ 1       │ 'two'  │",
        '└─────────┴────────┘',
      ].join('\n'),
    )
    expect(table([{ a: 1, b: 2 }, { b: 3 }], ['a'])).toBe(
      ['┌─────────┬───┐', '│ (index) │ a │', '├─────────┼───┤', '│ 0       │ 1 │', '│ 1       │   │', '└─────────┴───┘'].join('\n'),
    )
  })

  it('renders a Map and returns null for primitives', () => {
    expect(table(new Map([['k', 1]]))).toBe(
      [
        '┌───────────────────┬─────┬────────┐',
        '│ (iteration index) │ Key │ Values │',
        '├───────────────────┼─────┼────────┤',
        "│ 0                 │ 'k' │ 1      │",
        '└───────────────────┴─────┴────────┘',
      ].join('\n'),
    )
    expect(table(5)).toBeNull()
  })

  it('pads wide characters by their cell width', () => {
    expect(table([{ word: '日本' }, { word: 'ab' }])).toBe(
      [
        '┌─────────┬────────┐',
        '│ (index) │ word   │',
        '├─────────┼────────┤',
        "│ 0       │ '日本' │",
        "│ 1       │ 'ab'   │",
        '└─────────┴────────┘',
      ].join('\n'),
    )
  })
})

describe('inspect: huge arrays', () => {
  const holes = (length: number): unknown[] => {
    const list: unknown[] = []
    list.length = length
    return list
  }

  it('prints huge arrays and typed arrays without visiting every index [review: huge arrays]', () => {
    const cases: Array<[unknown, string, number]> = [
      [holes(10_000_000).fill(0), inspect(holes(200).fill(0)).replace('... 100 more items', '... 9999900 more items'), 0],
      [
        new Uint8Array(50_000_000),
        inspect(new Uint8Array(200)).replace('Uint8Array(200)', 'Uint8Array(50000000)').replace('... 100 more items', '... 49999900 more items'),
        0,
      ],
      [
        new Float64Array(20_000_000),
        inspect(new Float64Array(200)).replace('Float64Array(200)', 'Float64Array(20000000)').replace('... 100 more items', '... 19999900 more items'),
        0,
      ],
      [holes(10_000_000), '[ <10000000 empty items> ]', 1],
      [Object('x'.repeat(5_000_000)), `[String: '${'x'.repeat(10_000)}'... 4990000 more characters]`, 0],
    ]
    const keys = vi.spyOn(Object, 'keys')
    const seen: Array<[string, number]> = []
    try {
      const spied = createInspector()
      for (const [value] of cases) {
        keys.mockClear()
        const text = spied.inspect(value)
        seen.push([text, keys.mock.calls.filter(([target]) => target === value).length])
      }
    } finally {
      keys.mockRestore()
    }
    expect(seen).toEqual(cases.map(([, text, scans]) => [text, scans]))
  }, 30_000)

  it('still lists the extra properties of arrays up to 10000 items, and skips them above [review: huge arrays]', () => {
    expect(inspect(Object.assign(new Uint8Array(2), { tag: 'x' }))).toBe("Uint8Array(2) [ 0, 0, tag: 'x' ]")
    const tagged = Object.assign(holes(10_000).fill(0), { tag: 'x' })
    expect(inspect(tagged)).toBe(nodeInspect(tagged))
    expect(inspect(tagged).endsWith("  0, ... 9900 more items,\n  tag: 'x'\n]")).toBe(true)
    expect(inspect(Object.assign(holes(10_001).fill(0), { tag: 'x' })).endsWith('  ... 9901 more items\n]')).toBe(true)
  })
})

describe('inspect: endless prototype chains', () => {
  it('stops at a prototype cycle or after a bounded walk and shows the object as having no prototype [review: prototype walks]', () => {
    const cyclic: object = new Proxy({}, { getPrototypeOf: () => cyclic })
    const fresh = (): object => new Proxy({}, { getPrototypeOf: () => fresh() })
    const first: object = new Proxy({}, { getPrototypeOf: () => second })
    const second: object = new Proxy({}, { getPrototypeOf: () => first })
    const bare = '[Object: null prototype] {}'
    expect(inspect(cyclic)).toBe(bare)
    expect(inspect(fresh())).toBe(bare)
    expect(inspect([first, { second }])).toBe(`[\n  ${bare},\n  { second: ${bare} }\n]`)
    expect(format(['%s|%o|%O|%j', cyclic, fresh(), first, cyclic])).toBe(`${bare}|${bare}|${bare}|{}`)
    let thrown: unknown = null
    try {
      format(['%j', { toJSON: () => { throw cyclic } }])
    } catch (error) {
      thrown = error
    }
    expect(thrown === cyclic).toBe(true)
    expect(table([cyclic, fresh()])).toBe(['┌─────────┐', '│ (index) │', '├─────────┤', '│ 0       │', '│ 1       │', '└─────────┘'].join('\n'))
  })

  it('still finds the constructor, the error and the promise behind a proxy [review: prototype walks]', () => {
    class Point {
      x = 1
    }
    expect(inspect(new Proxy(new Point(), {}))).toBe('Point { x: 1 }')
    expect(inspect(new Proxy(new TypeError('bad'), {}))).toBe('TypeError: bad')
    expect(inspect(new Proxy(Promise.resolve(1), {}))).toBe('Promise {}')
    expect(inspect(Object.create(Object.create(Point.prototype)))).toBe('Point {}')
  })
})

describe('inspect: revoked proxies', () => {
  it('prints a revoked proxy as Node does, also inside other values [review: reply chain]', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    expect(inspect(proxy)).toBe('<Revoked Proxy>')
    expect(inspect([proxy, { inner: proxy }])).toBe('[ <Revoked Proxy>, { inner: <Revoked Proxy> } ]')
    expect(format(['%s and %o', proxy, proxy])).toBe('<Revoked Proxy> and <Revoked Proxy>')
    expect(format(['seen:', proxy])).toBe('seen: <Revoked Proxy>')
  })
})

describe('createInspector source', () => {
  it('runs from its own source text, with no access to module scope', () => {
    const shown = runInNewContext(
      `(${createInspector.toString()})().inspect(new Map([[1, { a: [1, 2], when: new Date(0) }]]))`,
    ) as string
    expect(shown).toBe('Map(1) { 1 => { a: [ 1, 2 ], when: 1970-01-01T00:00:00.000Z } }')
  })

  it('keeps working after user code replaces the built-ins it uses [review: primordials]', () => {
    const shown = runInNewContext(
      [
        `const inspector = (${createInspector.toString()})()`,
        'const values = [',
        "  new Map([[1, { a: [1, 2] }]]), new Set(['x']), new WeakMap(), new WeakSet(), new Date(0), /x/g,",
        "  Object(3), Object('s'), new Uint8Array([1, 2]), new ArrayBuffer(1), new TypeError('bad'), Symbol('s'),",
        "  -0, 10n, [undefined], { [Symbol.toStringTag]: 'T' }, Promise.resolve(1), function named() {},",
        ']',
        'for (const name of [',
        "  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean',",
        "  'Symbol', 'BigInt', 'JSON', 'Math', 'Date', 'RegExp', 'Error', 'TypeError', 'Uint8Array', 'ArrayBuffer',",
        "  'Reflect', 'Function', 'parseInt', 'parseFloat',",
        ']) globalThis[name] = null',
        'const lines = values.map((value) => inspector.inspect(value))',
        "lines.push(inspector.format(['%s=%d %j %i %f %O', 'n', 3, { a: 1 }, 4.7, '1.5x', { b: [2] }]))",
        "lines.push(inspector.table([{ a: 1 }, { a: 'two' }]))",
        "lines.join('\\n')",
      ].join('\n'),
    ) as string
    expect(shown).toBe(
      [
        'Map(1) { 1 => { a: [ 1, 2 ] } }',
        "Set(1) { 'x' }",
        'WeakMap { <items unknown> }',
        'WeakSet { <items unknown> }',
        '1970-01-01T00:00:00.000Z',
        '/x/g',
        '[Number: 3]',
        "[String: 's']",
        'Uint8Array(2) [ 1, 2 ]',
        'ArrayBuffer { [Uint8Contents]: <00>, [byteLength]: 1 }',
        'TypeError: bad',
        'Symbol(s)',
        '-0',
        '10n',
        '[ undefined ]',
        "{ Symbol(Symbol.toStringTag): 'T' }",
        'Promise {}',
        '[Function: named]',
        'n=3 {"a":1} 4 1.5 { b: [ 2 ] }',
        '┌─────────┬───────┐',
        '│ (index) │ a     │',
        '├─────────┼───────┤',
        '│ 0       │ 1     │',
        "│ 1       │ 'two' │",
        '└─────────┴───────┘',
      ].join('\n'),
    )
  })
})
