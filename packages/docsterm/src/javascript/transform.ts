import type { ClassDeclaration, FunctionDeclaration, Node, Options, Pattern, Program, VariableDeclaration } from 'acorn'

type Acorn = typeof import('acorn')

type AnyNode = Node & Record<string, unknown>

interface Edit {
  start: number
  end: number
  text: string
}

export type TransformResult =
  | { ok: true; code: string; declarations: string; async: boolean }
  | { ok: false; error: string }

const OPTIONS: Options = { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }

const SCOPE_BOUNDARIES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'StaticBlock'])

let loading: Promise<Acorn> | null = null

function loadAcorn(): Promise<Acorn> {
  if (loading === null) {
    loading = import('acorn').catch((error: unknown) => {
      loading = null
      throw error
    })
  }
  return loading
}

export function preloadTransform(): void {
  loadAcorn().catch(() => {})
}

const isNode = (value: unknown): value is AnyNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

function childrenOf(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = []
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item)
    } else if (isNode(value)) {
      children.push(value)
    }
  }
  return children
}

function collectNames(pattern: Pattern | null | undefined, names: string[]): void {
  if (!pattern) return
  if (pattern.type === 'Identifier') names.push(pattern.name)
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      collectNames(property.type === 'RestElement' ? property.argument : property.value, names)
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) collectNames(element, names)
  } else if (pattern.type === 'RestElement') collectNames(pattern.argument, names)
  else if (pattern.type === 'AssignmentPattern') collectNames(pattern.left, names)
}

function parseFailure(acorn: Acorn, source: string): Error | null {
  try {
    acorn.parse(source, OPTIONS)
    return null
  } catch (error) {
    return error instanceof Error ? error : new SyntaxError(String(error))
  }
}

function parseProgram(acorn: Acorn, source: string): { program: Program; source: string } | { error: Error } {
  const trimmed = source.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const wrapped = `(${source})`
    if (parseFailure(acorn, wrapped) === null) return { program: acorn.parse(wrapped, OPTIONS), source: wrapped }
  }
  try {
    return { program: acorn.parse(source, OPTIONS), source }
  } catch (error) {
    return { error: error instanceof Error ? error : new SyntaxError(String(error)) }
  }
}

function applyEdits(source: string, edits: Edit[]): string {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => left.edit.start - right.edit.start || left.index - right.index)
  let result = ''
  let cursor = 0
  for (const { edit } of ordered) {
    result += source.slice(cursor, edit.start) + edit.text
    cursor = Math.max(cursor, edit.end)
  }
  return result + source.slice(cursor)
}

function declarationEdits(node: VariableDeclaration, source: string, edits: Edit[], names: string[]): void {
  edits.push({ start: node.start, end: node.start + node.kind.length, text: 'var {} = [' })
  for (const declarator of node.declarations) {
    collectNames(declarator.id, names)
    if (!declarator.init && node.kind === 'var') continue
    edits.push({ start: declarator.start, end: declarator.start, text: '(' })
    edits.push({ start: declarator.end, end: declarator.end, text: declarator.init ? ')' : ' = undefined)' })
  }
  const last = node.declarations[node.declarations.length - 1]
  if (last) edits.push({ start: last.end, end: last.end, text: ']' })
  if (source[node.end - 1] !== ';') edits.push({ start: node.end, end: node.end, text: ';' })
}

function returnLastExpression(program: Program, source: string, edits: Edit[]): void {
  let lastIndex = program.body.length - 1
  while (lastIndex >= 0 && program.body[lastIndex]?.type === 'EmptyStatement') lastIndex -= 1
  const last = program.body[lastIndex]
  if (!last || last.type !== 'ExpressionStatement') return
  const close = source[last.end - 1] === ';' ? last.end - 1 : last.end
  edits.push({ start: last.start, end: last.start, text: 'return (' })
  edits.push({ start: close, end: close, text: ')' })
}

function lexicalNames(statements: readonly AnyNode[]): string[] {
  const names: string[] = []
  for (const statement of statements) {
    if (statement.type === 'VariableDeclaration') {
      const declaration = statement as unknown as VariableDeclaration
      if (declaration.kind !== 'var') for (const declarator of declaration.declarations) collectNames(declarator.id, names)
    } else if (statement.type === 'ClassDeclaration') {
      names.push((statement as unknown as ClassDeclaration).id.name)
    }
  }
  return names
}

function lexicalScope(node: AnyNode): string[] | null {
  if (node.type === 'BlockStatement') return lexicalNames(node.body as AnyNode[])
  if (node.type === 'SwitchStatement') {
    const statements: AnyNode[] = []
    for (const branch of node.cases as AnyNode[]) statements.push(...(branch.consequent as AnyNode[]))
    return lexicalNames(statements)
  }
  if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    const head = (node.type === 'ForStatement' ? node.init : node.left) as AnyNode | null
    return head !== null && head.type === 'VariableDeclaration' ? lexicalNames([head]) : null
  }
  if (node.type === 'CatchClause') {
    const param = node.param as Pattern | null
    if (param === null || param.type === 'Identifier') return null
    const names: string[] = []
    collectNames(param, names)
    return names
  }
  return null
}

function isStrict(program: Program): boolean {
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') return false
    if (statement.directive === 'use strict') return true
  }
  return false
}

const isDirective = (statement: Program['body'][number]): boolean =>
  statement.type === 'ExpressionStatement' && typeof statement.directive === 'string'

const distinct = (names: readonly string[]): string[] => names.filter((name, index) => names.indexOf(name) === index)

function rewrite(program: Program, source: string): TransformResult {
  const edits: Edit[] = []
  const names: string[] = []
  const blockFunctions: Array<{ declaration: FunctionDeclaration; wrap: boolean }> = []
  const guards = new Map<AnyNode, string[]>()
  const strict = isStrict(program)
  const topLexical = lexicalNames(program.body as unknown as AnyNode[])
  const functions = distinct(
    program.body.flatMap((statement) => (statement.type === 'FunctionDeclaration' ? [statement.id.name] : [])),
  )
  let isAsync = false

  const first = program.body.find((statement) => !isDirective(statement))
  if (first !== undefined && functions.length > 0) {
    const bindings = functions.map((name) => `this.${name} = ${name}`).join(', ')
    edits.push({ start: first.start, end: first.start, text: `var {} = [${bindings}]; ` })
  }

  const guard = (owner: AnyNode, name: string): void => {
    const list = guards.get(owner) ?? []
    if (!list.includes(name)) list.push(name)
    guards.set(owner, list)
  }

  const visit = (node: AnyNode, parent: AnyNode | null, scopes: readonly string[][], owner: AnyNode): void => {
    if (node.type === 'AwaitExpression') isAsync = true
    if (node.type === 'ForOfStatement' && node.await === true) isAsync = true
    if (node.type === 'VariableDeclaration' && parent !== null && parent.type !== 'Program') {
      const declaration = node as unknown as VariableDeclaration
      if (declaration.kind === 'var') {
        const head =
          (parent.type === 'ForStatement' && parent.init === node) ||
          ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && parent.left === node)
        if (head) {
          for (const declarator of declaration.declarations) collectNames(declarator.id, names)
          edits.push({ start: declaration.start, end: declaration.start + 3, text: '' })
        } else {
          declarationEdits(declaration, source, edits, names)
        }
      }
    }
    if (node.type === 'FunctionDeclaration' && parent !== null && parent.type !== 'Program') {
      const declaration = node as unknown as FunctionDeclaration
      const wrap = parent.type === 'IfStatement'
      const enclosing = wrap ? scopes : scopes.slice(0, -1)
      const name = declaration.id.name
      const nested = enclosing.some((scope) => scope !== topLexical && scope.includes(name))
      if (!declaration.generator && !declaration.async && !nested) {
        if (!enclosing.includes(topLexical) || !topLexical.includes(name)) blockFunctions.push({ declaration, wrap })
        else if (!strict) guard(wrap ? node : owner, name)
      }
    }
    if (parent !== null && SCOPE_BOUNDARIES.has(node.type)) return
    const scope = lexicalScope(node)
    const inner = scope === null ? scopes : scopes.concat([scope])
    const next = node.type === 'BlockStatement' || node.type === 'SwitchStatement' ? node : owner
    for (const child of childrenOf(node)) visit(child, node, inner, next)
  }

  const root = program as unknown as AnyNode
  for (const statement of program.body) {
    const node = statement as unknown as AnyNode
    if (statement.type === 'VariableDeclaration' && (statement.kind === 'var' || statement.kind === 'let' || statement.kind === 'const')) {
      declarationEdits(statement, source, edits, names)
    } else if (statement.type === 'ClassDeclaration') {
      const declaration = statement as ClassDeclaration
      names.push(declaration.id.name)
      edits.push({ start: declaration.start, end: declaration.start, text: `var {} = [${declaration.id.name} = ` })
      edits.push({ start: declaration.end, end: declaration.end, text: '];' })
    } else if (statement.type === 'FunctionDeclaration') {
      continue
    }
    visit(node, root, [topLexical], root)
  }

  for (const [owner, list] of guards) {
    const inside = owner.type === 'FunctionDeclaration'
    edits.push({ start: owner.start, end: owner.start, text: `{ let ${list.join(', ')}; ${inside ? '{ ' : ''}` })
    edits.push({ start: owner.end, end: owner.end, text: inside ? ' } }' : ' }' })
  }
  if (isAsync && !strict) {
    for (const { declaration, wrap } of blockFunctions) {
      const name = declaration.id.name
      names.push(name)
      if (wrap) edits.push({ start: declaration.start, end: declaration.start, text: '{ ' })
      edits.push({ start: declaration.end, end: declaration.end, text: ` this.${name} = ${name};${wrap ? ' }' : ''}` })
    }
  }
  const unique = distinct(names)
  const parts = unique.length > 0 ? [`var ${unique.join(', ')};`] : []
  for (const name of functions) parts.push(`function ${name}() {}`)
  const declarations = parts.join(' ')
  if (!isAsync) return { ok: true, code: applyEdits(source, edits), declarations, async: false }
  returnLastExpression(program, source, edits)
  return { ok: true, code: `(async () => {\n${applyEdits(source, edits)}\n})()`, declarations, async: true }
}

export async function transformSource(source: string): Promise<TransformResult> {
  const acorn = await loadAcorn()
  const parsed = parseProgram(acorn, source.startsWith('#!') ? `//${source.slice(2)}` : source)
  if ('error' in parsed) return { ok: false, error: `SyntaxError: ${parsed.error.message}` }
  return rewrite(parsed.program, parsed.source)
}

function endsWithLineContinuation(source: string): boolean {
  let end = source.length
  const last = source.charCodeAt(end - 1)
  if (last === 10 || last === 13 || last === 0x2028 || last === 0x2029) {
    end -= last === 10 && source.charCodeAt(end - 2) === 13 ? 2 : 1
  }
  return source.charCodeAt(end - 1) === 92
}

function isRecoverable(acorn: Acorn, source: string): boolean {
  const failure = parseFailure(acorn, source)
  if (failure === null) return false
  const position = (failure as { pos?: unknown }).pos
  if (typeof position === 'number' && position >= source.length) return true
  const message = failure.message
  if (message.startsWith('Unterminated template') || message.startsWith('Unterminated comment')) return true
  return message.startsWith('Unterminated string constant') && endsWithLineContinuation(source)
}

export async function isCompleteSource(source: string): Promise<boolean> {
  const acorn = await loadAcorn()
  if (!('error' in parseProgram(acorn, source))) return true
  if (isRecoverable(acorn, source)) return false
  return !(/^\s*\{/.test(source) && isRecoverable(acorn, `(${source}`))
}
