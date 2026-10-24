# docsterm reference

Русская версия: [reference.ru.md](./reference.ru.md) · Back to the [README](../README.md)

Everything beyond installing and a first terminal: backends, the AI layer, the control API and the widget options.

## Backends

A backend turns a command line into output and an exit code. Six ship with the package; [Writing a backend](#writing-a-backend) describes the contract for your own.

### Capability matrix

| | shell | javascript | pyodide | wasi | websocket | mock |
| --- | --- | --- | --- | --- | --- | --- |
| Runs in | the page | Web Worker | Web Worker | Web Worker (the page only with `worker: false`) | your server | the page |
| Output streams | yes | yes | yes | yes | yes | no |
| Ctrl+C | stops the command | restarts the runtime, variables are lost | `KeyboardInterrupt`; see [Python](#docstermpyodide) | stops the program | v1: `cancel`; v2 pty: SIGINT, a second press sends `cancel` | returns the prompt |
| Time limit | none | 10 s, exit 124 | none | 30 s, exit 124 | v1: 120 s without output; v2 pty: the server's | — |
| Tab completion | commands, paths, `~` | — | — | — | — | — |
| Multi-line input | `'> '` prompt | `'... '` prompt | `'... '` prompt | `'> '` prompt | `'> '` prompt | — |
| State between commands | files, cwd, variables, `$?` | variables, functions, classes | variables, imports, packages, files | none (fresh instance) | whatever the server keeps | none |
| Reads input | from pipes and files | — | `input()` raises `EOFError` | the fixed `stdin` option | v2 pty: yes | — |
| Full-screen programs | `less`, `more` | — | — | — | v2 pty: yes | — |
| CSP needs | — | `worker-src blob:`, `'unsafe-eval'` | `worker-src blob:`, CDN, `'wasm-unsafe-eval'` | `worker-src blob:`, `'wasm-unsafe-eval'` | `connect-src` for the server | — |

Details for each column are in the sections below and in [Content-Security-Policy](#content-security-policy).

### `docsterm/shell`

A shell over a virtual file system, with your own CLI as a command. It runs on the page itself and needs no network.

```ts
import { createShellBackend, type ShellCommand } from 'docsterm/shell'

const orbit: ShellCommand = async (ctx) => {
  if (ctx.argv[1] !== 'deploy') {
    return { stderr: `orbit: unknown command '${ctx.argv[1] ?? ''}'\n`, exitCode: 2 }
  }
  ctx.write?.('uploading build...\n')
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (ctx.signal?.aborted) return { exitCode: 130 }
  return 'Deployed to https://demo.orbit.app\n'
}

export const backend = createShellBackend({
  cwd: '/project',
  env: { PROJECT: 'orbit' },
  files: {
    project: {
      'README.md': '# demo app\n',
      'regions.csv': 'name,region\nalpha,eu\nbeta,us\n',
      src: { 'index.ts': 'export const answer = 42\n' },
    },
  },
  commands: { orbit },
})
```

Readers can then run `ls`, `cd src`, `grep eu regions.csv | wc -l`, `echo "Deploying $PROJECT" > notes.txt && cat notes.txt`, `find / -name "*.ts"` or `orbit deploy`, with real exit codes for `explain`.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `files` | `{}` | File tree rooted at `/`: a string is a file, an object is a directory |
| `cwd` | `/` | Start directory, created if missing |
| `env` | `HOME=/`, `SHELL=docsterm` | Environment variables (`PWD` follows `cd`) |
| `commands` | `{}` | Your commands, by name; they win over builtins with the same name |
| `prompt` | `(cwd) => cwd + ' $ '` | A string or `(cwd) => string` |
| `banner` | none | Printed once at start |
| `colors` | `true` | `ls` colours directories when its output goes to the terminal |

A command receives `ctx` with `argv` (`argv[0]` is the name), `stdin` (piped or redirected input), `cwd`, `env`, `fs` (the virtual file system), `setCwd()`, `write()`/`writeError()` (stream to the terminal, or into the pipe or file the command writes to), `signal` (aborts on Ctrl+C), `isTTY`, `colors`, `columns`, `commands`, `lastStatus` and `locale`. It returns a string (stdout), `{ stdout, stderr, exitCode }`, an [`InteractiveRun`](#interactive-programs) for a full-screen program, or a promise of one of these. Returned text is printed after anything the command streamed. `undefined` counts as success; `exitCode` wraps like a process status (`& 255`, fractions truncated, `NaN` and `Infinity` become 1); a thrown error prints `<name>: <message>` and exits 1.

**Syntax.** The reference is POSIX `sh` as `bash --posix` implements it, with GNU coreutils behaviour in a UTF-8 locale:

- pipelines `|` and `|&`, lists `&&`, `||`, `;` and newlines, negation `!`;
- redirects `>`, `>>`, `<`, `>|`, `2>`, `2>&1`, `>&2`, `&>`, `&>>`, `n>&-`, and `/dev/null`, `/dev/stdout`, `/dev/stderr`; `>&file` sends stdout and stderr to `file`, as in bash;
- single quotes, double quotes (with `$` expansion and `\` escapes) and backslashes;
- `$VAR`, `${VAR}`, `${VAR:-default}` and the other `-`, `=`, `?`, `+` forms with and without `:`, `${#VAR}`, `${VAR#pattern}`, `##`, `%`, `%%`, `$?`, `$$`, `$#`, `$0`, `$(command)` and backticks;
- `~`, brace expansion `{a,b}` and `{1..3}`, field splitting of unquoted expansions;
- globs `*`, `?`, `[abc]`, `[!abc]` and POSIX classes such as `[[:alpha:]]`; dotfiles match only when the pattern starts with `.`;
- assignments `NAME=value` and per-command `NAME=value command`;
- `#` comments;
- a trailing `\`, an unclosed quote or a trailing `|`, `&&`, `||` continues the command on a new line with the `'> '` prompt.

**Builtins:** `basename cat cd clear cp dirname echo env export false find grep head help less ls mkdir more mv printf pwd rm sleep sort tail tee touch true type uniq unset wc which`. Unknown options exit 2. `grep` supports basic (`\|`), extended (`-E`), fixed (`-F`) and `-P`, which uses JavaScript regular expressions. Tab completes commands in command position and paths elsewhere, understands quotes and `~`, escapes spaces and offers only directories after `cd`.

`less` and `more` are real pagers on the alternate screen: space/`f`/PgDn and `b`/PgUp page, `j`/Down/Enter and `k`/Up scroll, `d`/`u` move half a page, `g`/Home and `G`/End jump, `q`, `Q`, `ZZ` or Ctrl+C quit, `+G` starts at the end. They can read a pipe (`cat log | less`), their own output cannot be piped, and on a non-terminal (a file, `/dev/null`) they copy like `cat`.

**Limits.**

- Not supported: subshells `( )`, command groups `{ }`, functions, loops, `if`/`case`, here-documents and here-strings, background jobs `&`, `time`, arithmetic `$(( ))`, process substitution and `$'…'`. Such a line prints `docsterm: unsupported syntax: …`, exits 2 and runs nothing.
- `IFS` is fixed and the positional parameters are empty.
- Sorting (`ls`, globs, `sort`) uses ICU collation: punctuation and dotfiles sort before letters.
- `head -c`, `tail -c` and `printf '\xHH'` work on characters, not bytes.
- `ls missing` exits 1, as on BSD; GNU exits 2.
- Brace expansion stops at 10 000 words and 256 nesting levels.
- `grep -E` and `grep -P` run JavaScript regular expressions on the page's main thread with no time limit: a pattern with catastrophic backtracking freezes the tab.
- Missing: pager `/` search, `grep -f`, running a command through `env`, the `total` line of `ls -l`.
- The shell runs on the page's main thread: a custom command that computes synchronously for a long time blocks the page. Ctrl+C reaches commands through `ctx.signal`.

### `docsterm/javascript`

A JavaScript REPL in a Web Worker, modelled on the Node.js REPL.

```ts
import { createJavaScriptBackend } from 'docsterm/javascript'

const backend = createJavaScriptBackend({
  globals: { apiBase: 'https://api.example.com', users: ['ada', 'grace', 'linus'] },
  timeoutMs: 5000,
})
```

- The value of the last expression prints with Node-like formatting (`Map(1) { 'a' => 1 }`, `[ 1, 2 ]`, quoted strings); a returned promise is awaited.
- `const`, `let`, `class` and `function` declarations persist between commands, also with top-level `await`; running `const x = …` twice is allowed, as in DevTools.
- `console.log`, `info`, `warn`, `error`, `debug`, `table`, `dir`, `assert`, `count`, `countReset`, `time`, `timeEnd`, `group`, `groupEnd`, `trace` and the `%s %d %i %f %o %O %c` specifiers print to the terminal as they happen.
- Incomplete code continues with the `'... '` prompt (parsed with acorn, which loads when the backend starts).
- There is no DOM. Relative URLs (`/`, `./`, `../`) resolve against the page in `fetch`, `Request`, `XMLHttpRequest`, `importScripts` and `new URL()`; dynamic `import()` needs an absolute URL.
- Ctrl+C terminates the worker and starts a fresh one at once (exit 130, `runtime restarted, variables were reset`). A command that runs longer than `timeoutMs` ends the same way with exit 124.
- A line that starts with `#` is a syntax error here: pasted or `run()` lines go to the backend, see [The terminal](#the-terminal).

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `10000` | Wall-clock limit per command; `0`, a negative or a non-finite value disables it |
| `initTimeoutMs` | `10000` | How long the worker may take to report ready |
| `outputLimit` | `1048576` | Characters of output per command; the rest is dropped with a note |
| `globals` | none | Values defined in the worker; copied once with `structuredClone`, so functions and DOM objects are refused |
| `baseURL` | `document.baseURI` at each worker start | Base for relative URLs |
| `prompt` | `'> '` | Prompt |
| `banner` | none | Printed once the worker is ready |
| `createWorker` | a `blob:` worker running `WORKER_SOURCE` | Your own worker |

A custom `createWorker` must speak the 0.8 protocol: the host posts `{ type: 'init', globals, baseURL }` and then `{ type: 'run', id, code, declarations, columns, outputLimit }`; the worker answers `{ type: 'ready', evalBlocked }`, `{ type: 'log', id, text }` and `{ type: 'result', id, value?, error? }` (types `HostMessage` and `WorkerMessage`). The simplest custom worker runs the exported `WORKER_SOURCE`, for example served as a file from your origin instead of a `blob:` URL; a worker loaded from a URL follows the CSP of its own HTTP response. The worker type is the shared, DOM-free `WorkerLike`, so a real `Worker` fits without a cast.

### `docsterm/pyodide`

CPython compiled to WebAssembly ([Pyodide](https://pyodide.org)), running in a module Web Worker, so a busy loop never freezes the page and Python cannot reach the page's DOM or `localStorage`.

```ts
import { createPyodideBackend } from 'docsterm/pyodide'

const backend = createPyodideBackend({ packages: ['micropip', 'numpy'] })
```

- The banner shows the real versions (`Python 3.x (pyodide 314.0.7)`); expression results print with `repr()`, and `_` holds the last one.
- Blocks continue with the `'... '` prompt and end with an empty line; top-level `await` works.
- Imports of packages that ship with Pyodide (numpy, pandas…) load automatically.
- `pip install <package>` (also `%pip` and `!pip`; `-q`, `--pre`, `--no-deps` and `-U` are accepted) installs pure-Python wheels from PyPI and Pyodide packages through micropip.
- `input()` prints its prompt and raises `EOFError: reading input is not supported in this terminal`.
- `exit()`, `quit()` and `sys.exit(n)` end the command with status `n & 0xFF` (`True` is 1; a non-integer code is printed and gives 1).
- Files live in Pyodide's in-memory file system and disappear on reload or restart.
- After Ctrl+C the terminal shows only `^C`, as with the other backends.
- For production, self-host the runtime with `indexURL`: from the CDN the files load without an integrity check.

What Ctrl+C does depends on cross-origin isolation, that is, whether the page is served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (every cross-origin resource the page loads then needs CORS or `Cross-Origin-Resource-Policy`):

| Running code | Cross-origin isolated | Not isolated |
| --- | --- | --- |
| A busy loop | `KeyboardInterrupt`, variables kept | the runtime restarts after 0.5 s and variables are lost |
| `await`, asyncio tasks | `KeyboardInterrupt`, variables kept | cancelled in place, variables kept |
| `time.sleep()` | `KeyboardInterrupt`, variables kept | interrupted in place where the browser supports JSPI (Chromium); elsewhere it restarts like a busy loop |

If a command has not stopped 0.5 s after Ctrl+C (3 s when isolated), the runtime restarts and prints `runtime restarted, variables were reset`. A bare `run_sync(promise)` cannot be cancelled and always ends this way. Output printed by background tasks of an earlier command appears in whichever command runs at the time, and a partial line printed between commands appears at the end of the next one.

| Option | Default | Meaning |
| --- | --- | --- |
| `indexURL` | `https://cdn.jsdelivr.net/pyodide/v314.0.7/full/` | Where the runtime loads from. A relative value resolves against `document.baseURI`. A self-hosted folder needs `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json` and the wheels you use |
| `packages` | `['micropip']` | Loaded at start; a list replaces the default; failures do not stop the start |
| `prompt` | `'>>> '` | Prompt |
| `createWorker` | a `blob:` module worker | `(source) => WorkerLike`; for example a module worker served from your origin with `PYODIDE_WORKER_SOURCE` when the CSP forbids `blob:` workers. The worker global must support `addEventListener` for `error` and `unhandledrejection` (every browser worker does) |

Other exports: `DEFAULT_PYODIDE_VERSION` (`'314.0.7'`, also as `PYODIDE_VERSION`), `PYODIDE_WORKER_SOURCE`, the `PyodideWorker` type and `formatPythonError`, which the backend no longer uses.

### `docsterm/wasi`

Runs one program compiled to `wasm32-wasi` with docsterm's own WASI preview1 host.

```bash
cargo build --release --target wasm32-wasip1     # Rust
zig build-exe -target wasm32-wasi main.zig       # Zig
GOOS=wasip1 GOARCH=wasm go build -o greet.wasm    # Go
```

```ts
import { createWasiBackend } from 'docsterm/wasi'

const backend = createWasiBackend({
  url: '/greet.wasm',
  program: 'greet',
  usage: 'greet <name>',
  env: { RUST_LOG: 'info' },
})
```

The reader types `greet "Ada Lovelace"`. Supported: arguments, environment, stdout and stderr (in order and streamed), exit codes, clocks, sleep and random numbers. Standard input is the fixed `stdin` option: what the reader types never reaches the program. Every other WASI call (files, sockets…) returns `ENOSYS`, so the program starts and takes its own error path: Rust's `std::fs` returns an error, Go's `os.ReadFile` fails, a hello world, argument parsing and `thread::sleep` work.

- One program per line. Quotes, backslash escapes and `#` comments work; a trailing `\` or an open quote continues with the `'> '` prompt; blank and comment-only lines are allowed.
- Pipes, redirects, `&&`, `;`, variables, backticks, parentheses or a second command on another line print `pipes, redirects and variables are not supported in this terminal` (exit 2). Another program name prints `name: command not found (this terminal runs greet)` (exit 127).
- Each command gets a fresh instance, so one run cannot corrupt the next.
- Programs run in a Web Worker: Ctrl+C stops them (exit 130) and `timeoutMs` ends runaway loops (exit 124); a trap exits 1. On a page that is not cross-origin isolated, `sleep` busy-waits inside the worker, which keeps one CPU core busy but not the page.
- There is no silent fallback. When the worker cannot start (a CSP that blocks `blob:` workers, no `Worker` in the environment, a failing custom worker, or no ready message within `initTimeoutMs`), `init()` rejects or the commands fail with exit 1 and a localized reason such as `blocked by the page Content-Security-Policy (needs worker-src blob:)`. Chromium reports a blocked `blob:` worker late, so the reason may appear at the first command instead of at start.
- Programs run on the page only with `worker: false` or a custom `instantiate`. Then the page is blocked while a program runs, Ctrl+C cannot stop it, the time limit is checked only at system calls, `sleep` busy-waits, and a pure compute loop freezes the tab.

| Option | Default | Meaning |
| --- | --- | --- |
| `url`, `bytes`, `instantiate` | — | Where the module comes from (one is required). `url` is downloaded and compiled once at start; an HTTP error or an HTML page fails the start (`cannot download …: HTTP 404`, `not a WebAssembly module: …`) |
| `program` | `main` | The command name readers type |
| `args` | `[]` | Arguments inserted before the reader's |
| `env` | `{}` | Environment variables |
| `stdin` | `''` | Fixed standard input of every run |
| `usage` | none | Usage line shown by `help` and given to the AI |
| `prompt` | `'$ '` | Prompt |
| `banner` | none | Printed once at start |
| `timeoutMs` | `30000` | Limit per command; `0`, negative or non-finite disables it |
| `initTimeoutMs` | `10000` | How long the worker may take to start; then commands fail with `the WebAssembly worker did not start within … s` |
| `outputLimit` | `1048576` | Characters of output per command; after a note the rest is dropped while the program keeps running |
| `worker` | `true` | `false` runs programs on the page (see above) |
| `createWorker` | a `blob:` worker | `(source) => WorkerLike`, for example a file served from your origin with `WASI_WORKER_SOURCE` |

Exit codes: the program's status `& 255`; 1 for a trap or a crashed worker; 2 for a rejected command line; 124 for the time limit; 127 for another program name; 130 for Ctrl+C. Other exports: `createWasiHost`, `splitCommandLine` (throws `CommandLineError`), `isCompleteCommandLine`, `WASI_WORKER_SOURCE`.

### `docsterm/websocket`

Sends commands to a server you run. The [reference server](../examples/websocket-server/README.md) gives every reader one disposable Docker container and a real pseudo-terminal; read its security section before you deploy anything.

```ts
import { createWebSocketBackend } from 'docsterm/websocket'

const backend = createWebSocketBackend({
  url: 'wss://sandbox.example.com/',
  prompt: 'sandbox:~$ ',
  description: 'An Alpine Linux container with git and curl.',
})
```

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | — | Server URL (`wss://` on HTTPS pages) |
| `protocols` | none | WebSocket subprotocols |
| `prompt` | `'$ '` | Prompt until the server sends its own (feature `prompt`) |
| `banner` | none | Printed on the first connection |
| `description` | none | Text for `help` and the AI |
| `token` | none | Sent as `{"type":"auth","token":…}`, the first message on every new socket |
| `timeoutMs` | `120000` | Protocol v1 only: a command that prints nothing for this long is cancelled (exit 124); `0` disables it |
| `connectTimeoutMs` | `15000` | Limit for opening the socket |
| `readyTimeoutMs` | `1500` | How long `init()` waits for `ready` after the socket opens |
| `createSocket` | `new WebSocket(url, protocols)` | Your own socket; a DOM `WebSocket` fits `SocketLike` without a cast |

**Protocol v1** (every server). All frames are JSON text.

| Direction | Message | Meaning |
| --- | --- | --- |
| client → server | `{"type":"run","id":1,"command":"ls -l","locale":"en"}` | run a command; the optional `locale` (`en` or `ru`) lets the server localize its own notices, and servers that do not know it ignore it |
| client → server | `{"type":"cancel","id":1}` | stop command 1 (Ctrl+C, the time limit) |
| client → server | `{"type":"auth","token":"…"}` | first message, only with the `token` option |
| server → client | `{"type":"ready","banner":"…"}` | the session is open; `banner` is optional |
| server → client | `{"type":"output","id":1,"chunk":"…"}` | output of command 1 |
| server → client | `{"type":"exit","id":1,"code":0}` | command 1 finished |

**Protocol v2** adds, when `ready` carries `"protocol":2` and `features`:

| Direction | Message | Meaning |
| --- | --- | --- |
| server → client | `{"type":"ready","protocol":2,"features":["pty","resize","prompt","ping"],"prompt":"sandbox:~$ "}` | the server's features; `prompt` is optional |
| client → server | `{"type":"run","id":1,"command":"vi","columns":80,"rows":24}` | `columns`/`rows` are sent with `pty` or `resize` |
| client → server | `{"type":"stdin","id":1,"data":"y\r"}` | raw keys for the running command |
| client → server | `{"type":"resize","columns":120,"rows":40}` | the terminal was resized during a pty command |
| client → server | `{"type":"ping"}` | heartbeat |
| server → client | `{"type":"exit","id":1,"code":0,"prompt":"sandbox:~/app$ "}` | `prompt` follows the working directory |
| server → client | `{"type":"pong"}` | answer to `ping` |

- `pty`: `run()` returns an interactive run. Every key, Ctrl+C included, goes to the server as `stdin`, so the remote line discipline echoes, edits lines and turns Ctrl+C into SIGINT; a second Ctrl+C within a second sends `cancel`. Output reaches xterm untouched, so `vi`, `top`, `less` and `read` prompts work. Pty commands have no client time limit; the server's own limit applies.
- `resize`: resizes during a pty command are sent at once; a resize while idle reaches the server with the next command's `columns`/`rows`.
- `prompt`: the widget's prompt follows `ready.prompt` and `exit.prompt`.
- `ping`: the client pings every 20 s, and any valid server message counts as a sign of life. After 60 s of silence the running command ends with `the server stopped answering, connection dropped` (exit 1), and the client reconnects after 0.5, 1, 2, 4 and 8 s with a notice for each attempt. After five failures the next command tries again; a reconnect to a v2 server says that a new session started.

Rules for servers:

- Echo the `id` of every `output` and `exit`. Messages without an id (or with `null`) are accepted only while no cancelled command is waiting for its `exit`.
- Answer `cancel` with an `exit` (130 by convention).
- Send `ready` right after accepting the connection.

What the client does:

- `init()` resolves on `ready` or `readyTimeoutMs` after the socket opens, whichever comes first; until a `ready` arrives the client speaks v1, and a later `ready` banner is printed above the prompt.
- A conservative POSIX check (quotes, `$( )`, backticks, here-documents, `if`/`case`/loops, `{ }`, `( )`, a trailing `\`, `|`, `&&`, `||`) keeps an unfinished command open with the `'> '` prompt, and the lines go to the server as one command. The check leans towards "complete", so a real syntax error comes back from the server; Ctrl+C drops an unfinished command. A non-shell program behind the server gets the same shell rules.
- When the server closes the connection, the terminal prints `connection closed by the server (code: reason)`, a running command ends with exit 1, and the next command reconnects once (`reconnecting...`) or fails with `not connected to the server`. Features, protocol and prompt reset on every disconnect. A command typed while an automatic reconnect waits for `ready` waits for it (or `readyTimeoutMs`) before choosing v1 or v2.
- Connection errors show only the scheme, host, port and path of the server URL; tokens, credentials and fragments are never printed.

The [reference server](../examples/websocket-server/README.md) speaks v2 and adds limits of its own, all configurable. Its notices start with `docsterm-server:` and follow the `locale` of the command. `ready` may arrive without a prompt, which then comes with the first `exit`. A session ends after 30 minutes with a notice and close code 1000; a client that stops reading output is dropped (the browser sees close code 1006); input beyond its rate budget, such as a very long paste, is dropped.

The token is visible to every script on the page and to the reader. Use short-lived per-reader tokens that your docs backend issues, and prefer the `token` option to a `?token=` URL parameter: URLs end up in logs. The sandbox, every limit and its setting are described in the [reference server README](../examples/websocket-server/README.md).

### `docsterm/mock`

Fixed outputs for tutorials, tests and offline demos.

```ts
import { createMockBackend } from 'docsterm/mock'

const backend = createMockBackend({
  script: {
    'orbit init': { output: 'Project initialized.' },
    'orbit deploy': { output: 'Deploying...\nDeployed to https://demo.orbit.app', delayMs: 800 },
  },
  fallback: { output: 'try: orbit init', exitCode: 127 },
})
```

A command matches a `script` key exactly (after trimming). Without `fallback`, unknown commands print `command not found: <command>` with exit 127. `prompt` (default `'$ '`) and `banner` are optional.

## The terminal

The terminal is xterm.js driven by a line editor, with streaming output, cancellation and full-screen programs.

| Keys | Action |
| --- | --- |
| Enter | Run the line, or continue a multi-line command |
| ← → | Move by character (also Ctrl+B, Ctrl+F) |
| Alt+← Alt+→, Ctrl+← Ctrl+→ | Move by word (also Alt+B, Alt+F) |
| Home End | Start or end of the line (also Ctrl+A, Ctrl+E) |
| Backspace, Delete | Delete before or after the cursor (Ctrl+D deletes after it) |
| Ctrl+W, Ctrl+Backspace, Alt+Backspace | Delete the previous word |
| Alt+D, Ctrl+Delete | Delete the next word |
| Ctrl+U, Ctrl+K | Delete to the start, to the end |
| Ctrl+Y | Paste the last deleted text |
| Ctrl+T | Swap the two characters before the cursor |
| ↑ ↓ | Walk the history |
| Tab | Complete (when the backend supports it): one match is inserted, a shared prefix grows the word, several matches are listed |
| Ctrl+L | Clear the screen and keep the line |
| Ctrl+C | Stop the running command, AI request or y/N question; otherwise drop the line |
| Ctrl+Shift+C, Ctrl+Shift+V | Copy, paste |
| Shift+Tab, or Esc then Tab | Move the focus out of the terminal |

On Windows and Linux, Ctrl+C with a selection copies, and Ctrl+F, Ctrl+P, Ctrl+S and Ctrl+G go to the browser unless an interactive program runs. On macOS, Option+letter types a character, so use the arrow combinations there. There is no Ctrl+R search.

- **History** keeps 200 lines: typed, pasted and `run()` lines, every line of a multi-line command, and accepted one-line AI commands; blank lines, a line equal to the previous one and y/N answers are skipped. Edits to a recalled line are kept until Enter. The `history` builtin lists it.
- **Builtins** on top of every backend: `help` (commands, keys and the backend's description), `clear`, `history`, `explain` (AI explanation of the last failed command) and `#<request>`. They match only when the whole line is the word: `help;` or `print(help)` reaches the backend, which is how you read a REPL variable named `help`. Like `#`, `explain` asks the AI only when typed; from a paste, `run()` or a Run button it goes to the backend.
- **Pasting** uses bracketed paste: line endings are normalised, escape sequences and control characters dropped, tabs become four spaces, and every line runs in turn at its own prompt. A paste is one unit from its first start marker to its last end marker, so clipboard text containing a fake end-of-paste sequence cannot break out of it.
- **Type-ahead**: keys typed while a command runs appear at the next prompt; keys typed before an interactive program takes over are delivered to it. Anything typed or pasted before a y/N question appears is discarded.
- **Output while idle** (a late log line, a server notice) is printed above the prompt, and the line being typed is kept.
- **Full-screen programs** get raw keys and may use the alternate screen. A paste reaches a program the way xterm sends it, wrapped in bracketed-paste markers only if the program turned bracketed paste on. After a program ends, the widget leaves the alternate screen if needed and resets terminal modes before the next prompt.
- **Widget messages** (welcome, help, errors, AI notes) wrap at word boundaries to the terminal width; backend output, suggested commands and history rows are printed as they are.

### Asking the AI

With an AI provider configured:

- `#<request>`, for example `#find large log files`: the AI answers with one command and a one-sentence explanation. The explanation is printed first, the command directly above `run it? [y/N]`, and nothing runs without `y` or `yes` (with the Russian locale also `д` or `да`). A command too tall for the screen is refused.
- `explain` streams an explanation of the last failed command, using the first 500 and last 1500 characters of its output.
- The AI sees the page title, description and headings, the backend's description and the last five commands.

**`#` asks the AI only for typed lines.** The line goes to the AI only when its first non-blank character was typed by the reader: typing `#` and then pasting the question still asks the AI, and a line recalled from history counts as typed. Lines that come from a paste, `run()`, `insert()` or a Run button go to the backend unchanged: `#` is a comment in sh and Python, so pasted snippets with comments never start paid requests. In the JavaScript backend such a line is a syntax error. Without an AI provider, every `#` line goes to the backend.

## AI providers

An `AIProvider` has two methods, `suggestCommand` and `explainError`. Two providers ship with the package, and `createMockAIProvider` from `docsterm` serves offline demos and tests.

```ts
import { createAnthropicProvider } from 'docsterm/anthropic'
import { createOpenAIProvider } from 'docsterm/openai'

const claude = createAnthropicProvider()
const openRouter = createOpenAIProvider({ preset: 'openrouter', model: 'openai/gpt-6-luna' })
const localModel = createOpenAIProvider({ preset: 'ollama', model: 'llama3.2' })
const gateway = createOpenAIProvider({ baseURL: 'https://gateway.example.com/v1', model: 'internal-fast' })

export const providers = [claude, openRouter, localModel, gateway]
```

### Anthropic

`createAnthropicProvider(options)` uses the official SDK in browser mode; the SDK loads on the first request.

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | the reader's key from `localStorage` (`docsterm:anthropic-key`), only for api.anthropic.com | API key |
| `baseURL` | api.anthropic.com | Another endpoint, for example your proxy; no key is required, and a stored reader key is never sent there |
| `model` | `claude-opus-5-5` | Model |
| `maxTokens` | `8192` | Output limit |
| `effort` | `'low'` for models with effort support, otherwise not sent | `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'` or `false` |
| `fallbacks` | on for Fable 5.1, Mythos, Opus 5.x and Sonnet 5.5 | Server-side fallback models (`fallbacks: 'default'` with the `server-side-fallback-2026-07-01` beta); Bedrock, Vertex AI and Foundry reject it, so pass `false` there |
| `clientFactory` | the SDK client in browser mode | `(apiKey) => client` or a promise of one; a real `Anthropic` instance fits without a cast. It receives `undefined` when no key is configured and must then send no credentials |

Models with effort support: Opus 4.5 and newer, Sonnet 4.6 and newer, Haiku 5.5 and newer, Fable, Mythos. Suggestions request structured JSON output; explanations stream. If the API answers 400 and names `effort`, the output format or `fallbacks`, the provider retries once without that field and remembers the rejection until the page reloads. When the format is dropped, the prompt spells out the JSON shape instead. A remembered rejection can hide a mistake such as `effort: 'xhigh'` on a model without it.

### OpenAI-compatible endpoints

`createOpenAIProvider(options)` speaks `/chat/completions` with plain `fetch` and needs no dependency.

| Option | Default | Meaning |
| --- | --- | --- |
| `model` | — (required) | Model name |
| `preset` | `openai` when there is no `baseURL` | One of the presets below |
| `baseURL` | the preset's URL | Your endpoint, for example a gateway or a proxy |
| `apiKey` | the reader's key from `localStorage` | API key; optional for local presets and for a custom `baseURL` |
| `keyName` | `docsterm:key:<preset>` or `docsterm:key:<host[:port]>` | Where the reader's key is stored |
| `maxTokens` | `4096` | Output limit |
| `tokenParam` | per preset | `'max_tokens'` or `'max_completion_tokens'` |
| `jsonMode` | per preset | `'schema'` (strict JSON schema), `'object'` (`json_object`) or `'off'` |
| `stream` | `true` | Stream explanations over SSE |
| `headers` | none | Extra request headers |
| `id` | the preset | Provider id |
| `fetchImpl` | `fetch` | Your `fetch` |

| Preset | Base URL | Token parameter | JSON mode |
| --- | --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | `max_completion_tokens` | schema |
| `openrouter` | `https://openrouter.ai/api/v1` | `max_tokens` | object |
| `groq` | `https://api.groq.com/openai/v1` | `max_completion_tokens` | object |
| `deepseek` | `https://api.deepseek.com/v1` | `max_tokens` | object |
| `mistral` | `https://api.mistral.ai/v1` | `max_tokens` | object |
| `together` | `https://api.together.xyz/v1` | `max_tokens` | object |
| `xai` | `https://api.x.ai/v1` | `max_tokens` | object |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `max_tokens` | object |
| `ollama` | `http://localhost:11434/v1` | `max_tokens` | object, no key needed |
| `lmstudio` | `http://localhost:1234/v1` | `max_tokens` | schema, no key needed |
| custom `baseURL` | — | `max_tokens` | object |

If a suggestion request gets a 400 whose body mentions `response_format`, it is sent once more without it; the answer is then read from free text. The reader's key is bound to the endpoint: `defaultKeyName({ preset, baseURL })` returns the slot to store it in (`docsterm:key:openai` for OpenAI). The 0.7 slot `docsterm:openai-key` is no longer read, because it could hold another vendor's key; `OPENAI_KEY_NAME` is still exported but unused. A custom `baseURL` that is not one of the hosted presets needs no key, and without one no `Authorization` header is sent.

### Local models

The `ollama` and `lmstudio` presets talk to a model on the reader's own machine, without a key. A deployed docs site needs three things:

- Ollama accepts cross-origin requests only from `localhost` by default. The reader starts it with your origin allowed: `OLLAMA_ORIGINS=https://docs.example.com ollama serve`.
- LM Studio needs CORS enabled in its local server settings.
- Chrome's Local Network Access asks the reader for permission the first time a public site calls `localhost`. If they decline, the request fails with `cannot reach the AI service.`

### Keys, errors and answers

Keys are bring-your-own. The reader's key lives in their `localStorage` under the slot above (`keyStore.set(name, value)` and `keyStore.clear(name)` from `docsterm` manage it; see `demo/src/ai-settings.ts` for a settings form) and is sent only to the configured endpoint. Every script on your origin can read `localStorage`, so a cross-site scripting bug or a third-party script can steal it. Never put your own key into `apiKey` on a public page: every reader can read it from the bundle. To pay for readers' requests yourself, run a proxy that adds the key on the server and point the provider at it; neither provider then needs a key in the browser:

```ts
import { createAnthropicProvider } from 'docsterm/anthropic'
import { createOpenAIProvider } from 'docsterm/openai'

export const viaAnthropicProxy = createAnthropicProvider({ baseURL: 'https://docs.example.com/api/anthropic' })

export const viaOpenAIProxy = createOpenAIProvider({
  baseURL: 'https://docs.example.com/api/openai/v1',
  model: 'gpt-6-luna',
})
```

A keyless Anthropic request sends neither `x-api-key` nor `Authorization`.

Errors appear in the reader's language. A missing key, a refusal, a cut-off answer, an empty or unusable answer and a network failure each have their own message. A server error appears as `AI request failed: <status>: <message>`, where the message comes from `error.message`, a string `error`, `message` or a string `detail` in the response (cleaned, one line, at most 300 characters); HTML or empty bodies show `the AI service reported an error`. Providers throw `AIProviderError` with a `code` (`key-missing`, `refused`, `truncated`, `empty`, `invalid`, `http`, `network`) and a DOM `AbortError` after cancellation.

From a suggestion, both providers take the first JSON object with a non-empty string `command`, ignoring prose around it. The command is stripped of escape sequences and control characters; one longer than 2000 characters is refused, and so is one that contains invisible or formatting characters (bidirectional controls, zero-width characters, line separators, unassigned code points), because they can make the command on screen differ from the one that runs. An emoji joined with zero-width joiners is refused for the same reason. Such characters are removed from the explanation. A multi-line command is shown line by line and sent to the backend as one string.

## Control API

The page can drive the terminal: run the command from a code block, prefill a command for the reader to edit, or see where readers fail.

```ts
import '@xterm/xterm/css/xterm.css'
import { DocsTerminal, isAbortError, type DocsTerminalEvent } from 'docsterm'
import { createShellBackend } from 'docsterm/shell'

const terminal = new DocsTerminal({
  backend: createShellBackend({ cwd: '/project' }),
  onEvent: (event: DocsTerminalEvent) => {
    if (event.type === 'command' && event.exitCode !== 0) console.info('failed:', event.command)
  },
})

const container = document.querySelector<HTMLElement>('#terminal')
if (container) terminal.mount(container).catch((error: unknown) => console.error(error))

try {
  const report = await terminal.run('mkdir -p app && cd app && pwd')
  console.info(report.exitCode, report.output)
} catch (error) {
  if (!isAbortError(error)) throw error
}

terminal.insert('orbit deploy --env ')
terminal.focus()
```

| Member | What it does |
| --- | --- |
| `mount(element)` | Opens the terminal inside `element` and starts the backend. Resolves when the first prompt is shown. Throws at once if already mounted; rejects with the backend's error (also printed in the terminal with a reload hint) or with an `AbortError` when `dispose()` runs first |
| `run(text)` | Runs `text` as if it were pasted and followed by Enter; resolves with a `RunReport` |
| `insert(text)` | Types `text` at the cursor without Enter; line breaks become spaces |
| `clear()` | Clears the screen and the scrollback, keeping the typed line |
| `focus()` | Focuses the terminal |
| `element` | The terminal's own element inside your container, or `null` |
| `setOptions(patch)` | Changes live options, see [Widget options](#widget-options) |
| `setTheme`, `setLocale`, `setAI`, `setPageContext`, `setOnEvent` | Shortcuts for one option |
| `dispose()` | Removes the terminal, cancels running work and disposes the backend if it was started. The same instance can `mount()` again |

**`run(text)`**

- Multi-line text runs line by line, and continuation applies. One trailing newline is dropped. If the text leaves a multi-line command unfinished, one empty line is added, which ends a Python block: `'for i in range(3):\n    print(i)'` runs. If the command is still unfinished, nothing runs: the terminal prints `^C`, the promise resolves with exit 2, and an `error` event (phase `'run'`) says `incomplete command: it needs more lines, so it did not run`.
- Tabs are kept and shown as four spaces.
- Before mount, while the backend starts, and while the terminal is busy, the lines wait in the input queue.
- While a y/N question or a full-screen program is on screen, API input waits: it never answers the question or reaches the program. Keys the reader types keep flowing.
- A line the reader has half typed, and a multi-line command they have not finished, are set aside and restored after the last line has run, so clicking a `/tmp/x` block while the reader has typed `rm -rf` and a space never runs `rm -rf /tmp/x`. If the reader types while the run is in progress, the new input wins and the set-aside line goes to the history, where ↑ finds it. `insert()` merges into the reader's line instead.
- The promise resolves with `{ exitCode, output }` of the last command. Ctrl+C drops the lines still waiting and resolves 130 with the partial output of the running command. `help`, `clear` and `history` report 0 with the text they printed; `explain` and `#` lines go to the backend.
- `output` is what the command printed on the normal screen plus its returned output, with escape sequences and control characters removed, cut to the last 4096 characters. Output drawn on the alternate screen (`less`, `vi`) is not included.
- `dispose()` rejects waiting and running calls with an `AbortError` (check with `isAbortError`), and later calls reject until the next `mount()`. After a failed mount, calls reject with the mount error.

**Events** (the `onEvent` option, `setOnEvent()`, or `setOptions({ onEvent })`):

| Event | Fields | When |
| --- | --- | --- |
| `ready` | — | The backend started, before the first prompt and before `mount()` resolves |
| `command` | `command`, `source`, `exitCode`, `durationMs` | A command finished, including `help`, `clear` and `history`. `source` is `'typed'`, `'paste'`, `'api'` or `'ai'`; a multi-line command reports its lines joined with `\n` |
| `interrupt` | `command?` | Ctrl+C while something runs: with `command` for a running command or program (every Ctrl+C sent to a program counts), without it for an AI request. Not at an idle prompt or during continuation |
| `ai-suggest` | `request`, `command?`, `accepted?` | A `#` request ended: answered y/N (`command`, `accepted`), Ctrl+C at the question (`accepted: false`), or failed and unusable answers (no `command`) |
| `ai-explain` | `command` | `explain` started for the last failed command |
| `error` | `phase`, `message` | `'init'`: the mount failed (not when `dispose()` interrupts it); `'run'`: the backend threw, or a `run()` text stayed incomplete; `'ai'`: an AI request failed |

Order: an accepted suggestion gives `ai-suggest` and then `command` with source `'ai'`; a backend exception gives `error` (`'run'`) and then `command` with exit code 1; an AI failure gives `error` (`'ai'`) and then `ai-suggest` without `command`. `explain` emits `ai-explain` (and `error` if the request fails), never `command`. An exception in your listener is logged and never breaks the session.

**Privacy.** Events carry the command text, `ai-suggest` carries the reader's request, error messages may echo input, and `RunReport.output` may contain whatever the reader printed, secrets included. Decide what goes to your analytics.

## Run buttons

`attachRunButtons(root, terminal, options?)` adds a run button to code blocks.

```html
<pre data-docsterm-run><code>$ orbit init
Project initialized.
$ orbit deploy</code></pre>
```

```ts
import { attachRunButtons, DocsTerminal } from 'docsterm'
import { createShellBackend } from 'docsterm/shell'

const terminal = new DocsTerminal({ backend: createShellBackend() })
const container = document.querySelector<HTMLElement>('#terminal')
if (container) terminal.mount(container).catch((error: unknown) => console.error(error))

const detach = attachRunButtons(document.body, terminal)
window.addEventListener('pagehide', detach, { once: true })
```

- The default selector is `pre[data-docsterm-run] code, code[data-docsterm-run]`; pass `selector` for another, for example `'pre > code.language-bash'`.
- If a block has lines starting with a prompt (`prompts`, default `['$ ', '% ']`), only those commands run, without the prompt; the other lines count as shown output. A command continues on the next line after a trailing `\`, or on lines starting with `>` and a space. A block without prompts runs whole.
- Lines are read the way the block is displayed: `<br>` and line elements (`div`, `p`, `li`, and the `.token-line`, `.ec-line` and `.line` classes of Docusaurus, Expressive Code and Shiki) end a line. Text hidden from the reader (`hidden`, `aria-hidden="true"`, `display: none`, `visibility: hidden`) is never run; a block inside a closed tab or `<details>` keeps its button. A block without a command gets no button.
- The button is a `<button type="button" class="docsterm-run">` in one shared `span.docsterm-run-bar` at the top right of the `<pre>`, so buttons from several calls never overlap. It is labelled `run` (`запустить` in Russian), with an `aria-label` that names the first command. The language is the `locale` option, else the nearest `lang` attribute, else the browser's.
- A click scrolls the terminal into view, focuses it and calls `run()`; the button is disabled until the run finishes.
- One small stylesheet is added per document (or shadow root) and removed with the last cleanup. Its rules use `:where()`, so your CSS wins. With `styles: false` nothing is injected and you style `.docsterm-run` yourself, for example under a CSP that forbids inline styles.
- Nothing watches the page. After client-side navigation, call the returned cleanup and attach again; a block that already has a button is skipped.
- `terminal` is anything with `run(text)` and `focus()`: a `DocsTerminal`, a `<docs-terminal>` element or a React ref handle. The terminal is scrolled into view when it has an `element` or is an element itself.

## React

```tsx
import '@xterm/xterm/css/xterm.css'
import { useRef, useState } from 'react'
import type { DocsTerminalEvent } from 'docsterm'
import { DocsTerminal, type DocsTerminalHandle } from 'docsterm/react'
import { createShellBackend } from 'docsterm/shell'

export function ShellTutorial({ dark }: { dark: boolean }) {
  const [backend] = useState(() => createShellBackend({ cwd: '/project' }))
  const terminal = useRef<DocsTerminalHandle>(null)
  const track = (event: DocsTerminalEvent) => {
    if (event.type === 'error') console.warn(event.message)
  }
  return (
    <>
      <button type="button" onClick={() => void terminal.current?.run('ls -la')}>
        list files
      </button>
      <DocsTerminal
        ref={terminal}
        backend={backend}
        theme={dark ? 'dark' : 'light'}
        aria-label="Project shell"
        onEvent={track}
        style={{ height: 320 }}
      />
    </>
  )
}
```

- Props are the [widget options](#widget-options) plus `onReady(terminal)`, `onError(error)` and the container attributes `id`, `title`, `role`, `className`, `style`, `aria-*` and `data-*`. `aria-label` labels the terminal itself unless `ariaLabel` is set.
- A new `backend` object remounts the terminal and wipes the session, so create it once: `useState(() => createXBackend())` or module scope. A backend created inline in render remounts on every re-render.
- `theme`, `locale`, `ai`, `pageContext`, `fontFamily`, `fontSize`, `ariaLabel`, `screenReaderMode` and `onEvent` update live; `welcome` applies at mount.
- The ref handle has `run`, `insert`, `focus` and `clear`. `run()` rejects with an `AbortError` while no terminal is mounted.
- StrictMode's mount, unmount, mount sequence leaves exactly one working terminal.
- The module starts with `'use client'`. In the Next.js App Router, create the backend inside a client component; see [the recipe](./embedding.md#nextjs-app-router).

## The `<docs-terminal>` element

```html
<docs-terminal theme="auto" locale="en" style="height: 300px"></docs-terminal>
```

```ts
import '@xterm/xterm/css/xterm.css'
import { defineDocsTerminal } from 'docsterm/element'
import { createShellBackend } from 'docsterm/shell'

defineDocsTerminal()

const element = document.querySelector('docs-terminal')
if (element) {
  element.backend = createShellBackend({ cwd: '/project' })
  element.addEventListener('docsterm-error', (event) => {
    if (event.detail.phase === 'init') console.warn(event.detail.message)
  })
}
```

- `defineDocsTerminal(tagName = 'docs-terminal')` defines the element. Importing the module defines nothing, a second call is a no-op, and in Node it does nothing at all, so it is safe in server-side builds.
- Attributes: `backend` (`shell`, `javascript`, `pyodide` or `websocket`, loaded on demand with default options), `url` (required for `websocket`), `locale`, `theme` (`light`, `dark`, `auto`), `font-size`, `font-family`, `aria-label` and `welcome` (read at mount).
- Properties: `backend` (any `Backend`; wins over the attribute), `theme` (also a `TerminalTheme` object; wins over the attribute), `ai`, `pageContext`, `onEvent`, and the read-only `terminal` (the `DocsTerminal`, or `null`). Methods: `run`, `insert`, `clear`, `focus`.
- Events `docsterm-ready`, `docsterm-error` and `docsterm-event` are `CustomEvent`s with the [event](#control-api) as `detail`; they bubble and cross shadow roots. `docsterm-error` fires for every error phase, so check `detail.phase === 'init'` for start-up failures. `addEventListener` is typed for these events, and `document.querySelector('docs-terminal')` returns a `DocsTerminalElement`.
- The element uses light DOM: load `@xterm/xterm/css/xterm.css` on the page and give the element a height. It is `display: block` unless your CSS sets a display.

The full reference and the Vue, Astro/Starlight and plain-HTML recipes are in [docs/embedding.md](./embedding.md#the-docs-terminal-element).

## Widget options

`new DocsTerminal(options)` and the React component take:

| Option | Type | Default | Live |
| --- | --- | --- | --- |
| `backend` | `Backend` | required | no: create a new terminal (React and the element remount) |
| `ai` | `AIProvider` | none: `#` lines go to the backend and `explain` is unavailable | yes |
| `locale` | `'en'` or `'ru'` | the browser language (`ru*` gives Russian, anything else English) | yes |
| `theme` | `'light'`, `'dark'`, `'auto'` or a `TerminalTheme` | `'auto'` | yes |
| `fontFamily` | string | `monospace` | yes |
| `fontSize` | number | `14` | yes |
| `pageContext` | `Partial<PageContext>` | collected from the page | yes |
| `welcome` | string | localized welcome line | no |
| `ariaLabel` | string | `Terminal` / `Терминал` | yes |
| `screenReaderMode` | boolean | `false` | yes |
| `onEvent` | `(event) => void` | none | yes |

- `'auto'` follows `prefers-color-scheme`, including changes after mount. An object theme fills the gaps from the light or dark built-in theme, picked by the brightness of its `background`. xterm raises text contrast to at least 4.5:1 with any theme.
- The page context holds the title, the URL, the meta description and up to 30 `h1`–`h3` headings; the AI receives the title, the description and the first 15 headings. Pass `pageContext` in single-page apps when the document does not describe the current route.
- The terminal's element has `role="region"` and the label; the label also goes to xterm's input element.

## Writing a backend

```ts
import type { Backend, BackendRunResult, InteractiveRun, RunContext, RunOutcome } from 'docsterm'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function ticker(context: RunContext): InteractiveRun {
  let finish!: (result: BackendRunResult) => void
  const done = new Promise<BackendRunResult>((resolve) => {
    finish = resolve
  })
  let ticks = 0
  let stopped = false
  context.write('\x1b[?1049h')
  const timer = setInterval(() => {
    ticks += 1
    context.write(`\x1b[H\x1b[2Jtick ${ticks}, press q to quit`)
  }, 500)
  const stop = (exitCode: number) => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    context.write('\x1b[?1049l')
    finish({ output: `stopped after ${ticks} ticks`, exitCode })
  }
  return {
    done,
    onKey: (data) => {
      if (data === 'q') stop(0)
      if (data === '\x03') stop(130)
    },
    cancel: () => stop(130),
  }
}

export function createDemoBackend(): Backend {
  return {
    id: 'demo',
    prompt: 'demo> ',
    async init(host) {
      host.write('commands: build, ticker\n')
    },
    async run(command: string, context?: RunContext): Promise<RunOutcome> {
      const name = command.trim()
      if (name === 'ticker' && context) return ticker(context)
      if (name !== 'build') return { output: `${name}: unknown command`, exitCode: 127 }
      for (const step of ['compile', 'bundle', 'upload']) {
        if (context?.signal.aborted) return { output: '', exitCode: 130 }
        context?.write(`${step}...\n`)
        await sleep(300)
      }
      return { output: 'build complete', exitCode: 0 }
    },
    complete({ line, cursor }) {
      const word = line.slice(0, cursor)
      return { from: 0, to: cursor, candidates: ['build', 'ticker'].filter((name) => name.startsWith(word)) }
    },
    describe: () => 'A demo CLI. Commands: build (prints three steps), ticker (a full-screen ticker, q quits).',
    dispose() {},
  }
}
```

The contract (`Backend` and the related types are exported from `docsterm`):

- **Lifecycle.** `init(host)` runs at mount. A rejection is printed as `environment failed to start: <message>` with a reload hint, and `mount()` rejects. `dispose()` cancels work in flight and releases workers and sockets, but must leave the object reusable: `init()` after `dispose()` must work, because React StrictMode and remounts do exactly that, and `init()` twice must not leak.
- **Output.** `context.write(text)` streams while the command runs. The returned `output` holds only what was not streamed and is printed after the stream; a backend that never streams returns everything there. If the returned output starts with the streamed text, that copy is dropped. `context.write` works only until `run()` settles, and never after Ctrl+C or `dispose()`; later output goes through `host.write()`, which prints above the prompt.
- **Cancellation.** `context.signal` aborts on Ctrl+C and on `dispose()`. Return quickly, by convention with exit code 130.
- **Exit codes.** `exitCode` must be a finite number; a numeric string is accepted and anything else counts as 0. A non-zero code makes the command the one `explain` talks about. Use 124 for time limits.
- **Locale.** `context.locale` and `host.locale` (a live value) tell you the reader's language.
- **Prompt.** `prompt` is read before every prompt, so it can be a getter that follows a working directory.
- **Continuation.** `isComplete(source)` receives all lines typed so far, joined with `\n`. `false` asks for another line with `continuationPrompt` (default `'... '`); an empty line is appended too, which is how Python ends a block. Ctrl+C drops the pending lines.
- **Description.** `describe()` returns plain text without escape sequences, at most about 600 characters: what runs and which commands or syntax exist. `help` prints it and the AI receives it.
- **Completion.** `complete({ line, cursor })` returns `{ from, to, candidates }` or `null`; the range is replaced.

### Interactive programs

`run()` may return an `InteractiveRun` instead of a result:

- `onKey(data)` receives every key as raw terminal data while the program runs. A paste arrives as xterm sends it: line breaks become `\r`, and the text is wrapped in `\x1b[200~`…`\x1b[201~` only if the program enabled bracketed paste (`\x1b[?2004h`). Return `done`, a promise of the final result.
- The first Ctrl+C is passed to `onKey` as `\x03`, so the program decides what it means; handle it. A second Ctrl+C within one second calls `cancel()` and abandons the run, and the prompt returns.
- `cancel()` is also called when an interactive run arrives after the reader already pressed Ctrl+C. Writes made inside `cancel()` still reach the screen, so leave the alternate screen there; during `dispose()` they are dropped, because the terminal is being removed.
- `resize(columns, rows)` is called when the terminal is resized.
- Output drawn while the alternate screen is on (`\x1b[?1049h`, `?1047h`, `?47h`) never reaches `explain`, the AI or `RunReport.output`; text on the normal screen does.

## Content-Security-Policy

| Part | Needs |
| --- | --- |
| Every page with a terminal | `style-src 'unsafe-inline'`: xterm.js 6 writes its theme and cell sizes into `<style>` elements. Plus wherever `xterm.css` is served from |
| Run buttons | one more injected `<style>` element, unless `styles: false` |
| `docsterm/shell`, `docsterm/mock` | nothing more |
| `docsterm/javascript` | `worker-src blob:` and `script-src 'unsafe-eval'` (the worker evaluates code, and a `blob:` worker inherits the page's policy). A blocked worker prints `blocked by the page Content-Security-Policy (needs worker-src blob:; script-src 'unsafe-eval')`. A worker served from your origin through `createWorker` follows its own response's policy |
| `docsterm/pyodide` | `worker-src blob:` (or a worker from your origin through `createWorker`), `script-src https://cdn.jsdelivr.net 'wasm-unsafe-eval'`, `connect-src https://cdn.jsdelivr.net`, and for `pip install` also `https://pypi.org https://files.pythonhosted.org`. Use your own origin instead of the CDN when you set `indexURL` |
| `docsterm/wasi` | `script-src 'wasm-unsafe-eval'`; `worker-src blob:` (without it commands fail with `blocked by the page Content-Security-Policy (needs worker-src blob:)`, see [WASI](#docstermwasi)); `connect-src` for the `.wasm` URL if it is on another origin |
| `docsterm/websocket` | `connect-src` for the server, for example `wss://sandbox.example.com` |
| `docsterm/anthropic` | `connect-src https://api.anthropic.com` (or your proxy) |
| `docsterm/openai` | `connect-src` for the preset's base URL or your `baseURL` (`http://localhost:11434`, `http://localhost:1234` for local models) |

Without a `worker-src` directive browsers fall back to `child-src` and then `script-src`, so `blob:` must be allowed there instead. `'unsafe-eval'` also allows WebAssembly compilation.

## Languages and themes

Widget messages ship in English and Russian (`locale: 'en' | 'ru'`, default from the browser language). Themes: `light`, `dark`, `auto` or an object, see [Widget options](#widget-options).
