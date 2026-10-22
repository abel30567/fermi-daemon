import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { classifyResult, parseResetMs, Backoff, chatFromEvent } from '../lib/turn-outcome.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'test/fixtures/blocking-limit-result.json')
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'Done.', terminal_reason: 'completed', api_error_status: null }

describe('classifyResult', () => {
  test('blocking-limit fixture (subtype success, is_error true) is a spend limit with its reset time', () => {
    const now = Date.parse('2026-10-19T05:00:00Z') // 01:00 in New York
    const c = classifyResult(fixture, now)
    assert.equal(c.ok, false)
    assert.equal(c.kind, 'spend_limit')
    assert.equal(c.retryAfterMs, 60 * 60_000) // resets 2am (America/New_York)
    assert.match(c.detail, /spend limit/)
  })

  test('a normal success result is ok', () => {
    assert.deepEqual(classifyResult(SUCCESS), { ok: true, kind: 'ok', detail: 'Done.' })
  })

  test('kinds from is_error, terminal_reason, api_error_status and text', () => {
    const err = (o) => classifyResult({ type: 'result', subtype: 'success', is_error: true, ...o }).kind
    assert.equal(err({ result: 'Prompt is too long', terminal_reason: 'blocking_limit' }), 'context_overflow')
    assert.equal(err({ result: 'x', api_error_status: 429 }), 'rate_limit')
    assert.equal(err({ result: 'Claude usage limit reached · resets 3pm' }), 'rate_limit')
    assert.equal(err({ result: 'Invalid API key · Please run /login', api_error_status: 401 }), 'auth')
    assert.equal(err({ result: 'API Error: 500 Internal server error', api_error_status: 500 }), 'api_error')
    assert.equal(err({ subtype: 'error_during_execution', result: '' }), 'unknown_error')
  })

  test('parseResetMs rolls to the next day and falls back to local time', () => {
    const now = Date.parse('2026-10-19T07:00:00Z') // 03:00 in New York
    assert.equal(parseResetMs('resets 2am (America/New_York)', now), 23 * 60 * 60_000)
    assert.equal(parseResetMs('resets 2:30am (America/New_York)', now), 23.5 * 60 * 60_000)
    assert.ok(parseResetMs('resets 2am (Not/AZone)', now) > 0)
    assert.equal(parseResetMs('no reset here', now), undefined)
  })

  test('chatFromEvent reads the claimed task from a task_claim tool_result', () => {
    const tasks = [{ channel: 'dc', chat_id: 42 }]
    const ev = { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify({ tasks }) }] } }
    assert.deepEqual(chatFromEvent(ev), { channel: 'dc', chat_id: '42' })
    assert.equal(chatFromEvent(SUCCESS), null)
  })
})

describe('Backoff', () => {
  test('10 consecutive error turns: non-decreasing, >= 30s apart, capped at 30 min', () => {
    let clock = 0
    const b = new Backoff({ now: () => clock })
    const retries = []
    for (let i = 0; i < 10; i++) {
      b.fail()
      assert.equal(b.ready(), false)
      clock = b.until // fake clock: jump to when the next retry is allowed
      assert.equal(b.ready(), true)
      retries.push(clock)
    }
    const gaps = retries.map((t, i) => t - (retries[i - 1] ?? 0))
    assert.deepEqual(gaps.slice(0, 7), [30e3, 60e3, 120e3, 240e3, 480e3, 960e3, 1800e3])
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1])
    assert.ok(gaps.every((g) => g >= 30e3 && g <= 30 * 60e3))
  })

  test('a reset time later than the backoff wins; reset() clears it', () => {
    let clock = 0
    const b = new Backoff({ now: () => clock })
    assert.equal(b.fail(600_000), 600_000)
    assert.equal(b.fail(1000), 60_000)
    b.reset()
    assert.equal(b.ready(), true)
    assert.equal(b.fail(), 30_000)
  })

  test('a 10 h reset time is capped at 30 min', () => {
    let clock = 0
    const b = new Backoff({ now: () => clock })
    const wait = b.fail(10 * 3_600_000)
    assert.ok(wait <= 30 * 60_000, `wait ${wait}`)
    assert.equal(b.until, 30 * 60_000)
  })
})

// ---- integration: real warm-worker.mjs against a fake harness ---------------
// Time is scaled 60x: 10 simulated minutes = 10 s, 30 s base backoff = 500 ms.
const SCALE = 60
const sim = (ms) => Math.round(ms / SCALE)

export async function runWorker({ result, errors, claim, durationMs, worker = join(ROOT, 'warm-worker.mjs') }) {
  const home = mkdtempSync(join(tmpdir(), 'dmn2-'))
  const daemon = join(home, 'fermi-daemon')
  mkdirSync(join(daemon, 'prompts'), { recursive: true })
  mkdirSync(join(daemon, 'runs'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  writeFileSync(join(daemon, 'prompts/drain.md'), 'test prompt\n')
  const resultFile = join(home, 'result.json')
  writeFileSync(resultFile, JSON.stringify(result))
  const claudeBin = join(home, '.local/bin/claude')
  writeFileSync(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/fixtures/fake-claude.mjs')}" "$@"\n`)
  chmodSync(claudeBin, 0o755)

  const narrations = []
  const server = http.createServer((req, res) => {
    if (req.url === '/admin/tasks/pending') return res.end(JSON.stringify({ pending: 1 }))
    if (req.url === '/admin/narrate') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        narrations.push(JSON.parse(body))
        res.end('{}')
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:${server.address().port}\nFERMI_BEARER_TOKEN=test\n`)

  const child = spawn(process.execPath, [worker], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      WARM_POLL_MS: String(sim(1000)),
      WARM_CONTROL_PORT: '0',
      WARM_BACKOFF_BASE_MS: String(sim(30_000)),
      WARM_BACKOFF_MAX_MS: String(sim(1_800_000)),
      FAKE_DIR: home,
      FAKE_RESULT: resultFile,
      FAKE_DELAY_MS: String(sim(3000)), // the incident's turns took ~4 s end to end
      ...(errors != null && { FAKE_ERRORS: String(errors) }),
      ...(claim && { FAKE_CLAIM: '1' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  await new Promise((r) => setTimeout(r, durationMs))
  child.kill('SIGTERM')
  await new Promise((r) => child.on('exit', r))
  server.close()
  const turnsLog = join(home, 'turns.log')
  const events = existsSync(turnsLog)
    ? readFileSync(turnsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  rmSync(home, { recursive: true, force: true })
  return { events, drains: events.filter((e) => e.drain), narrations, log }
}

const noResetTime = { ...fixture, result: fixture.result.replace(/ · your weekly limit resets.*$/, '') }

describe('warm-worker with a failing harness', { concurrency: true }, () => {
  test('fixture result for 10 simulated minutes: at most 5 drain turns, alert logged only', async (t) => {
    const { drains, narrations, log } = await runWorker({ result: fixture, durationMs: sim(600_000) })
    t.diagnostic(`${drains.length} drain turns`)
    assert.ok(drains.length >= 1 && drains.length <= 5, `${drains.length} drain turns\n${log}`)
    assert.equal(narrations.length, 0) // no task claimed → no known channel → log only
    assert.match(log, /drain turn error \(spend_limit\)/)
  })

  test('no reset time: exponential backoff, >= 30 s apart, one alert to the claimed chat', async (t) => {
    const { drains, narrations, log } = await runWorker({ result: noResetTime, claim: true, durationMs: sim(600_000) })
    t.diagnostic(`${drains.length} drain turns`)
    assert.ok(drains.length >= 2 && drains.length <= 5, `${drains.length} drain turns\n${log}`)
    for (let i = 1; i < drains.length; i++) assert.ok(drains[i].t - drains[i - 1].t >= sim(30_000))
    assert.equal(narrations.length, 1)
    assert.equal(narrations[0].channel, 'wa')
    assert.equal(narrations[0].chat_id, '+15555550100')
    assert.equal(log.match(/next drain in/g).length, drains.length) // one line per error turn, not per poll
  })

  test('a successful turn after errors resets the backoff and drains normally', async () => {
    const { drains, log } = await runWorker({ result: noResetTime, errors: 2, durationMs: sim(180_000) })
    assert.match(log, /drain recovered after 2 error turn\(s\)/)
    const after = drains.slice(2) // turns from the first success on
    assert.ok(after.length >= 5, `${after.length} drain turns after recovery\n${log}`)
    for (let i = 1; i < after.length; i++) assert.ok(after[i].t - after[i - 1].t < sim(30_000))
  })

  test('context overflow respawns the harness before the retry', async () => {
    const overflow = { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'blocking_limit', result: 'Prompt is too long' }
    const { events, drains, log } = await runWorker({ result: overflow, durationMs: 6000 }) // respawn waits a fixed 2 s
    assert.ok(drains.length >= 2, log)
    const first = events.indexOf(drains[0])
    const second = events.indexOf(drains[1])
    assert.ok(events.slice(first, second).some((e) => e.kind === 'spawn'), log)
    assert.ok(new Set(drains.map((d) => d.pid)).size === drains.length)
  })
})
