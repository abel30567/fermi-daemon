import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { evaluate, outbound } from '../evals/lib/assertions.mjs'
import { validate } from '../evals/lib/json-schema.mjs'
import { assertLocalUrls, isLocalUrl } from '../evals/lib/net.mjs'
import { DRAIN_PROMPT, EVAL_OVERLAY, runAttempt } from '../evals/lib/runner.mjs'
import { loadPrompt } from '../lib/prompt.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'

const RUN = join(ROOT, 'evals/run.mjs')
const EXAMPLES = join(ROOT, 'evals/scenarios/examples')
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'evals/schema/results.schema.json'), 'utf8'))
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn10-'))
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))
const readTrace = (...p) => readFileSync(join(...p), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const GUARDED = ['FERMI_URL', 'MACOS_MCP_URL', 'SLACK_API_BASE', 'TELEGRAM_API_BASE', 'DISCORD_API_BASE', 'TWILIO_API_BASE', 'ANTHROPIC_API_BASE']
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra }
  for (const k of GUARDED) if (!(k in extra)) delete env[k]
  return env
}
// The runner as a CLI, with every non-loopback TCP connection made to throw.
const runCli = (args, env = {}) =>
  spawnSync(process.execPath, ['--import', PRELOAD, RUN, ...args], { cwd: ROOT, env: cleanEnv(env), encoding: 'utf8', timeout: 60_000 })

const REPLY = (text = 'ok') => [
  { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } },
  { tool: 'context_bootstrap', args: { channel: '${task.channel}', chat_id: '${task.chat_id}' } },
  { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text } },
  { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'r' } },
  { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } },
]
const scenario = (over = {}) => ({
  name: 'unit',
  fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
  inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
  expect: [{ called: 'channel_send' }],
  fake: { script: REPLY() },
  ...over,
})
const attempt = (s, opts = {}) => runAttempt({ scenario: s, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp(), ...opts })

describe('AC1: the examples run under the fake harness', () => {
  test('3 examples pass, the negative example is reported as a failure, exit 0', () => {
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--scenarios', `${EXAMPLES}/*`, '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const summary = readJson(out, 'summary.json')
    assert.equal(summary.attempts, 4)
    assert.equal(summary.passed, 3)
    assert.equal(summary.expectedFailures, 1)
    assert.deepEqual(summary.unexpected, [])
    assert.equal(summary.ok, true)
    for (const name of ['reply-contract', 'queue-isolation', 'phone-confirm-before-dial']) assert.equal(summary.byScenario[name].passes, 1, name)
    const neg = readJson(out, 'results.json').find((x) => x.scenario === 'negative-double-reply')
    assert.equal(neg.pass, false)
    assert.deepEqual(neg.failed.map((f) => Object.keys(f.assertion)[0]), ['exactlyOnce', 'outbox.count'])
    assert.match(r.stdout, /FAIL \(expected\) negative-double-reply/)
  })

  test('a failing assertion that was expected to pass fails the run (exit 1)', () => {
    const dir = tmp()
    const neg = readJson(EXAMPLES, 'negative-double-reply.json')
    delete neg.expectOutcome
    writeFileSync(join(dir, 'neg.json'), JSON.stringify(neg))
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--scenarios', join(dir, 'neg.json'), '--out', out])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    const summary = readJson(out, 'summary.json')
    assert.equal(summary.ok, false)
    assert.deepEqual(summary.unexpected, [{ scenario: 'negative-double-reply', attempt: 1, pass: false }])
  })

  test('-k repeats every scenario; shell-expanded paths work too', () => {
    const out = tmp()
    const r = runCli(['--harness', 'fake', '-k', '2', '--scenarios', join(EXAMPLES, 'reply-contract.json'), join(EXAMPLES, 'queue-isolation.json'), '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const results = readJson(out, 'results.json')
    assert.deepEqual(results.map((x) => `${x.scenario}#${x.attempt}`), ['reply-contract#1', 'reply-contract#2', 'queue-isolation#1', 'queue-isolation#2'])
  })
})

describe('AC2: fake harness, localhost only', () => {
  test('the runner passes under a non-loopback connection trap; its MCP config is the local fermi server', () => {
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--scenarios', join(EXAMPLES, 'reply-contract.json'), '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const mcp = readJson(out, 'reply-contract/1/mcp.json')
    assert.deepEqual(Object.keys(mcp.mcpServers), ['fermi']) // tools surface as mcp__fermi__*
    assert.ok(isLocalUrl(mcp.mcpServers.fermi.url))
  })

  test('the trap itself blocks a non-loopback connection', () => {
    const r = spawnSync(process.execPath, ['--import', PRELOAD, '-e', "require('node:net').connect(443, '192.0.2.1').on('error', () => {})"], { encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /localhost-only: blocked connection to 192\.0\.2\.1/)
  })

  test('the harness gets prompts/drain.md rendered with the eval overlay, only mcp__fermi__* tools and no claude.ai connectors', async () => {
    let seen
    const spy = { runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    const r = await attempt(scenario(), { harness: spy })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(seen.prompt, loadPrompt(DRAIN_PROMPT, EVAL_OVERLAY))
    assert.doesNotMatch(seen.prompt, /\{\{/)
    assert.deepEqual(seen.allowedTools, ['mcp__fermi__*'])
    assert.equal(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
  })
})

describe('AC3: results.json matches evals/schema/results.schema.json', () => {
  test('a full run validates', () => {
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--scenarios', `${EXAMPLES}/*`, '--out', out])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(validate(SCHEMA, readJson(out, 'results.json')), [])
  })

  test('the validator rejects a malformed entry', () => {
    const errs = validate(SCHEMA, [{ scenario: 'x', attempt: 0, pass: 'yes', extra: 1 }])
    assert.ok(errs.some((e) => /attempt: 0 < 1/.test(e)), errs.join('\n'))
    assert.ok(errs.some((e) => /pass: expected boolean/.test(e)))
    assert.ok(errs.some((e) => /missing failed/.test(e)))
    assert.ok(errs.some((e) => /unexpected property extra/.test(e)))
  })

  test('a runner error (bad --worker checkout) still yields a schema-valid failed result', () => {
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--worker', tmp(), '--scenarios', join(EXAMPLES, 'reply-contract.json'), '--out', out])
    assert.equal(r.status, 1)
    const [res] = readJson(out, 'results.json')
    assert.deepEqual(res.errorKinds, ['runner_error'])
    assert.match(res.failed[0].message, /no wrangler\.eval\.jsonc/)
    assert.deepEqual(validate(SCHEMA, [res]), [])
  })
})

describe('usage errors exit 2', () => {
  test('F2: a non-fake harness without --worker is refused instead of grading against the fake target', () => {
    const out = tmp()
    const r = runCli(['--harness', 'claude-code', '--scenarios', `${EXAMPLES}/*`, '--out', out])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /--harness claude-code needs --worker/)
    assert.equal(existsSync(join(out, 'results.json')), false)
  })

  test('F3: malformed scenario JSON is a clear error, not a stack trace', () => {
    const f = join(tmp(), 'x.json')
    writeFileSync(f, '{bad')
    const r = runCli(['--harness', 'fake', '--scenarios', f, '--out', tmp()])
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.ok(r.stderr.startsWith(`evals: ${f}: `), r.stderr)
    assert.doesNotMatch(r.stderr, /\n\s+at /)
  })
})

describe('AC4: refuses non-localhost URLs', () => {
  for (const [k, v] of [
    ['FERMI_URL', 'https://fermi.example.workers.dev'],
    ['SLACK_API_BASE', 'https://slack.com'],
    ['MACOS_MCP_URL', 'http://127.0.0.1.example.com:9000'],
  ]) {
    test(`${k}=${v} → exit 2 before anything starts`, () => {
      const out = join(tmp(), 'out')
      const r = runCli(['--harness', 'fake', '--scenarios', `${EXAMPLES}/*`, '--out', out], { [k]: v })
      assert.equal(r.status, 2)
      assert.match(r.stderr, new RegExp(`refusing to start: non-localhost URL\\(s\\) configured: ${k}=`))
      assert.equal(existsSync(out), false)
    })
  }

  test('a localhost FERMI_URL is allowed', () => {
    const r = runCli(['--harness', 'fake', '--scenarios', join(EXAMPLES, 'reply-contract.json'), '--out', tmp()], { FERMI_URL: 'http://127.0.0.1:8787' })
    assert.equal(r.status, 0, r.stderr)
  })

  test('assertLocalUrls', () => {
    for (const ok of ['http://127.0.0.1:1', 'http://localhost', 'https://localhost:8443/x', 'http://[::1]:9/mcp']) assert.equal(isLocalUrl(ok), true, ok)
    for (const bad of ['https://fermi.example.workers.dev', 'http://10.0.0.1', 'ftp://127.0.0.1', 'http://localhost.example.com', 'not a url'])
      assert.equal(isLocalUrl(bad), false, bad)
    assert.doesNotThrow(() => assertLocalUrls({ a: 'http://127.0.0.1:1', b: null }))
    assert.throws(() => assertLocalUrls({ mcp: 'https://fermi.example.workers.dev/mcp' }), /refusing to start.*mcp=/)
  })
})

describe('driver: faults, fakes and state', () => {
  test('an error fault answers the tool with isError and never reaches the target', async () => {
    const out = tmp()
    const s = scenario({ faults: { channel_send: { error: 'slack is down' } }, expect: [{ 'outbox.count': 0 }, { 'task.status': 'done' }] })
    const r = await attempt(s, { outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(r.errorKinds, ['tool_error'])
    const trace = readTrace(out, 'unit/1/trace.jsonl')
    assert.equal(trace.find((e) => e.type === 'tool_result' && !e.ok)?.content, 'slack is down')
    assert.deepEqual(readJson(out, 'unit/1/state.json').fakes.slack.map((c) => c.phase), ['inbound']) // only the webhook ack
  })

  test('a latency fault delays the call; maxLatencyMs catches it', async () => {
    const r = await attempt(scenario({ faults: { context_bootstrap: { latencyMs: 300 } }, expect: [{ maxLatencyMs: 200 }] }))
    assert.ok(r.latencyMs >= 300, String(r.latencyMs))
    assert.match(r.failed[0].message, /latency \d+ ms > 200 ms/)
  })

  test('the run is cut at the timeout', async () => {
    const r = await attempt(scenario({ faults: { context_bootstrap: { latencyMs: 2000 } } }), { timeoutMs: 200 })
    assert.ok(r.errorKinds.includes('timeout'), JSON.stringify(r))
    assert.ok(r.latencyMs < 1500, String(r.latencyMs))
  })

  test('F1: a timed-out attempt fails even when its assertions hold on the partial trace', async () => {
    const r = await attempt(scenario({ faults: { task_claim: { latencyMs: 2000 } }, expect: [{ notCalled: 'phone_call_start' }] }), { timeoutMs: 200 })
    assert.equal(r.pass, false, JSON.stringify(r))
    assert.ok(r.failed.some((f) => f.assertion === null && /timed out after 200 ms/.test(f.message)), JSON.stringify(r.failed))
  })

  test('F1: a turn_end with ok:false fails the attempt', async () => {
    const r = await attempt(scenario({ fake: {}, expect: [{ notCalled: 'phone_call_start' }] })) // no script → unknown_error
    assert.equal(r.pass, false, JSON.stringify(r))
    assert.ok(r.errorKinds.includes('unknown_error'))
    assert.ok(r.failed.some((f) => /harness turn ended with unknown_error: .*no script/.test(f.message)), JSON.stringify(r.failed))
  })

  test('the fake Mac bridge answers the model-switch curl and canned commands, and records them', async () => {
    const out = tmp()
    const curl = `curl -s -X POST http://127.0.0.1:8791/model -H 'content-type: application/json' -d '{"model":"opus"}'`
    const s = scenario({
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }], mac: [{ match: 'uptime', result: 'up 3 days' }] },
      fake: {
        script: [
          ...REPLY().slice(0, 4),
          { tool: 'mac_shell', args: { command: curl } },
          { tool: 'mac_shell', args: { command: 'curl -s http://127.0.0.1:8791/model' } },
          { tool: 'mac_shell', args: { command: 'uptime' } },
        ],
      },
      expect: [{ order: ['channel_send', 'task_complete', 'mac_shell'] }],
    })
    const r = await attempt(s, { outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    const state = readJson(out, 'unit/1/state.json')
    assert.deepEqual(state.fakes.macModel, { current: 'opus', switches: ['opus'] })
    assert.equal(state.fakes.mac.length, 3)
    const results = readTrace(out, 'unit/1/trace.jsonl').filter((e) => e.type === 'tool_result').map((e) => e.content)
    assert.deepEqual(results.slice(-3), ['{"ok":true,"model":"opus"}', '{"model":"opus"}', 'up 3 days'])
  })

  test("the webhook's own ack is recorded as inbound and not counted by outbox.count", async () => {
    const out = tmp()
    const r = await attempt(scenario({ expect: [{ 'outbox.count': 1 }] }), { outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    const slack = readJson(out, 'unit/1/state.json').fakes.slack
    assert.deepEqual(slack.map((c) => [c.phase, c.body.text]), [['inbound', 'Got it — working on it.'], ['drain', 'ok']])
  })

  test('a sender that is not allowlisted is never enqueued', async () => {
    const r = await attempt(scenario({ fixtures: {}, expect: [{ 'task.status': 'done' }] }))
    assert.match(r.failed[0].message, /no task matches/)
  })

  test('attachments arrive in the payload the way the bridges write them', async () => {
    const out = tmp()
    await attempt(scenario({ inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'what is this', attachment: { kind: 'image', file: 'x.jpg' } } }), { outDir: out })
    assert.match(readJson(out, 'unit/1/state.json').tasks[0].payload, /^what is this\n\[image attachment saved to .*\/media\/x\.jpg\]$/)
  })
})

describe('assertions', () => {
  const call = (name, input = {}) => ({ type: 'tool_call', name, input })
  const trace = [call('task_claim', { limit: 1 }), call('context_bootstrap'), call('channel_send', { chat_id: 'D1', text: 'Call +15555550100?' }), call('task_complete', { id: 't1' }), { type: 'text', text: 'done' }]
  const state = {
    tasks: [
      { id: 't1', channel: 'sl', chat_id: 'D1', status: 'done', queue: 'main' },
      { id: 'g', channel: 'sl', chat_id: 'D2', status: 'pending', queue: 'grok-bot' },
    ],
    outbox: [{ channel: 'wa', chat_id: 'w@s', body: '{"text":"hi"}' }],
    fakes: {
      slack: [{ method: 'POST', path: '/api/chat.postMessage', body: { channel: 'D1', text: 'Call +15555550100?' } }],
      telegram: [],
      discord: [{ method: 'POST', path: '/api/v10/channels/42/messages', body: { content: 'yo' } }],
    },
  }
  const sc = { inbound: { channel: 'sl', chat: 'D1' } }
  const check = (a) => evaluate([a], { trace, state, scenario: sc, latencyMs: 50 })
  const cases = [
    [{ called: 'channel_send' }, { called: 'phone_call_start' }],
    [{ notCalled: 'phone_call_start' }, { notCalled: 'channel_send' }],
    [{ exactlyOnce: 'channel_send' }, { exactlyOnce: 'mac_shell' }],
    [{ order: ['task_claim', 'channel_send', 'task_complete'] }, { order: ['task_complete', 'channel_send'] }],
    [{ argsMatch: { tool: 'channel_send', args: { chat_id: 'D1', text: '/\\+1555/' } } }, { argsMatch: { tool: 'channel_send', args: { text: '/^nope/' } } }],
    [{ argsMatch: { tool: 'task_claim', every: true, args: { queue: null } } }, { argsMatch: { tool: 'task_claim', args: { limit: null } } }],
    [{ 'outbox.count': 3 }, { 'outbox.count': { eq: 2, channel: 'sl' } }],
    [{ 'outbox.count': { min: 1, max: 1, chat_id: '42' } }, { 'outbox.count': { max: 0, channel: 'wa' } }],
    [{ 'task.status': 'done' }, { 'task.status': { queue: 'grok-bot', is: 'done' } }],
    [{ noSecretIn: ['sk-secret'] }, { noSecretIn: '+15555550100' }],
    [{ maxToolCalls: 4 }, { maxToolCalls: 3 }],
    [{ maxLatencyMs: 50 }, { maxLatencyMs: 49 }],
  ]
  for (const [pass, fail] of cases) {
    test(`${Object.keys(pass)[0]} ${JSON.stringify(Object.values(fail)[0])}`, () => {
      assert.deepEqual(check(pass), [], JSON.stringify(pass))
      assert.equal(check(fail).length, 1, JSON.stringify(fail))
    })
  }
  test('noSecretIn does not echo the secret', () => assert.doesNotMatch(check({ noSecretIn: '+15555550100' })[0].message, /5555550100/))
  test('outbound collects every channel', () => assert.deepEqual(outbound(state).map((m) => `${m.channel}:${m.chat_id}`), ['sl:D1', 'dc:42', 'wa:w@s']))
  test('scenario validation rejects unknown assertions and missing inbound fields', () => {
    const f = join(tmp(), 's.json')
    writeFileSync(f, JSON.stringify({ inbound: { channel: 'sl' }, expect: [{ calledd: 'x' }] }))
    assert.throws(() => loadScenario(f), /inbound needs.*bad assertion/)
  })
})
