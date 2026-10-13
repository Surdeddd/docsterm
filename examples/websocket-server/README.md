# docsterm reference WebSocket server

[Русская версия](README.ru.md)

A server for the docsterm `websocket` backend that gives every reader a real terminal: one disposable Docker container and one pseudo-terminal per connection. Echo, line editing, Ctrl+C as SIGINT, `read` prompts and full-screen programs (`vi`, `top`, `less`) behave exactly as in a local terminal, and `cd` / `export` persist between commands.

It speaks WebSocket protocol v2 and stays compatible with v1 clients.

> **This server runs commands typed by strangers.** It never starts a host shell: the container is started through node-pty with an argv array, without network, with a read-only root file system, no capabilities and CPU, memory and process limits. Keep it that way. Do not mount host directories into the sandbox and do not relax the flags below unless you understand the consequences.

## Quick start

Requirements: Node.js 22 or newer, Docker, and an image with a POSIX `sh`, `stty` and `dd` (Alpine, BusyBox and Debian images all qualify).

```sh
pnpm install            # from the repository root (the example is a workspace package)
node examples/websocket-server/server.mjs
```

On start the server prints one machine-readable line to stdout, for example:

```json
{"event":"listening","host":"127.0.0.1","port":8080,"url":"ws://127.0.0.1:8080"}
```

Logs go to stderr. Connect the widget:

```ts
import { createWebSocketBackend } from 'docsterm/websocket'

const backend = createWebSocketBackend({ url: 'ws://127.0.0.1:8080' })
```

If the image is not present locally, the server pulls it once at startup. Every connection then starts its container with `--pull never`.

## The sandbox

Each connection creates a container and then attaches to it through node-pty:

```text
docker create --rm -i -t --pull never --network none --memory 256m --memory-swap 256m --cpus 0.5
  --pids-limit 128 --read-only --tmpfs /work:rw,exec,size=64m,uid=65534,gid=65534,mode=0700
  --tmpfs /tmp:rw,size=16m,uid=65534,gid=65534,mode=1777 -w /work --user 65534:65534
  --cap-drop ALL --security-opt no-new-privileges -e HOME=/work -e TERM=xterm-256color
  --label docsterm.sandbox=1 --label docsterm.owner=<host>/<server pid> --name docsterm-<random> <IMAGE> sh
docker start --attach --interactive --detach-keys ctrl-^,ctrl-_ <container id>
```

- The shell runs as the unprivileged user 65534 (`nobody`), not as root; `SANDBOX_USER` changes it.
- `--memory-swap` equals `--memory`, so the sandbox cannot swap.
- `/work` is the home directory and the only large writable place, owned by the sandbox user. It allows `exec` so that tutorials can run `./script.sh`; Docker mounts tmpfs `noexec` by default.
- `/tmp` is a small writable tmpfs, because many tools expect it.
- `--detach-keys` moves Docker's detach sequence away from Ctrl+P, which `vi`, `less` and shells use.
- Creating the container separately means the server always knows its id, so it can remove it even when the reader disconnects during the start. The container is removed (`docker rm -f`, which kills it first; retried a few times) when the reader disconnects, after the idle or session limit, after `exit` (a fresh one is started) and when the server receives SIGINT or SIGTERM. A connection slot is freed only once its container is gone, so the number of containers never exceeds `MAX_CONNECTIONS`.
- At startup and every five minutes the server removes labelled containers that are not running and older than a minute, and containers whose owning server on this host is no longer running (left behind by a SIGKILL). To clean up by hand: `docker ps -aq --filter label=docsterm.sandbox=1 | xargs docker rm -f`.
- At startup the server reads `docker info` and prints a `WARNING` when the daemon runs containers without a seccomp profile. For a public deployment use a hardened runtime: gVisor (`--runtime runsc` as the daemon default) or user-namespace remapping (`userns-remap`), and keep the daemon's seccomp profile enabled.

`SANDBOX=local` runs a plain local `/bin/sh` in a fresh temporary directory instead of Docker. It has no isolation at all, is refused unless `NODE_ENV=test`, and exists only for the integration test. Its directories are named `docsterm-sandbox-<server pid>-*` and are removed when the session ends; a server killed with SIGKILL cannot do that, so every local server removes, at startup, the directories of servers that are no longer running (and untagged directories older than ten minutes). A local server also shuts down when the process that started it dies.

## Protocol v2

All frames are JSON text frames.

Client to server:

| message | meaning |
| --- | --- |
| `{"type":"run","id":1,"command":"ls -l","columns":80,"rows":24,"locale":"ru"}` | run a command; `columns` and `rows` are optional and resize the pty first; `locale` is optional and picks the language of the server's notices for this run (`ru` or `ru-*`: Russian, anything else: English) |
| `{"type":"stdin","id":1,"data":"y\r"}` | raw keystrokes for the running command `id`, written to the pty unchanged |
| `{"type":"cancel","id":1}` | stop command `id` |
| `{"type":"resize","columns":120,"rows":40}` | resize the pty (any time; one size per connection) |
| `{"type":"ping"}` | heartbeat |
| `{"type":"auth","token":"…"}` | first message, only when `TOKEN` is set and not given as `?token=` |

Server to client:

| message | meaning |
| --- | --- |
| `{"type":"ready","protocol":2,"features":["pty","resize","prompt","ping"],"prompt":"sandbox:~$ ","banner":"…"}` | the session is open; `prompt` and `banner` are optional |
| `{"type":"output","id":1,"chunk":"…"}` | raw terminal output of command `id`, escape sequences included, `\r\n` line endings |
| `{"type":"exit","id":1,"code":0,"prompt":"sandbox:~/app$ "}` | command `id` finished; `prompt` reflects the new working directory |
| `{"type":"pong"}` | answer to `ping` |

Features:

- `pty`: the command runs on a real pty. While it runs, the client forwards every key as `stdin` (Ctrl+C included); the remote line discipline echoes, edits lines and turns `\x03` into SIGINT.
- `resize`: `resize` messages and `columns`/`rows` on `run` reach the pty (`stty size`, full-screen programs).
- `prompt`: `ready` (when the sandbox is already up) and every `exit` carry the prompt.
- `ping`: `ping` is answered with `pong`.

Ids are non-negative integers chosen by the client. A v1 client (no `columns`, `rows`, `stdin`, `resize`, `ping`) keeps working unchanged.

### Timing of `ready`

`ready` is sent as soon as the connection is accepted (after the origin and token checks), without waiting for a slow container start: the server waits at most `READY_WAIT_MS` (500 ms by default) for the sandbox. If the shell is up by then, `ready` carries the prompt; otherwise the prompt is omitted and the first `exit` carries it. A `run` that arrives before the shell is ready waits for it (bounded by `START_TIMEOUT_MS`). If the sandbox cannot start, that run is answered with `docsterm-server: the sandbox could not be started` and exit code 125, and the connection is closed with code 1011.

### Prompt

`sandbox:<dir>$` followed by one space, where `<dir>` is the working directory with the home directory (`/work`) shown as `~`. Paths longer than 40 characters keep their last two components (`sandbox:…/some/thing$`). Control and bidirectional formatting characters are replaced with `?`.

### Exit codes and notices

Server notices are written into the output of the command as one line starting with `docsterm-server:`, in English or Russian depending on the `locale` of the run (English when it is missing). The texts below are the English ones. Close reasons stay English.

| code | when |
| --- | --- |
| the command's own code | normal completion |
| 1 | a second `run` while another command is running (`another command is still running`) |
| 2 | the command was rejected: not a string, longer than `MAX_COMMAND_LENGTH`, or containing control characters other than tab and newline |
| 124 | the command received no input from the reader for `COMMAND_TIMEOUT_MS` (`command timed out after … without input`) |
| 125 | the sandbox could not be started |
| 130 | cancelled with `cancel` |
| N | `exit N`: the shell ended; the server starts a fresh sandbox, says so (`the shell exited with code N; started a fresh sandbox`) and reports N. Files, variables and the working directory are reset. |

Behaviour details:

- **One command at a time.** A `run` that arrives while a command is being cancelled (after `cancel` or a timeout) is queued and starts as soon as the previous command has finished; `stdin` sent for a queued run is delivered after it starts. Any other concurrent `run` is answered with exit code 1. A `run` with the id of the running or queued command is ignored.
- **Cancel.** `cancel` writes Ctrl+C to the pty. If the command has not finished after `CANCEL_GRACE_MS` (2 s), the server kills the foreground process group inside the sandbox; if the shell still does not come back after another grace period, the sandbox is replaced and the notice says so. The exit code is 130 in every case. A Ctrl+C sent as `stdin` is just a keystroke: the program decides (a shell command usually ends with 130).
- **Timeout.** `COMMAND_TIMEOUT_MS` (120 s) is measured from the start of the command and restarted by every accepted `stdin` message, so a reader who is working in `vi` or answering a `read` is never cut off, while an unattended runaway command still ends with 124 after the limit. Output does not restart the timer, and neither do `stdin` messages dropped by the rate limit.
- **Output limit.** After `OUTPUT_LIMIT_BYTES` (5 MB) of output the server writes a notice, discards the rest and interrupts the command (it usually ends with 130). The limit counts the JSON-encoded size that goes over the wire, so output full of control bytes reaches it sooner.
- **Flow control.** When more than 1 MiB of output waits for a slow client, the server stops reading the pty, so the program blocks on its own output, and resumes below 256 KiB. A client that reads nothing for `STALL_TIMEOUT_MS` (30 s), or lets more than 8 MiB pile up, is disconnected.
- **Rates.** Each connection may send `MESSAGE_BURST` (200) messages at once and `MESSAGES_PER_SECOND` (100) after that; extra messages are dropped. `stdin` messages longer than 16 characters (pastes) also draw from a byte budget of `STDIN_BURST_BYTES` (256 KB) refilled at `STDIN_BYTES_PER_SECOND` (64 KB/s); keystrokes always pass. At most one `pong` is sent per 500 ms, and a burst of `resize` messages is applied once, with the latest size (a pending resize is applied before the next `stdin` or `run`).
- **Session lifetime.** A connection lasts at most `MAX_SESSION_MS` (30 min). Then the running command, if any, gets a notice (`session time limit of 30 min reached`) and the connection is closed with 1000 `session limit reached`.
- **Background jobs.** Output produced after a command has finished (for example by `sleep 1 && echo late &`) is dropped.
- **Type-ahead.** Keys that the command did not read before it finished are discarded, so they can never run as stray commands.

### Errors and limits

| situation | result |
| --- | --- |
| plain HTTP request | `426 Upgrade Required` |
| `Origin` not allowed | HTTP 403 before the WebSocket handshake |
| wrong `?token=` | HTTP 401 |
| more than `MAX_CONNECTIONS_PER_IP` connections from one address, or more than `CONNECTS_PER_MINUTE_PER_IP` connection attempts per minute | HTTP 429 |
| more than `MAX_CONNECTIONS` connections, or shutting down | HTTP 503 |
| invalid JSON, binary frames, unknown types, invalid fields, frames larger than `MAX_MESSAGE_BYTES` | ignored; the session keeps working |
| frames larger than `max(4 × MAX_MESSAGE_BYTES, 1 MiB)` | closed by the WebSocket layer (1009) |
| no or wrong `auth` message when a token is required | close 1008 `unauthorized` (`authentication timed out` after `AUTH_TIMEOUT_MS`) |
| no activity for `IDLE_TIMEOUT_MS` | close 1000 `idle limit reached`, sandbox killed |
| session older than `MAX_SESSION_MS` | close 1000 `session limit reached`, sandbox killed |
| the client stops reading (see Flow control) | connection dropped without a close frame |
| the sandbox cannot start or ends between commands | close 1011 |
| server shutdown | close 1001 |

## Security

- **Origins.** Browsers attach an `Origin` header to every WebSocket handshake, so the allowlist stops other web pages from using your server. Without `ALLOWED_ORIGINS` only loopback pages are accepted (`http://localhost`, `http://127.0.0.1`, `http://[::1]` on any port, also `https`); a cross-site page cannot connect. Set `ALLOWED_ORIGINS` to a comma-separated list of exact origins (`https://docs.example.com,https://example.github.io`) for production; `*` allows every origin and is not recommended. Requests without an `Origin` header (non-browser clients) are allowed: use `TOKEN` to control them.
- **Token.** With `TOKEN` set, a client must present it as `?token=` in the URL or as the first message `{"type":"auth","token":"…"}`. The comparison is constant-time. A token in a public docs page is visible to every reader; it limits casual use, it is not a secret.
- **Limits.** Connections and connection attempts per client and in total are limited. Clients are grouped by IPv4 address and by IPv6 /64 network (IPv4-mapped IPv6 addresses count as IPv4). Behind a reverse proxy every reader appears with the proxy's address, so raise `MAX_CONNECTIONS_PER_IP` and `CONNECTS_PER_MINUTE_PER_IP` or enforce limits in the proxy. Refusals are logged at most ten times per ten seconds, followed by a count of the suppressed lines.
- **Boundary spoofing.** The shell keeps its per-connection nonce in `__dt_n`, so a reader who prints a forged boundary on purpose (or redefines `__dt_*`) can end or confuse only their own command and session; other connections have other nonces and other sandboxes.
- **Logs** contain connection ids, client addresses, exit reasons and close codes. They never contain commands, keystrokes, output, URLs or tokens.
- **Host.** The server listens on `127.0.0.1` by default. Put it behind a TLS-terminating proxy (`wss://`) before exposing it.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `PORT` | `8080` | listening port; `0` picks a free port (see the `listening` line) |
| `HOST` | `127.0.0.1` | listening address |
| `IMAGE` | `alpine:3` | sandbox image; pin a digest in production |
| `ALLOWED_ORIGINS` | loopback only | comma-separated exact origins, or `*` |
| `TOKEN` | none | shared token, see Security |
| `BANNER` | none | text sent with `ready` (500 characters at most) |
| `READY_WAIT_MS` | `500` | how long `ready` may wait for the sandbox (0 to 1000) |
| `START_TIMEOUT_MS` | `30000` | sandbox start limit |
| `COMMAND_TIMEOUT_MS` | `120000` | per-command limit without reader input |
| `CANCEL_GRACE_MS` | `2000` | wait after Ctrl+C before killing the foreground job |
| `OUTPUT_LIMIT_BYTES` | `5242880` | output limit per command |
| `IDLE_TIMEOUT_MS` | `600000` | idle connection limit |
| `AUTH_TIMEOUT_MS` | `10000` | time for the `auth` message |
| `MAX_MESSAGE_BYTES` | `65536` | larger frames are ignored |
| `MAX_COMMAND_LENGTH` | `16384` | characters per command |
| `MAX_STDIN_LENGTH` | `32768` | characters per `stdin` message |
| `MAX_CONNECTIONS` | `20` | connections in total |
| `MAX_CONNECTIONS_PER_IP` | `4` | connections per client address (IPv6: per /64) |
| `CONNECTS_PER_MINUTE_PER_IP` | `30` | connection attempts per client address per minute |
| `MAX_SESSION_MS` | `1800000` | absolute session lifetime |
| `STALL_TIMEOUT_MS` | `30000` | how long a client may leave output unread |
| `MESSAGE_BURST` | `200` | messages a connection may send at once |
| `MESSAGES_PER_SECOND` | `100` | sustained message rate per connection |
| `STDIN_BURST_BYTES` | `262144` | byte budget for long `stdin` messages |
| `STDIN_BYTES_PER_SECOND` | `65536` | refill rate of that budget |
| `SANDBOX_USER` | `65534:65534` | `uid:gid` of the sandbox shell |
| `SANDBOX_MEMORY` | `256m` | `--memory` and `--memory-swap` |
| `SANDBOX_CPUS` | `0.5` | `--cpus` |
| `SANDBOX_PIDS_LIMIT` | `128` | `--pids-limit` |
| `SANDBOX_WORK_SIZE` | `64m` | size of `/work` |
| `SANDBOX_TMP_SIZE` | `16m` | size of `/tmp` |
| `SANDBOX` | `docker` | `local` only with `NODE_ENV=test` |
| `LOCAL_SHELL` | `/bin/sh` | shell of the local test sandbox |
| `LOCAL_START_DELAY_MS` | `0` | test only: delays the local sandbox start |

## How command boundaries work

The shell runs with echo off and an invisible prompt while idle. A command is sent as one logical line, `stty echo; eval '<command>'; __dt_end $? <n>`, with the command single-quoted and split into short continuation lines, so the shell has read all of it before anything runs: a command that reads stdin (`read x`, `cat`) gets the reader's keystrokes, never the boundary machinery. Multi-line commands, here-documents and trailing `# comments` work because they stay inside `eval`. `__dt_end` drains unread type-ahead, turns echo off, restores cooked terminal modes and prints a sentinel with a per-connection random nonce, the exit code and `$PWD`; the server strips it from the stream, also when it is split across chunks, without adding or removing any byte of the command's own output. The prompt (`PS1`) is a second nonce marker: if the shell returns to its prompt without a sentinel (dash and BusyBox abort the whole line on SIGINT or on a syntax error), the server asks the shell for the sentinel again. Both markers are assembled only when they are printed, from three variables (`PS1='${__dt_a}${__dt_n}P${__dt_n}${__dt_b}'`, where `__dt_a` and `__dt_b` hold the separator bytes), so no variable, function body, `set`, `env` or `declare -p` listing contains a complete marker, and `echo "$PS1"` or `set` cannot confuse the server.

## Development

```sh
npx vitest run packages/docsterm/test/websocket-server.test.ts
```

The test starts the server with `SANDBOX=local NODE_ENV=test PORT=0`. To try another shell, set `LOCAL_SHELL=/bin/dash`.

node-pty 1.1.0 can install its `spawn-helper` without the executable bit (`posix_spawnp failed`); the server fixes the mode at startup.

## Known limitations

- A Ctrl+C that arrives in the instant between a shell builtin and the start of the next program (`printf x; sleep 10`) reaches the shell instead of the program, and the shell waits for that program, as in any terminal. The reader presses Ctrl+C again, or the client sends `cancel`.
- When the output limit, a timeout or a `cancel` interrupts a command at the very moment it finishes, the interrupt can land in the shell's own boundary call. The shell then loses the boundary and the server starts a fresh sandbox (variables and the working directory reset) and says so. The next command runs normally.
- On macOS, the pty can emit `\r\r\n` instead of `\r\n` at internal buffer boundaries; terminals render both the same.
- On Docker Desktop the daemon often runs without seccomp; the server warns about it but cannot fix it.
- `set -x` makes the shell trace the internal `__dt_end` call into the output. Redefining or unsetting `__dt_end`, `__dt_n`, `__dt_a` or `__dt_b`, or printing `"$__dt_a$__dt_n"` on purpose, breaks the boundary; such a session ends in a timeout or a fresh sandbox.
