import { describe, expect, it } from 'vitest'
import { isShellComplete } from '../src/websocket/syntax.js'

const verdicts = (rows: Array<[string, boolean]>) => rows.map(([source]) => [source, isShellComplete(source)])

describe('isShellComplete', () => {
  it('accepts ordinary one-line commands', () => {
    const rows: Array<[string, boolean]> = [
      ['', true],
      ['ls -la', true],
      ['echo "a b" \'c d\'', true],
      ['echo it\'\'s', true],
      ['ls & ', true],
      ['ls;', true],
      ['[ -f x ] && echo yes || echo no', true],
      ['echo {a,b} }', true],
      ['echo a#b # a comment with ( and "', true],
      ['# only a comment {', true],
      ['echo \\\\', true],
      ['x=$((1 + 2)); echo ${x:-"none"} `date`', true],
      ['echo "$(echo ")")"', true],
      ['f() { echo hi; }', true],
      ['(cd /tmp && ls)', true],
      ['cat <<< word', true],
    ]
    expect(verdicts(rows)).toEqual(rows)
  })

  it('asks for more after open quotes, substitutions and a trailing backslash', () => {
    const rows: Array<[string, boolean]> = [
      ["echo 'abc", false],
      ['echo "abc', false],
      ['echo "a\\"', false],
      ['echo $(date', false],
      ['echo $((1 +', false],
      ['echo ${HOME', false],
      ['echo `date', false],
      ['echo one \\', false],
      ['echo one \\\n  two', true],
      ["echo 'one\ntwo'", true],
      ['echo "$(printf \'%s\' \\\n x)"', true],
    ]
    expect(verdicts(rows)).toEqual(rows)
  })

  it('asks for more after a trailing pipe, && or ||, comments and blank lines included', () => {
    const rows: Array<[string, boolean]> = [
      ['ls |', false],
      ['ls &&', false],
      ['ls ||  ', false],
      ['ls | # count them', false],
      ['ls |\n', false],
      ['ls |\nwc -l', true],
      ['ls &&\n\necho done', true],
    ]
    expect(verdicts(rows)).toEqual(rows)
  })

  it('waits for compound commands to close', () => {
    const rows: Array<[string, boolean]> = [
      ['for i in 1 2 3', false],
      ['for i in 1 2 3; do', false],
      ['for i in 1 2 3\ndo\n  echo $i\ndone', true],
      ['for i; do echo $i; done', true],
      ['for word in if fi case; do echo $word; done', true],
      ['while read line; do echo "$line"; done < notes.md', true],
      ['until false', false],
      ['if true', false],
      ['if [ -d /tmp ]; then\n  echo yes\nelif true; then\n  echo maybe\nelse\n  echo no\nfi', true],
      ['if true; then if false; then echo; fi', false],
      ['{ echo a; echo b', false],
      ['{ echo a; echo b; }', true],
      ['{ echo }', false],
      ['(cd /tmp', false],
      ['f() {', false],
      ['f ()\n{\n  echo hi\n}', true],
      ['! grep -q x notes.md', true],
    ]
    expect(verdicts(rows)).toEqual(rows)
  })

  it('reads case statements without mistaking patterns for subshells or keywords', () => {
    const rows: Array<[string, boolean]> = [
      ['case "$1" in', false],
      ['case "$1" in\n  start|stop) echo ok ;;', false],
      ['case "$1" in\n  start|stop) echo ok ;;\n  *) echo no ;;\nesac', true],
      ['case x in (a) echo "(";; esac', true],
      ['case x in if) echo fi;; done) ( cd /; ls ) ;; esac', true],
      ['case x in esac', true],
      ['case x in a) echo esac;;', false],
      ['case x in a) case y in b) echo;; esac;;', false],
      ['case x in a) case y in b) echo;; esac;; esac', true],
      ['if true; then case x in a) echo;; esac', false],
      ['if true; then case x in a) echo;; esac; fi', true],
    ]
    expect(verdicts(rows)).toEqual(rows)
  })

  it('waits for every here-document to reach its delimiter line', () => {
    const rows: Array<[string, boolean]> = [
      ['cat <<EOF', false],
      ['cat <<EOF\nhello', false],
      ['cat <<EOF\nhello\nEOF', true],
      ['cat <<EOF\nhello\nEOF\n', true],
      ['cat <<EOF\nEOF is not alone\n  EOF\nEOF', true],
      ['cat <<-EOF\n\thello\n\tEOF', true],
      ['cat <<EOF\n\thello\n\tEOF', false],
      ["cat <<'EOF'\n$(not run\nEOF", true],
      ['cat <<"E O"\nx\nE O', true],
      ['cat <<\\EOF\n`x\nEOF', true],
      ['cat <<A <<B\n1\nA', false],
      ['cat <<A <<B\n1\nA\n2\nB', true],
      ['cat <<EOF | wc -l\na ( "\nEOF', true],
      ['cat <<EOF; if true\nbody\nEOF', false],
    ]
    expect(verdicts(rows)).toEqual(rows)
  })

  it('says complete whenever it cannot be sure, so the server reports the error instead of the reader waiting', () => {
    const rows: Array<[string, boolean]> = [
      ['fi', true],
      ['done', true],
      ['esac', true],
      ['}', true],
      ['echo )', true],
      ['ls ;; echo', true],
      ['echo (', true],
      ['cat <<', true],
      ['fi; if true', true],
      ['x=$(case y in a) echo;; esac)', true],
      ['for i in 1 2; fi', true],
    ]
    expect(verdicts(rows)).toEqual(rows)
  })

  it('treats CRLF like LF and stays fast on long input', () => {
    expect(isShellComplete('for i in 1 2\r\ndo echo $i\r\ndone')).toBe(true)
    expect(isShellComplete('cat <<EOF\r\nx\r\nEOF')).toBe(true)
    const long = `${'echo "a $(b) ${c}" \'d\' | '.repeat(20_000)}wc -l`
    const started = performance.now()
    expect(isShellComplete(long)).toBe(true)
    expect(isShellComplete(`${'(('.repeat(20_000)}`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
