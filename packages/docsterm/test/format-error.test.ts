import { describe, expect, it } from 'vitest'
import { formatPythonError } from '../src/pyodide/index'

const raw = [
  'PythonError: Traceback (most recent call last):',
  'Traceback (most recent call last):',
  '  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code_async',
  '    await CodeRunner(',
  '  File "<exec>", line 1, in <module>',
  "NameError: name 'foo' is not defined",
].join('\n')

describe('formatPythonError', () => {
  it('drops pyodide-internal frames but keeps user frames and the error', () => {
    const formatted = formatPythonError(raw)
    expect(formatted).toContain('Traceback (most recent call last):')
    expect(formatted).toContain('File "<exec>", line 1, in <module>')
    expect(formatted).toContain("NameError: name 'foo' is not defined")
    expect(formatted).not.toContain('_base.py')
    expect(formatted).not.toContain('await CodeRunner')
  })

  it('returns plain messages untouched', () => {
    expect(formatPythonError('SyntaxError: invalid syntax')).toBe('SyntaxError: invalid syntax')
  })
})
