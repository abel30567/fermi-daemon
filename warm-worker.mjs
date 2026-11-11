#!/usr/bin/env node
// Fermi warm worker — a single long-lived `claude` process that keeps its MCP +
// claude.ai Fermi connector warm, so replies skip the ~130s per-message cold
// start + connector warm-up that the cold `claude -p` spawns in poll.sh pay.
//
// Measured: cold spawn's first tool call ~130s; a warm turn ~1.5s (simple) /
// a few s (a full claim→bootstrap→reply→complete). Self-polls the queue every
// POLL_MS and fires one drain turn whenever work is pending.
//
// Runs as launchd service com.fermi.warm-worker. Respawns claude on death.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { Backoff, chatFromEvent } from './lib/turn-outcome.mjs'
import { loadHarness } from './harness/index.mjs'
import { ALLOWED_TOOLS } from './lib/run-policy.mjs'
import { loadPrompt, ownerNote } from './lib/prompt.mjs'
import { redact } from './lib/redact.mjs'
import { openLog, secureLogs, pruneRuns, redactStdio } from './lib/logs.mjs'

// Everything this process prints (logs/warm-worker.log under launchd) is redacted, crash traces too.
redactStdio()

const HOME = process.env.HOME
const DAEMON = join(HOME, 'fermi-daemon')
// Harness adapter (env HARNESS, default claude-code); the worker only sees its normalized events.
const harness = await loadHarness()

// ---- config from .env ------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(join(DAEMON, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const FERMI_URL = env.FERMI_URL
const TOKEN = env.FERMI_BEARER_TOKEN

// ---- model selection --------------------------------------------------------
// Priority: runtime switch (warm-model file, set via POST /model) > WARM_MODEL
// env > default. Aliases keep chat commands simple ("switch to opus").
const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-6',
  'opus-1m': 'claude-opus-4-6[1m]',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5',
  'opus-5': 'claude-opus-5',
}
const MODEL_FILE = join(DAEMON, 'warm-model')
const DEFAULT_MODEL = process.env.WARM_MODEL || 'claude-sonnet-5'

function resolveModel(name) {
  if (!name) return null
  const n = String(name).trim().toLowerCase()
  if (MODEL_ALIASES[n]) return MODEL_ALIASES[n]
  // accept fully-qualified claude-* ids as-is
  if (/^claude-[a-z0-9.\-[\]]+$/.test(n)) return name.trim()
  return null
}

function currentModel() {
  try {
    const m = resolveModel(readFileSync(MODEL_FILE, 'utf8'))
    if (m) return m
  } catch {}
  return DEFAULT_MODEL
}
const POLL_MS = Number(process.env.WARM_POLL_MS || 1000)
const TURN_TIMEOUT_MS = Number(process.env.WARM_TURN_TIMEOUT_MS || 900000) // kill+respawn a hung turn (15min — long transcriptions/PoC work are legitimate turns)
const KEEPALIVE_MS = Number(process.env.WARM_KEEPALIVE_MS || 240000) // no-op turn to keep connector hot
const CONTROL_SOCKET = join(DAEMON, 'run/control.sock') // owner-only (0600) emergency-stop + model-switch endpoint
const MAX_CONTROL_FIELD = 128 // longest channel / chat_id /abort accepts, so the stop instruction stays bounded
const STALENESS_MS = Number(process.env.WARM_STALENESS_MS || 300000) // idle re-check of prompt/server staleness
const PROMPT_PATH = join(DAEMON, 'prompts/drain.md')
// Refuse to start on a prompt that cannot render (missing prompts/local.json or key).
try {
  loadPrompt(PROMPT_PATH)
} catch (e) {
  console.error(new Date().toISOString(), `refusing to start: ${e.message}`)
  process.exit(1)
}
// After an error drain turn, hold further drain turns: 30s, doubling, capped at 30min.
const backoff = new Backoff({
  baseMs: Number(process.env.WARM_BACKOFF_BASE_MS || 30000),
  maxMs: Number(process.env.WARM_BACKOFF_MAX_MS || 1800000),
})
let alerted = false // one owner-visible alert per error episode
let turnChat = null // {channel, chat_id} of a task claimed during the current drain turn

// Emergency stops requested via the control endpoint, drained by the main loop
// ahead of any normal queue work. Each is {channel, chat_id}.
const pendingStops = []

// Inbound Microsoft Teams messages (via Power Automate flow → tunnel →
// POST /teams/webhook). Each is {sender, text, link}. Processed by the loop
// like queue work; replies go out via tools/teams-send.sh.
const pendingTeams = []
const TEAMS_SECRET = env.TEAMS_WEBHOOK_SECRET || ''
// POST /teams/webhook has its own localhost TCP listener (the tunnel's target), apart from the control socket.
const TEAMS_PORT = process.env.WARM_TEAMS_PORT || env.WARM_TEAMS_PORT || ''
function refuse(why) {
  console.error(new Date().toISOString(), `refusing to start: ${why}`)
  process.exit(1)
}
if (TEAMS_SECRET && !TEAMS_PORT) refuse('TEAMS_WEBHOOK_SECRET is set but WARM_TEAMS_PORT is not (the Teams webhook port)')
if (TEAMS_PORT && !(/^\d+$/.test(TEAMS_PORT) && Number(TEAMS_PORT) <= 65535)) refuse(`WARM_TEAMS_PORT is not a port: ${TEAMS_PORT}`)

// Teams sends HTML bodies — flatten to plain text for the agent.
function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

const log = (...a) =>
  console.log(new Date().toISOString(), ...a)

// runs/ and logs/ are owner-only; runs/ files expire after RUNS_RETENTION_DAYS (0 keeps them).
const RUNS_RETENTION_DAYS = Number(process.env.RUNS_RETENTION_DAYS ?? 14)
// A file it cannot chmod or remove (owned by root, say) is warned about, not fatal.
try {
  secureLogs([join(DAEMON, 'runs'), join(DAEMON, 'logs')])
} catch (e) {
  log(`warning: could not make runs/ and logs/ owner-only: ${e.message}`)
}
function pruneRunsDir() {
  try {
    const n = pruneRuns(join(DAEMON, 'runs'), RUNS_RETENTION_DAYS)
    if (n) log(`runs/: removed ${n} file(s) older than ${RUNS_RETENTION_DAYS} days`)
  } catch (e) {
    log(`warning: could not prune runs/: ${e.message}`)
  }
}

// ---- persistent claude process ---------------------------------------------
let session = null // harness session (harness/index.mjs contract)
let busy = false
let turnResolve = null
let turnLog = null // write stream for the current drain turn's raw stream-json
let eventsLog = null // the same turn's normalized events, JSON lines (narrator.py prefers this)
// Staleness baselines, captured at each spawn: the child freezes its system
// prompt + MCP toolset at spawn, so when either source changes we respawn.
let promptHash = null // sha256 of the rendered prompts/drain.md as handed to the child
let serverVersion = null // `version` from GET /health at spawn (null = not advertised)

// GET /health `version` — the server's capability version. /health does not
// advertise `version` yet; the worker consumes it once the server does, and a
// missing field is treated as unchanged.
async function fetchServerVersion() {
  try {
    const res = await fetch(`${FERMI_URL}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const j = await res.json()
    return j.version ?? null
  } catch {
    return null
  }
}

function startClaude() {
  const model = currentModel()
  const systemPrompt = loadPrompt(PROMPT_PATH)
  promptHash = createHash('sha256').update(systemPrompt).digest('hex')
  serverVersion = null
  fetchServerVersion().then((v) => {
    if (serverVersion == null) serverVersion = v
  })
  log(`starting warm claude (model=${model})`)
  session = harness.startSession({
    model,
    systemPrompt,
    cwd: DAEMON,
    allowedTools: ALLOWED_TOOLS,
  })
  busy = false

  // Tee the drain turn's stream to its logs so narrator.py can post progress.
  session.events.on('raw', (line) => {
    if (turnLog) {
      try {
        turnLog.write(line + '\n')
      } catch {}
    }
  })
  session.events.on('event', (ev) => {
    if (eventsLog) {
      try {
        eventsLog.write(JSON.stringify(ev) + '\n')
      } catch {}
    }
    handleEvent(ev)
  })
  session.events.on('stderr', (s) => {
    if (/error|block|denied/i.test(s)) log('claude stderr:', redact(s).slice(0, 200))
  })
  session.events.on('exit', (code) => {
    log(`claude exited (${code}) — respawning in 2s`)
    if (turnResolve) {
      turnResolve()
      turnResolve = null
    }
    session = null
    setTimeout(startClaude, 2000)
  })

  // Warm-up turn: forces init + connector + tool load now, so the first real
  // drain is already hot. Hold `busy` until it resolves so the loop can't fire a
  // drain turn that races/supersedes the warm-up (that race leaked a kill-timer).
  busy = true
  sendTurn('Warm-up. Do not call any tools. Reply with exactly: READY').then(() => {
    busy = false
  })
}

function handleEvent(ev) {
  const chat = chatFromEvent(ev)
  if (chat) turnChat = chat
  if (ev.type === 'turn_end' && turnResolve) {
    const r = turnResolve
    turnResolve = null
    r(ev)
  }
}

// Abort the in-flight turn WITHOUT killing the process — the same session stays
// alive (keeps ownership of its claimed task) so it can mark it failed. Verified
// that claude honors this control message and the session survives.
function sendInterrupt() {
  if (!session?.alive) return
  try {
    session.interrupt()
    log('sent interrupt to claude')
  } catch (e) {
    log('interrupt write failed:', String(e))
  }
}

// Only one turn is ever in flight; cancelActiveTurn clears its timer + resolves it
// if a new turn supersedes it. Without this, a superseded turn's 15-min kill-timer
// leaked and later SIGKILL'd a healthy claude — causing ~15-min respawn loops
// (each respawn also registers a new session in the Claude Code app).
let cancelActiveTurn = null

function sendTurn(text) {
  return new Promise((resolve) => {
    if (!session?.alive) return resolve(null)
    if (cancelActiveTurn) cancelActiveTurn() // supersede any prior in-flight turn

    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (cancelActiveTurn === superseder) cancelActiveTurn = null
      resolve(v)
    }
    const superseder = () => finish(null)
    // Safety net: a turn that genuinely hangs (connector went stale) gets claude
    // killed → clean respawn+rewarm via the exit handler.
    const timer = setTimeout(() => {
      log(`turn exceeded ${TURN_TIMEOUT_MS}ms — killing claude to respawn`)
      if (session) session.close('SIGKILL')
      finish(null)
    }, TURN_TIMEOUT_MS)
    cancelActiveTurn = superseder
    turnResolve = (v) => finish(v)
    session.send(text)
  })
}

// ---- drain turn outcome -----------------------------------------------------
// A `result` with is_error (spend/rate limit, context overflow, API error) used
// to count as a finished turn, so pending work re-fired a drain every few
// seconds for as long as the error lasted. Back off instead.
// `c` is the turn_end event (classifyResult's ok/kind/detail/retryAfterMs).
function onDrainResult(c) {
  if (c.ok) {
    if (backoff.failures) log(`drain recovered after ${backoff.failures} error turn(s) — backoff reset`)
    backoff.reset()
    alerted = false
    return
  }
  const wait = backoff.fail(c.retryAfterMs)
  log(`drain turn error (${c.kind}): ${c.detail} — next drain in ${Math.round(wait / 1000)}s`)
  if (!alerted && turnChat) {
    alerted = true
    alertOwner(turnChat, c, wait)
  }
  if (c.kind === 'context_overflow' && session) {
    log('context overflow — respawning claude for a fresh session')
    session.close()
  }
}

async function alertOwner({ channel, chat_id }, c, wait) {
  const text = `⚠️ I can't process messages right now (${c.kind}): ${c.detail} — retrying automatically in ${Math.ceil(wait / 60000)} min.`
  try {
    const res = await fetch(`${FERMI_URL}/admin/narrate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel, chat_id, text }),
      signal: AbortSignal.timeout(8000),
    })
    log(`error alert sent to ${channel}/${chat_id} (${res.status})`)
  } catch (e) {
    log('error alert failed:', String(e))
  }
}

// ---- queue polling ---------------------------------------------------------
async function pendingCount() {
  try {
    const res = await fetch(`${FERMI_URL}/admin/tasks/pending`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return 0
    const j = await res.json()
    return j.pending || 0
  } catch {
    return 0
  }
}

// ---- emergency-stop control endpoint --------------------------------------
// The channel bridges (wa-bridge etc.) POST here the instant they see a stop
// command in an inbound message, so we can interrupt a running turn immediately
// instead of the stop waiting in the queue behind the very task it's stopping.
// It listens on a unix socket (run/ is 0700, the socket 0600), never on TCP.
const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Reads a JSON object body of at most `limit` bytes whose keys are all in `fields`; 400 otherwise.
function readBody(req, res, limit, fields, cb) {
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > limit) req.destroy()
  })
  req.on('end', () => {
    let p
    try {
      p = JSON.parse(body || '{}')
    } catch {
      return reply(res, 400, { ok: false, error: 'invalid JSON' })
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) return reply(res, 400, { ok: false, error: 'body must be a JSON object' })
    const unknown = Object.keys(p).filter((k) => !fields.includes(k))
    if (unknown.length) return reply(res, 400, { ok: false, error: 'unknown field(s)', fields: unknown })
    cb(p)
  })
}

function controlHandler(req, res) {
  // GET /model — current model + accepted aliases.
  if (req.method === 'GET' && req.url === '/model') {
    return reply(res, 200, { model: currentModel(), aliases: MODEL_ALIASES })
  }
  // POST /model {"model": "opus"|"sonnet"|"haiku"|"opus-1m"|"claude-…"} —
  // persist the choice and respawn the claude child on it. Waits for any
  // in-flight turn to finish first (the loop is between turns when !busy).
  if (req.method === 'POST' && req.url === '/model') {
    return readBody(req, res, 4096, ['model'], (p) => {
      const resolved = resolveModel(p.model)
      if (!resolved) {
        return reply(res, 400, { ok: false, error: 'unknown model', aliases: Object.keys(MODEL_ALIASES) })
      }
      const prev = currentModel()
      try {
        writeFileSync(MODEL_FILE, resolved + '\n')
      } catch (e) {
        res.writeHead(500)
        return res.end(JSON.stringify({ ok: false, error: String(e) }))
      }
      log(`model switch: ${prev} -> ${resolved} (respawning claude)`)
      // Respawn: exit handler restarts claude, which reads the new model.
      // If a turn is mid-flight this kills it — model switches are explicit
      // user requests, so that is the expected behavior.
      if (session) session.close()
      reply(res, 200, { ok: true, model: resolved, previous: prev })
    })
  }
  if (req.method !== 'POST' || req.url !== '/abort') {
    res.writeHead(404)
    return res.end('not found')
  }
  // POST /abort {"channel"?: "wa", "chat_id": "…"} — accepted only for the chat whose task the
  // current drain turn claimed (turnChat); anything else is a 400 and interrupts nothing.
  readBody(req, res, 4096, ['channel', 'chat_id'], (p) => {
    const { channel = 'wa', chat_id } = p
    if ([channel, chat_id].some((v) => typeof v !== 'string' || !v || v.length > MAX_CONTROL_FIELD)) {
      return reply(res, 400, { ok: false, error: `channel and chat_id must be non-empty strings of at most ${MAX_CONTROL_FIELD} chars` })
    }
    if (!turnChat || channel !== turnChat.channel || chat_id !== turnChat.chat_id) {
      log(`ABORT rejected: not the active chat (busy=${busy})`)
      return reply(res, 400, { ok: false, error: 'not the active chat' })
    }
    log(`ABORT requested for ${channel}/${chat_id} (busy=${busy})`)
    // Concurrent stops for the same chat share one interrupt and one cleanup turn.
    if (!pendingStops.some((s) => s.channel === channel && s.chat_id === chat_id)) {
      pendingStops.push({ channel, chat_id })
      // If a turn is in flight, interrupt it now; the loop then runs cleanup.
      if (busy) sendInterrupt()
    }
    reply(res, 200, { ok: true, interrupted: busy })
  })
}

// True when something accepts connections on the unix socket at `path`.
const answers = (path) =>
  new Promise((resolve) => {
    const s = net.connect(path)
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })

let controlListening = false
async function startControlServer() {
  mkdirSync(dirname(CONTROL_SOCKET), { recursive: true, mode: 0o700 })
  chmodSync(dirname(CONTROL_SOCKET), 0o700)
  let st = null
  try {
    st = lstatSync(CONTROL_SOCKET)
  } catch {}
  if (st) {
    if (!st.isSocket()) refuse(`${CONTROL_SOCKET} exists and is not a socket`)
    if (await answers(CONTROL_SOCKET)) refuse(`a live listener already answers on ${CONTROL_SOCKET} (another warm worker?)`)
    unlinkSync(CONTROL_SOCKET)
    log(`removed stale control socket ${CONTROL_SOCKET}`)
  }
  const server = http.createServer(controlHandler)
  // The socket is created owner-only, then chmod'ed in case the umask was ignored.
  const umask = process.umask(0o177)
  try {
    server.listen(CONTROL_SOCKET)
  } finally {
    process.umask(umask)
  }
  try {
    await once(server, 'listening')
  } catch (e) {
    refuse(`control socket ${CONTROL_SOCKET}: ${e.message}`)
  }
  controlListening = true
  chmodSync(CONTROL_SOCKET, 0o600)
  server.on('error', (e) => log('control server error:', String(e)))
  log(`control endpoint on unix:${CONTROL_SOCKET}`)
}

// POST /teams/webhook — inbound Teams message from the Power Automate flow
// (reaches us through the cloudflared tunnel, which targets only this port).
// Auth: x-teams-bridge-secret header. Without WARM_TEAMS_PORT there is no listener.
function startTeamsServer() {
  if (!TEAMS_PORT) return log('teams webhook disabled (WARM_TEAMS_PORT unset)')
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/teams/webhook') {
      res.writeHead(404)
      return res.end('not found')
    }
    if (!TEAMS_SECRET || req.headers['x-teams-bridge-secret'] !== TEAMS_SECRET) {
      res.writeHead(401)
      return res.end('unauthorized')
    }
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 262144) req.destroy()
    })
    req.on('end', () => {
      let p = {}
      try {
        p = JSON.parse(body || '{}')
      } catch {}
      const sender = String(p.senderDisplayName || 'Teams user')
      const text = htmlToText(p.messageBody || '')
      if (!text) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, skipped: 'empty' }))
      }
      log(`teams inbound from ${sender}: ${redact(text).slice(0, 80)}`)
      pendingTeams.push({ sender, text, link: p.linkToMessage || '' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  server.on('error', (e) => log('teams webhook server error:', String(e)))
  server.listen(Number(TEAMS_PORT), '127.0.0.1', () =>
    log(`teams webhook on 127.0.0.1:${server.address().port}/teams/webhook`),
  )
}

// ---- staleness self-check ---------------------------------------------------
// The claude child freezes the rendered prompts/drain.md (prompt + local.json) and its Fermi MCP toolset at spawn.
// Periodically (idle only — never mid-task) re-check both sources; on a change,
// kill the child and let the exit handler respawn it (same mechanism as the
// POST /model switch): fresh process = fresh prompt + fresh MCP session.
async function stalenessCheck() {
  if (busy || !session) return
  try {
    const h = createHash('sha256').update(loadPrompt(PROMPT_PATH)).digest('hex')
    if (promptHash && h !== promptHash) {
      log(`staleness respawn: prompt-changed (prompts/drain.md ${promptHash.slice(0, 12)} -> ${h.slice(0, 12)})`)
      session.close()
      return
    }
  } catch (e) {
    log('staleness prompt check failed (non-fatal):', String(e))
  }
  const v = await fetchServerVersion()
  if (v == null) return // no/unreachable version — treated as unchanged
  if (serverVersion == null) {
    serverVersion = v
    return
  }
  if (v !== serverVersion && !busy && session) {
    log(`staleness respawn: server-version-changed (${serverVersion} -> ${v})`)
    session.close()
  }
}

let lastActivity = Date.now()

async function loop() {
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (busy || !session) continue
    // Emergency stops take priority over any normal queue work.
    if (pendingStops.length) {
      busy = true
      while (pendingStops.length) {
        const { channel, chat_id } = pendingStops.shift()
        log(`emergency-stop cleanup for ${channel}/${chat_id}`)
        try {
          await sendTurn(
            `EMERGENCY STOP from the user — you were just interrupted. Do ONLY these steps, then stop:\n` +
              `(1) If DURING THIS TURN you claimed a task (its id is in your immediate context just above), call task_complete on THAT task id with status "failed" and result "stopped by user". Only that one task — do NOT call task_list to hunt for others, and do NOT touch older or unrelated tasks.\n` +
              `(2) channel_send a brief "🛑 Stopped." to channel "${channel}" chat_id "${chat_id}".\n` +
              `(3) Do NOT resume, retry, or redo the interrupted work.`,
          )
        } catch (e) {
          log('stop cleanup error:', String(e))
        }
      }
      lastActivity = Date.now()
      busy = false
      continue
    }
    // Teams messages: not in the Fermi queue — handled as direct warm turns.
    if (pendingTeams.length) {
      busy = true
      const batch = pendingTeams.splice(0, pendingTeams.length)
      const t0 = Date.now()
      log(`teams: ${batch.length} message(s) — firing warm turn`)
      const msgs = batch
        .map((m) => `- From ${m.sender}: ${m.text}`)
        .join('\n')
      try {
        await sendTurn(
          `New message(s) from the Microsoft Teams "fermi-bridge" channel (Daniel's-agents test bridge — treat like a normal user chat):\n${msgs}\n\n` +
            `Reply by running (Bash tool, directly on this Mac — do NOT use mac_shell for this): ~/fermi-daemon/tools/teams-send.sh 'your reply text' — single quotes, escape as needed; keep replies concise (they render as a Teams card). ` +
            `These messages are NOT queue tasks: do NOT call task_claim or task_complete for them. Use context_bootstrap only if you need user context${ownerNote(join(DAEMON, 'prompts/local.json'))}.`,
        )
        log(`teams turn done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } catch (e) {
        log('teams turn error:', String(e))
      }
      lastActivity = Date.now()
      busy = false
      continue
    }
    if (!backoff.ready()) continue
    const n = await pendingCount()
    if (n <= 0) {
      // Keep the connector hot during long idle spells so the next real drain
      // is still warm (avoids a stale-connector slow/hung first turn).
      if (Date.now() - lastActivity > KEEPALIVE_MS) {
        busy = true
        await sendTurn('Keep-alive. Do not call any tools. Reply with exactly: OK')
        lastActivity = Date.now()
        busy = false
      }
      continue
    }
    busy = true
    const t0 = Date.now()
    log(`drain: ${n} pending — firing warm turn`)
    // Per-turn stream log + narrator, so long tasks (browser automation etc.)
    // post live "🌐 Browsing…" progress to the chat instead of going silent.
    const logPath = join(DAEMON, `runs/warm-${t0}.log`)
    let narrator = null
    try {
      // Opened synchronously so it exists before the narrator looks for it.
      eventsLog = openLog(join(DAEMON, `runs/warm-${t0}.events.jsonl`), 'w')
      turnLog = openLog(logPath, 'w')
      narrator = spawn('python3', [join(DAEMON, 'narrator.py'), logPath], {
        cwd: DAEMON,
        stdio: 'ignore',
        detached: true,
      })
      narrator.unref()
    } catch (e) {
      log('narrator spawn failed (non-fatal):', String(e))
    }
    turnChat = null
    try {
      const r = await sendTurn(
        'There are pending tasks in the queue. Claim and process every pending task now (claim one at a time, bootstrap, reply, complete), looping until task_claim returns empty. Then stop.',
      )
      log(`drain turn done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      // An emergency stop interrupts the turn on purpose — not an error to back off from.
      if (r && !pendingStops.length) onDrainResult(r)
    } catch (e) {
      log('drain turn error:', String(e))
    } finally {
      for (const w of [turnLog, eventsLog]) {
        try {
          w?.end()
        } catch {}
      }
      turnLog = eventsLog = null
    }
    lastActivity = Date.now()
    busy = false
  }
}

process.on('SIGTERM', () => {
  if (session) session.close()
  if (controlListening) {
    try {
      unlinkSync(CONTROL_SOCKET)
    } catch {}
  }
  process.exit(0)
})

pruneRunsDir()
setInterval(pruneRunsDir, 86_400_000)
await startControlServer()
startTeamsServer()
startClaude()
setInterval(stalenessCheck, STALENESS_MS)
loop()
