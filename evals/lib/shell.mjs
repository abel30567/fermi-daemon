// A small parser for the commands a model passes to a shell tool (mac_shell, Bash, …), for the
// shellOnly assertion. It splits a command into simple commands at ; && || | and newlines, including
// the commands inside $( ) and backticks, and resolves quoting, escapes, $name and redirections.
// It understands only that subset of the shell: anything else (subshells and groups, a background &,
// heredocs, arithmetic, ${…} forms other than ${name}, prefix assignments, comments) throws, so a
// check built on it fails closed.
//
// $name is a variable assigned earlier in the same command (f=~/x; ls $f), HOME (as ~) or $? (kept
// as written); any other variable, a command substitution, an unquoted glob or brace makes the word
// known only at run time, and parseShell returns it as null.

export class ShellParseError extends Error {}

const SAFE = /^[\w@%+=:,./~-]+$/
// One word as shellOnly's allow patterns see it: bare when it needs no quoting, else in single
// quotes, else (it holds a ') in double quotes.
export const quote = (w) => (SAFE.test(w) ? w : !w.includes("'") ? `'${w}'` : `"${w.replace(/["\\$`]/g, '\\$&')}"`)

// → [{ argv: [string | null], redirects: [{ fd, op, target }] }], one per simple command, in the
// order they start. Assignment-only commands (f=…) are applied, not returned.
export function parseShell(src) {
  const vars = new Map([['HOME', '~']])
  const out = []
  let i = 0
  const fail = (why) => {
    throw new ShellParseError(`${why} at offset ${i}`)
  }
  const blanks = () => {
    while (src[i] === ' ' || src[i] === '\t' || (src[i] === '\\' && src[i + 1] === '\n')) i += src[i] === '\\' ? 2 : 1
  }

  // $… at src[i]; → [text, dynamic]
  const dollar = (quoted) => {
    const rest = src.slice(i + 1)
    if (rest.startsWith('((')) fail('arithmetic $(( ))')
    if (rest[0] === '(') {
      i += 2
      list(')')
      return ['', true]
    }
    if (rest[0] === '?') return (i += 2), ['$?', false]
    if (rest[0] === "'" || rest[0] === '"') fail('$\'…\' or $"…" quoting')
    const m = /^\{([A-Za-z_]\w*)\}/.exec(rest) ?? /^([A-Za-z_]\w*)/.exec(rest)
    if (!m) {
      if (rest[0] === '{' || /^[\w$!#@*-]/.test(rest)) fail('a special parameter or ${…} form')
      return (i += 1), ['$', false]
    }
    i += 1 + m[0].length
    if (!vars.has(m[1])) return ['', true]
    const v = vars.get(m[1])
    return [v, !quoted && /[\s*?[{}]/.test(v)]
  }

  // A word at src[i]; → { value, dynamic } (value is null when dynamic).
  const word = (end) => {
    let v = ''
    let dyn = false
    const add = ([t, d]) => ((v += t), (dyn ||= d))
    for (;;) {
      const c = src[i]
      if (c === undefined || /[ \t\n;&|()<>]/.test(c)) break
      if (c === '`') {
        if (end === '`') break
        i++
        list('`')
        dyn = true
      } else if (c === '\\') {
        if (i + 1 >= src.length) fail('a trailing backslash')
        if (src[i + 1] !== '\n') v += src[i + 1]
        i += 2
      } else if (c === "'") {
        const j = src.indexOf("'", i + 1)
        if (j < 0) fail('an unterminated quote')
        v += src.slice(i + 1, j)
        i = j + 1
      } else if (c === '"') {
        i++
        for (;;) {
          const d = src[i]
          if (d === undefined) fail('an unterminated quote')
          if (d === '"') break
          if (d === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) {
            if (src[i + 1] !== '\n') v += src[i + 1]
            i += 2
          } else if (d === '$') add(dollar(true))
          else if (d === '`') {
            if (end === '`') fail('a backtick inside quotes inside backticks')
            i++
            list('`')
            dyn = true
          } else (v += d), i++
        }
        i++
      } else if (c === '$') add(dollar(false))
      else {
        if ('*?[{}'.includes(c)) dyn = true
        if (c === '#' && v === '') fail('a comment')
        v += c
        i++
      }
    }
    return { value: dyn ? null : v, dynamic: dyn }
  }

  // Commands up to `end` (')' or '`', or the end of the source).
  function list(end) {
    let cmd = { argv: [], redirects: [], assign: null }
    let pending = false // after && || |, a command must follow
    const finish = (op) => {
      const empty = !cmd.argv.length && !cmd.redirects.length && !cmd.assign
      if (empty && (op || pending)) fail('an empty command')
      if (cmd.assign) {
        const [name, value] = cmd.assign
        if (cmd.argv.length || cmd.redirects.length) fail('an assignment before a command')
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail(`an assignment to ${name}`)
        if (value === null) fail(`a run-time value assigned to ${name}`)
        vars.set(name, value)
      } else if (!empty) out.push({ argv: cmd.argv, redirects: cmd.redirects })
      cmd = { argv: [], redirects: [], assign: null }
      pending = op === '&&' || op === '||' || op === '|'
    }
    for (;;) {
      blanks()
      const c = src[i]
      if (c === undefined) {
        if (end) fail(`an unterminated ${end === ')' ? '$(' : '`'}`)
        return finish()
      }
      if (c === end) {
        i++
        return finish()
      }
      if (c === '\n' || c === ';') {
        if (src[i + 1] === ';') fail(';;')
        i++
        finish(c === ';' ? ';' : null)
        continue
      }
      const op = /^(?:&&|\|\||\|&|\|)/.exec(src.slice(i))?.[0]
      if (op === '|&') fail('|&')
      if (op) {
        i += op.length
        finish(op)
        continue
      }
      const r = /^(\d*)(&>>|&>|>>|>&|>\||<<<|<<|<&|<>|>|<)/.exec(src.slice(i))
      if (r) {
        if (r[2].startsWith('<<')) fail('a heredoc')
        i += r[0].length
        blanks()
        const t = word(end)
        if (t.dynamic || t.value === '') fail('a redirection to a run-time or missing target')
        cmd.redirects.push({ fd: r[1] || null, op: r[2], target: t.value })
        continue
      }
      if (c === '&') fail('a background &')
      if (c === '(' || c === ')') fail('a subshell or group')
      const a = !cmd.argv.length && !cmd.assign && /^([A-Za-z_]\w*)=/.exec(src.slice(i))
      if (a) {
        i += a[0].length
        cmd.assign = [a[1], word(end).value]
        continue
      }
      if (cmd.assign) fail('an assignment before a command')
      cmd.argv.push(word(end).value)
    }
  }

  list(null)
  return out
}
