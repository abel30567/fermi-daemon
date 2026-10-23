// DMN-34: infrastructure outcomes (rate/spend limits, 5xx) are retried, not graded;
// an attempt still limited is invalid and compare.mjs leaves it out of every rate;
// runner processes sharing an --auth backend run their attempts one at a time.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { compare, renderMarkdown } from '../evals/compare.mjs'
import { validate } from '../evals/lib/json-schema.mjs'
import { acquireLock, createPacer, lockDir } from '../evals/lib/pacing.mjs'
import { INFRA_BACKOFF, runAttempt, summarize } from '../evals/lib/runner.mjs'
import { classifyResult } from '../lib/turn-outcome.mjs'
import * as fake from '../evals/harness/fake.mjs'

const RUN = join(ROOT, 'evals/run.mjs')
const COMPARE = join(ROOT, 'evals/compare.mjs')
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const CHILD = join(ROOT, 'test/fixtures/paced-runner.mjs')
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'evals/schema/results.schema.json'), 'utf8'))
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn34-'))
const FAST = { baseMs: 10, maxMs: 40 } // the 30 s → 10 min backoff, time scaled

const CLAIM = { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } }
const SEND = { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text: 'Paris.' } }
const DONE = { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'r' } }
const LIMIT = { apiError: { status: 429, text: 'API Error: 429 {"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}' } }
const scenario = {
  name: 'infra',
  category: 'core',
  fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
  inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'What is the capital of France?' },
  expect: [{ exactlyOnce: 'channel_send' }, { 'task.status': 'done' }],
  fake: { script: [CLAIM, SEND, DONE, CLAIM] },
}

// The fake harness, playing `scripts[i]` on its i-th run (the last one from then on).
const scripted = (scripts) => {
  let n = 0
  return { ...fake, runOnce: (o) => fake.runOnce({ ...o, script: scripts[Math.min(n++, scripts.length - 1)] }) }
}
// A harness whose i-th run only ends its turn with `ends[i]` (the last one from then on).
const ending = (ends) => {
  let n = 0
  return {
    name: 'fake',
    runOnce() {
      const events = new EventEmitter()
      const ev = { type: 'turn_end', durationMs: 0, raw: null, ...ends[Math.min(n++, ends.length - 1)] }
      const done = (async () => (await null, events.emit('event', ev), { code: 0 }))()
      return { pid: process.pid, events, done, close() {} }
    },
  }
}
const OK = { ok: true, kind: 'ok', detail: 'done' }
const attempt = (harness, opts = {}) => {
  const waits = []
  const outDir = opts.outDir ?? tmp()
  return runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir, backoff: FAST, onInfraRetry: (x) => waits.push(x.waitMs), ...opts }).then((r) => ({ r, waits, outDir }))
}

describe('AC1: rate-limited twice, then a pass → one passing attempt with infraRetries 2', () => {
  test('the attempt is re-run from scratch and graded on the last try', async () => {
    const { r, waits, outDir } = await attempt(scripted([[CLAIM, LIMIT], [CLAIM, SEND, LIMIT], scenario.fake.script]), { infraRetries: 3 })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(r.status, 'valid')
    assert.equal(r.infraRetries, 2)
    assert.deepEqual(r.errorKinds, [])
    assert.deepEqual(waits, [10, 20]) // exponential from the base
    // Fresh state each try: the second try's send went to a fresh target, so exactlyOnce held.
    for (const d of ['1.infra-1', '1.infra-2', '1']) assert.ok(existsSync(join(outDir, 'infra', d, 'trace.jsonl')), d)
    assert.deepEqual(validate(SCHEMA, [r]), [])
  })

  test('backoff is capped, and a reset time from the error wins', async () => {
    const limited = { ok: false, kind: 'rate_limit', detail: 'usage limit reached' }
    const { waits } = await attempt(ending([limited, limited, limited, limited, OK]), { infraRetries: 5 })
    assert.deepEqual(waits, [10, 20, 40, 40])
    const reset = await attempt(ending([{ ...limited, retryAfterMs: 7 }, OK]), { infraRetries: 3 })
    assert.deepEqual(reset.waits, [7])
    assert.equal(reset.r.infraRetries, 1)
  })

  test('a reset beyond the 10 min wait cap ("resets 2am") is invalid at once, the reset time in the reason', async () => {
    const now = Date.parse('2026-10-19T05:00:00Z') // 01:00 in New York: the reset is 1 h away
    const end = classifyResult({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached · resets 2am (America/New_York)' }, now)
    assert.equal(end.retryAfterMs, 60 * 60_000)
    const t0 = Date.now()
    const { r, waits } = await attempt(ending([end, OK]), { infraRetries: 3, backoff: INFRA_BACKOFF })
    assert.ok(Date.now() - t0 < 5_000, 'no long sleep')
    assert.deepEqual([r.pass, r.status, r.infraRetries, waits], [null, 'invalid', 0, []])
    const at = Date.parse(/resets at (\S+),/.exec(r.invalidReason)?.[1])
    assert.ok(Math.abs(at - (t0 + 60 * 60_000)) < 5_000, r.invalidReason)
    assert.match(r.invalidReason, /^rate_limit resets at .* beyond the 600000 ms infra wait cap: .*resets 2am/)
    assert.deepEqual(validate(SCHEMA, [r]), [])
  })

  test('spend limits and 5xx/overloaded are infrastructure; other API errors and harness failures are graded', async () => {
    const infra = [
      { ok: false, kind: 'spend_limit', detail: 'spending limit reached' },
      { ok: false, kind: 'api_error', detail: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}' },
      { ok: false, kind: 'api_error', detail: 'API Error: 500 Internal server error' },
    ]
    for (const end of infra) assert.equal((await attempt(ending([end, OK]), { infraRetries: 1 })).r.infraRetries, 1, end.detail)
    const graded = [
      { ok: false, kind: 'api_error', detail: 'API Error: 400 invalid_request_error' },
      { ok: false, kind: 'context_overflow', detail: 'Prompt is too long' },
      { ok: false, kind: 'auth', detail: 'Invalid API key' },
    ]
    for (const end of graded) {
      const { r, waits } = await attempt(ending([end, OK]), { infraRetries: 3 })
      assert.deepEqual([r.pass, r.status, r.infraRetries, waits], [false, 'valid', 0, []], end.detail)
    }
  })

  test('a 429 a warm session re-drains through is the harness behaviour under test, not retried', async () => {
    const s = { ...scenario, session: { redrain: 1 }, fake: { script: [{ ...CLAIM, onTurn: 1 }, { ...LIMIT, onTurn: 1 }, { ...SEND, onTurn: 2 }, { ...DONE, onTurn: 2 }] } }
    const { r } = await attempt(fake, { scenario: s, infraRetries: 3 })
    assert.deepEqual([r.pass, r.status, r.infraRetries], [true, 'valid', 0], JSON.stringify(r.failed))
  })
})

describe('AC2: always rate-limited → status invalid, left out by compare.mjs, INCONCLUSIVE', () => {
  const limitedAttempt = () => attempt(scripted([[CLAIM, LIMIT]]), { infraRetries: 3 })

  test('the attempt is invalid with the reason, never pass:false', async () => {
    const { r, waits } = await limitedAttempt()
    assert.equal(r.status, 'invalid')
    assert.equal(r.pass, null)
    assert.equal(r.infraRetries, 3)
    assert.deepEqual(waits, [10, 20, 40])
    assert.match(r.invalidReason, /^rate_limit after 3 infra retries: API Error: 429/)
    assert.deepEqual(validate(SCHEMA, [r]), [])
    const s = summarize([r], {})
    assert.deepEqual([s.passed, s.failed, s.unexpected, s.invalid.length, s.ok], [0, 0, [], 1, false])
  })

  test('compare.mjs excludes invalid attempts from every rate and reports INCONCLUSIVE for the category', async () => {
    const { r: bad } = await limitedAttempt()
    const good = (await attempt(fake)).r
    const valid = Array.from({ length: 8 }, (_, i) => ({ ...good, attempt: i + 1 }))
    const baseline = Array.from({ length: 10 }, (_, i) => ({ ...good, attempt: i + 1 }))
    const candidate = [...valid, { ...bad, attempt: 9 }, { ...bad, attempt: 10 }] // 2/10 = 20% invalid
    const report = compare(baseline, candidate)
    const core = report.categories.candidate.core
    assert.deepEqual([core.attempts, core.passes, core.passRate, core.invalidAttempts], [8, 8, 1, 2])
    assert.equal(report.categories.baseline.core.invalidAttempts, 0)
    assert.equal(report.stats.candidate.attempts, 8)
    assert.equal(report.stats.candidate.errorKinds.rate_limit, undefined) // not counted as a harness error
    assert.equal(report.verdict, 'INCONCLUSIVE')
    assert.deepEqual(report.inconclusive, [{ run: 'candidate', category: 'core', invalidAttempts: 2, attempts: 10 }])
    const md = renderMarkdown(report)
    assert.match(md, /^\*\*Swap gate: INCONCLUSIVE\*\* \(> 10\.0% invalid: candidate core 2\/10\)$/m)
    assert.match(md, /^\| core \| 10\/10 \(100\.0%\) .* \| 8\/8 \(100\.0%\) .* \| 0 \/ 2 \|$/m)
    // At most 10% invalid is not inconclusive: the gate decides on the valid attempts.
    const one = compare(baseline, [...valid, { ...good, attempt: 9 }, { ...bad, attempt: 10 }])
    assert.equal(one.categories.candidate.core.invalidAttempts, 1)
    assert.equal(one.verdict, 'NO-GO') // this toy run has no critical/soak/credential categories
  })

  test('the CLI exits 3 on INCONCLUSIVE', async () => {
    const { r: bad } = await limitedAttempt()
    const dir = tmp()
    writeFileSync(join(dir, 'b.json'), JSON.stringify([{ ...bad, status: 'valid', pass: true, failed: [], errorKinds: [] }]))
    writeFileSync(join(dir, 'c.json'), JSON.stringify([bad]))
    const p = spawnSync(process.execPath, [COMPARE, join(dir, 'b.json'), join(dir, 'c.json'), '--out', dir], { encoding: 'utf8' })
    assert.equal(p.status, 3, p.stderr)
    assert.match(p.stdout, /Swap gate: INCONCLUSIVE/)
    assert.equal(JSON.parse(readFileSync(join(dir, 'compare.json'), 'utf8')).verdict, 'INCONCLUSIVE')
  })

  test('run.mjs records status and infraRetries, prints INVALID and exits 1', () => {
    const dir = tmp()
    const file = join(dir, 'limited.json')
    writeFileSync(file, JSON.stringify({ ...scenario, name: 'limited', fake: { script: [CLAIM, LIMIT] } }))
    const out = join(dir, 'out')
    const p = spawnSync(process.execPath, ['--import', PRELOAD, RUN, '--harness', 'fake', '--scenarios', file, '--infra-retries', '0', '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    assert.equal(p.status, 1, p.stdout + p.stderr)
    assert.match(p.stdout, /^INVALID limited #1/m)
    const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
    assert.deepEqual([results[0].status, results[0].infraRetries, results[0].pass], ['invalid', 0, null])
    assert.deepEqual(validate(SCHEMA, results), [])
    assert.equal(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).invalid.length, 1)
  })

  test('--infra-retries and --min-gap-ms are validated', () => {
    for (const args of [['--infra-retries', '-1'], ['--infra-retries', '1.5'], ['--min-gap-ms', 'x']]) {
      const p = spawnSync(process.execPath, ['--import', PRELOAD, RUN, '--harness', 'fake', '--scenarios', 'x', ...args], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(p.status, 2, args.join(' '))
    }
  })
})

describe('AC3: runner processes sharing an --auth backend never run attempts concurrently', () => {
  const runChildren = (home, log, backend, { n = 4, holdMs = 60, minGapMs = 0, procs = 2 } = {}) =>
    Promise.all(
      Array.from({ length: procs }, () => {
        const p = spawn(process.execPath, ['--import', PRELOAD, CHILD, home, log, tmp(), backend, String(n), String(holdMs), String(minGapMs)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
        let err = ''
        p.stderr.on('data', (d) => (err += d))
        return new Promise((resolve) => p.on('exit', (code) => resolve({ code, err })))
      }),
    )
  const intervals = (log) =>
    readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.start - b.start)

  test('two processes on the proxy backend take turns, --min-gap-ms apart', async () => {
    const home = tmp()
    const log = join(home, 'attempts.jsonl')
    for (const { code, err } of await runChildren(home, log, 'proxy', { minGapMs: 30 })) assert.equal(code, 0, err)
    const xs = intervals(log)
    assert.equal(xs.length, 8)
    assert.equal(new Set(xs.map((x) => x.pid)).size, 2)
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i].start >= xs[i - 1].end + 30, `attempt ${i} overlaps or is too close: ${JSON.stringify(xs.slice(i - 1, i + 1))}`)
    assert.ok(!existsSync(join(lockDir(home), 'proxy.lock')), 'the lock is released')
  })

  test('without a shared backend (--auth none) the processes are not serialized', async () => {
    const home = tmp()
    const log = join(home, 'attempts.jsonl')
    for (const { code, err } of await runChildren(home, log, 'none', { n: 2, holdMs: 400 })) assert.equal(code, 0, err)
    const xs = intervals(log)
    assert.ok(xs.some((x, i) => i > 0 && x.start < xs[i - 1].end), 'some attempts overlapped')
    assert.ok(!existsSync(lockDir(home)))
  })

  test('a lock left by a dead process is recovered', async () => {
    const home = tmp()
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
    mkdirSync(lockDir(home), { recursive: true })
    const lock = join(lockDir(home), 'keychain.lock')
    writeFileSync(lock, `${dead}\n`)
    const release = await acquireLock(lock, { pollMs: 10 })
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid))
    release()
    assert.ok(!existsSync(lock))
  })

  test('an empty lock (its creator died before writing its pid) is recovered once it is 5 s old', async () => {
    const home = tmp()
    mkdirSync(lockDir(home), { recursive: true })
    const lock = join(lockDir(home), 'proxy.lock')
    writeFileSync(lock, '')
    let got = false
    const p = acquireLock(lock, { pollMs: 10 }).then((release) => ((got = true), release))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(got, false, 'a fresh empty lock is one being written')
    const old = (Date.now() - 10_000) / 1000
    utimesSync(lock, old, old)
    const release = await p
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid))
    release()
    assert.ok(!existsSync(lock))
  })

  test('a lock held by a live process is waited for', async () => {
    const home = tmp()
    mkdirSync(lockDir(home), { recursive: true })
    const lock = join(lockDir(home), 'fd.lock')
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    writeFileSync(lock, `${holder.pid}\n`)
    let got = false
    const p = createPacer({ backend: 'fd', home, pollMs: 10 }).run(async () => (got = true))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(got, false)
    holder.kill()
    await p
    assert.equal(got, true)
  })
})
