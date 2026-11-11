// Cloud task envelopes (DMN-50): the verify side. The signer (fermi-mcp gateway) attaches
//   task.envelope = { v: 1, nonce: "<unix-seconds>.<32+ lowercase hex>", sig: "<base64url>" }
// to each task { id, payload } it hands out, where payload is the exact string sent and
//   sig = base64url(HMAC-SHA256(key, "fermi-task-v1\n" + id + "\n" + nonce + "\n" + sha256hex(payload)))
// key = the 32+ bytes hex-decoded from FERMI_ENVELOPE_KEY (`openssl rand -hex 32`), no derivation.
// FERMI_ENVELOPE_KEY_PREV, if set, is also accepted (rotation: sign with the new key, then drop PREV).
//
// A nonce is accepted once, and only while now - ttl - skew <= its timestamp <= now + skew.
// Seen nonces are kept in memory for that window; after a restart an older nonce is still
// refused by its timestamp, so the replay window is never larger than ttl + skew.
//
// Grace mode (FERMI_ENVELOPE_ENFORCE unset or not "1", the default until the signer ships):
// a task without an envelope is accepted with a warning. A task WITH an envelope is always
// verified, so a forged or replayed envelope is refused in either mode.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const DEFAULT_TTL_MS = 5 * 60_000
export const DEFAULT_SKEW_MS = 30_000
const NONCE = /^(\d{1,12})\.[0-9a-f]{32,128}$/
const KEY = /^(?:[0-9a-f]{2}){32,}$/i

export const canonical = (id, nonce, payload) =>
  `fermi-task-v1\n${id}\n${nonce}\n${createHash('sha256').update(payload).digest('hex')}`

export const sign = (key, id, nonce, payload) =>
  createHmac('sha256', Buffer.from(key, 'hex')).update(canonical(id, nonce, payload)).digest('base64url')

// env (a .env map plus process.env) → verifier options; throws on a malformed key.
export function envelopeConfig(env) {
  const keys = [env.FERMI_ENVELOPE_KEY, env.FERMI_ENVELOPE_KEY_PREV].filter(Boolean)
  for (const k of keys) if (!KEY.test(k)) throw new Error('FERMI_ENVELOPE_KEY / FERMI_ENVELOPE_KEY_PREV must be at least 32 bytes of hex (openssl rand -hex 32)')
  const enforce = env.FERMI_ENVELOPE_ENFORCE === '1'
  if (enforce && !env.FERMI_ENVELOPE_KEY) throw new Error('FERMI_ENVELOPE_ENFORCE=1 needs FERMI_ENVELOPE_KEY')
  const num = (v, d) => (v == null || v === '' ? d : Number(v))
  return { keys, enforce, ttlMs: num(env.FERMI_ENVELOPE_TTL_MS, DEFAULT_TTL_MS), skewMs: num(env.FERMI_ENVELOPE_SKEW_MS, DEFAULT_SKEW_MS) }
}

// → verify(task, now = Date.now()) → { ok: true, warning? } | { ok: false, reason }
export function createVerifier({ keys = [], enforce = false, ttlMs = DEFAULT_TTL_MS, skewMs = DEFAULT_SKEW_MS } = {}) {
  const seen = new Map() // nonce → when it leaves the acceptance window (ms)
  return function verify(task, now = Date.now()) {
    for (const [n, until] of seen) if (until < now) seen.delete(n)
    const env = task?.envelope
    if (env == null) {
      if (enforce) return { ok: false, reason: 'unsigned task (no envelope)' }
      return { ok: true, warning: 'UNSIGNED TASK ACCEPTED (grace mode: FERMI_ENVELOPE_ENFORCE is not 1)' }
    }
    if (!keys.length) {
      // Only reachable in grace mode (enforce requires a key): nothing to verify against.
      return { ok: true, warning: 'SIGNED TASK ACCEPTED UNVERIFIED (grace mode: FERMI_ENVELOPE_KEY is not set)' }
    }
    if (typeof env !== 'object' || env.v !== 1 || typeof env.sig !== 'string' || typeof env.nonce !== 'string')
      return { ok: false, reason: 'malformed envelope' }
    if (typeof task.id !== 'string' || typeof task.payload !== 'string') return { ok: false, reason: 'task id and payload must be strings' }
    const m = NONCE.exec(env.nonce)
    if (!m) return { ok: false, reason: 'malformed nonce' }
    const got = Buffer.from(env.sig, 'base64url')
    const valid = keys.some((k) => {
      const want = Buffer.from(sign(k, task.id, env.nonce, task.payload), 'base64url')
      return got.length === want.length && timingSafeEqual(got, want)
    })
    if (!valid) return { ok: false, reason: 'bad signature' }
    const ts = Number(m[1]) * 1000
    if (ts > now + skewMs) return { ok: false, reason: 'nonce timestamp is in the future' }
    if (ts < now - ttlMs - skewMs) return { ok: false, reason: 'nonce expired' }
    if (seen.has(env.nonce)) return { ok: false, reason: 'replayed nonce' }
    seen.set(env.nonce, ts + ttlMs + skewMs)
    return { ok: true }
  }
}
