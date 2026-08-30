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
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'

const HOME = process.env.HOME
const DAEMON = join(HOME, 'fermi-daemon')
const CLAUDE = join(HOME, '.local/bin/claude')

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
const CONTROL_PORT = Number(process.env.WARM_CONTROL_PORT || 8791) // localhost emergency-stop endpoint
const SYSTEM_PROMPT = readFileSync(join(DAEMON, 'prompts/drain.md'), 'utf8')

// Emergency stops requested via the control endpoint, drained by the main loop
// ahead of any normal queue work. Each is {channel, chat_id}.
const pendingStops = []

// Inbound Microsoft Teams messages (via Power Automate flow → tunnel →
// POST /teams/webhook). Each is {sender, text, link}. Processed by the loop
// like queue work; replies go out via tools/teams-send.sh.
const pendingTeams = []
const TEAMS_SECRET = env.TEAMS_WEBHOOK_SECRET || ''

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

// ---- persistent claude process ---------------------------------------------
let claude = null
let busy = false
let buf = ''
let turnResolve = null
let turnLog = null // write stream for the current drain turn's stream-json (fed to narrator.py)

function startClaude() {
  const model = currentModel()
  log(`starting warm claude (model=${model})`)
  claude = spawn(
    CLAUDE,
    [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--setting-sources', 'project,local', // skip global user hooks (they block/latency)
      '--append-system-prompt', SYSTEM_PROMPT,
      '--allowedTools', 'Bash,mcp__claude_ai_Fermi,mcp__playwright',
    ],
    { cwd: DAEMON, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  buf = ''
  busy = false

  claude.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      // Tee the drain turn's stream to its log so narrator.py can post progress.
      if (turnLog) {
        try {
          turnLog.write(line + '\n')
        } catch {}
      }
      let j
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      handleEvent(j)
    }
  })
  claude.stderr.on('data', (d) => {
    const s = d.toString()
    if (/error|block|denied/i.test(s)) log('claude stderr:', s.slice(0, 200))
  })
  claude.on('exit', (code) => {
    log(`claude exited (${code}) — respawning in 2s`)
    if (turnResolve) {
      turnResolve()
      turnResolve = null
    }
    claude = null
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

function handleEvent(j) {
  // turn completion: the result event (type:result, or has num_turns+is_error)
  if (j.type === 'result' || (j.num_turns !== undefined && j.is_error !== undefined)) {
    if (turnResolve) {
      const r = turnResolve
      turnResolve = null
      r(j)
    }
  }
}

// Abort the in-flight turn WITHOUT killing the process — the same session stays
// alive (keeps ownership of its claimed task) so it can mark it failed. Verified
// that claude honors this control message and the session survives.
function sendInterrupt() {
  if (!claude || !claude.stdin.writable) return
  try {
    claude.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'stop_' + Date.now(),
        request: { subtype: 'interrupt' },
      }) + '\n',
    )
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
    if (!claude || !claude.stdin.writable) return resolve(null)
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
      if (claude) claude.kill('SIGKILL')
      finish(null)
    }, TURN_TIMEOUT_MS)
    cancelActiveTurn = superseder
    turnResolve = (v) => finish(v)
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }
    claude.stdin.write(JSON.stringify(msg) + '\n')
  })
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
function startControlServer() {
  const server = http.createServer((req, res) => {
    // GET /model — current model + accepted aliases.
    if (req.method === 'GET' && req.url === '/model') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ model: currentModel(), aliases: MODEL_ALIASES }))
    }
    // POST /model {"model": "opus"|"sonnet"|"haiku"|"opus-1m"|"claude-…"} —
    // persist the choice and respawn the claude child on it. Waits for any
    // in-flight turn to finish first (the loop is between turns when !busy).
    if (req.method === 'POST' && req.url === '/model') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => {
        let p = {}
        try {
          p = JSON.parse(body || '{}')
        } catch {}
        const resolved = resolveModel(p.model)
        if (!resolved) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(
            JSON.stringify({ ok: false, error: 'unknown model', aliases: Object.keys(MODEL_ALIASES) }),
          )
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
        if (claude) claude.kill()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, model: resolved, previous: prev }))
      })
      return
    }
    // POST /teams/webhook — inbound Teams message from the Power Automate flow
    // (reaches us through the cloudflared tunnel; path-scoped so only /teams/*
    // is public). Auth: x-teams-bridge-secret header.
    if (req.method === 'POST' && req.url === '/teams/webhook') {
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
        log(`teams inbound from ${sender}: ${text.slice(0, 80)}`)
        pendingTeams.push({ sender, text, link: p.linkToMessage || '' })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    if (req.method !== 'POST' || req.url !== '/abort') {
      res.writeHead(404)
      return res.end('not found')
    }
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 4096) req.destroy()
    })
    req.on('end', () => {
      let p = {}
      try {
        p = JSON.parse(body || '{}')
      } catch {}
      const channel = p.channel || 'wa'
      const chat_id = String(p.chat_id || '')
      log(`ABORT requested for ${channel}/${chat_id} (busy=${busy})`)
      pendingStops.push({ channel, chat_id })
      // If a turn is in flight, interrupt it now; the loop then runs cleanup.
      if (busy) sendInterrupt()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, interrupted: busy }))
    })
  })
  server.on('error', (e) => log('control server error:', String(e)))
  server.listen(CONTROL_PORT, '127.0.0.1', () =>
    log(`control endpoint on 127.0.0.1:${CONTROL_PORT}/abort`),
  )
}

let lastActivity = Date.now()

async function loop() {
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (busy || !claude) continue
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
            `These messages are NOT queue tasks: do NOT call task_claim or task_complete for them. Use context_bootstrap only if you need user context (channel wa, chat_id 17866630320 is the same person: Claudio).`,
        )
        log(`teams turn done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } catch (e) {
        log('teams turn error:', String(e))
      }
      lastActivity = Date.now()
      busy = false
      continue
    }
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
      turnLog = createWriteStream(logPath)
      narrator = spawn('python3', [join(DAEMON, 'narrator.py'), logPath], {
        cwd: DAEMON,
        stdio: 'ignore',
        detached: true,
      })
      narrator.unref()
    } catch (e) {
      log('narrator spawn failed (non-fatal):', String(e))
    }
    try {
      await sendTurn(
        'There are pending tasks in the queue. Claim and process every pending task now (claim one at a time, bootstrap, reply, complete), looping until task_claim returns empty. Then stop.',
      )
      log(`drain turn done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (e) {
      log('drain turn error:', String(e))
    } finally {
      if (turnLog) {
        try {
          turnLog.end()
        } catch {}
        turnLog = null
      }
    }
    lastActivity = Date.now()
    busy = false
  }
}

process.on('SIGTERM', () => {
  if (claude) claude.kill()
  process.exit(0)
})

startClaude()
startControlServer()
loop()
