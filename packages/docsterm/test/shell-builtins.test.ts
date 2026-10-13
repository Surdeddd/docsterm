import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtins, type CommandContext, type CommandResult } from '../src/shell/builtins.js'
import { ShellFileSystem, type FileTree } from '../src/shell/fs.js'
import { createShellBackend } from '../src/shell/index.js'
import { isOptionError, parseOptions } from '../src/shell/options.js'
import { isInteractiveRun, type BackendRunResult, type InteractiveRun, type RunContext } from '../src/types.js'

const README = '# demo app\n\nDeployed with the orbit CLI.\nRun `orbit help` to start.\n'
const REGIONS = 'name,region\nalpha,eu-central\nbeta,us-east\ngamma,eu-west\n'
const NUMS = '10\n9\n2\n10\n'
const ACCESS = 'GET /index.html 200\nGET /docs 200\nGET /missing 404\nPOST /api/deploy 200\n'
const INDEX = "export const handler = () => 'hello from orbit'\n"
const CONFIG = 'export const region = "eu-central"\n'
const HEAVY_TIMEOUT = 30_000

const demoTree = (): FileTree => ({
  project: {
    'README.md': README,
    'regions.csv': REGIONS,
    'nums.txt': NUMS,
    'access.log': ACCESS,
    src: { 'index.ts': INDEX, 'config.ts': CONFIG },
  },
  home: { reader: {} },
})

interface Outcome {
  stdout: string
  stderr: string
  exitCode: number
}

interface RunOptions {
  stdin?: string
  tty?: boolean
  colors?: boolean
  columns?: number
  signal?: AbortSignal
  commands?: readonly string[]
}

type Event = ['out' | 'err', string]

const ok = (stdout: string): Outcome => ({ stdout, stderr: '', exitCode: 0 })
const failed = (stderr: string, exitCode = 1, stdout = ''): Outcome => ({ stdout, stderr, exitCode })

const words = (line: string): string[] =>
  [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')

const asResult = (value: CommandResult | string | InteractiveRun): CommandResult => {
  if (typeof value !== 'string' && 'onKey' in value) throw new Error('unexpected interactive run')
  return typeof value === 'string' ? { stdout: value } : value
}

class Sandbox {
  readonly fs = new ShellFileSystem(demoTree())
  readonly env: Record<string, string> = { HOME: '/home/reader', PROJECT: 'orbit', PWD: '/project' }
  cwd = '/project'

  context(argv: string[], options: RunOptions = {}): CommandContext {
    return {
      argv,
      stdin: options.stdin ?? '',
      cwd: this.cwd,
      env: this.env,
      fs: this.fs,
      setCwd: (path) => {
        this.env.OLDPWD = this.cwd
        this.env.PWD = path
        this.cwd = path
      },
      isTTY: options.tty,
      colors: options.colors,
      columns: options.columns,
      signal: options.signal,
      commands: options.commands,
    }
  }

  async run(argv: string[], options: RunOptions = {}): Promise<Outcome> {
    const handler = builtins[argv[0] ?? '']
    if (!handler) throw new Error(`no builtin named ${argv[0]}`)
    const result = asResult(await handler(this.context(argv, options)))
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 }
  }

  async stream(line: string, options: RunOptions = {}): Promise<{ events: Event[]; exitCode: number }> {
    const argv = words(line)
    const handler = builtins[argv[0] ?? '']
    if (!handler) throw new Error(`no builtin named ${argv[0]}`)
    const events: Event[] = []
    const context: CommandContext = {
      ...this.context(argv, options),
      write: (text) => events.push(['out', text]),
      writeError: (text) => events.push(['err', text]),
    }
    const result = asResult(await handler(context))
    if (result.stdout) events.push(['out', result.stdout])
    if (result.stderr) events.push(['err', result.stderr])
    return { events, exitCode: result.exitCode ?? 0 }
  }

  async sh(line: string, options: RunOptions = {}): Promise<Outcome> {
    let stdin = options.stdin ?? ''
    let stderr = ''
    let last: Outcome = ok('')
    for (const stage of line.split(' | ')) {
      last = await this.run(words(stage), { ...options, stdin })
      stderr += last.stderr
      stdin = last.stdout
    }
    return { ...last, stderr }
  }
}

let sb: Sandbox

beforeEach(() => {
  sb = new Sandbox()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('golden table (plan Task 1.D)', () => {
  it('echo -n hi / echo -5 / echo "- item" / echo -e "a\\tb" / echo -- x', async () => {
    expect(await sb.sh('echo -n hi')).toEqual(ok('hi'))
    expect(await sb.sh('echo -5')).toEqual(ok('-5\n'))
    expect(await sb.sh('echo "- item"')).toEqual(ok('- item\n'))
    expect(await sb.sh('echo -e "a\\tb"')).toEqual(ok('a\tb\n'))
    expect(await sb.sh('echo -- x')).toEqual(ok('-- x\n'))
  })

  it('head -2 / head -n2 / tail -n +2 / tail -n 0', async () => {
    expect(await sb.sh('head -2 regions.csv')).toEqual(ok('name,region\nalpha,eu-central\n'))
    expect(await sb.sh('head -n2 regions.csv')).toEqual(ok('name,region\nalpha,eu-central\n'))
    expect(await sb.sh('tail -n +2 regions.csv')).toEqual(ok('alpha,eu-central\nbeta,us-east\ngamma,eu-west\n'))
    expect(await sb.sh('tail -n 0 regions.csv')).toEqual(ok(''))
  })

  it('grep -n 200 access.log', async () => {
    expect(await sb.sh('grep -n 200 access.log')).toEqual(
      ok('1:GET /index.html 200\n2:GET /docs 200\n4:POST /api/deploy 200\n'),
    )
  })

  it('grep -c/-l/-q/-w/-x/-o/-i/-v/-e follow GNU semantics', async () => {
    expect(await sb.sh('grep -c 200 access.log')).toEqual(ok('3\n'))
    expect(await sb.sh('grep -l eu regions.csv README.md')).toEqual(ok('regions.csv\n'))
    expect(await sb.sh('grep -q GET access.log')).toEqual(ok(''))
    expect(await sb.sh('grep -q PUT access.log')).toEqual(failed(''))
    expect(await sb.sh('grep -w GET access.log')).toEqual(ok('GET /index.html 200\nGET /docs 200\nGET /missing 404\n'))
    expect(await sb.sh('grep -w ET access.log')).toEqual(failed(''))
    expect(await sb.sh('grep -x beta,us-east regions.csv')).toEqual(ok('beta,us-east\n'))
    expect(await sb.sh('grep -x beta regions.csv')).toEqual(failed(''))
    expect(await sb.sh('grep -o eu-[a-z]* regions.csv')).toEqual(ok('eu-central\neu-west\n'))
    expect(await sb.sh('grep -i deployed README.md')).toEqual(ok('Deployed with the orbit CLI.\n'))
    expect(await sb.sh('grep -v 200 access.log')).toEqual(ok('GET /missing 404\n'))
    expect(await sb.sh('grep -e 404 -e POST access.log')).toEqual(ok('GET /missing 404\nPOST /api/deploy 200\n'))
  })

  it('grep -r handler src', async () => {
    expect(await sb.sh('grep -r handler src')).toEqual(ok(`src/index.ts:${INDEX}`))
  })

  it('grep -C 1 beta regions.csv', async () => {
    expect(await sb.sh('grep -C 1 beta regions.csv')).toEqual(ok('alpha,eu-central\nbeta,us-east\ngamma,eu-west\n'))
  })

  it('grep eu regions.csv README.md / grep eu nope.txt', async () => {
    expect(await sb.sh('grep eu regions.csv README.md')).toEqual(
      ok('regions.csv:alpha,eu-central\nregions.csv:gamma,eu-west\n'),
    )
    expect(await sb.sh('grep eu nope.txt')).toEqual(failed('grep: nope.txt: No such file or directory\n', 2))
  })

  it('wc -l regions.csv README.md / echo привет | wc -c / wc -m', async () => {
    expect(await sb.sh('wc -l regions.csv README.md')).toEqual(ok('  4 regions.csv\n  4 README.md\n  8 total\n'))
    expect(await sb.sh('echo привет | wc -c')).toEqual(ok('13\n'))
    expect(await sb.sh('echo привет | wc -m')).toEqual(ok('7\n'))
  })

  it('sort -n / sort -u / sort -t, -k2 / sort | uniq -c', async () => {
    expect(await sb.sh('sort -n nums.txt')).toEqual(ok('2\n9\n10\n10\n'))
    expect(await sb.sh('sort -u nums.txt')).toEqual(ok('10\n2\n9\n'))
    expect(await sb.sh('sort -t, -k2 regions.csv')).toEqual(
      ok('alpha,eu-central\ngamma,eu-west\nname,region\nbeta,us-east\n'),
    )
    expect(await sb.sh('sort nums.txt | uniq -c')).toEqual(ok('      2 10\n      1 2\n      1 9\n'))
  })

  it('uniq a.txt out.txt writes the output file', async () => {
    sb.fs.write('/project/a.txt', 'a\na\nb\n')
    expect(await sb.sh('uniq a.txt out.txt')).toEqual(ok(''))
    expect(sb.fs.read('/project/out.txt')).toBe('a\nb\n')
  })

  it('find . -type f / -type d / find -name / find src / find nope', async () => {
    expect(await sb.sh('find . -type f')).toEqual(
      ok('./README.md\n./access.log\n./nums.txt\n./regions.csv\n./src/config.ts\n./src/index.ts\n'),
    )
    expect(await sb.sh('find . -type d')).toEqual(ok('.\n./src\n'))
    expect(await sb.sh('find -name *.ts')).toEqual(ok('./src/config.ts\n./src/index.ts\n'))
    expect(await sb.sh('find src')).toEqual(ok('src\nsrc/config.ts\nsrc/index.ts\n'))
    expect(await sb.sh('find nope')).toEqual(failed("find: 'nope': No such file or directory\n"))
  })

  it('ls src/*.ts, ls README.md regions.csv, ls src / handle every operand', async () => {
    expect(await sb.sh('ls src/config.ts src/index.ts')).toEqual(ok('src/config.ts\nsrc/index.ts\n'))
    expect(await sb.sh('ls README.md regions.csv')).toEqual(ok('README.md\nregions.csv\n'))
    expect(await sb.sh('ls src /')).toEqual(ok('/:\nhome\nproject\n\nsrc:\nconfig.ts\nindex.ts\n'))
    expect(await sb.sh('ls src /', { tty: true })).toEqual(ok('/:\nhome  project\n\nsrc:\nconfig.ts  index.ts\n'))
  })

  it('ls -1 / ls -d src / ls -l README.md', async () => {
    expect(await sb.sh('ls -1', { tty: true })).toEqual(ok('access.log\nnums.txt\nREADME.md\nregions.csv\nsrc\n'))
    expect(await sb.sh('ls -d src')).toEqual(ok('src\n'))
    expect(await sb.sh('ls -l README.md')).toEqual(ok('-rw-r--r-- 68 README.md\n'))
  })

  it('cp README.md regions.csv backup/ copies both into the directory', async () => {
    await sb.sh('mkdir backup')
    expect(await sb.sh('cp README.md regions.csv backup/')).toEqual(ok(''))
    expect(sb.fs.list('/project/backup')).toEqual(['README.md', 'regions.csv'])
    expect(sb.fs.read('/project/backup/regions.csv')).toBe(REGIONS)
    expect(sb.fs.read('/project/regions.csv')).toBe(REGIONS)
  })

  it('cp -r src lib copies the tree; cp src lib refuses', async () => {
    expect(await sb.sh('cp -r src lib')).toEqual(ok(''))
    expect(sb.fs.list('/project/lib')).toEqual(['config.ts', 'index.ts'])
    expect(sb.fs.read('/project/lib/index.ts')).toBe(INDEX)
    expect(await sb.sh('cp src lib2')).toEqual(failed("cp: -r not specified; omitting directory 'src'\n"))
    expect(sb.fs.exists('/project/lib2')).toBe(false)
  })

  it('mv README.md . / mv README.md README.md refuse and keep the file', async () => {
    expect(await sb.sh('mv README.md .')).toEqual(failed("mv: 'README.md' and './README.md' are the same file\n"))
    expect(await sb.sh('mv README.md README.md')).toEqual(failed("mv: 'README.md' and 'README.md' are the same file\n"))
    expect(sb.fs.read('/project/README.md')).toBe(README)
  })

  it('mv src lib renames the directory', async () => {
    expect(await sb.sh('mv src lib')).toEqual(ok(''))
    expect(sb.fs.list('/project/lib')).toEqual(['config.ts', 'index.ts'])
    expect(sb.fs.exists('/project/src')).toBe(false)
  })

  it('which ls / which nope', async () => {
    expect(await sb.sh('which ls')).toEqual(ok('ls: shell builtin\n'))
    expect(await sb.sh('which nope')).toEqual(failed('nope not found\n'))
  })

  it('rm / rm nope README.md', async () => {
    expect(await sb.sh('rm')).toEqual(failed('rm: missing operand\n'))
    expect(await sb.sh('rm nope README.md')).toEqual(failed("rm: cannot remove 'nope': No such file or directory\n"))
    expect(sb.fs.exists('/project/README.md')).toBe(false)
  })

  it('rm -rf / and rm -r . are refused and the tree stays', async () => {
    expect(await sb.sh('rm -rf /')).toEqual(
      failed("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n"),
    )
    expect(await sb.sh('rm -r .')).toEqual(failed("rm: refusing to remove '.' or '..' directory: skipping '.'\n"))
    expect(sb.fs.list('/')).toEqual(['home', 'project'])
    expect(sb.fs.list('/project')).toEqual(['README.md', 'access.log', 'nums.txt', 'regions.csv', 'src'])
  })

  it('mkdir src / mkdir -p src', async () => {
    expect(await sb.sh('mkdir src')).toEqual(failed("mkdir: cannot create directory 'src': File exists\n"))
    expect(await sb.sh('mkdir -p src')).toEqual(ok(''))
  })

  it('cd src; cd -; echo $PWD $OLDPWD', async () => {
    expect(await sb.sh('cd src')).toEqual(ok(''))
    expect(await sb.sh('cd -')).toEqual(ok('/project\n'))
    expect(sb.cwd).toBe('/project')
    expect([sb.env.PWD, sb.env.OLDPWD]).toEqual(['/project', '/project/src'])
  })

  it('export lists the environment / export 1bad=x fails', async () => {
    expect(await sb.sh('export')).toEqual(
      ok('export HOME="/home/reader"\nexport PROJECT="orbit"\nexport PWD="/project"\n'),
    )
    expect(await sb.sh('export 1bad=x')).toEqual(failed("export: '1bad=x': not a valid identifier\n"))
    expect(Object.keys(sb.env)).toEqual(['HOME', 'PROJECT', 'PWD'])
  })

  it('sleep 1s sleeps a full second', async () => {
    vi.useFakeTimers()
    let settled = false
    const pending = sb.sh('sleep 1s').then((outcome) => {
      settled = true
      return outcome
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual(ok(''))
  })

  it('sleep abc fails', async () => {
    expect(await sb.sh('sleep abc')).toEqual(failed("sleep: invalid time interval 'abc'\n"))
  })

  it('an abort during sleep 2 returns 130 at once and clears its timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = sb.sh('sleep 2', { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    expect(await pending).toEqual(failed('', 130))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cat -n README.md / echo hi | cat -', async () => {
    expect(await sb.sh('cat -n README.md')).toEqual(
      ok('     1\t# demo app\n     2\t\n     3\tDeployed with the orbit CLI.\n     4\tRun `orbit help` to start.\n'),
    )
    expect(await sb.sh('echo hi | cat -')).toEqual(ok('hi\n'))
  })

  it('ls -Z is an invalid option', async () => {
    expect(await sb.sh('ls -Z')).toEqual(failed("ls: invalid option -- 'Z'\n", 2))
  })

  it('unset, printf, tee, basename, dirname, type', async () => {
    expect(await sb.sh('unset PROJECT')).toEqual(ok(''))
    expect(sb.env.PROJECT).toBeUndefined()
    expect(await sb.sh("printf '%s=%d\\n' a 1")).toEqual(ok('a=1\n'))
    expect(await sb.sh('echo hi | tee t.txt')).toEqual(ok('hi\n'))
    expect(sb.fs.read('/project/t.txt')).toBe('hi\n')
    expect(await sb.sh('basename /a/b.txt .txt')).toEqual(ok('b\n'))
    expect(await sb.sh('dirname /a/b.txt')).toEqual(ok('/a\n'))
    expect(await sb.sh('type ls')).toEqual(ok('ls is a shell builtin\n'))
  })
})

describe('option parser [sb-33]', () => {
  const spec = {
    flags: 'alq',
    values: 'n',
    numeric: 'n',
    long: { all: 'a', lines: 'n', quiet: 'q', color: { key: 'color', argument: 'optional' as const } },
  }

  it('collects clustered flags, values and operands in any order', () => {
    const parsed = parseOptions(['cmd', '-la', 'src', '-n', '5', 'more'], spec)
    if (isOptionError(parsed)) throw new Error(parsed.error)
    expect([...parsed.flags]).toEqual(['l', 'a'])
    expect(parsed.values.get('n')).toEqual(['5'])
    expect(parsed.operands).toEqual(['src', 'more'])
  })

  it('stops at -- and treats - as an operand', () => {
    const parsed = parseOptions(['cmd', '-', '--', '-l', '--all'], spec)
    if (isOptionError(parsed)) throw new Error(parsed.error)
    expect(parsed.flags.size).toBe(0)
    expect(parsed.operands).toEqual(['-', '-l', '--all'])
  })

  it('reads -nVALUE, -NUM, --long=value, --long value and unique prefixes', () => {
    const forms = [['-n7'], ['-7'], ['--lines=7'], ['--lines', '7'], ['--lin=7']]
    for (const form of forms) {
      const parsed = parseOptions(['cmd', ...form], spec)
      if (isOptionError(parsed)) throw new Error(parsed.error)
      expect(parsed.values.get('n'), form.join(' ')).toEqual(['7'])
    }
  })

  it('keeps an optional long argument empty when it is absent', () => {
    const bare = parseOptions(['cmd', '--color'], spec)
    const given = parseOptions(['cmd', '--color=never'], spec)
    if (isOptionError(bare) || isOptionError(given)) throw new Error('unexpected error')
    expect(bare.values.get('color')).toEqual([''])
    expect(given.values.get('color')).toEqual(['never'])
  })

  it('reports unknown and malformed options like getopt', () => {
    expect(parseOptions(['ls', '-lZ'], spec)).toEqual({ error: "ls: invalid option -- 'Z'" })
    expect(parseOptions(['ls', '--bogus'], spec)).toEqual({ error: "ls: unrecognized option '--bogus'" })
    expect(parseOptions(['head', '-n'], spec)).toEqual({ error: "head: option requires an argument -- 'n'" })
    expect(parseOptions(['ls', '--all=yes'], spec)).toEqual({ error: "ls: option '--all' doesn't allow an argument" })
    expect(parseOptions(['head', '--lines'], spec)).toEqual({ error: "head: option '--lines' requires an argument" })
  })

  it('rejects unknown options in every builtin with exit 2 instead of ignoring them', async () => {
    expect(await sb.sh('cat -x README.md')).toEqual(failed("cat: invalid option -- 'x'\n", 2))
    expect(await sb.sh('sort -z nums.txt')).toEqual(failed("sort: invalid option -- 'z'\n", 2))
    expect(await sb.sh('grep --bogus x')).toEqual(failed("grep: unrecognized option '--bogus'\n", 2))
    expect(await sb.sh('sleep -1')).toEqual(failed("sleep: invalid option -- '1'\n", 2))
  })

  it('lets -- address a file whose name starts with a dash', async () => {
    expect(await sb.sh('touch ./-v')).toEqual(ok(''))
    expect(await sb.sh('rm -- -v')).toEqual(ok(''))
    expect(sb.fs.exists('/project/-v')).toBe(false)
    expect(await sb.sh('grep -- -v regions.csv')).toEqual(failed(''))
  })
})

describe('ls [sb-3, sb-6, sb-28, shell-ls-first-operand-only, shell-ls-colors-leak]', () => {
  it('joins names with two spaces on a terminal and prints one per line elsewhere', async () => {
    expect(await sb.sh('ls', { tty: true })).toEqual(ok('access.log  nums.txt  README.md  regions.csv  src\n'))
    expect(await sb.sh('ls')).toEqual(ok('access.log\nnums.txt\nREADME.md\nregions.csv\nsrc\n'))
  })

  it('paints directories only for a coloured terminal', async () => {
    expect(await sb.sh('ls', { tty: true, colors: true })).toEqual(
      ok('access.log  nums.txt  README.md  regions.csv  \x1b[34msrc\x1b[0m\n'),
    )
    expect(await sb.sh('ls', { tty: false, colors: true })).toEqual(
      ok('access.log\nnums.txt\nREADME.md\nregions.csv\nsrc\n'),
    )
    expect(await sb.sh('ls', { tty: true, colors: false })).toEqual(
      ok('access.log  nums.txt  README.md  regions.csv  src\n'),
    )
  })

  it('honours --color=never and --color=always', async () => {
    expect(await sb.sh('ls --color=never', { tty: true, colors: true })).toEqual(
      ok('access.log  nums.txt  README.md  regions.csv  src\n'),
    )
    expect(await sb.sh('ls --color=always /project')).toEqual(
      ok('access.log\nnums.txt\nREADME.md\nregions.csv\n\x1b[34msrc\x1b[0m\n'),
    )
    expect(await sb.sh('ls --color=sometimes')).toEqual(failed("ls: invalid argument 'sometimes' for '--color'\n", 2))
  })

  it('reports a missing operand, lists the rest and exits 1', async () => {
    expect(await sb.sh('ls nope README.md')).toEqual(
      failed("ls: cannot access 'nope': No such file or directory\n", 1, 'README.md\n'),
    )
  })

  it('keeps stderr and stdout in order through write/writeError', async () => {
    expect(await sb.stream('ls nope README.md')).toEqual({
      events: [
        ['err', "ls: cannot access 'nope': No such file or directory\n"],
        ['out', 'README.md\n'],
      ],
      exitCode: 1,
    })
  })

  it('shows dotfiles with -a and -A', async () => {
    sb.fs.write('/project/src/.env', 'X=1\n')
    expect(await sb.sh('ls src')).toEqual(ok('config.ts\nindex.ts\n'))
    expect(await sb.sh('ls -a src')).toEqual(ok('.\n..\n.env\nconfig.ts\nindex.ts\n'))
    expect(await sb.sh('ls -A src')).toEqual(ok('.env\nconfig.ts\nindex.ts\n'))
  })

  it('prints byte sizes in the long format', async () => {
    sb.fs.write('/project/ru.txt', 'привет\n')
    expect(await sb.sh('ls -l ru.txt')).toEqual(ok('-rw-r--r-- 13 ru.txt\n'))
    expect(await sb.sh('ls -l src')).toEqual(ok('-rw-r--r-- 35 config.ts\n-rw-r--r-- 48 index.ts\n'))
    expect(await sb.sh('ls -ld src')).toEqual(ok('drwxr-xr-x 4096 src\n'))
    sb.fs.write('/project/big.bin', 'x'.repeat(2048))
    expect(await sb.sh('ls -lh big.bin')).toEqual(ok('-rw-r--r-- 2.0K big.bin\n'))
  })

  it('classifies, reverses, sorts by size and recurses', async () => {
    expect(await sb.sh('ls -F', { tty: true })).toEqual(ok('access.log  nums.txt  README.md  regions.csv  src/\n'))
    expect(await sb.sh('ls -r src')).toEqual(ok('index.ts\nconfig.ts\n'))
    expect(await sb.sh('ls -S src')).toEqual(ok('index.ts\nconfig.ts\n'))
    sb.fs.mkdir('/project/src/lib')
    expect(await sb.sh('ls -R src')).toEqual(ok('src:\nconfig.ts\nindex.ts\nlib\n\nsrc/lib:\n'))
  })

  it('lays names out down then across in columns that fit the terminal width', async () => {
    expect(await sb.sh('ls', { tty: true, columns: 80 })).toEqual(ok('access.log  nums.txt  README.md  regions.csv  src\n'))
    expect(await sb.sh('ls', { tty: true, columns: 30 })).toEqual(ok('access.log  README.md    src\nnums.txt    regions.csv\n'))
    expect(await sb.sh('ls', { tty: true, columns: 29 })).toEqual(ok('access.log  README.md    src\nnums.txt    regions.csv\n'))
    expect(await sb.sh('ls', { tty: true, columns: 28 })).toEqual(ok('access.log  regions.csv\nnums.txt    src\nREADME.md\n'))
    expect(await sb.sh('ls', { tty: true, columns: 12 })).toEqual(ok('access.log\nnums.txt\nREADME.md\nregions.csv\nsrc\n'))
    expect(await sb.sh('ls', { columns: 30 })).toEqual(ok('access.log\nnums.txt\nREADME.md\nregions.csv\nsrc\n'))
    expect(await sb.sh('ls -C', { columns: 30 })).toEqual(ok('access.log  README.md    src\nnums.txt    regions.csv\n'))
    expect(await sb.sh('ls -1', { tty: true, columns: 80 })).toEqual(ok('access.log\nnums.txt\nREADME.md\nregions.csv\nsrc\n'))
  })

  it('measures painted and wide names by the cells they take', async () => {
    sb.fs.mkdir('/project/docs')
    expect(await sb.sh('ls', { tty: true, colors: true, columns: 30 })).toEqual(
      ok('access.log  README.md\n\x1b[34mdocs\x1b[0m        regions.csv\nnums.txt    \x1b[34msrc\x1b[0m\n'),
    )
    sb.fs.mkdir('/project/wide')
    for (const name of ['ab', 'cd', '日本語.md']) sb.fs.write(`/project/wide/${name}`, '')
    expect(await sb.sh('ls wide', { tty: true, columns: 13 })).toEqual(ok('ab\ncd\n日本語.md\n'))
    expect(await sb.sh('ls wide', { tty: true, columns: 14 })).toEqual(ok('ab  日本語.md\ncd\n'))
  })

  it('accepts -G as a harmless no-op', async () => {
    expect(await sb.sh('ls -G src')).toEqual(ok('config.ts\nindex.ts\n'))
    expect(await sb.sh('ls -lG README.md')).toEqual(ok('-rw-r--r-- 68 README.md\n'))
    expect(await sb.sh('ls --no-group README.md')).toEqual(ok('README.md\n'))
  })
})

describe('echo [sb-8, sb-9]', () => {
  it('treats only leading -n/-e/-E words as options', async () => {
    expect(await sb.sh('echo "- item one"')).toEqual(ok('- item one\n'))
    expect(await sb.sh('echo a -b c')).toEqual(ok('a -b c\n'))
    expect(await sb.sh('echo a -n b')).toEqual(ok('a -n b\n'))
    expect(await sb.sh('echo -n 5')).toEqual(ok('5'))
    expect(await sb.sh('echo -nx 5')).toEqual(ok('-nx 5\n'))
  })

  it('interprets escapes only with -e', async () => {
    expect(await sb.sh('echo -ne "a\\nb"')).toEqual(ok('a\nb'))
    expect(await sb.sh('echo -e "x\\cy"')).toEqual(ok('x'))
    expect(await sb.sh('echo -E "a\\tb"')).toEqual(ok('a\\tb\n'))
    expect(await sb.sh('echo "a\\tb"')).toEqual(ok('a\\tb\n'))
    expect(await sb.sh('echo -e "\\x41\\0102\\u00e9"')).toEqual(ok('ABé\n'))
  })
})

describe('head and tail [sb-10, sb-14]', () => {
  it('accepts -NUM, -nNUM, --lines=NUM and tail +NUM', async () => {
    expect(await sb.sh('tail -1 regions.csv')).toEqual(ok('gamma,eu-west\n'))
    expect(await sb.sh('head --lines=1 regions.csv')).toEqual(ok('name,region\n'))
    expect(await sb.sh('head -n 0 regions.csv')).toEqual(ok(''))
    expect(await sb.sh('tail +3 nums.txt')).toEqual(ok('2\n10\n'))
    expect(await sb.sh('head -n -2 nums.txt')).toEqual(ok('10\n9\n'))
  })

  it('counts bytes with -c', async () => {
    expect(await sb.sh('head -c 5 README.md')).toEqual(ok('# dem'))
    expect(await sb.sh('tail -c 3 nums.txt')).toEqual(ok('10\n'))
    expect(await sb.sh('tail -c +4 nums.txt')).toEqual(ok('9\n2\n10\n'))
  })

  it('keeps a missing final newline', async () => {
    sb.fs.write('/project/x.txt', 'a\nb')
    expect(await sb.sh('head -n 5 x.txt')).toEqual(ok('a\nb'))
    expect(await sb.sh('tail -n 1 x.txt')).toEqual(ok('b'))
  })

  it('prints a header per file when there are several', async () => {
    expect(await sb.sh('head -n 1 regions.csv README.md')).toEqual(
      ok('==> regions.csv <==\nname,region\n\n==> README.md <==\n# demo app\n'),
    )
    expect(await sb.sh('tail -q -n 1 regions.csv nums.txt')).toEqual(ok('gamma,eu-west\n10\n'))
    expect(await sb.sh('head -v -n 1 nums.txt')).toEqual(ok('==> nums.txt <==\n10\n'))
  })

  it('reports unreadable files the coreutils way and continues', async () => {
    expect(await sb.sh('head nope.txt nums.txt')).toEqual(
      failed("head: cannot open 'nope.txt' for reading: No such file or directory\n", 1, `==> nums.txt <==\n${NUMS}`),
    )
    expect(await sb.sh('tail src')).toEqual(failed("tail: error reading 'src': Is a directory\n"))
    expect(await sb.sh('head -n x nums.txt')).toEqual(failed("head: invalid number of lines: 'x'\n"))
  })
})

describe('wc [sb-14, sb-28]', () => {
  it('pads columns like GNU wc', async () => {
    expect(await sb.sh('wc README.md')).toEqual(ok(' 4 13 68 README.md\n'))
    expect(await sb.sh('echo hi | wc')).toEqual(ok('      1       1       3\n'))
    expect(await sb.sh('wc -lw nums.txt')).toEqual(ok(' 4  4 nums.txt\n'))
  })

  it('counts newlines, bytes and characters', async () => {
    sb.fs.write('/project/x.txt', 'a\nb')
    expect(await sb.sh('wc -l x.txt')).toEqual(ok('1 x.txt\n'))
    expect(await sb.sh('echo 😀 | wc -c')).toEqual(ok('5\n'))
    expect(await sb.sh('echo 😀 | wc -m')).toEqual(ok('2\n'))
  })

  it('reports a missing file and still totals the rest', async () => {
    expect(await sb.sh('wc -l nope.txt nums.txt')).toEqual(
      failed('wc: nope.txt: No such file or directory\n', 1, '4 nums.txt\n4 total\n'),
    )
  })
})

describe('grep [sb-8, sb-13, sb-14]', () => {
  it('numbers lines per file and prefixes file names', async () => {
    expect(await sb.sh('grep -n region regions.csv src/config.ts')).toEqual(
      ok(`regions.csv:1:name,region\nsrc/config.ts:1:${CONFIG}`),
    )
    expect(await sb.sh('grep -c eu regions.csv README.md')).toEqual(ok('regions.csv:2\nREADME.md:0\n'))
    expect(await sb.sh('grep -h eu regions.csv README.md')).toEqual(ok('alpha,eu-central\ngamma,eu-west\n'))
    expect(await sb.sh('grep -H eu regions.csv')).toEqual(ok('regions.csv:alpha,eu-central\nregions.csv:gamma,eu-west\n'))
  })

  it('prints context with separators', async () => {
    expect(await sb.sh('grep -A 1 alpha regions.csv')).toEqual(ok('alpha,eu-central\nbeta,us-east\n'))
    expect(await sb.sh('grep -B 1 10 nums.txt')).toEqual(ok('10\n--\n2\n10\n'))
    expect(await sb.sh('grep -n -C 1 9 nums.txt')).toEqual(ok('1-10\n2:9\n3-2\n'))
    expect(await sb.sh('grep -1 9 nums.txt')).toEqual(ok('10\n9\n2\n'))
  })

  it('supports -m, -o -n, -l over a tree and an implicit recursive root', async () => {
    expect(await sb.sh('grep -m 1 200 access.log')).toEqual(ok('GET /index.html 200\n'))
    expect(await sb.sh('grep -o -n eu regions.csv')).toEqual(ok('2:eu\n4:eu\n'))
    expect(await sb.sh('grep -rl eu .')).toEqual(ok('./regions.csv\n./src/config.ts\n'))
    expect(await sb.sh('grep -r handler')).toEqual(ok(`src/index.ts:${INDEX}`))
    expect(await sb.sh('grep -r --include=*.csv eu .')).toEqual(
      ok('./regions.csv:alpha,eu-central\n./regions.csv:gamma,eu-west\n'),
    )
  })

  it('distinguishes fixed strings, basic and extended expressions', async () => {
    sb.fs.write('/project/dots.txt', 'a.b\naxb\na|b\nab\n')
    expect(await sb.sh('grep -F a.b dots.txt')).toEqual(ok('a.b\n'))
    expect(await sb.sh('grep a.b dots.txt')).toEqual(ok('a.b\naxb\na|b\n'))
    expect(await sb.sh("grep 'a|b' dots.txt")).toEqual(ok('a|b\n'))
    expect(await sb.sh("grep -E 'a|b' dots.txt")).toEqual(ok('a.b\naxb\na|b\nab\n'))
    expect(await sb.sh("grep 'GET\\|POST' access.log")).toEqual(ok(ACCESS))
    expect(await sb.sh("grep -c '[[:digit:]]\\{3\\}' access.log")).toEqual(ok('4\n'))
    expect(await sb.sh("grep -o '\\<eu' regions.csv")).toEqual(ok('eu\neu\n'))
  })

  it('reads stdin, highlights on request and reports usage errors', async () => {
    expect(await sb.sh('echo hi | grep -c hi')).toEqual(ok('1\n'))
    expect(await sb.sh('grep --color=always handler src/index.ts')).toEqual(
      ok("export const \x1b[01;31m\x1b[Khandler\x1b[m\x1b[K = () => 'hello from orbit'\n"),
    )
    expect(await sb.sh('grep')).toEqual(failed('Usage: grep [OPTION]... PATTERNS [FILE]...\n', 2))
    expect(await sb.sh('grep -E ( regions.csv')).toEqual(failed('grep: invalid pattern: (\n', 2))
    expect(await sb.sh('grep -C x eu regions.csv')).toEqual(failed('grep: x: invalid context length argument\n', 2))
  })

  it('exits 2 on unreadable files unless -q found a match', async () => {
    expect(await sb.sh('grep eu src')).toEqual(failed('grep: src: Is a directory\n', 2))
    expect(await sb.sh('grep -q GET nope.txt access.log')).toEqual(
      failed('grep: nope.txt: No such file or directory\n', 0),
    )
    expect(await sb.sh('grep -s eu nope.txt')).toEqual(failed('', 2))
    expect(await sb.sh('grep eu nope.txt regions.csv')).toEqual(
      failed(
        'grep: nope.txt: No such file or directory\n',
        2,
        'regions.csv:alpha,eu-central\nregions.csv:gamma,eu-west\n',
      ),
    )
  })
})

describe('grep on Unicode text', () => {
  beforeEach(() => {
    sb.fs.write('/project/ru.txt', 'грепать слово\nсловарь\nпро слово.\nСЛОВО и Слово\nслово2\n')
  })

  it('matches whole Cyrillic words with -w in every pattern syntax', async () => {
    for (const syntax of ['-G', '-E', '-F', '-P']) {
      expect(await sb.sh(`grep -w ${syntax} слово ru.txt`), syntax).toEqual(ok('грепать слово\nпро слово.\n'))
      expect(await sb.sh(`grep -w ${syntax} слов ru.txt`), syntax).toEqual(failed(''))
    }
    expect(await sb.sh('grep -wi слово ru.txt')).toEqual(ok('грепать слово\nпро слово.\nСЛОВО и Слово\n'))
  })

  it('anchors \\<, \\>, \\b and \\B at Cyrillic word edges', async () => {
    expect(await sb.sh("grep -c '\\<слово\\>' ru.txt")).toEqual(ok('2\n'))
    expect(await sb.sh("grep -o '\\bсл[а-я]*' ru.txt")).toEqual(ok('слово\nсловарь\nслово\nслово\n'))
    expect(await sb.sh("grep -c 'о\\b' ru.txt")).toEqual(ok('3\n'))
    expect(await sb.sh("grep 'слово\\B' ru.txt")).toEqual(ok('слово2\n'))
  })

  it('counts Unicode letters as \\w and as members of the POSIX classes', async () => {
    expect(await sb.sh("grep -o -m 1 '\\w\\+' ru.txt")).toEqual(ok('грепать\nслово\n'))
    expect(await sb.sh("grep -o '[[:upper:]]\\+' ru.txt")).toEqual(ok('СЛОВО\nС\n'))
    expect(await sb.sh("grep '^[[:lower:]]\\+$' ru.txt")).toEqual(ok('словарь\n'))
    expect(await sb.sh("grep -o '[[:alpha:]]*[[:digit:]]' ru.txt")).toEqual(ok('слово2\n'))
    expect(await sb.sh("grep -o '[[:alnum:]]\\{6,\\}' ru.txt")).toEqual(ok('грепать\nсловарь\nслово2\n'))
    sb.fs.write('/project/space.txt', 'а　б\nа б\nаб\n')
    expect(await sb.sh("grep -c 'а[[:space:]]б' space.txt")).toEqual(ok('2\n'))
    sb.fs.write('/project/quote.txt', '«цитата» — да\n')
    expect(await sb.sh("grep -o '[[:punct:]]' quote.txt")).toEqual(ok('«\n»\n—\n'))
  })

  it('matches POSIX classes against Cyrillic file names', async () => {
    sb.fs.write('/project/Привет.txt', 'eu\n')
    expect(await sb.sh('find . -name [[:upper:]]*.txt')).toEqual(ok('./Привет.txt\n'))
  })

  it('still reads lone brackets, braces and Perl escapes the way it did before', async () => {
    sb.fs.write('/project/braces.txt', 'a{b}\nx]y\nслово-дело\n')
    expect(await sb.sh("grep -E 'a{b' braces.txt")).toEqual(ok('a{b}\n'))
    expect(await sb.sh("grep -E 'b}' braces.txt")).toEqual(ok('a{b}\n'))
    expect(await sb.sh("grep 'b}' braces.txt")).toEqual(ok('a{b}\n'))
    expect(await sb.sh("grep -c ']' braces.txt")).toEqual(ok('1\n'))
    expect(await sb.sh("grep -Eo 'x{,1}]' braces.txt")).toEqual(ok('x]\n'))
    expect(await sb.sh("grep -o '[[:lower:]-z]\\+' braces.txt")).toEqual(ok('a\nb\nx\ny\nслово-дело\n'))
    expect(await sb.sh("grep -P 'eu\\-west' regions.csv")).toEqual(ok('gamma,eu-west\n'))
  })
})

describe('grep options for trees [review: rejected harmless options]', () => {
  it('skips binary files with -I', async () => {
    sb.fs.write('/project/blob.bin', 'eu\0\n')
    expect(await sb.sh('grep -rl eu .')).toEqual(ok('./blob.bin\n./regions.csv\n./src/config.ts\n'))
    expect(await sb.sh('grep -rlI eu .')).toEqual(ok('./regions.csv\n./src/config.ts\n'))
    expect(await sb.sh('grep -I eu blob.bin')).toEqual(failed(''))
  })

  it('prunes directories that match --exclude-dir while recursing', async () => {
    sb.fs.mkdir('/project/node_modules/pkg', true)
    sb.fs.write('/project/node_modules/pkg/index.js', 'const handler = 1\n')
    expect(await sb.sh('grep -rl handler .')).toEqual(ok('./node_modules/pkg/index.js\n./src/index.ts\n'))
    expect(await sb.sh('grep -rl --exclude-dir=node_modules handler .')).toEqual(ok('./src/index.ts\n'))
    expect(await sb.sh('grep -rl --exclude-dir node_modules/ handler')).toEqual(ok('src/index.ts\n'))
    expect(await sb.sh('grep -rl --exclude-dir=pkg handler .')).toEqual(ok('./src/index.ts\n'))
    expect(await sb.sh('grep -rl --exclude-dir=*_modules handler node_modules src')).toEqual(ok('src/index.ts\n'))
  })

  it('limits the files searched with --include while recursing', async () => {
    expect(await sb.sh('grep -r --include *.ts eu .')).toEqual(ok(`./src/config.ts:${CONFIG}`))
    expect(await sb.sh('grep -rh --include=*.csv --include=*.ts eu')).toEqual(
      ok(`alpha,eu-central\ngamma,eu-west\n${CONFIG}`),
    )
  })
})

describe('grep pattern edges like GNU grep', () => {
  const UNMATCHED = 'grep: Unmatched [, [^, [:, [., or [=\n'
  const CLASS_SYNTAX = 'grep: character class syntax is [[:space:]], not [:space:]\n'

  it('rejects an unmatched bracket with exit 2 in basic and extended syntax', async () => {
    expect(await sb.sh('grep [ regions.csv')).toEqual(failed(UNMATCHED, 2))
    expect(await sb.sh('grep -E a[b regions.csv')).toEqual(failed(UNMATCHED, 2))
    expect(await sb.sh('grep -c \\[ regions.csv')).toEqual(failed('', 1, '0\n'))
    expect(await sb.sh('grep -F [ regions.csv')).toEqual(failed(''))
  })

  it('rejects [:space:] written without the outer brackets', async () => {
    expect(await sb.sh('grep [:space:] README.md')).toEqual(failed(CLASS_SYNTAX, 2))
    expect(await sb.sh('grep -E [^:alpha:] README.md')).toEqual(failed(CLASS_SYNTAX, 2))
    expect(await sb.sh('grep -c [[:space:]] README.md')).toEqual(ok('3\n'))
    expect(await sb.sh('grep -c [:a] regions.csv')).toEqual(ok('4\n'))
    expect(await sb.sh('grep -c [:a-z:] regions.csv')).toEqual(ok('4\n'))
  })

  it('reads a star after \\( or \\| as a literal in basic syntax', async () => {
    const stdin = '*a\nxa\nb\n'
    expect(await sb.sh("grep '\\(*a\\)'", { stdin })).toEqual(ok('*a\n'))
    expect(await sb.sh("grep 'b\\|*a'", { stdin })).toEqual(ok('*a\nb\n'))
    expect(await sb.sh("grep '^*a'", { stdin })).toEqual(ok('*a\n'))
  })

  it('drops a repetition operator that starts an extended expression and warns like grep 3.8+', async () => {
    const stdin = '*a\nxa\nb\n'
    expect(await sb.sh("grep -E '(*a)'", { stdin })).toEqual({
      stdout: '*a\nxa\n',
      stderr: 'grep: warning: * at start of expression\n',
      exitCode: 0,
    })
    expect(await sb.sh("grep -E 'b|*q'", { stdin })).toEqual({
      stdout: 'b\n',
      stderr: 'grep: warning: * at start of expression\n',
      exitCode: 0,
    })
    expect(await sb.sh("grep -oE '+a|?b'", { stdin })).toEqual({
      stdout: 'a\na\nb\n',
      stderr: 'grep: warning: + at start of expression\ngrep: warning: ? at start of expression\n',
      exitCode: 0,
    })
  })
})

describe('grep --include and --exclude on file operands', () => {
  it('filters command-line files by name suffix and never filters stdin', async () => {
    expect(await sb.sh('grep --exclude=*.csv -c e regions.csv README.md')).toEqual(ok('README.md:3\n'))
    expect(await sb.sh('grep --include=*.md -l e regions.csv README.md')).toEqual(ok('README.md\n'))
    expect(await sb.sh('grep --exclude=index.ts handler src/index.ts')).toEqual(failed(''))
    expect(await sb.sh('grep --exclude=* eu', { stdin: 'eu\n' })).toEqual(ok('eu\n'))
    expect(await sb.sh('grep --exclude=* eu -', { stdin: 'eu\n' })).toEqual(ok('eu\n'))
  })

  it('lets the last matching option win and defaults to the opposite of the first', async () => {
    expect(await sb.sh('grep --include=*.csv --exclude=regions.* -l e regions.csv README.md')).toEqual(failed(''))
    expect(await sb.sh('grep --exclude=regions.* --include=*.csv -l e regions.csv README.md')).toEqual(
      ok('regions.csv\nREADME.md\n'),
    )
    expect(await sb.sh('grep -rl --include=*.ts --exclude=index.* e src')).toEqual(ok('src/config.ts\n'))
  })
})

describe('wc on a directory', () => {
  it('reports the directory and still prints its zero counts like GNU wc', async () => {
    expect(await sb.sh('wc src')).toEqual(failed('wc: src: Is a directory\n', 1, '      0       0       0 src\n'))
    expect(await sb.sh('wc -l src')).toEqual(failed('wc: src: Is a directory\n', 1, '0 src\n'))
    expect(await sb.sh('wc src nums.txt')).toEqual(
      failed('wc: src: Is a directory\n', 1, '      0       0       0 src\n      4       4      10 nums.txt\n      4       4      10 total\n'),
    )
    expect(await sb.sh('wc nope.txt src')).toEqual(
      failed('wc: nope.txt: No such file or directory\nwc: src: Is a directory\n', 1, '0 0 0 src\n0 0 0 total\n'),
    )
    expect(await sb.stream('wc src')).toEqual({
      events: [
        ['err', 'wc: src: Is a directory\n'],
        ['out', '      0       0       0 src\n'],
      ],
      exitCode: 1,
    })
  })
})

describe('ls formats and order', () => {
  it('lets the last of -l, -1 and -C choose the format', async () => {
    expect(await sb.sh('ls -l -1 src')).toEqual(ok('config.ts\nindex.ts\n'))
    expect(await sb.sh('ls -1 -l nums.txt')).toEqual(ok('-rw-r--r-- 10 nums.txt\n'))
    expect(await sb.sh('ls -l -C src', { tty: true, columns: 80 })).toEqual(ok('config.ts  index.ts\n'))
    expect(await sb.sh('ls -C -1 src', { tty: true, columns: 80 })).toEqual(ok('config.ts\nindex.ts\n'))
  })

  it('sorts names with the locale collation that sort uses', async () => {
    sb.fs.write('/project/Zeta.md', '')
    sb.fs.write('/project/ёлка.txt', '')
    expect(await sb.sh('ls -1')).toEqual(ok('access.log\nnums.txt\nREADME.md\nregions.csv\nsrc\nZeta.md\nёлка.txt\n'))
    expect(await sb.sh('ls -1r')).toEqual(ok('ёлка.txt\nZeta.md\nsrc\nregions.csv\nREADME.md\nnums.txt\naccess.log\n'))
    expect(await sb.sh('ls -1 | sort')).toEqual(await sb.sh('ls -1'))
  })

  it('lists a directory larger than the engine argument limit in long format', async () => {
    const count = 150_000
    const shell = createShellBackend({
      files: { many: Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, 'x'])) },
    })
    expect(await shell.run('ls -l /many | wc -l')).toEqual({ output: String(count), exitCode: 0 })
  }, HEAVY_TIMEOUT)
})

describe('find actions', () => {
  it('prints only the paths that reach an explicit -print', async () => {
    expect(await sb.sh("find . -name '*.md' -print -o -name '*.csv'")).toEqual(ok('./README.md\n'))
    expect(await sb.sh("find . -name '*.csv' -o -name '*.md' -print")).toEqual(ok('./README.md\n'))
    expect(await sb.sh('find src -name index.ts -print -print')).toEqual(ok('src/index.ts\nsrc/index.ts\n'))
    expect(await sb.sh('find src -type d -print -o -name c* -print')).toEqual(ok('src\nsrc/config.ts\n'))
    expect(await sb.sh("find . -maxdepth 1 -name '*.csv'")).toEqual(ok('./regions.csv\n'))
  })
})

describe('printf integer range', () => {
  const RANGE = (arg: string): string => `printf: '${arg}': Numerical result out of range\n`

  it('clamps out-of-range integers and reports them like GNU printf', async () => {
    expect(await sb.sh("printf '%d\\n' 99999999999999999999")).toEqual(
      failed(RANGE('99999999999999999999'), 1, '9223372036854775807\n'),
    )
    expect(await sb.sh("printf '%i\\n' -99999999999999999999")).toEqual(
      failed(RANGE('-99999999999999999999'), 1, '-9223372036854775808\n'),
    )
    expect(await sb.sh("printf '%x\\n' 99999999999999999999")).toEqual(
      failed(RANGE('99999999999999999999'), 1, 'ffffffffffffffff\n'),
    )
  })

  it('keeps every digit of 64-bit values and wraps negative unsigned values', async () => {
    expect(await sb.sh("printf '%d %d\\n' 9223372036854775807 9007199254740993")).toEqual(
      ok('9223372036854775807 9007199254740993\n'),
    )
    expect(await sb.sh("printf '%u %x %o\\n' -1 -1 8")).toEqual(ok('18446744073709551615 ffffffffffffffff 10\n'))
    expect(await sb.sh("printf '%05d|%-4d|%+d|%.3d\\n' 42 7 5 9")).toEqual(ok('00042|7   |+5|009\n'))
  })
})

describe('sort and uniq [sb-12, sb-16]', () => {
  it('extracts each key once per line, so a far key on many lines stays fast', async () => {
    const count = 5000
    const fields = Array.from({ length: 59 }, (_, index) => `f${index}`).join(' ')
    const lines = Array.from({ length: count }, (_, index) => `${fields} k${(index * 7919) % count}`)
    sb.fs.write('/project/wide.txt', `${lines.join('\n')}\n`)
    const upper = vi.spyOn(String.prototype, 'toUpperCase')
    let extracted = 0
    let sorted = ''
    try {
      sorted = (await sb.run(['sort', '-f', '-k60,60', 'wide.txt'])).stdout
      extracted = upper.mock.contexts.filter((text) => /^\s*k\d+$/.test(String(text))).length
    } finally {
      upper.mockRestore()
    }
    expect([extracted, sorted.split('\n').slice(0, 3).map((line) => line.split(' ').at(-1))]).toEqual([
      count,
      ['k0', 'k1', 'k10'],
    ])
  })

  it('sorts inputs larger than the engine argument limit', async () => {
    const text = Array.from({ length: 300_000 }, (_, index) => `${index}\n`).join('')
    sb.fs.write('/project/big.txt', text)
    const sorted = await sb.sh('sort -n big.txt')
    expect(sorted.exitCode).toBe(0)
    expect(sorted.stdout === text).toBe(true)
  }, HEAVY_TIMEOUT)

  it('reverses, combines numeric with reverse and unique', async () => {
    expect(await sb.sh('sort -r nums.txt')).toEqual(ok('9\n2\n10\n10\n'))
    expect(await sb.sh('sort -rn nums.txt')).toEqual(ok('10\n10\n9\n2\n'))
    expect(await sb.sh('sort -nu nums.txt')).toEqual(ok('2\n9\n10\n'))
  })

  it('folds case and dedupes by the folded key', async () => {
    sb.fs.write('/project/case.txt', 'b\nB\na\nA\n')
    expect(await sb.sh('sort -fu case.txt')).toEqual(ok('a\nb\n'))
  })

  it('sorts by numeric keys inside fields', async () => {
    sb.fs.write('/project/scores.txt', 'carol 7\nalice 12\nbob 9\n')
    expect(await sb.sh('sort -k2n scores.txt')).toEqual(ok('carol 7\nbob 9\nalice 12\n'))
    expect(await sb.sh('sort -k 2,2nr scores.txt')).toEqual(ok('alice 12\nbob 9\ncarol 7\n'))
  })

  it('writes -o output and rejects bad separators and keys', async () => {
    expect(await sb.sh('sort -o sorted.txt nums.txt')).toEqual(ok(''))
    expect(sb.fs.read('/project/sorted.txt')).toBe('10\n10\n2\n9\n')
    expect(await sb.sh('sort -t ab nums.txt')).toEqual(failed("sort: multi-character tab 'ab'\n", 2))
    expect(await sb.sh('sort -k x nums.txt')).toEqual(
      failed("sort: invalid number at field start: invalid count at start of 'x'\n", 2),
    )
  })

  it('reports unreadable inputs instead of printing nothing', async () => {
    expect(await sb.sh('sort nope.txt')).toEqual(failed('sort: cannot read: nope.txt: No such file or directory\n', 2))
    expect(await sb.sh('uniq nope.txt')).toEqual(failed('uniq: nope.txt: No such file or directory\n'))
  })

  it('supports -d, -u, -i and refuses extra operands', async () => {
    sb.fs.write('/project/a.txt', 'a\na\nA\nb\n')
    expect(await sb.sh('uniq -d a.txt')).toEqual(ok('a\n'))
    expect(await sb.sh('uniq -u a.txt')).toEqual(ok('A\nb\n'))
    expect(await sb.sh('uniq -ci a.txt')).toEqual(ok('      3 a\n      1 b\n'))
    expect(await sb.sh('uniq a.txt b.txt c.txt')).toEqual(failed("uniq: extra operand 'c.txt'\n"))
  })
})

describe('find [sb-11]', () => {
  it('combines tests, depth limits, negation and alternatives', async () => {
    expect(await sb.sh('find src -name *.ts -type f')).toEqual(ok('src/config.ts\nsrc/index.ts\n'))
    expect(await sb.sh('find . -maxdepth 0')).toEqual(ok('.\n'))
    expect(await sb.sh('find . -mindepth 2')).toEqual(ok('./src/config.ts\n./src/index.ts\n'))
    expect(await sb.sh('find / -name index.ts')).toEqual(ok('/project/src/index.ts\n'))
    expect(await sb.sh('find -iname *.MD')).toEqual(ok('./README.md\n'))
    expect(await sb.sh('find . -name *.ts -o -name *.md')).toEqual(
      ok('./README.md\n./src/config.ts\n./src/index.ts\n'),
    )
    expect(await sb.sh('find . ! -name *.ts -type f')).toEqual(
      ok('./README.md\n./access.log\n./nums.txt\n./regions.csv\n'),
    )
    expect(await sb.sh('find src/ -path src/i*')).toEqual(ok('src/index.ts\n'))
  })

  it('reports malformed expressions', async () => {
    expect(await sb.sh('find . -type x')).toEqual(failed('find: Unknown argument to -type: x\n'))
    expect(await sb.sh('find . -bogus')).toEqual(failed("find: unknown predicate '-bogus'\n"))
    expect(await sb.sh('find . -name')).toEqual(failed("find: missing argument to '-name'\n"))
  })
})

describe('cp and mv [sb-4, sb-5, sb-7, sb-19, shell-cp-mv-multi, shell-mv-same-path, shell-cp-mv-directories]', () => {
  it('refuses several sources when the target is not a directory', async () => {
    expect(await sb.sh('cp README.md regions.csv backup')).toEqual(failed("cp: target 'backup' is not a directory\n"))
    expect(await sb.sh('mv README.md regions.csv backup')).toEqual(failed("mv: target 'backup' is not a directory\n"))
    expect(sb.fs.read('/project/regions.csv')).toBe(REGIONS)
    expect(sb.fs.read('/project/README.md')).toBe(README)
    expect(sb.fs.exists('/project/backup')).toBe(false)
  })

  it('copies and moves globbed sources into the target directory', async () => {
    sb.fs.mkdir('/project/backup')
    expect(await sb.sh('cp src/config.ts src/index.ts backup/')).toEqual(ok(''))
    expect(sb.fs.list('/project/backup')).toEqual(['config.ts', 'index.ts'])
    expect(sb.fs.read('/project/src/index.ts')).toBe(INDEX)
    sb.fs.mkdir('/project/moved')
    expect(await sb.sh('mv src/config.ts src/index.ts moved')).toEqual(ok(''))
    expect(sb.fs.list('/project/moved')).toEqual(['config.ts', 'index.ts'])
    expect(sb.fs.list('/project/src')).toEqual([])
  })

  it('refuses to move or copy a file onto itself', async () => {
    expect(await sb.sh('mv src/config.ts src/')).toEqual(
      failed("mv: 'src/config.ts' and 'src/config.ts' are the same file\n"),
    )
    expect(await sb.sh('cp README.md .')).toEqual(failed("cp: 'README.md' and './README.md' are the same file\n"))
    expect(sb.fs.read('/project/src/config.ts')).toBe(CONFIG)
  })

  it('never turns a missing name/ target into a file', async () => {
    expect(await sb.sh('cp README.md newdir/')).toEqual(
      failed("cp: cannot create regular file 'newdir/': Not a directory\n"),
    )
    expect(await sb.sh('mv README.md newdir/')).toEqual(
      failed("mv: cannot move 'README.md' to 'newdir/': Not a directory\n"),
    )
    expect(await sb.sh('cp README.md nodir/x')).toEqual(
      failed("cp: cannot create regular file 'nodir/x': No such file or directory\n"),
    )
    expect(sb.fs.list('/project')).toEqual(['README.md', 'access.log', 'nums.txt', 'regions.csv', 'src'])
  })

  it('guards directory copies and renames', async () => {
    expect(await sb.sh('cp -r src src/inner')).toEqual(
      failed("cp: cannot copy a directory, 'src', into itself, 'src/inner'\n"),
    )
    expect(await sb.sh('mv src src/inner')).toEqual(
      failed("mv: cannot move 'src' to a subdirectory of itself, 'src/inner'\n"),
    )
    expect(await sb.sh('mv src README.md')).toEqual(
      failed("mv: cannot overwrite non-directory 'README.md' with directory 'src'\n"),
    )
    expect(await sb.sh('cp -r src lib')).toEqual(ok(''))
    expect(await sb.sh('cp -r src lib')).toEqual(ok(''))
    expect(sb.fs.list('/project/lib')).toEqual(['config.ts', 'index.ts', 'src'])
  })

  it('reports missing operands and sources', async () => {
    expect(await sb.sh('cp')).toEqual(failed('cp: missing file operand\n'))
    expect(await sb.sh('cp a')).toEqual(failed("cp: missing destination file operand after 'a'\n"))
    expect(await sb.sh('mv')).toEqual(failed('mv: missing file operand\n'))
    expect(await sb.sh('cp nope x')).toEqual(failed("cp: cannot stat 'nope': No such file or directory\n"))
    expect(await sb.sh('mv nope x')).toEqual(failed("mv: cannot stat 'nope': No such file or directory\n"))
  })

  it('prints verbose transfers', async () => {
    expect(await sb.sh('cp -v nums.txt n2.txt')).toEqual(ok("'nums.txt' -> 'n2.txt'\n"))
    expect(await sb.sh('mv -v n2.txt n3.txt')).toEqual(ok("renamed 'n2.txt' -> 'n3.txt'\n"))
  })
})

describe('which and type [sb-15, docs-shell-3]', () => {
  const commands = ['ls', 'cat', 'which', 'type', 'orbit', 'less']

  it('looks names up in the command table', async () => {
    expect(await sb.sh('which ls cat', { commands })).toEqual(ok('ls: shell builtin\ncat: shell builtin\n'))
    expect(await sb.sh('which orbit', { commands })).toEqual(ok('/usr/bin/orbit\n'))
    expect(await sb.sh('which docker', { commands })).toEqual(failed('docker not found\n'))
    expect(await sb.sh('which ls docker', { commands })).toEqual(failed('docker not found\n', 1, 'ls: shell builtin\n'))
  })

  it('treats the shell-level help as a builtin and other runtime commands as programs', async () => {
    const shellCommands = [...commands, 'help', 'clear']
    expect(await sb.sh('type help clear less', { commands: shellCommands })).toEqual(
      ok('help is a shell builtin\nclear is /usr/bin/clear\nless is /usr/bin/less\n'),
    )
    expect(await sb.sh('which help', { commands: shellCommands })).toEqual(ok('help: shell builtin\n'))
  })

  it('describes names with type', async () => {
    expect(await sb.sh('type orbit ls', { commands })).toEqual(ok('orbit is /usr/bin/orbit\nls is a shell builtin\n'))
    expect(await sb.sh('type nope', { commands })).toEqual(failed('type: nope: not found\n'))
    expect(await sb.sh('type -t ls orbit', { commands })).toEqual(ok('builtin\nfile\n'))
  })
})

describe('rm, mkdir, touch [sb-17, sb-18, sb-19, sb-31]', () => {
  it('handles -f without operands or targets', async () => {
    expect(await sb.sh('rm -f')).toEqual(ok(''))
    expect(await sb.sh('rm -f nope')).toEqual(ok(''))
  })

  it('refuses directories without -r and dot paths with -r', async () => {
    expect(await sb.sh('rm src')).toEqual(failed("rm: cannot remove 'src': Is a directory\n"))
    expect(await sb.sh('rm -r src/..')).toEqual(failed("rm: refusing to remove '.' or '..' directory: skipping 'src/..'\n"))
    expect(await sb.sh('rm -rf /project/..')).toEqual(
      failed("rm: refusing to remove '.' or '..' directory: skipping '/project/..'\n"),
    )
    expect(await sb.sh('rm -rf //')).toEqual(
      failed(
        "rm: it is dangerous to operate recursively on '//' (same as '/')\nrm: use --no-preserve-root to override this failsafe\n",
      ),
    )
    expect(await sb.sh('rm .')).toEqual(failed("rm: cannot remove '.': Is a directory\n"))
    expect(sb.fs.list('/project/src')).toEqual(['config.ts', 'index.ts'])
  })

  it('refuses a trailing slash after a regular file and keeps the file', async () => {
    expect(await sb.sh('rm README.md/')).toEqual(failed("rm: cannot remove 'README.md/': Not a directory\n"))
    expect(await sb.sh('rm -r README.md/ nums.txt')).toEqual(failed("rm: cannot remove 'README.md/': Not a directory\n"))
    expect(await sb.sh('rm -f README.md/')).toEqual(ok(''))
    expect(sb.fs.read('/project/README.md')).toBe(README)
    expect(sb.fs.exists('/project/nums.txt')).toBe(false)
    expect(await sb.sh('rm -r src/')).toEqual(ok(''))
    expect(sb.fs.exists('/project/src')).toBe(false)
  })

  it('removes empty directories with -d and reports verbose removals', async () => {
    sb.fs.mkdir('/project/empty')
    expect(await sb.sh('rm -dv empty README.md')).toEqual(ok("removed directory 'empty'\nremoved 'README.md'\n"))
    expect(await sb.sh('rm -d src')).toEqual(failed("rm: cannot remove 'src': Directory not empty\n"))
  })

  it('reports missing operands for mkdir and touch', async () => {
    expect(await sb.sh('mkdir')).toEqual(failed('mkdir: missing operand\n'))
    expect(await sb.sh('touch')).toEqual(failed('touch: missing file operand\n'))
  })

  it('processes every mkdir operand and never shadows a file', async () => {
    expect(await sb.sh('mkdir a src b')).toEqual(failed("mkdir: cannot create directory 'src': File exists\n"))
    expect(sb.fs.isDir('/project/a') && sb.fs.isDir('/project/b')).toBe(true)
    expect(await sb.sh('mkdir README.md')).toEqual(failed("mkdir: cannot create directory 'README.md': File exists\n"))
    expect(sb.fs.read('/project/README.md')).toBe(README)
    expect(await sb.sh('mkdir x/y')).toEqual(failed("mkdir: cannot create directory 'x/y': No such file or directory\n"))
    expect(await sb.sh('mkdir -p x/y')).toEqual(ok(''))
    expect(await sb.sh('mkdir -v z')).toEqual(ok("mkdir: created directory 'z'\n"))
  })

  it('does not create files under missing or file parents', async () => {
    expect(await sb.sh('touch notes/todo.txt')).toEqual(
      failed("touch: cannot touch 'notes/todo.txt': No such file or directory\n"),
    )
    expect(await sb.sh('touch README.md/x')).toEqual(failed("touch: cannot touch 'README.md/x': Not a directory\n"))
    expect(await sb.sh('touch newdir/')).toEqual(
      failed("touch: setting times of 'newdir/': No such file or directory\n"),
    )
    expect(sb.fs.list('/project')).toEqual(['README.md', 'access.log', 'nums.txt', 'regions.csv', 'src'])
  })
})

describe('cd [sb-26]', () => {
  it('goes home without an argument and validates its operand', async () => {
    expect(await sb.sh('cd')).toEqual(ok(''))
    expect(sb.cwd).toBe('/home/reader')
    expect(await sb.sh('cd a b')).toEqual(failed('cd: too many arguments\n'))
    expect(await sb.sh('cd /nowhere')).toEqual(failed('cd: /nowhere: No such file or directory\n'))
    expect(await sb.sh('cd /project/README.md')).toEqual(failed('cd: /project/README.md: Not a directory\n'))
  })

  it('reports unset HOME and OLDPWD', async () => {
    expect(await sb.sh('cd -')).toEqual(failed('cd: OLDPWD not set\n'))
    delete sb.env.HOME
    expect(await sb.sh('cd')).toEqual(failed('cd: HOME not set\n'))
    expect(sb.cwd).toBe('/project')
  })
})

describe('export and unset [sb-32]', () => {
  it('rejects invalid names and quotes listed values', async () => {
    expect(await sb.sh('export =oops')).toEqual(failed("export: '=oops': not a valid identifier\n"))
    expect(await sb.sh('export A=1 B=2')).toEqual(ok(''))
    expect([sb.env.A, sb.env.B]).toEqual(['1', '2'])
    sb.env.QUOTE = 'say "hi" $HOME'
    expect(await sb.sh('export -p')).toEqual(
      ok(
        'export A="1"\nexport B="2"\nexport HOME="/home/reader"\nexport PROJECT="orbit"\nexport PWD="/project"\nexport QUOTE="say \\"hi\\" \\$HOME"\n',
      ),
    )
    expect(await sb.sh('unset 1bad')).toEqual(failed("unset: '1bad': not a valid identifier\n"))
  })
})

describe('sleep [sb-27]', () => {
  it('does not cap long sleeps and sums its operands', async () => {
    vi.useFakeTimers()
    let settled = false
    const pending = sb.sh('sleep 6 0.5m').then((outcome) => {
      settled = true
      return outcome
    })
    await vi.advanceTimersByTimeAsync(35_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual(ok(''))
  })

  it('needs an operand and returns 130 at once for an aborted signal', async () => {
    expect(await sb.sh('sleep')).toEqual(failed('sleep: missing operand\n'))
    const controller = new AbortController()
    controller.abort()
    expect(await sb.sh('sleep 10', { signal: controller.signal })).toEqual(failed('', 130))
  })
})

describe('cat [sb-29 ordering inside the builtin, sb-33]', () => {
  it('returns stdout and stderr separately without write callbacks', async () => {
    expect(await sb.sh('cat README.md nope.txt regions.csv')).toEqual(
      failed('cat: nope.txt: No such file or directory\n', 1, README + REGIONS),
    )
  })

  it('streams in operand order through write/writeError', async () => {
    expect(await sb.stream('cat README.md nope.txt regions.csv')).toEqual({
      events: [
        ['out', README],
        ['err', 'cat: nope.txt: No such file or directory\n'],
        ['out', REGIONS],
      ],
      exitCode: 1,
    })
  })

  it('numbers, squeezes and marks line ends', async () => {
    expect(await sb.sh('cat -b README.md')).toEqual(
      ok('     1\t# demo app\n\n     2\tDeployed with the orbit CLI.\n     3\tRun `orbit help` to start.\n'),
    )
    sb.fs.write('/project/gaps.txt', 'a\n\n\n\nb\n')
    expect(await sb.sh('cat -s gaps.txt')).toEqual(ok('a\n\nb\n'))
    expect(await sb.sh('cat -E nums.txt')).toEqual(ok('10$\n9$\n2$\n10$\n'))
    expect(await sb.sh('cat -n nums.txt nums.txt')).toEqual(
      ok('     1\t10\n     2\t9\n     3\t2\n     4\t10\n     5\t10\n     6\t9\n     7\t2\n     8\t10\n'),
    )
    expect(await sb.sh('cat src')).toEqual(failed('cat: src: Is a directory\n'))
  })

  it('shows nonprinting characters with -v, -A, -e and -t', async () => {
    sb.fs.write('/project/raw.txt', 'a\tb\x01\x7f\n')
    expect(await sb.sh('cat -v raw.txt')).toEqual(ok('a\tb^A^?\n'))
    expect(await sb.sh('cat -A raw.txt')).toEqual(ok('a^Ib^A^?$\n'))
    expect(await sb.sh('cat -e raw.txt')).toEqual(ok('a\tb^A^?$\n'))
    expect(await sb.sh('cat -t raw.txt')).toEqual(ok('a^Ib^A^?\n'))
  })
})

describe('operand order through write/writeError [sb-29]', () => {
  const merged = (events: Event[]): Event[] =>
    events.reduce<Event[]>((list, [kind, text]) => {
      const last = list[list.length - 1]
      if (last?.[0] === kind) list[list.length - 1] = [kind, last[1] + text]
      else list.push([kind, text])
      return list
    }, [])

  const rows: Array<[string, Event[], number]> = [
    [
      'head -n 1 regions.csv nope.txt nums.txt',
      [
        ['out', '==> regions.csv <==\nname,region\n'],
        ['err', "head: cannot open 'nope.txt' for reading: No such file or directory\n"],
        ['out', '\n==> nums.txt <==\n10\n'],
      ],
      1,
    ],
    [
      'tail -n 1 regions.csv nope.txt nums.txt',
      [
        ['out', '==> regions.csv <==\ngamma,eu-west\n'],
        ['err', "tail: cannot open 'nope.txt' for reading: No such file or directory\n"],
        ['out', '\n==> nums.txt <==\n10\n'],
      ],
      1,
    ],
    [
      'head -n 1 regions.csv src nums.txt',
      [
        ['out', '==> regions.csv <==\nname,region\n\n==> src <==\n'],
        ['err', "head: error reading 'src': Is a directory\n"],
        ['out', '\n==> nums.txt <==\n10\n'],
      ],
      1,
    ],
    [
      'tail -n 1 src regions.csv',
      [
        ['out', '==> src <==\n'],
        ['err', "tail: error reading 'src': Is a directory\n"],
        ['out', '\n==> regions.csv <==\ngamma,eu-west\n'],
      ],
      1,
    ],
    [
      'head -v src',
      [
        ['out', '==> src <==\n'],
        ['err', "head: error reading 'src': Is a directory\n"],
      ],
      1,
    ],
    [
      'head -q -n 1 src nums.txt',
      [
        ['err', "head: error reading 'src': Is a directory\n"],
        ['out', '10\n'],
      ],
      1,
    ],
    [
      'wc -l nums.txt nope.txt regions.csv',
      [
        ['out', ' 4 nums.txt\n'],
        ['err', 'wc: nope.txt: No such file or directory\n'],
        ['out', ' 4 regions.csv\n 8 total\n'],
      ],
      1,
    ],
    [
      'grep -c e regions.csv nope.txt nums.txt',
      [
        ['out', 'regions.csv:4\n'],
        ['err', 'grep: nope.txt: No such file or directory\n'],
        ['out', 'nums.txt:0\n'],
      ],
      2,
    ],
    [
      'find src nope README.md',
      [
        ['out', 'src\nsrc/config.ts\nsrc/index.ts\n'],
        ['err', "find: 'nope': No such file or directory\n"],
        ['out', 'README.md\n'],
      ],
      1,
    ],
    [
      'rm -v README.md nope.txt nums.txt',
      [
        ['out', "removed 'README.md'\n"],
        ['err', "rm: cannot remove 'nope.txt': No such file or directory\n"],
        ['out', "removed 'nums.txt'\n"],
      ],
      1,
    ],
    [
      'mkdir -v a nope/b c',
      [
        ['out', "mkdir: created directory 'a'\n"],
        ['err', "mkdir: cannot create directory 'nope/b': No such file or directory\n"],
        ['out', "mkdir: created directory 'c'\n"],
      ],
      1,
    ],
    [
      'cp -v README.md nope.txt nums.txt src',
      [
        ['out', "'README.md' -> 'src/README.md'\n"],
        ['err', "cp: cannot stat 'nope.txt': No such file or directory\n"],
        ['out', "'nums.txt' -> 'src/nums.txt'\n"],
      ],
      1,
    ],
    [
      'mv -v README.md nope.txt nums.txt src',
      [
        ['out', "renamed 'README.md' -> 'src/README.md'\n"],
        ['err', "mv: cannot stat 'nope.txt': No such file or directory\n"],
        ['out', "renamed 'nums.txt' -> 'src/nums.txt'\n"],
      ],
      1,
    ],
    [
      'type ls nope cat',
      [
        ['out', 'ls is a shell builtin\n'],
        ['err', 'type: nope: not found\n'],
        ['out', 'cat is a shell builtin\n'],
      ],
      1,
    ],
    [
      "printf '%d\\n' 1 x 2",
      [
        ['out', '1\n'],
        ['err', "printf: 'x': expected a numeric value\n"],
        ['out', '0\n2\n'],
      ],
      1,
    ],
    [
      "printf '%s:%d|' a 1 b x c 3",
      [
        ['out', 'a:1|b:'],
        ['err', "printf: 'x': expected a numeric value\n"],
        ['out', '0|c:3|'],
      ],
      1,
    ],
    [
      "printf 'a%zb'",
      [
        ['out', 'a'],
        ['err', 'printf: %z: invalid conversion specification\n'],
      ],
      1,
    ],
  ]

  it.each(rows)('%s', async (line, events, exitCode) => {
    const streamed = await sb.stream(line)
    expect({ events: merged(streamed.events), exitCode: streamed.exitCode }).toEqual({ events, exitCode })
  })
})

describe('printf', () => {
  it('formats strings, numbers and escapes', async () => {
    expect(await sb.sh("printf '%5s|%-5s|\\n' ab cd")).toEqual(ok('   ab|cd   |\n'))
    expect(await sb.sh("printf '%05.1f %x %X %o %c %%\\n' 3.14159 255 255 8 hello")).toEqual(ok('003.1 ff FF 10 h %\n'))
    expect(await sb.sh("printf '%i %d %+d\\n' 0x1f -7 5")).toEqual(ok('31 -7 +5\n'))
    expect(await sb.sh("printf '%e %g %g\\n' 1234.5 0.0001 1234567")).toEqual(ok('1.234500e+03 0.0001 1.23457e+06\n'))
    expect(await sb.sh("printf '%b|%s\\n' 'a\\tb' 'a\\tb'")).toEqual(ok('a\tb|a\\tb\n'))
    expect(await sb.sh("printf '%.2s\\n' abcdef")).toEqual(ok('ab\n'))
  })

  it('reuses the format for remaining arguments', async () => {
    expect(await sb.sh("printf '%s\\n' a b c")).toEqual(ok('a\nb\nc\n'))
    expect(await sb.sh("printf '%s=%s\\n' a 1 b")).toEqual(ok('a=1\nb=\n'))
    expect(await sb.sh('printf hi')).toEqual(ok('hi'))
  })

  it('reports bad numbers and a missing format', async () => {
    expect(await sb.sh("printf '%d\\n' abc")).toEqual(failed("printf: 'abc': expected a numeric value\n", 1, '0\n'))
    expect(await sb.sh('printf')).toEqual(failed('printf: missing operand\n'))
    expect(await sb.sh("printf '%z'")).toEqual(failed('printf: %z: invalid conversion specification\n'))
  })
})

describe('tee, basename, dirname, env', () => {
  it('appends with tee -a and keeps going after a failed file', async () => {
    await sb.sh('echo hi | tee -a log.txt')
    await sb.sh('echo hi | tee -a log.txt')
    expect(sb.fs.read('/project/log.txt')).toBe('hi\nhi\n')
    expect(await sb.sh('echo hi | tee nodir/x ok.txt')).toEqual(
      failed('tee: nodir/x: No such file or directory\n', 1, 'hi\n'),
    )
    expect(sb.fs.read('/project/ok.txt')).toBe('hi\n')
  })

  it('strips directories and suffixes', async () => {
    expect(await sb.sh('basename src/')).toEqual(ok('src\n'))
    expect(await sb.sh('basename /')).toEqual(ok('/\n'))
    expect(await sb.sh('basename -a a/b c/d')).toEqual(ok('b\nd\n'))
    expect(await sb.sh('basename -s .ts src/index.ts src/config.ts')).toEqual(ok('index\nconfig\n'))
    expect(await sb.sh('basename')).toEqual(failed('basename: missing operand\n'))
    expect(await sb.sh('basename a b c')).toEqual(failed("basename: extra operand 'c'\n"))
  })

  it('computes parent directories', async () => {
    expect(await sb.sh('dirname a')).toEqual(ok('.\n'))
    expect(await sb.sh('dirname /a/')).toEqual(ok('/\n'))
    expect(await sb.sh('dirname a/b/ c')).toEqual(ok('a\n.\n'))
    expect(await sb.sh('dirname')).toEqual(failed('dirname: missing operand\n'))
  })

  it('lists the environment sorted, with extra assignments', async () => {
    expect(await sb.sh('env')).toEqual(ok('HOME=/home/reader\nPROJECT=orbit\nPWD=/project\n'))
    expect(await sb.sh('env A=1')).toEqual(ok('A=1\nHOME=/home/reader\nPROJECT=orbit\nPWD=/project\n'))
    expect(sb.env.A).toBeUndefined()
  })
})

describe('tail -f', () => {
  it('prints the file and then waits for Ctrl+C', async () => {
    const controller = new AbortController()
    let settled = false
    const pending = sb.sh('tail -f -n 1 nums.txt', { signal: controller.signal }).then((outcome) => {
      settled = true
      return outcome
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    controller.abort()
    expect(await pending).toEqual({ stdout: '10\n', stderr: '', exitCode: 130 })
  })
})

describe('golden table through createShellBackend', () => {
  const backend = () =>
    createShellBackend({
      files: demoTree(),
      cwd: '/project',
      env: { HOME: '/home/reader', PROJECT: 'orbit' },
      colors: false,
      commands: { orbit: () => 'orbit 1.0\n' },
    })

  const rows: Array<[string, string, number?]> = [
    ['echo -n hi', 'hi'],
    ['echo -5', '-5'],
    ['echo "- item"', '- item'],
    ['echo -e "a\\tb"', 'a\tb'],
    ['echo -- x', '-- x'],
    ['head -2 regions.csv', 'name,region\nalpha,eu-central'],
    ['head -n2 regions.csv', 'name,region\nalpha,eu-central'],
    ['tail -n +2 regions.csv', 'alpha,eu-central\nbeta,us-east\ngamma,eu-west'],
    ['tail -n 0 regions.csv', ''],
    ['grep -n 200 access.log', '1:GET /index.html 200\n2:GET /docs 200\n4:POST /api/deploy 200'],
    ['grep -c 200 access.log', '3'],
    ['grep -l eu regions.csv README.md', 'regions.csv'],
    ['grep -q GET access.log', ''],
    ['grep -w ET access.log', '', 1],
    ['grep -x beta,us-east regions.csv', 'beta,us-east'],
    ["grep -o 'eu-[a-z]*' regions.csv", 'eu-central\neu-west'],
    ['grep -i deployed README.md', 'Deployed with the orbit CLI.'],
    ['grep -v 200 access.log', 'GET /missing 404'],
    ['grep -e 404 -e POST access.log', 'GET /missing 404\nPOST /api/deploy 200'],
    ['grep -r handler src', "src/index.ts:export const handler = () => 'hello from orbit'"],
    ['grep -C 1 beta regions.csv', 'alpha,eu-central\nbeta,us-east\ngamma,eu-west'],
    ['grep eu regions.csv README.md', 'regions.csv:alpha,eu-central\nregions.csv:gamma,eu-west'],
    ['grep eu nope.txt', 'grep: nope.txt: No such file or directory', 2],
    ['wc -l regions.csv README.md', '  4 regions.csv\n  4 README.md\n  8 total'],
    ['echo привет | wc -c', '13'],
    ['echo привет | wc -m', '7'],
    ['sort -n nums.txt', '2\n9\n10\n10'],
    ['sort -u nums.txt', '10\n2\n9'],
    ['sort -t, -k2 regions.csv', 'alpha,eu-central\ngamma,eu-west\nname,region\nbeta,us-east'],
    ['sort nums.txt | uniq -c', '      2 10\n      1 2\n      1 9'],
    ['printf "a\\na\\nb\\n" > a.txt; uniq a.txt out.txt; cat out.txt', 'a\nb'],
    ['find . -type f', './README.md\n./access.log\n./nums.txt\n./regions.csv\n./src/config.ts\n./src/index.ts'],
    ['find . -type d', '.\n./src'],
    ['find -name "*.ts"', './src/config.ts\n./src/index.ts'],
    ['find src', 'src\nsrc/config.ts\nsrc/index.ts'],
    ['find nope', "find: 'nope': No such file or directory", 1],
    ['ls src/*.ts', 'src/config.ts  src/index.ts'],
    ['ls README.md regions.csv', 'README.md  regions.csv'],
    ['ls src /', '/:\nhome  project\n\nsrc:\nconfig.ts  index.ts'],
    ['ls -1', 'access.log\nnums.txt\nREADME.md\nregions.csv\nsrc'],
    ['ls -d src', 'src'],
    ['ls -l README.md', '-rw-r--r-- 68 README.md'],
    ['ls | wc -l', '5'],
    ['ls src > f.txt; cat f.txt', 'config.ts\nindex.ts'],
    ['mkdir backup; cp README.md regions.csv backup/; ls backup', 'README.md  regions.csv'],
    ['cp -r src lib; ls lib', 'config.ts  index.ts'],
    ['cp src lib', "cp: -r not specified; omitting directory 'src'", 1],
    ['mv README.md .', "mv: 'README.md' and './README.md' are the same file", 1],
    [
      'mv README.md README.md; cat README.md',
      `mv: 'README.md' and 'README.md' are the same file\n${README.replace(/\n$/, '')}`,
    ],
    ['mv src lib; ls lib', 'config.ts  index.ts'],
    ['which ls', 'ls: shell builtin'],
    ['which orbit', '/usr/bin/orbit'],
    ['which nope', 'nope not found', 1],
    ['rm', 'rm: missing operand', 1],
    ['rm nope README.md; ls', "rm: cannot remove 'nope': No such file or directory\naccess.log  nums.txt  regions.csv  src"],
    [
      'rm -rf /',
      "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe",
      1,
    ],
    ['rm -r .', "rm: refusing to remove '.' or '..' directory: skipping '.'", 1],
    ['mkdir src', "mkdir: cannot create directory 'src': File exists", 1],
    ['mkdir -p src', ''],
    ['cd src; cd -; echo $PWD $OLDPWD', '/project\n/project /project/src'],
    ['export | grep PROJECT', 'export PROJECT="orbit"'],
    ['export 1bad=x', "export: '1bad=x': not a valid identifier", 1],
    ['sleep abc', "sleep: invalid time interval 'abc'", 1],
    ['cat -n nums.txt', '     1\t10\n     2\t9\n     3\t2\n     4\t10'],
    ['echo hi | cat -', 'hi'],
    ['ls -Z', "ls: invalid option -- 'Z'", 2],
    [
      'cat README.md nope.txt regions.csv',
      `${README}cat: nope.txt: No such file or directory\n${REGIONS.replace(/\n$/, '')}`,
      1,
    ],
    ["printf '%d\\n' 1 x 2", "1\nprintf: 'x': expected a numeric value\n0\n2", 1],
    ['unset PROJECT; echo "[$PROJECT]"', '[]'],
    ["printf '%s=%d\\n' a 1", 'a=1'],
    ['echo hi | tee t.txt; cat t.txt', 'hi\nhi'],
    ['basename /a/b.txt .txt', 'b'],
    ['dirname /a/b.txt', '/a'],
    ['type ls', 'ls is a shell builtin'],
  ]

  it.each(rows)('%s', async (line, output, exitCode = 0) => {
    const result = (await backend().run(line)) as BackendRunResult
    expect(result).toEqual({ output, exitCode })
  })

  it('sleep 1s sleeps a second and an abort during sleep 2 returns 130 at once', async () => {
    vi.useFakeTimers()
    let slept = false
    const sleeping = backend()
      .run('sleep 1s')
      .finally(() => {
        slept = true
      })
    await vi.advanceTimersByTimeAsync(999)
    expect(slept).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await sleeping).toEqual({ output: '', exitCode: 0 })
    const controller = new AbortController()
    const context: RunContext = { write: () => {}, signal: controller.signal, columns: 80, rows: 24 }
    const pending = backend().run('sleep 2', context)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    const outcome = await pending
    expect([isInteractiveRun(outcome) ? null : outcome.exitCode, vi.getTimerCount()]).toEqual([130, 0])
  })

  it('paints ls only when it reaches a coloured terminal', async () => {
    const shell = createShellBackend({ files: demoTree(), cwd: '/project' })
    const written: string[] = []
    const context: RunContext = {
      write: (text) => written.push(text),
      signal: new AbortController().signal,
      columns: 80,
      rows: 24,
    }
    await shell.run('ls src; ls | cat; ls / > list.txt; cat list.txt', context)
    expect(written.join('')).toBe('config.ts  index.ts\naccess.log\nnums.txt\nREADME.md\nregions.csv\nsrc\nhome\nproject\n')
    written.length = 0
    await shell.run('ls', context)
    expect(written.join('')).toBe('access.log  list.txt  nums.txt  README.md  regions.csv  \x1b[34msrc\x1b[0m\n')
  })

  it('streams errors to the terminal between the outputs they interrupt [sb-29]', async () => {
    const written: string[] = []
    const context: RunContext = {
      write: (text) => written.push(text),
      signal: new AbortController().signal,
      columns: 80,
      rows: 24,
    }
    const line = "cat README.md nope.txt regions.csv; printf '%d\\n' 1 x 2; ls nope src"
    expect(await backend().run(line, context)).toEqual({ output: '', exitCode: 1 })
    expect(written.join('')).toBe(
      `${README}cat: nope.txt: No such file or directory\n${REGIONS}` +
        "1\nprintf: 'x': expected a numeric value\n0\n2\n" +
        "ls: cannot access 'nope': No such file or directory\nsrc:\nconfig.ts  index.ts\n",
    )
  })
})
