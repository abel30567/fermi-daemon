// redact.mjs — strips secret-shaped strings from text before it is persisted (run logs,
// event transcripts, worker log lines). The patterns follow narrator.py's chat redaction and
// cover every kind scripts/scan-secrets.mjs fails a run on. A match keeps its identifying
// prefix (`Bearer `, `API_TOKEN=`) and loses its value to [REDACTED].
//
//   redact(text)          any string; a PEM private key may span lines
//   redactLine(line)      one log line; a JSON line is redacted value by value and stays valid JSON
//   createLineRedactor()  {write(chunk), end()} for a stream: buffers partial lines and follows
//                         a PEM key whose lines arrive one by one

export const REDACTED = '[REDACTED]'

// A PEM private key, through its END line or, if that never comes, to the end of the text.
const PEM = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY-----)/
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/
// A line inside a PEM block: base64 body, a header (Proc-Type: …) or blank.
const PEM_BODY = /^\s*(?:[A-Za-z0-9+/=]+|[A-Za-z-]+:.*)?\s*$/

// [regex, keep the prefix in group 1?]
const TOKENS = [
  [PEM, false],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, true],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, false],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g, false],
  [/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, false],
  [/(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{10,}/g, false],
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, false],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, false],
  [/([?&](?:key|token|api_key|apikey|access_token|secret|password|sig)=)[^&\s'"\\#]+/gi, true],
]

// `NAME=value` where NAME contains a secret word (narrator.py's rule), and `name: value` where
// the name ends in one (x-api-key: …, "client_secret": "…"). Quotes around the value stay.
const ASSIGN = /(?<![A-Za-z0-9_-])([A-Za-z_][A-Za-z0-9_-]{0,63})(["']?[ \t]*([=:])[ \t]*)("[^"\n]*"|'[^'\n]*'|(?!=)[^\s'"\\;&|,]+)/g
const SECRET_WORD = /key|token|secret|pass|auth|credential/i
const SECRET_NAME = /(?:^|[_-])(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd|credentials?)$/i
const assignSecret = (name, op) => (op === '=' ? SECRET_WORD.test(name) && !/tokens$/i.test(name) : SECRET_NAME.test(name))
const quoted = (v) => (/^["']/.test(v) ? v[0] + REDACTED + v[0] : REDACTED)

// `Basic <base64 user:pass>` and any base64 run (std or url-safe, possibly line-wrapped)
// whose decoded text holds a secret.
const BASIC = /(Basic\s+)([A-Za-z0-9+/]{8,}={0,2})/g
const B64 = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{24,}(?:\r?\n[A-Za-z0-9+/_-]{4,})*={0,2}/g
const decode = (s) => Buffer.from(s.replace(/\s/g, ''), 'base64').toString('latin1')

function redactPlain(text) {
  for (const [re, keep] of TOKENS) text = text.replace(re, (m, p) => (keep ? p : '') + REDACTED)
  text = text.replace(ASSIGN, (m, name, op, sym, v) => (assignSecret(name, sym) && !v.includes(REDACTED) ? name + op + quoted(v) : m))
  return text.replace(BASIC, (m, p, v) => (decode(v).includes(':') ? p + REDACTED : m))
}

export function redact(text) {
  const out = redactPlain(text)
  return out.replace(B64, (m) => (redactPlain(decode(m)) !== decode(m) ? REDACTED : m))
}

// The redacted line if `line` is a JSON object/array, else null. Unchanged lines come back as is.
function redactJson(line) {
  const c = line.trimStart()[0]
  if (c !== '{' && c !== '[') return null
  let v
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  let changed = false
  const walk = (x) => {
    if (typeof x === 'string') {
      const r = redact(x)
      if (r !== x) changed = true
      return r
    }
    if (x && typeof x === 'object') for (const k of Object.keys(x)) x[k] = walk(x[k])
    return x
  }
  v = walk(v)
  return changed ? JSON.stringify(v) : line
}

export const redactLine = (line) => redactJson(line) ?? redact(line)

export function createLineRedactor() {
  let buf = ''
  let inKey = false // inside a PEM key opened on an earlier line
  const line = (l) => {
    if (inKey) {
      const end = PEM_END.exec(l)
      if (end) {
        inKey = false
        return REDACTED + redactLine(l.slice(end.index + end[0].length))
      }
      if (PEM_BODY.test(l)) return REDACTED
      inKey = false
    }
    const json = redactJson(l)
    if (json != null) return json
    if (PEM_OPEN.test(l)) inKey = true
    return redact(l)
  }
  return {
    write(chunk) {
      const i = chunk.lastIndexOf('\n')
      if (i < 0) {
        buf += chunk
        return ''
      }
      const lines = (buf + chunk.slice(0, i)).split('\n')
      buf = chunk.slice(i + 1)
      return lines.map((l) => line(l) + '\n').join('')
    },
    end() {
      const rest = buf
      buf = ''
      return rest ? line(rest) : ''
    },
  }
}
