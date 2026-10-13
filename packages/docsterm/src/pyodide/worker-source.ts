const DRIVER_FILENAME = '<docsterm>'

const DRIVER_SOURCE = String.raw`
import ast
import asyncio
import builtins
import codeop
import contextvars
import functools
import linecache
import math
import os
import shlex
import signal
import sys
import time
import traceback
import warnings

import __main__
import _pyodide
import pyodide
from pyodide.code import eval_code_async

_compiler = codeop.CommandCompiler()
_compiler.compiler.flags |= ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
_state = {'inputs': 0, 'task': None, 'input_message': '', 'armed': False, 'interrupted': False}
_command = contextvars.ContextVar('docsterm_command', default=None)
_PIP_COMMANDS = ('pip', '%pip', '!pip')
_PIP_QUIET = ('-q', '--quiet')
_PIP_UPGRADE = ('-U', '--upgrade')
_USER_FILE = '<python-input-'
_MACHINERY = tuple(f'{os.path.dirname(module.__file__)}/' for module in (asyncio, pyodide, _pyodide))
_SLEEP_SLICE = 0.05
_STATUS_LIMIT = 1 << 63
PYTHON_VERSION = sys.version.split()[0]


def _boundary(frame):
    while frame is not None:
        filename = frame.f_code.co_filename
        if filename.startswith(_USER_FILE) or filename == '${DRIVER_FILENAME}':
            return filename
        if filename.startswith(_MACHINERY):
            return None
        frame = frame.f_back
    return None


def _on_interrupt(signum, frame):
    task = _state['task']
    if task is None or task.done():
        return
    boundary = _boundary(frame)
    if boundary is None:
        return
    if boundary.startswith(_USER_FILE):
        raise KeyboardInterrupt
    try:
        current = asyncio.current_task()
    except RuntimeError:
        return
    if current is not None and (current is not task or _state['armed']):
        raise KeyboardInterrupt


signal.signal(signal.SIGINT, _on_interrupt)
asyncio.get_event_loop()._keyboard_interrupt_handler = lambda: None


def _raise_if_interrupted():
    task = _state['task']
    if _state['interrupted'] and task is not None and not task.done():
        raise KeyboardInterrupt from None


_pyodide_sleep = time.sleep


@functools.wraps(_pyodide_sleep)
def _sleep(seconds):
    if not (isinstance(seconds, (int, float)) and 0 < seconds < math.inf):
        return _pyodide_sleep(seconds)
    deadline = time.monotonic() + seconds
    while True:
        _raise_if_interrupted()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            _pyodide_sleep(min(remaining, _SLEEP_SLICE))
        except asyncio.CancelledError:
            _raise_if_interrupted()
            raise


time.sleep = _sleep


def is_complete(source):
    try:
        with warnings.catch_warnings(action='ignore'):
            return _compiler(source, '<python-input>', 'single') is not None
    except BaseException:
        return True


def _input(prompt=''):
    if prompt != '':
        sys.stdout.write(f'{prompt}\n')
        sys.stdout.flush()
    raise EOFError(_state['input_message'])


_input.__name__ = 'input'
_input.__qualname__ = 'input'
builtins.input = _input


class _Quitter(type(builtins.exit)):
    def __call__(self, code=None):
        raise SystemExit(code)


builtins.exit = _Quitter('exit', 'Ctrl-D (i.e. EOF)')
builtins.quit = _Quitter('quit', 'Ctrl-D (i.e. EOF)')


def _user_traceback(tb):
    frames = []
    while tb is not None:
        frames.append(tb)
        tb = tb.tb_next
    while frames and not frames[0].tb_frame.f_code.co_filename.startswith(_USER_FILE):
        frames.pop(0)
    kept = [frame for frame in frames if frame.tb_frame.f_code.co_filename != '${DRIVER_FILENAME}']
    for frame, following in zip(kept, kept[1:] + [None]):
        frame.tb_next = following
    return kept[0] if kept else None


def _show_error(error):
    traceback.print_exception(type(error), error, _user_traceback(error.__traceback__))


def _exit_code(error):
    code = error.code
    if code is None:
        return 0
    if isinstance(code, int):
        status = int(code)
        if not -_STATUS_LIMIT <= status < _STATUS_LIMIT:
            status = -1
        return status & 0xFF
    print(code, file=sys.stderr)
    return 1


def _interrupted():
    print('KeyboardInterrupt', file=sys.stderr)
    return 130


async def _armed(awaitable):
    _state['armed'] = True
    try:
        return await awaitable
    finally:
        _state['armed'] = False


async def _evaluate(source, filename):
    result = await eval_code_async(source, __main__.__dict__, filename=filename, dedent=False)
    sys.displayhook(result)


def _pip_words(source):
    text = source.strip()
    if '\n' in text:
        return None
    try:
        words = shlex.split(text)
    except ValueError:
        return None
    if len(words) >= 2 and words[0] in _PIP_COMMANDS and words[1] == 'install':
        return words[2:]
    return None


async def _micropip(run_id):
    try:
        import micropip
    except ImportError:
        await load_package('micropip', run_id)
        try:
            import micropip
        except ImportError:
            return None
    return micropip


async def _pip_install(words, run_id):
    options = {'deps': True, 'pre': False, 'verbose': True}
    requirements = []
    for word in words:
        if word in _PIP_QUIET:
            options['verbose'] = False
        elif word == '--no-deps':
            options['deps'] = False
        elif word == '--pre':
            options['pre'] = True
        elif word in _PIP_UPGRADE:
            continue
        elif word.startswith('-'):
            print(f'ERROR: no such option: {word}', file=sys.stderr)
            return 2
        else:
            requirements.append(word)
    if not requirements:
        print('ERROR: You must give at least one requirement to install (see "pip help install")', file=sys.stderr)
        return 1
    micropip = await _micropip(run_id)
    if micropip is None:
        return 1
    try:
        await _armed(micropip.install(requirements, **options))
    except Exception as error:
        print(f'ERROR: {str(error).strip()}', file=sys.stderr)
        return 1
    return 0


async def _run(source, filename, run_id):
    _command.set(run_id)
    try:
        words = _pip_words(source)
        if words is not None:
            return await _pip_install(words, run_id)
        with warnings.catch_warnings(action='ignore'):
            loading = load_imports(source, run_id)
        await loading
        linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
        await _armed(_evaluate(source, filename))
        return 0
    except SystemExit as error:
        return _exit_code(error)
    except KeyboardInterrupt as error:
        _show_error(error)
        return 130
    except asyncio.CancelledError as error:
        if _state['interrupted']:
            return _interrupted()
        _show_error(error)
        return 1
    except BaseException as error:
        _show_error(error)
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()


def start(source, input_message, run_id):
    filename = f'{_USER_FILE}{_state["inputs"]}>'
    _state['inputs'] += 1
    _state['input_message'] = input_message
    _state['interrupted'] = False
    task = asyncio.ensure_future(_run(source, filename, run_id))
    _state['task'] = task
    return task


def _cancel_started_by(task):
    owner = task.get_context().get(_command)
    for other in asyncio.all_tasks(task.get_loop()):
        if other is not task and other.get_context().get(_command) == owner:
            other.cancel()


def cancel():
    task = _state['task']
    if task is None or task.done():
        return
    _state['interrupted'] = True
    task.cancel()
    if task.get_coro().cr_running:
        _cancel_started_by(task)
`

export const PYODIDE_WORKER_SOURCE = String.raw`
const DRIVER = ${JSON.stringify(DRIVER_SOURCE)}
const DRIVER_FILENAME = ${JSON.stringify(DRIVER_FILENAME)}
let pyodide = null
let driver = null
let buffer = null
let current = null
let cancelled = false
let chain = Promise.resolve()
const queued = new Set()
const interrupted = new Set()
const decoders = [new TextDecoder(), new TextDecoder()]

const post = (message) => self.postMessage(message)
const errorText = (error) => (error instanceof Error ? error.message : String(error))

const emit = (text, owner) => {
  if (text) post({ type: 'output', id: typeof owner === 'number' ? owner : null, text })
}

const line = (text, owner) => emit(String(text) + '\n', owner)

const NO_OP_PROGRESS = / already loaded from |^No new packages to load$/

const reporter = (owner) => ({
  messageCallback: (text) => {
    if (!NO_OP_PROGRESS.test(String(text))) line(text, owner)
  },
  errorCallback: (text) => line(text, owner),
})

const sink = (fd) => ({
  write: (bytes) => {
    emit(decoders[fd - 1].decode(bytes, { stream: true }), current)
    return bytes.length
  },
})

const flush = (owner) => {
  for (const decoder of decoders) emit(decoder.decode(), owner)
}

const uncaught = (error) => {
  const text = error instanceof Error && typeof error.type === 'string' ? error.message : String(error)
  emit(text.endsWith('\n') ? text : text + '\n', current)
}

self.addEventListener('error', (event) => {
  event.preventDefault()
  uncaught(event.error ?? event.message)
})

self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault()
  uncaught(event.reason)
})

const loaderIndexURL = async (indexURL) => {
  if (!indexURL.startsWith('file:') || typeof process !== 'object') return indexURL
  const { fileURLToPath } = await import('node:url')
  return fileURLToPath(indexURL)
}

const loadImports = async (source, owner) => {
  try {
    await pyodide.loadPackagesFromImports(source, reporter(owner))
  } catch (error) {
    line(errorText(error), owner)
  }
}

const loadPackage = async (name, owner) => {
  try {
    await pyodide.loadPackage(name, reporter(owner))
  } catch (error) {
    line(errorText(error), owner)
  }
}

const preload = async (packages) => {
  if (packages.length === 0) return
  try {
    await pyodide.loadPackage(packages, { messageCallback: () => undefined, errorCallback: () => undefined })
  } catch {
    return
  }
}

const startDriver = () => {
  const scope = pyodide.globals.get('dict')()
  scope.set('load_imports', loadImports)
  scope.set('load_package', loadPackage)
  pyodide.runPython(DRIVER, { globals: scope, filename: DRIVER_FILENAME })
  driver = { start: scope.get('start'), cancel: scope.get('cancel'), isComplete: scope.get('is_complete') }
  const python = scope.get('PYTHON_VERSION')
  scope.destroy()
  return python
}

const boot = async (request) => {
  try {
    const { loadPyodide } = await import(request.indexURL + 'pyodide.mjs')
    pyodide = await loadPyodide({ indexURL: await loaderIndexURL(request.indexURL) })
    pyodide.setStdout(sink(1))
    pyodide.setStderr(sink(2))
    pyodide.setStdin({ stdin: () => null })
    if (request.buffer) {
      buffer = request.buffer
      pyodide.setInterruptBuffer(buffer)
    }
    const python = startDriver()
    await preload(request.packages)
    post({ type: 'ready', version: pyodide.version, python })
  } catch (error) {
    post({ type: 'boot-error', message: errorText(error) })
  }
}

const run = async (request) => {
  queued.delete(request.id)
  if (interrupted.delete(request.id)) {
    post({ type: 'done', id: request.id, exitCode: 130 })
    return
  }
  current = request.id
  cancelled = false
  let exitCode = 1
  let task = null
  try {
    task = driver.start(request.code, request.inputMessage, request.id)
    exitCode = await task
  } catch (error) {
    if (cancelled) exitCode = 130
    else line(errorText(error), request.id)
  } finally {
    if (task) task.destroy()
    flush(request.id)
    current = null
    post({ type: 'done', id: request.id, exitCode })
  }
}

const interrupt = (id) => {
  if (id === current) {
    cancelled = true
    if (buffer) buffer[0] = 0
    driver.cancel()
  } else if (queued.has(id)) {
    interrupted.add(id)
  }
}

const check = (request) => {
  let complete = true
  try {
    if (driver) complete = driver.isComplete(request.source) === true
  } catch {
    complete = true
  }
  post({ type: 'checked', id: request.id, complete })
}

self.onmessage = (event) => {
  const message = event.data
  if (message.type === 'boot') {
    boot(message)
  } else if (message.type === 'run') {
    queued.add(message.id)
    chain = chain.then(() => run(message)).catch(() => undefined)
  } else if (message.type === 'interrupt') {
    interrupt(message.id)
  } else if (message.type === 'check') {
    check(message)
  }
}
`
