// Turn outcome classification for the warm worker. A stream-json `result`
// event ends every turn, including failed ones: `subtype` can be "success"
// while `is_error` is true (e.g. a spend limit blocking compaction), so the
// worker must read is_error / terminal_reason / api_error_status / result text
// before treating a turn as done, and back off instead of re-firing.

const DAY_MIN = 24 * 60

// Classify a `result` event. Returns { ok, kind, retryAfterMs?, detail } with
// kind one of ok | spend_limit | rate_limit | context_overflow | api_error |
// auth | unknown_error. retryAfterMs is set only when the text names a reset time.
export function classifyResult(ev, now = Date.now()) {
  const text = typeof ev?.result === 'string' ? ev.result : ''
  const status = ev?.api_error_status ?? null
  const detail =
    text.replace(/\s+/g, ' ').trim().slice(0, 200) ||
    [ev?.subtype, ev?.terminal_reason].filter(Boolean).join('/')
  if (ev?.is_error !== true && status == null) return { ok: true, kind: 'ok', detail }

  let kind = 'unknown_error'
  if (status === 401 || status === 403 || /authentication|unauthori[sz]ed|invalid api key|\/login|oauth token/i.test(text))
    kind = 'auth'
  else if (/spend(ing)? limit|credit balance|billing/i.test(text)) kind = 'spend_limit'
  else if (status === 429 || /rate.?limit|usage limit|limit reached|too many requests/i.test(text)) kind = 'rate_limit'
  else if (
    ev?.terminal_reason === 'blocking_limit' ||
    /prompt is too long|context (window|length)|maximum context/i.test(text)
  )
    kind = 'context_overflow'
  else if (status != null || /api error|overloaded|internal server error/i.test(text)) kind = 'api_error'

  const out = { ok: false, kind, detail }
  if (kind === 'spend_limit' || kind === 'rate_limit') {
    const ms = parseResetMs(text, now)
    if (ms != null) out.retryAfterMs = ms
  }
  return out
}

// "… resets 2am (America/New_York)" / "resets at 3:30pm" → ms until the next
// such wall-clock time (in the named zone, else local time). undefined if none.
export function parseResetMs(text, now = Date.now()) {
  const m = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)]+)\))?/i.exec(String(text))
  if (!m) return undefined
  const h12 = Number(m[1])
  const min = Number(m[2] || 0)
  if (h12 < 1 || h12 > 12 || min > 59) return undefined
  const target = (h12 % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)
  let tz = m[4]?.trim()
  try {
    wallMinutes(now, tz)
  } catch {
    tz = undefined // unknown zone name → local time
  }
  const mod = (x) => ((x % DAY_MIN) + DAY_MIN) % DAY_MIN
  let ms = mod(target * 60 + min - wallMinutes(now, tz)) * 60000 - (now % 60000)
  if (ms <= 0) ms += DAY_MIN * 60000
  // One DST correction: if the zone's offset changes before the reset, shift by the difference.
  const drift = mod(target * 60 + min - wallMinutes(now + ms, tz))
  if (drift !== 0) ms += (drift > DAY_MIN / 2 ? drift - DAY_MIN : drift) * 60000
  return ms
}

function wallMinutes(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms))
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  return get('hour') * 60 + get('minute')
}

// Exponential backoff between error turns: baseMs, 2×, 4×, …; a reset time
// from the error (minMs) wins when it is later. Every wait, including a reset
// time, is capped at maxMs so the worker re-probes (the limit may be raised
// sooner). reset() on the first ok turn.
export class Backoff {
  constructor({ baseMs = 30_000, maxMs = 30 * 60_000, now = Date.now } = {}) {
    this.baseMs = baseMs
    this.maxMs = maxMs
    this.now = now
    this.failures = 0
    this.until = 0
  }

  // Record an error turn; returns the delay before the next retry.
  fail(minMs = 0) {
    const delay = Math.min(this.maxMs, Math.max(this.baseMs * 2 ** this.failures, minMs))
    this.failures++
    this.until = this.now() + delay
    return delay
  }

  ready() {
    return this.now() >= this.until
  }

  reset() {
    this.failures = 0
    this.until = 0
  }
}

// The {channel, chat_id} of a task claimed in this event (a task_claim
// tool_result in a `user` event), as narrator.py learns it. null otherwise.
export function chatFromEvent(ev) {
  if (ev?.type !== 'user' || !Array.isArray(ev.message?.content)) return null
  for (const block of ev.message.content) {
    if (block?.type !== 'tool_result') continue
    const c = block.content
    const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : ''
    try {
      const t = JSON.parse(raw)?.tasks?.[0]
      if (t?.channel && t?.chat_id) return { channel: t.channel, chat_id: String(t.chat_id) }
    } catch {}
  }
  return null
}
