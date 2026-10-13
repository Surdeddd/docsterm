import { describe, expect, it } from 'vitest'
import { createShellBackend, type ShellBackendOptions, type ShellCommand } from '../src/shell/index.js'
import { isInteractiveRun, type Backend, type Locale, type RunContext } from '../src/types.js'

const demoTree = () => ({
  project: {
    'README.md': '# demo app\n\nDeployed with the orbit CLI.\nRun `orbit help` to start.\n',
    'regions.csv': 'name,region\nalpha,eu-central\nbeta,us-east\ngamma,eu-west\n',
    src: {
      'index.ts': "export const handler = () => 'hello from orbit'\n",
      'config.ts': 'export const region = "eu-central"\n',
    },
  },
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const HEAVY_TIMEOUT = 30_000

const pageCommands: Record<string, ShellCommand> = {
  build: async (ctx) => {
    for (const step of ['[1/2] bundling...\n', '[2/2] uploading...\n']) {
      await tick()
      ctx.write?.(step)
    }
    return { stdout: 'build complete in 3.5s\n' }
  },
  mixed: (ctx) => {
    ctx.write?.('a\n')
    ctx.writeError?.('err\n')
    ctx.write?.('b\n')
    return { stdout: 'out\n', stderr: 'bad\n' }
  },
  nothing: (() => undefined) as unknown as ShellCommand,
  orphan: (ctx) => {
    ctx.fs.write(ctx.fs.resolve(ctx.cwd, 'nodir/x.txt'), 'x')
    return {}
  },
  rootrm: (ctx) => {
    ctx.fs.remove('/', true)
    return {}
  },
  status: (ctx) => ({ exitCode: Number(ctx.argv[1]) }),
  upper: (ctx) => ctx.stdin.toUpperCase(),
  warn: () => ({ stderr: 'warn: missing\n', exitCode: 1 }),
}

const createDemoShell = (overrides: ShellBackendOptions = {}): Backend =>
  createShellBackend({
    files: demoTree(),
    cwd: '/project',
    env: { HOME: '/home/reader', PROJECT: 'orbit' },
    colors: false,
    commands: pageCommands,
    ...overrides,
  })

interface Screen {
  screen: string
  writes: string[]
  output: string
  exitCode: number
}

const runLine = async (shell: Backend, line: string, locale: Locale = 'en'): Promise<Screen> => {
  const writes: string[] = []
  const context: RunContext = {
    write: (text) => {
      writes.push(text)
    },
    signal: new AbortController().signal,
    columns: 80,
    rows: 24,
    locale,
  }
  const outcome = await shell.run(line, context)
  if (isInteractiveRun(outcome)) throw new Error(`${line}: unexpected interactive run`)
  return { screen: writes.join('') + outcome.output, writes, output: outcome.output, exitCode: outcome.exitCode }
}

type Step = [line: string, screen: string, exitCode?: number]

const golden: Array<[string, Step[]]> = [
  [
    'double quotes expand parameters',
    [
      ['echo "Deploying $PROJECT"', 'Deploying orbit\n'],
      ['echo "Project: ${PROJECT}"', 'Project: orbit\n'],
      ['echo "$HOME"', '/home/reader\n'],
    ],
  ],
  ['single quotes stay literal', [["echo '$PROJECT' '${PROJECT}'", '$PROJECT ${PROJECT}\n']]],
  [
    'partly quoted words keep expanding their unquoted parts',
    [
      ['echo $PROJECT"-cli"', 'orbit-cli\n'],
      ['echo \\$HOME/$PROJECT', '$HOME/orbit\n'],
      ['echo src/*".ts"', 'src/config.ts src/index.ts\n'],
      ['echo ~/"notes"', '/home/reader/notes\n'],
    ],
  ],
  [
    'backslashes inside double quotes',
    [
      ['echo "say \\"hi\\""', 'say "hi"\n'],
      ['echo "a\\\\b"', 'a\\b\n'],
      ['echo "{\\"name\\": \\"x\\"}"', '{"name": "x"}\n'],
      ['echo "cost: \\$5 \\x"', 'cost: $5 \\x\n'],
    ],
  ],
  [
    'comments',
    [
      ['echo hi # note', 'hi\n'],
      ['echo a#b page#section', 'a#b page#section\n'],
      ['mkdir -p build # create the build dir', ''],
      ['echo */', 'build/ src/\n'],
    ],
  ],
  [
    'stderr redirects',
    [
      ['ls missing 2>/dev/null; echo $?', '1\n'],
      ['cat missing.txt 2>/dev/null; echo $?', '1\n'],
      ['warn 2>/dev/null', '', 1],
      ['warn 2>err.txt; cat err.txt', 'warn: missing\n'],
      ['warn 2>&1 | grep missing', 'warn: missing\n'],
      ['warn |& upper', 'WARN: MISSING\n'],
    ],
  ],
  [
    'stdout duplicated onto stderr',
    [
      ['echo oops >&2', 'oops\n'],
      ['echo oops >&2 | upper', 'oops\n'],
      ['echo oops >&2 2>/dev/null', 'oops\n'],
      ['echo oops 2>/dev/null >&2', ''],
      ['echo oops >/dev/stderr | upper', 'oops\n'],
    ],
  ],
  [
    'both streams into one file',
    [
      ['echo hi &> out.log; cat out.log', 'hi\n'],
      ['warn &>> out.log; cat out.log', 'hi\nwarn: missing\n'],
      ['mixed > all.log 2>&1; cat all.log', 'a\nerr\nb\nout\nbad\n'],
    ],
  ],
  [
    'stdout and stderr keep their order',
    [
      ['mixed', 'a\nerr\nb\nout\nbad\n'],
      ['mixed 2>/dev/null', 'a\nb\nout\n'],
      ['mixed >/dev/null', 'err\nbad\n'],
      ['mixed 2>&1 | upper', 'A\nERR\nB\nOUT\nBAD\n'],
    ],
  ],
  [
    'assignments set shell variables',
    [
      ['FOO=bar; echo $FOO', 'bar\n'],
      ['A=1 B=$A; echo "$A$B"', '11\n'],
      ['N=1; N+=2; echo $N', '12\n'],
      ['DIRS=~/bin:~/lib; echo $DIRS', '/home/reader/bin:/home/reader/lib\n'],
    ],
  ],
  [
    'prefix assignments only reach their command',
    [
      ['FOO=bar env | grep FOO', 'FOO=bar\n'],
      ['echo "[$FOO]"', '[]\n'],
      ['X=5 echo "[$X]"', '[]\n'],
    ],
  ],
  [
    'exit status',
    [
      ['false; echo "exit=$?"', 'exit=1\n'],
      ['true; echo $?', '0\n'],
      ['nope; echo $?', 'nope: command not found\n127\n'],
      ['false', '', 1],
      ['echo $?', '1\n'],
    ],
  ],
  [
    'special parameters',
    [
      ['echo $0', 'docsterm\n'],
      ['echo $# [$1] [$@]', '0 [] []\n'],
    ],
  ],
  [
    'brace expansion',
    [
      ['mkdir -p app/{src,tests}; ls app', 'src  tests\n'],
      ['echo {a,b}{1,2} x{,.bak}', 'a1 a2 b1 b2 x x.bak\n'],
      ['echo {1..3} {c..a} {01..03} {1..10..4}', '1 2 3 c b a 01 02 03 1 5 9\n'],
      ['echo {a} {} {a{b,c} "{a,b}" \\{a,b}', '{a} {} {ab {ac {a,b} {a,b}\n'],
    ],
  ],
  [
    'parameter operators',
    [
      ['echo ${MISSING:-default} ${PORT:-3000}', 'default 3000\n'],
      ['echo ${PROJECT:+set} [${MISSING:+set}]', 'set []\n'],
      ['echo ${NEW:=assigned} $NEW', 'assigned assigned\n'],
      ['F=dir/file.tar.gz; echo ${F%.*} ${F%%.*} ${F#*/} ${F##*.} ${#F}', 'dir/file.tar dir/file file.tar.gz gz 15\n'],
      ['echo ${MISSING:?is required}', 'docsterm: MISSING: is required\n', 1],
      ['echo ${PROJECT/o/0}', 'docsterm: unsupported syntax: parameter expansion ${PROJECT/o/0}\n', 2],
    ],
  ],
  [
    'a fatal expansion error discards the rest of the line',
    [
      ['echo ${MISSING:?is required}; echo after', 'docsterm: MISSING: is required\n', 1],
      ['echo $?', '1\n'],
      ['echo before; true && echo ${X?unset} || echo fallback; echo after', 'before\ndocsterm: X: unset\n', 1],
      ['Y=${X:?no value}; echo after', 'docsterm: X: no value\n', 1],
      ['GREETING=${X:?no prefix} echo hi; echo after', 'docsterm: X: no prefix\n', 1],
      ['echo hi > ${X:?no target}; echo after', 'docsterm: X: no target\n', 1],
      ['X=${Y:?boom} true 2>/dev/null; echo after', 'docsterm: Y: boom\n', 1],
      ['echo {1..20000}; echo after', 'docsterm: brace expansion: too many words\n', 1],
      ['echo ${X:?piped} | upper; echo after', 'docsterm: X: piped\nafter\n'],
      ['echo "[$(echo a; echo ${X:?inner}; echo b)]"; echo after', 'docsterm: X: inner\n[a]\nafter\n'],
      ['V=$(echo ${X:?inner}); echo "$?[$V]"', 'docsterm: X: inner\n1[]\n'],
    ],
  ],
  [
    'an empty or comment-only line succeeds and keeps $?',
    [
      ['false', '', 1],
      ['', '', 0],
      ['# just a note', '', 0],
      ['   # indented note', '', 0],
      ['echo $?', '1\n'],
    ],
  ],
  [
    '>&WORD duplicates a number, closes on a dash and sends both streams to any other word on descriptor 1',
    [
      ['FD=2; echo oops >&$FD | upper', 'oops\n'],
      ['echo oops >&"2" | upper', 'oops\n'],
      ['F=out.txt; echo hi >&$F; cat out.txt', 'hi\n'],
      ['warn >&$F; cat out.txt', 'warn: missing\n'],
      ['mixed 1>&$F; cat out.txt', 'a\nerr\nb\nout\nbad\n'],
      ['echo hi >&$UNSET', 'docsterm: $UNSET: ambiguous redirect\n', 1],
      ['echo hi 2>&file', 'docsterm: file: ambiguous redirect\n', 1],
      ['echo hi 2>&$F && echo chained', 'docsterm: out.txt: ambiguous redirect\n', 1],
      ['D=nodir/x; echo hi >&$D', 'docsterm: nodir/x: No such file or directory\n', 1],
      ['echo *', 'out.txt README.md regions.csv src\n'],
      ['echo hi >&both.log; cat both.log', 'hi\n'],
    ],
  ],
  [
    '! negates the status of a pipeline',
    [
      ['! false; echo $?', '0\n'],
      ['! true; echo $?', '1\n'],
      ['! false | true; echo $?', '1\n'],
      ['! true && echo yes || echo no', 'no\n'],
      ['true && ! false && echo yes', 'yes\n'],
      ['! ! true; echo $?', '0\n'],
      ['!; echo $?', '1\n'],
      ['! nope 2>/dev/null; echo $?', '0\n'],
      ['! false', '', 0],
      ['! true', '', 1],
      ['echo ! "!"', '! !\n'],
      ['true | ! false', "docsterm: syntax error near unexpected token '!'\n", 2],
    ],
  ],
  [
    'custom exit codes wrap like a process status',
    [
      ['status 256; echo $?', '0\n'],
      ['status -1; echo $?', '255\n'],
      ['status 300', '', 44],
      ['status 3.7; echo $?', '3\n'],
      ['status -1.5; echo $?', '255\n'],
      ['status NaN; echo $?', '1\n'],
      ['status Infinity; echo $?', '1\n'],
      ['status -Infinity', '', 1],
    ],
  ],
  [
    '"$@" without positional parameters makes no field',
    [
      ['echo "$@" x', 'x\n'],
      ['echo "[$@]" "[$*]" "x$@"', '[] [] x\n'],
      ['echo "$@" | upper', '\n'],
    ],
  ],
  [
    'glob classes know Unicode letters and agree with grep',
    [
      ['touch отчёт.md Ёлка.txt _tmp 1.log', ''],
      ['echo [[:lower:]]*', 'regions.csv src отчёт.md\n'],
      ['echo [[:upper:]]*', 'README.md Ёлка.txt\n'],
      ['echo [[:alpha:]]*.*', 'README.md regions.csv Ёлка.txt отчёт.md\n'],
      ['echo [[:punct:]]* [[:digit:]]* [[:word:]]tmp', '_tmp 1.log _tmp\n'],
      ['echo [![:alnum:]]* [[:blank:]]* [[:cntrl:]]*', '_tmp [[:blank:]]* [[:cntrl:]]*\n'],
      ['echo [[:graph:]]???.txt [[:print:]]*.log', 'Ёлка.txt 1.log\n'],
      ['ls | grep "^[[:upper:]]"', 'README.md\nЁлка.txt\n'],
    ],
  ],
  [
    'globs and ls sort like sort does in a UTF-8 locale',
    [
      ['touch access.log Zeta.md; echo *', 'access.log README.md regions.csv src Zeta.md\n'],
      ['ls', 'access.log  README.md  regions.csv  src  Zeta.md\n'],
      ['ls -1 | sort', 'access.log\nREADME.md\nregions.csv\nsrc\nZeta.md\n'],
    ],
  ],
  [
    'pattern removal',
    [
      ['V=aXbXc; echo "${V#*X}" "${V##*X}" "${V%X*}" "${V%%X*}" "${V#??}" "${V%[bc]}"', 'bXc c aXb a bXc aXbX\n'],
      ['echo "${V#}" "${V#*}" "[${V##*}]" "${V%*}" "[${V%%*}]" ${V#"*"} ${V#a*?} "[${V%%?X*}]"', 'aXbXc aXbXc [] aXbXc [] aXbXc bXc []\n'],
      ['V=abcabc; echo ${V#*b*c} "[${V##*b*c}]" ${V%a*c} "[${V%%a*c}]" ${V%b*} ${V#b*}', 'abc [] abc [] abca abcabc\n'],
      ['V=привет; echo ${V#п?} ${V%%е*} ${V%[[:alpha:]]}', 'ивет прив приве\n'],
    ],
  ],
  [
    'prefix assignments before export and unset reach the shell',
    [
      ['FOO=1 export X=1; echo "$FOO $X"', '1 1\n'],
      ['Y=5; BAR=2 unset Y; echo "[$BAR][$Y]"', '[2][]\n'],
      ['BAZ=3 true; echo "[$BAZ]"', '[]\n'],
      ['QUX=4 export QUX; echo "[$QUX]"', '[4]\n'],
      ['GREETING=hi unset; echo "[$GREETING]"', '[hi]\n'],
    ],
  ],
  [
    'an exported list splits into separate files',
    [['export FILES="a.txt b.txt"; touch $FILES; ls a.txt b.txt', 'a.txt  b.txt\n']],
  ],
  [
    'field splitting',
    [
      ['export FILES="a.txt b.txt"; touch $FILES; echo *.txt', 'a.txt b.txt\n'],
      ['echo $UNSET hi', 'hi\n'],
      ['echo "$UNSET" | upper', '\n'],
      ['X=" a "; echo b${X}c "b${X}c"', 'b a c b a c\n'],
    ],
  ],
  [
    'command substitution',
    [
      ['echo $(pwd)', '/project\n'],
      ['echo `echo nested`', 'nested\n'],
      ['echo `echo \\`echo deep\\``', 'deep\n'],
      ['echo $(echo "in  ner") "$(echo "in  ner")"', 'in ner in  ner\n'],
      ['echo "[$(echo a; echo)]"', '[a]\n'],
      ['echo $(cd src; pwd); pwd', '/project/src\n/project\n'],
      ['X=$(false); echo $?', '1\n'],
      ['echo $(warn)', 'warn: missing\n\n'],
    ],
  ],
  [
    'tilde expansion',
    [
      ['mkdir -p /home/reader; echo hi > ~/x.txt; cat ~/x.txt', 'hi\n'],
      ['cat < ~/x.txt', 'hi\n'],
      ['echo hi > $HOME/y.txt; cat ~/y.txt', 'hi\n'],
      ['echo ~ ~/a "~" ~reader', '/home/reader /home/reader/a ~ ~reader\n'],
      ['cd src; echo ~+ ~-', '/project/src /project\n'],
    ],
  ],
  [
    'redirect failures do not run the command',
    [
      ['echo hi > nodir/x', 'docsterm: nodir/x: No such file or directory\n', 1],
      ['echo hi > nodir/x && echo chained', 'docsterm: nodir/x: No such file or directory\n', 1],
      ['echo hi > src', 'docsterm: src: Is a directory\n', 1],
      ['echo hi >> README.md/x', 'docsterm: README.md/x: Not a directory\n', 1],
      ['cat < missing.txt', 'docsterm: missing.txt: No such file or directory\n', 1],
      ['cat < src', 'docsterm: src: Is a directory\n', 1],
      ['F="a b"; echo hi > $F', 'docsterm: $F: ambiguous redirect\n', 1],
      ['echo hi > ""', 'docsterm: : No such file or directory\n', 1],
      ['cat < $UNSET', 'docsterm: $UNSET: ambiguous redirect\n', 1],
      ['echo hi 2>/dev/null > nodir/x', '', 1],
      ['echo *', 'README.md regions.csv src\n'],
    ],
  ],
  [
    '/dev/null is a sink',
    [
      ['echo x > /dev/null; cat /dev/null', ''],
      ['echo /*', '/project\n'],
    ],
  ],
  [
    'the last output redirect wins',
    [
      ['echo hi > a.txt > b.txt', ''],
      ['cat a.txt', ''],
      ['cat b.txt', 'hi\n'],
    ],
  ],
  [
    'newlines separate commands',
    [
      ['echo a \\\nb', 'a b\n'],
      ['echo a\necho b', 'a\nb\n'],
      ['cd src\npwd', '/project/src\n'],
      ['echo one |\nupper', 'ONE\n'],
      ['true &&\n\necho yes', 'yes\n'],
    ],
  ],
  [
    'syntax errors',
    [
      ['ls |', 'docsterm: syntax error: unexpected end of file\n', 2],
      ['&& echo x', "docsterm: syntax error near unexpected token '&&'\n", 2],
      ['echo a && || echo b', "docsterm: syntax error near unexpected token '||'\n", 2],
      ['| upper', "docsterm: syntax error near unexpected token '|'\n", 2],
      ['echo a ;; echo b', "docsterm: syntax error near unexpected token ';;'\n", 2],
      ['echo a; ; echo b', "docsterm: syntax error near unexpected token ';'\n", 2],
      ['echo >', "docsterm: syntax error near unexpected token 'newline'\n", 2],
      ['echo "open', "docsterm: syntax error: unexpected end of file while looking for matching '\"'\n", 2],
      ['echo $?', '2\n'],
    ],
  ],
  [
    'a dangling operator inside $( ) is a syntax error, not a continuation',
    [
      ['echo $(ls |)', "docsterm: syntax error near unexpected token ')'\n", 2],
      ['echo start; echo "$(true &&)"', "docsterm: syntax error near unexpected token ')'\n", 2],
      ['echo ${X:-$(ls |)}; echo $?', "docsterm: syntax error near unexpected token ')'\n", 2],
      ['echo $?', '2\n'],
      ['echo $(echo one |\nupper)', 'ONE\n'],
    ],
  ],
  [
    'unsupported syntax is reported before anything runs',
    [
      ['sleep 1 &', 'docsterm: unsupported syntax: background jobs (&)\n', 2],
      ['cat <<EOF', 'docsterm: unsupported syntax: here-documents (<<)\n', 2],
      ['for i in 1 2; do echo $i; done', 'docsterm: unsupported syntax: loops (for)\n', 2],
      ['echo start; while true; do echo x; done', 'docsterm: unsupported syntax: loops (while)\n', 2],
      ['if true; then echo y; fi', 'docsterm: unsupported syntax: conditionals (if)\n', 2],
      ['echo $((1 + 2))', 'docsterm: unsupported syntax: arithmetic $(( ))\n', 2],
      ['(cd src)', 'docsterm: unsupported syntax: subshells ( )\n', 2],
      ["echo $'a\\tb'", "docsterm: unsupported syntax: ANSI-C quoting $'...'\n", 2],
      ['f() { echo hi; }', 'docsterm: unsupported syntax: functions\n', 2],
      ['greet ( ) { echo hi; }', 'docsterm: unsupported syntax: functions\n', 2],
      ['function greet { echo hi; }', 'docsterm: unsupported syntax: functions\n', 2],
      ['function greet() { echo hi; }', 'docsterm: unsupported syntax: functions\n', 2],
      ['echo $(f() { echo hi; })', 'docsterm: unsupported syntax: functions\n', 2],
    ],
  ],
  [
    'prototype names are neither commands nor variables',
    [
      ['constructor', 'constructor: command not found\n', 127],
      ['toString', 'toString: command not found\n', 127],
      ['__proto__', '__proto__: command not found\n', 127],
      ['echo $toString', '\n'],
      ['echo "[$constructor][${hasOwnProperty}]"', '[][]\n'],
    ],
  ],
  ['history belongs to the widget, not the shell', [['history', 'history: command not found\n', 127]]],
  [
    'clear works inside a command list',
    [
      ['clear; echo done', '\x1b[H\x1b[2J\x1b[3Jdone\n'],
      ['clear; ls', '\x1b[H\x1b[2J\x1b[3JREADME.md  regions.csv  src\n'],
    ],
  ],
  [
    'a custom command that returns nothing succeeds',
    [
      ['echo ok; nothing; echo after', 'ok\nafter\n'],
      ['nothing && echo yes', 'yes\n'],
    ],
  ],
  [
    'file system errors thrown by commands become stderr',
    [
      ['orphan', 'orphan: /project/nodir/x.txt: No such file or directory\n', 1],
      ['rootrm', 'rootrm: /: Invalid argument\n', 1],
      ['echo /*', '/project\n'],
    ],
  ],
  [
    'the working directory falls back when it is removed',
    [
      ['cd src; rm -r /project/src', ''],
      ['pwd; echo $PWD', '/project\n/project\n'],
    ],
  ],
  ['cd updates PWD and OLDPWD', [['cd src; echo $PWD $OLDPWD', '/project/src /project\n']]],
  [
    'globs',
    [
      ['echo */ */*.ts', 'src/ src/config.ts src/index.ts\n'],
      ['echo [rR]* s?c', 'README.md regions.csv src\n'],
      ['echo *.nothing src/*/', '*.nothing src/*/\n'],
      ['touch .env; echo *', 'README.md regions.csv src\n'],
      ['echo .* ./s*', '.env ./src\n'],
      ['cd sr*/; pwd; echo ../*.csv', '/project/src\n../regions.csv\n'],
    ],
  ],
  [
    'streaming commands',
    [
      ['echo first; build', 'first\n[1/2] bundling...\n[2/2] uploading...\nbuild complete in 3.5s\n'],
      ['build | grep upload', '[2/2] uploading...\n'],
      ['build > build.log; cat build.log', '[1/2] bundling...\n[2/2] uploading...\nbuild complete in 3.5s\n'],
      ['build && echo done', '[1/2] bundling...\n[2/2] uploading...\nbuild complete in 3.5s\ndone\n'],
    ],
  ],
]

describe('shell language golden table', () => {
  it.each(golden)('%s', async (_name, steps) => {
    const shell = createDemoShell()
    for (const [line, screen, exitCode = 0] of steps) {
      const result = await runLine(shell, line)
      expect({ line, screen: result.screen, exitCode: result.exitCode }).toEqual({ line, screen, exitCode })
    }
  })
})

describe('pattern matching stays safe', () => {
  it('matches many stars in linear time', async () => {
    const shell = createDemoShell()
    const name = 'a'.repeat(64)
    await runLine(shell, `touch ${name}`)
    const started = Date.now()
    const result = await runLine(shell, 'echo *a*a*a*a*a*a*a*a*a*a*b; V=' + name + '; echo ${V%a*a*a*a*a*a*a*a*b}')
    expect(Date.now() - started).toBeLessThan(500)
    expect(result.screen).toBe(`*a*a*a*a*a*a*a*a*a*a*b\n${name}\n`)
  })

  it('removes affixes from a 200 KB value in linear time', async () => {
    const tree = demoTree()
    const big = `${'x'.repeat(200_000)}y${'z'.repeat(10)}`
    const shell = createDemoShell({ files: { project: { ...tree.project, 'big.txt': big } } })
    const started = Date.now()
    const result = await runLine(
      shell,
      'V=$(cat big.txt); echo "${V%%y*}" | wc -c; echo "${V#*y}"; echo "${V##*x}"; echo "${V%x*}" | wc -c; echo "[${V%%*x*x*x*q}]" | wc -c; echo "${V##*x*x*x*y}"',
    )
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.screen).toBe('200001\nzzzzzzzzzz\nyzzzzzzzzzz\n200000\n200014\nzzzzzzzzzz\n')
  })

  it('expands and globs lists larger than the engine argument limit', async () => {
    const count = 150_000
    const tree = demoTree()
    const words = Array.from({ length: count }, (_, index) => `w${index}`).join(' ')
    const many = Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, '']))
    const shell = createDemoShell({ files: { project: { ...tree.project, 'words.txt': `${words}\n` }, many } })
    const result = await runLine(shell, 'echo $(cat words.txt) | wc -w; echo /many/* | wc -w')
    expect(result.screen).toBe(`${count}\n${count}\n`)
  }, HEAVY_TIMEOUT)

  it('stops at the brace limit instead of overflowing the stack on a long word of groups', async () => {
    const screen = 'docsterm: brace expansion: too many words\n'
    const line = `echo ${'{a,b}'.repeat(20_000)}; echo after`
    expect(await runLine(createDemoShell(), line)).toEqual({ screen, writes: [screen], output: '', exitCode: 1 })
    const nested = `echo ${'{a,'.repeat(5_000)}b${'}'.repeat(5_000)}`
    expect((await runLine(createDemoShell(), nested)).exitCode).toBe(1)
    expect((await runLine(createDemoShell(), 'echo {a,{b,{c,d}}}x {a{b,c}} {x{a,b}')).screen).toBe('ax bx cx dx {ab} {ac} {xa {xb\n')
  }, HEAVY_TIMEOUT)

  it('treats a reversed bracket range as text', async () => {
    const result = await runLine(createDemoShell(), 'echo [z-a]* [!R]*.csv [[:upper:]]*')
    expect(result).toEqual({
      screen: '[z-a]* regions.csv README.md\n',
      writes: ['[z-a]* regions.csv README.md\n'],
      output: '',
      exitCode: 0,
    })
  })
})

describe('terminal output', () => {
  it('streams each command as it finishes and returns nothing left over', async () => {
    const result = await runLine(createDemoShell(), 'echo first; build; echo last')
    expect(result.writes).toEqual([
      'first\n',
      '[1/2] bundling...\n',
      '[2/2] uploading...\n',
      'build complete in 3.5s\n',
      'last\n',
    ])
    expect(result.output).toBe('')
  })

  it('streams syntax errors through the terminal too', async () => {
    const result = await runLine(createDemoShell(), 'echo a && || echo b')
    expect(result.writes).toEqual(["docsterm: syntax error near unexpected token '||'\n"])
    expect(result.output).toBe('')
  })

  it('keeps colour codes out of redirected output', async () => {
    const shell = createDemoShell({ colors: true })
    expect(await runLine(shell, 'ls > f.txt')).toEqual({ screen: '', writes: [], output: '', exitCode: 0 })
    expect((await runLine(shell, 'cat f.txt')).screen).toBe('f.txt\nREADME.md\nregions.csv\nsrc\n')
    expect((await runLine(shell, 'ls src | cat')).screen).toBe('config.ts\nindex.ts\n')
    expect((await runLine(shell, 'echo "$(ls)"')).screen).toBe('f.txt\nREADME.md\nregions.csv\nsrc\n')
    expect((await runLine(shell, 'ls')).screen).toBe('f.txt  README.md  regions.csv  \x1b[34msrc\x1b[0m\n')
  })

  it('reports special parameters $$ as a number', async () => {
    const result = await runLine(createDemoShell(), 'echo $$')
    expect(result.screen).toMatch(/^\d+\n$/)
  })
})

describe('localized shell diagnostics', () => {
  it.each([
    ['sleep 1 &', 'docsterm: неподдерживаемый синтаксис: фоновые задачи (&)\n'],
    ['cat <<EOF', 'docsterm: неподдерживаемый синтаксис: here-документы (<<)\n'],
    ['for i in 1 2; do echo $i; done', 'docsterm: неподдерживаемый синтаксис: циклы (for)\n'],
    ['if true; then echo y; fi', 'docsterm: неподдерживаемый синтаксис: условные конструкции (if)\n'],
    ['f() { echo hi; }', 'docsterm: неподдерживаемый синтаксис: функции\n'],
    ['function greet { echo hi; }', 'docsterm: неподдерживаемый синтаксис: функции\n'],
    ['(cd src)', 'docsterm: неподдерживаемый синтаксис: подоболочки ( )\n'],
    ['echo $((1 + 2))', 'docsterm: неподдерживаемый синтаксис: арифметические выражения $(( ))\n'],
    ['echo ${PROJECT/o/0}', 'docsterm: неподдерживаемый синтаксис: подстановка параметров ${PROJECT/o/0}\n'],
    ['( )', 'docsterm: неподдерживаемый синтаксис: подоболочки ( )\n'],
    ['time ls', 'docsterm: неподдерживаемый синтаксис: замер времени команд (time)\n'],
  ])('reports %j in Russian', async (line, screen) => {
    expect(await runLine(createDemoShell(), line, 'ru')).toEqual({ screen, writes: [screen], output: '', exitCode: 2 })
  })

  it('reports the brace expansion limit in the run locale', async () => {
    const screen = 'docsterm: раскрытие фигурных скобок: слишком много слов\n'
    expect(await runLine(createDemoShell(), 'echo {1..20000}; echo after', 'ru')).toEqual({
      screen,
      writes: [screen],
      output: '',
      exitCode: 1,
    })
  })

  it.each([
    ['( )', 'subshells ( )'],
    ['echo a ()', 'subshells ( )'],
    ['ls; ()', 'subshells ( )'],
    ['X=1 f()', 'subshells ( )'],
    ['echo "a" ( )', 'subshells ( )'],
    ['f ( )', 'functions'],
    ['echo ()', 'functions'],
    ['ls && greet() { echo hi; }', 'functions'],
    ['time ls', 'command timing (time)'],
    ['! time true', 'command timing (time)'],
  ])('treats only NAME ( ) at the start of a command as a function: %j', async (line, construct) => {
    const screen = `docsterm: unsupported syntax: ${construct}\n`
    expect(await runLine(createDemoShell(), line)).toEqual({ screen, writes: [screen], output: '', exitCode: 2 })
  })

  it('names every unsupported construct in both languages', async () => {
    const constructs: Array<[line: string, english: string, russian: string]> = [
      ['sleep 1 &', 'background jobs (&)', 'фоновые задачи (&)'],
      ['cat <<<x', 'here-strings (<<<)', 'here-строки (<<<)'],
      ['cat <<EOF', 'here-documents (<<)', 'here-документы (<<)'],
      ['cat <&3', 'input duplication (<&)', 'дублирование ввода (<&)'],
      ['cat <>f', 'read-write redirection (<>)', 'перенаправление на чтение и запись (<>)'],
      ['cat <(ls)', 'process substitution <( )', 'подстановка процессов <( )'],
      ['tee >(cat)', 'process substitution >( )', 'подстановка процессов >( )'],
      ['(cd src)', 'subshells ( )', 'подоболочки ( )'],
      ['if x', 'conditionals (if)', 'условные конструкции (if)'],
      ['[[ -f x ]]', 'conditionals ([[)', 'условные конструкции ([[)'],
      ['while x', 'loops (while)', 'циклы (while)'],
      ['select x', 'loops (select)', 'циклы (select)'],
      ['case x', 'case statements (case)', 'конструкции case (case)'],
      ['esac', 'case statements (esac)', 'конструкции case (esac)'],
      ['function f', 'functions', 'функции'],
      ['f()', 'functions', 'функции'],
      ['{ ls; }', 'command groups { }', 'группы команд { }'],
      ['echo $((1))', 'arithmetic $(( ))', 'арифметические выражения $(( ))'],
      ['echo $[1]', 'arithmetic $[ ]', 'арифметические выражения $[ ]'],
      ["echo $'x'", "ANSI-C quoting $'...'", "кавычки ANSI-C $'...'"],
      ['echo ${X/a/b}', 'parameter expansion ${X/a/b}', 'подстановка параметров ${X/a/b}'],
      ['time ls', 'command timing (time)', 'замер времени команд (time)'],
    ]
    const seen: Array<[string, string, string]> = []
    for (const [line] of constructs) {
      const en = await runLine(createDemoShell(), line, 'en')
      const ru = await runLine(createDemoShell(), line, 'ru')
      expect([line, en.exitCode, ru.exitCode]).toEqual([line, 2, 2])
      seen.push([line, en.screen, ru.screen])
    }
    expect(seen).toEqual(
      constructs.map(([line, english, russian]) => [
        line,
        `docsterm: unsupported syntax: ${english}\n`,
        `docsterm: неподдерживаемый синтаксис: ${russian}\n`,
      ]),
    )
  })

  it('refuses a piped pager in the run locale', async () => {
    const screen = 'less: интерактивные команды нельзя использовать в конвейере\n'
    expect(await runLine(createDemoShell(), 'less README.md | wc -l', 'ru')).toEqual({
      screen,
      writes: [screen],
      output: '',
      exitCode: 1,
    })
  })
})
