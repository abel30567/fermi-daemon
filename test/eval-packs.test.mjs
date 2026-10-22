// DMN-14: the breadth, faults, credential-isolation and endurance scenario packs,
// and the runner features they use (warm-session mode, HTTP-status / malformed-result
// faults, canned breadth tools, tokenFd, the leak / turn / drift assertions).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { evaluate } from '../evals/lib/assertions.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'

const RUN = join(ROOT, 'evals/run.mjs')
const PACKS = join(ROOT, 'evals/scenarios')
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn14-'))
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))
const readTrace = (...p) => readFileSync(join(...p), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const GUARDED = ['FERMI_URL', 'MACOS_MCP_URL', 'SLACK_API_BASE', 'TELEGRAM_API_BASE', 'DISCORD_API_BASE', 'TWILIO_API_BASE', 'ANTHROPIC_API_BASE']
const runCli = (args) => {
  const env = { ...process.env }
  for (const k of GUARDED) delete env[k]
  return spawnSync(process.execPath, ['--import', PRELOAD, RUN, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 180_000 })
}
const files = (pack) => readdirSync(join(PACKS, pack)).filter((f) => ['.json', '.yaml'].includes(extname(f))).map((f) => join(PACKS, pack, f))
const isControl = (f) => basename(f).startsWith('negative-')

const CLAIM = { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } }
const SEND = (text = 'ok') => ({ tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text } })
const DONE = { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'r' } }
const scenario = (over = {}) => ({
  name: 'unit',
  fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
  inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
  expect: [{ 'task.status': 'done' }],
  fake: { script: [CLAIM, SEND(), DONE, CLAIM] },
  ...over,
})
const attempt = (s, opts = {}) => runAttempt({ scenario: s, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp(), ...opts })

describe('AC1: breadth and fault packs with controls pass against the fake harness', () => {
  const packs = ['breadth', 'faults', 'credential-isolation']
  let out, r
  const run = () => (r ??= runCli(['--harness', 'fake', '--scenarios', ...packs.map((p) => `${PACKS}/${p}/*`), '--out', (out = tmp())]))

  test('every attempt ends as expected (exit 0)', () => {
    run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(readJson(out, 'summary.json').unexpected, [])
  })

  test('at least 20 breadth and fault scenarios, each with a negative control, and each control a real one', () => {
    const all = [...files('breadth'), ...files('faults')]
    const positives = all.filter((f) => !isControl(f)).map((f) => basename(f, '.json'))
    const controls = all.filter(isControl).map((f) => basename(f, '.json').replace(/^negative-/, ''))
    assert.ok(positives.length >= 20, `${positives.length} scenarios`)
    assert.deepEqual(controls.sort(), positives.sort())
  })

  test('each control fails on its own assertions, not a runner error, and each scenario passes', () => {
    run()
    for (const x of readJson(out, 'results.json')) {
      if (x.expectedOutcome === 'pass') assert.equal(x.pass, true, `${x.scenario}: ${JSON.stringify(x.failed)}`)
      else {
        assert.equal(x.pass, false, x.scenario)
        assert.ok(!x.errorKinds.includes('runner_error'), `${x.scenario}: ${JSON.stringify(x.failed)}`)
        assert.ok(x.failed.some((f) => f.assertion), `${x.scenario} failed on no assertion`)
      }
    }
  })

  test('the breadth pack covers every tool family in the ticket', () => {
    const called = new Set(files('breadth').flatMap((f) => loadScenario(f).fake.script.map((s) => s.tool)))
    for (const t of ['memory_write', 'memory_recall', 'profile_update', 'skill_load', 'search', 'session_search', 'fs_read', 'fs_write', 'connector_list', 'retriever_run', 'mac_screen_ocr', 'mac_file_search', 'browser_extract', 'cloud_agent_launch', 'phone_call_status', 'web_session_list', 'schedule_create', 'schedule_delete'])
      assert.ok(called.has(t), t)
  })

  test('credential isolation: critical, a fake token on the fd, noLeak on it, and every control leaks it', () => {
    run()
    const results = readJson(out, 'results.json')
    for (const f of files('credential-isolation')) {
      const s = loadScenario(f)
      assert.equal(s.category, 'credential-isolation', f)
      assert.equal(s.severity, 'critical', f)
      assert.ok(s.credentials?.token, f)
      assert.ok(s.expect.some((a) => a.noLeak?.includes(s.credentials.token)), `${f}: noLeak must name the fd token`)
      if (isControl(f)) assert.ok(results.find((x) => x.scenario === s.name).failed.some((x) => x.assertion?.noLeak), s.name)
    }
  })
})

describe('AC1: soak (weekly) against the fake harness', () => {
  test('soak.yaml: 200 tasks in one warm session pass in under 2 minutes; the overflow control fails', () => {
    const out = tmp()
    const t0 = Date.now()
    const r = runCli(['--harness', 'fake', '--weekly', '--scenarios', join(PACKS, 'endurance/soak.yaml'), join(PACKS, 'endurance/negative-soak-context-overflow.yaml'), '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const soak = readJson(out, 'results.json').find((x) => x.scenario === 'soak')
    assert.equal(soak.pass, true, JSON.stringify(soak.failed))
    assert.ok(soak.latencyMs < 120_000, String(soak.latencyMs))
    assert.ok(Date.now() - t0 < 120_000)
    assert.equal(soak.toolCalls.filter((t) => t === 'channel_send').length, 200)
    const ctl = readJson(out, 'results.json').find((x) => x.scenario === 'negative-soak-context-overflow')
    assert.deepEqual(ctl.failed.filter((f) => f.assertion).map((f) => Object.keys(f.assertion)[0]), ['noTurnKind', 'noErrorTurns', 'task.status', 'outbox.count'])
  })

  test('the soak is weekly only: skipped without --weekly', () => {
    const s = loadScenario(join(PACKS, 'endurance/soak.yaml'))
    assert.equal(s.schedule, 'weekly')
    assert.deepEqual(s.session, { tasks: 200 })
    for (const k of ['noTurnKind', 'noErrorTurns', 'latencyDrift']) assert.ok(s.expect.some((a) => k in a), k)
    const r = runCli(['--harness', 'fake', '--scenarios', `${PACKS}/endurance/*`, '--out', tmp()])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stdout, /skipping 3 weekly scenario\(s\).*pass --weekly/)
  })
})

describe('runner: faults', () => {
  test('a status fault is an HTTP 500 that the harness sees as a failed tool result, and the drain goes on', async () => {
    const out = tmp()
    const r = await attempt(scenario({ faults: { memory_recall: { status: 500 } }, fake: { script: [CLAIM, { tool: 'memory_recall', args: { query: 'x' } }, SEND(), DONE, CLAIM] } }), { outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(r.errorKinds, ['tool_error'])
    const bad = readTrace(out, 'unit/1/trace.jsonl').find((e) => e.type === 'tool_result' && !e.ok)
    assert.match(bad.content, /MCP HTTP 500/)
  })

  test('a result fault replaces the answer (not an error); times limits it to the first n calls', async () => {
    const out = tmp()
    const s = scenario({ faults: { task_claim: { result: '{"tasks":[{', times: 1 } }, fake: { script: [CLAIM, CLAIM, SEND(), DONE, CLAIM] }, expect: [{ 'task.status': 'done' }, { 'outbox.count': 1 }] })
    const r = await attempt(s, { outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    const claims = readTrace(out, 'unit/1/trace.jsonl').filter((e) => e.type === 'tool_result').slice(0, 2)
    assert.deepEqual(claims.map((e) => [e.ok, e.content.startsWith('{"tasks":[{"')]), [[true, false], [true, true]])
  })
})

describe('runner: warm-session mode', () => {
  const ERR = { apiError: { status: 429, text: 'API Error: 429 rate_limit_error' } }

  test('an error turn fails the attempt unless the session re-drains and recovers', async () => {
    const script = [{ ...CLAIM, onTurn: 1 }, { ...SEND(), onTurn: 1 }, { ...ERR, onTurn: 1 }, { ...DONE, onTurn: 2 }, { ...CLAIM, onTurn: 2 }]
    const once = await attempt(scenario({ session: {}, fake: { script } }))
    assert.equal(once.pass, false)
    assert.ok(once.failed.some((f) => /turn ended with rate_limit/.test(f.message)), JSON.stringify(once.failed))
    const retried = await attempt(scenario({ session: { redrain: 1 }, fake: { script }, expect: [{ 'task.status': 'done' }, { exactlyOnce: 'channel_send' }] }))
    assert.equal(retried.pass, true, JSON.stringify(retried.failed))
    assert.ok(retried.errorKinds.includes('rate_limit'))
  })

  test('tasks: n enqueues n messages, one drain turn each, in one session that keeps its context', async () => {
    const out = tmp()
    let sessions = 0
    const spy = { startSession: (o) => (sessions++, assert.equal(o.systemPrompt, readFileSync(join(ROOT, 'prompts/drain.md'), 'utf8')), fake.startSession(o)) }
    const s = scenario({
      session: { tasks: 3 },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'msg ${n}' },
      fake: { script: [CLAIM, { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text: 'turn ${turn}: ${task.payload}' } }, DONE, CLAIM] },
      expect: [{ 'task.status': 'done' }, { 'outbox.count': 3 }],
    })
    const r = await attempt(s, { outDir: out, harness: spy })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(sessions, 1)
    const sent = readJson(out, 'unit/1/state.json').fakes.slack.filter((c) => c.phase === 'drain').map((c) => c.body.text)
    assert.deepEqual(sent, ['turn 1: msg 1', 'turn 2: msg 2', 'turn 3: msg 3']) // the webhook acks stay out of the drain phase
  })

  test('the session is cut at the timeout', async () => {
    const r = await attempt(scenario({ session: { tasks: 5 }, fake: { script: [CLAIM, { sleepMs: 2000 }] } }), { timeoutMs: 300 })
    assert.ok(r.errorKinds.includes('timeout'), JSON.stringify(r))
    assert.equal(r.pass, false)
  })
})

describe('runner: tokenFd and the fake target breadth tools', () => {
  test('credentials.token reaches the harness on an fd; the fake harness can leak it as ${token}', async () => {
    let fdText
    const peek = (fd) => {
      const buf = Buffer.alloc(64)
      return buf.toString('utf8', 0, readSync(fd, buf, 0, 64, 0)) // positional: leaves the offset for the harness
    }
    const spy = { runOnce: (o) => ((fdText = peek(o.tokenFd)), fake.runOnce(o)) }
    const r = await attempt(scenario({ credentials: { token: 'tok-canary' }, fake: { script: [CLAIM, SEND('${token}'), DONE, CLAIM] }, expect: [{ noLeak: ['tok-canary'] }] }), { harness: spy })
    assert.equal(fdText, 'tok-canary')
    assert.match(r.failed[0].message, /1 value\(s\) leaked/)
  })

  test('surface tools answer from canned results (first match wins), mac_* reach the fake Mac, unknown tools fail', async () => {
    const out = tmp()
    const s = scenario({
      fixtures: {
        bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }],
        tools: [{ tool: 'fs_read', match: 'a\\.md', result: 'A' }, { tool: 'fs_read', result: { other: true } }],
        mac: [{ tool: 'mac_screen_ocr', result: 'screen text' }],
      },
      fake: { script: [{ tool: 'fs_read', args: { path: 'a.md' } }, { tool: 'fs_read', args: { path: 'b.md' } }, { tool: 'mac_screen_ocr' }, { tool: 'search', args: {} }, { tool: 'not_a_tool' }] },
      expect: [{ called: 'fs_read' }],
    })
    await attempt(s, { outDir: out })
    const res = readTrace(out, 'unit/1/trace.jsonl').filter((e) => e.type === 'tool_result').map((e) => [e.ok, e.content])
    assert.deepEqual(res, [[true, 'A'], [true, '{"other":true}'], [true, 'screen text'], [false, 'fake target: no canned result for search (add one to fixtures.tools)'], [false, 'unknown tool not_a_tool']])
  })
})

describe('assertions: noLeak, turns, drift', () => {
  const end = (ok, kind = ok ? 'ok' : 'api_error') => ({ type: 'turn_end', ok, kind, detail: '' })
  const check = (a, trace = [], extra = {}) => evaluate([a], { trace, state: { fakes: {} }, scenario: {}, latencyMs: 0, ...extra })
  test('noLeak sees tool results and turn details, which noSecretIn does not', () => {
    const trace = [{ type: 'tool_result', id: '1', ok: true, content: 'TOKEN=canary' }, { type: 'turn_end', ok: false, kind: 'auth', detail: 'bad canary' }]
    assert.equal(check({ noLeak: ['canary'] }, trace).length, 1)
    assert.equal(check({ noSecretIn: ['canary'] }, trace).length, 0)
    assert.equal(check({ noLeak: ['canary'] }, [], { state: { tasks: [{ result: 'canary' }] } }).length, 1)
    assert.doesNotMatch(check({ noLeak: ['canary'] }, trace)[0].message, /canary/)
  })
  test('noErrorTurns / noTurnKind', () => {
    assert.equal(check({ noErrorTurns: true }, [end(true), end(true)]).length, 0)
    assert.match(check({ noErrorTurns: true }, [end(true), end(false, 'rate_limit')])[0].message, /1 error turn\(s\): rate_limit/)
    assert.equal(check({ noTurnKind: 'context_overflow' }, [end(false, 'rate_limit')]).length, 0)
    assert.equal(check({ noTurnKind: 'context_overflow' }, [end(false, 'context_overflow')]).length, 1)
  })
  test('latencyDrift compares the p95 of the first and last window', () => {
    const lat = (first, last) => [...Array(50).fill(first), ...Array(50).fill(last)]
    const drift = { latencyDrift: { window: 50, maxPct: 25 } }
    assert.equal(check(drift, [], { taskLatencies: lat(100, 125) }).length, 0)
    assert.match(check(drift, [], { taskLatencies: lat(100, 126) })[0].message, /drifted 26\.0%/)
    assert.equal(check(drift, [], { taskLatencies: lat(100, 50) }).length, 0) // getting faster is not drift
    assert.match(check(drift, [], { taskLatencies: lat(1, 1).slice(1) })[0].message, /needs 100 tasks, got 99/)
  })
})

describe('scenario loader', () => {
  test('.yaml scenarios in JSON flow style load; block style is a clear error; schedule and session are validated', () => {
    const dir = tmp()
    const base = { inbound: { channel: 'sl', sender: 'U', chat: 'D', text: 't' }, expect: [{ called: 'x' }] }
    writeFileSync(join(dir, 'ok.yaml'), JSON.stringify({ ...base, schedule: 'weekly', session: { tasks: 2 } }))
    assert.equal(loadScenario(join(dir, 'ok.yaml')).name, 'ok')
    writeFileSync(join(dir, 'block.yaml'), 'inbound:\n  channel: sl\n')
    assert.throws(() => loadScenario(join(dir, 'block.yaml')), /JSON-compatible flow style/)
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...base, schedule: 'daily', session: { tasks: -1 } }))
    assert.throws(() => loadScenario(join(dir, 'bad.json')), /schedule must be "weekly".*session must be/)
  })
})
