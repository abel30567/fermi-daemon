#!/usr/bin/env node
// One-shot cold run for poll.sh: one prompt file, one harness process (via the
// harness adapter's runOnce), with the warm worker's tool and settings surface
// (lib/run-policy.mjs).
//
//   node bin/run-once.mjs --prompt prompts/drain.md --log runs/<ts>.log \
//     [--lane lanes/<n>] [--session session.id] [--model M] [--max-turns N] [--timeout-s S]
//
// --log      raw harness output (stream-json) plus stderr, appended
// --lane     lane dir from poll.sh's acquire_lane; removed when this process exits
// --session  resume the session id in this file (if any), then store the run's id there
// --timeout-s watchdog: SIGTERM the harness after S seconds, SIGKILL 2s later (exit 124)
//
// Runs in the current directory (poll.sh cds to the daemon home first).

import { readFileSync, writeFileSync, existsSync, rmSync, createWriteStream } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadHarness } from '../harness/index.mjs'
import { ALLOWED_TOOLS, SETTING_SOURCES } from '../lib/run-policy.mjs'

const KILL_GRACE_MS = 2000

const { values: o } = parseArgs({
  options: {
    prompt: { type: 'string' },
    log: { type: 'string' },
    lane: { type: 'string' },
    session: { type: 'string' },
    model: { type: 'string' },
    'max-turns': { type: 'string' },
    'timeout-s': { type: 'string' },
  },
})
if (!o.prompt || !o.log) {
  console.error('run-once: --prompt and --log are required')
  process.exit(2)
}

// The lane is ours from here on: free it however we exit.
if (o.lane) process.on('exit', () => rmSync(o.lane, { recursive: true, force: true }))

const out = createWriteStream(o.log, { flags: 'a' })
const note = (msg) => out.write(`run-once: ${msg}\n`)

const resume = o.session && existsSync(o.session) ? readFileSync(o.session, 'utf8').trim() : ''
const harness = await loadHarness()
const run = harness.runOnce({
  prompt: readFileSync(o.prompt, 'utf8'),
  cwd: process.cwd(),
  model: o.model,
  maxTurns: o['max-turns'] != null ? Number(o['max-turns']) : undefined,
  allowedTools: ALLOWED_TOOLS,
  settingSources: SETTING_SOURCES,
  resume: resume || undefined,
})
note(`harness pid ${run.pid}`)

let sessionId = null
run.events.on('raw', (line) => {
  out.write(line + '\n')
  if (sessionId) return
  try {
    sessionId = JSON.parse(line).session_id ?? null
  } catch {}
})
run.events.on('stderr', (s) => out.write(s))

// poll.sh's reaper SIGTERMs us on its own watchdog; take the harness down with us.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    note(`${sig}: stopping harness`)
    run.close('SIGTERM')
    out.end(() => process.exit(143))
  })
}

let timedOut = false
let killTimer
const watchdog =
  o['timeout-s'] != null &&
  setTimeout(() => {
    timedOut = true
    note(`watchdog: killing harness after ${o['timeout-s']}s`)
    run.close('SIGTERM')
    killTimer = setTimeout(() => run.close('SIGKILL'), KILL_GRACE_MS)
  }, Number(o['timeout-s']) * 1000)

const { code } = await run.done
clearTimeout(watchdog)
clearTimeout(killTimer)
if (o.session && sessionId && !timedOut) writeFileSync(o.session, sessionId + '\n')
note(`exit ${timedOut ? 'watchdog' : code}`)
out.end(() => process.exit(timedOut ? 124 : (code ?? 1)))
