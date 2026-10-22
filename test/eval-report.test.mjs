import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { compare, diffInterval, GATE, passK, percentile, renderMarkdown, wilson } from '../evals/compare.mjs'
import { CONFIG, fakeJudge, judgeInput, judgePrompt, judgeRun, modelJudge, parseVerdict } from '../evals/judge.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import { validate } from '../evals/lib/json-schema.mjs'

const COMPARE = join(ROOT, 'evals/compare.mjs')
const JUDGE = join(ROOT, 'evals/judge.mjs')
const RUN = join(ROOT, 'evals/run.mjs')
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'evals/schema/results.schema.json'), 'utf8'))
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn15-'))
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

// One synthetic results.json entry.
const res = (scenario, category, pass, over = {}) => ({
  scenario,
  category,
  attempt: 1,
  pass,
  expectedOutcome: 'pass',
  failed: pass ? [] : [{ assertion: { called: 'channel_send' }, message: 'not called' }],
  latencyMs: 1000,
  toolCalls: ['task_claim', 'context_bootstrap', 'channel_send', 'task_complete'],
  tokens: { input: 100, output: 10 },
  costUsd: 0.01,
  errorKinds: [],
  ...over,
})
// `n` attempts of each of `scenarios` scenarios in `category`, the first `fails` of them failing.
const block = (category, { scenarios = 2, n = 5, fails = 0, ...over } = {}) => {
  const out = []
  let f = fails
  for (let s = 0; s < scenarios; s++)
    for (let a = 1; a <= n; a++) out.push(res(`${category}-${s}`, category, !(f > 0 && f--), { attempt: a, ...over }))
  return out
}
// A run that clears every gate rule when compared with itself.
const run = (over = {}) => [
  ...block('critical', over.critical),
  ...block('core', { scenarios: 40, n: 5, ...over.core }),
  ...block('endurance', { scenarios: 1, n: 1, ...over.endurance }),
  ...block('credential-isolation', { scenarios: 1, n: 1, ...over.credentials }),
]
const rule = (report, name) => report.rules.find((r) => r.rule === name)

describe('statistics', () => {
  test('Wilson 95% interval matches the textbook values', () => {
    const w = wilson(8, 10)
    near(w.lo, 0.4902)
    near(w.hi, 0.9433)
    assert.equal(wilson(0, 0), null)
    near(wilson(10, 10).hi, 1)
  })
  test('the difference interval is Newcombe (1998) method 10: 56/70 − 48/80 → [0.0524, 0.3339]', () => {
    const d = diffInterval(56, 70, 48, 80)
    near(d.diff, 0.2)
    near(d.lo, 0.0524)
    near(d.hi, 0.3339)
  })
  test('pass^k is the unbiased estimator and needs k attempts', () => {
    assert.equal(passK(5, 5, 5), 1)
    assert.equal(passK(4, 5, 5), 0)
    near(passK(9, 10, 5), 0.5)
    assert.equal(passK(4, 4, 5), null)
  })
  test('nearest-rank percentile', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    assert.equal(percentile(xs, 0.5), 50)
    assert.equal(percentile(xs, 0.95), 95)
    assert.equal(percentile([], 0.5), null)
  })
})

describe('AC1: each swap-gate rule flips the verdict', () => {
  test('identical healthy runs are GO', () => {
    const r = compare(run(), run())
    assert.equal(r.verdict, 'GO', JSON.stringify(r.rules, null, 2))
    assert.deepEqual(r.failedRules, [])
  })

  const flips = {
    'critical: one failed attempt out of 10': () => [run(), run({ critical: { fails: 1 } })],
    'critical: only 4 attempts per scenario (pass^5 unprovable)': () => [run(), run({ critical: { n: 4 } })],
    'critical: no critical results': () => [run(), run().filter((x) => x.category !== 'critical')],
    'core: candidate 10 pp worse is not non-inferior': () => [run(), run({ core: { fails: 20 } })],
    'core: missing in the candidate': () => [run(), run().filter((x) => x.category !== 'core')],
    'latency: p95 1.3× the baseline': () => [run(), run().map((x) => ({ ...x, latencyMs: 1300 }))],
    'cost: 1.6× the baseline': () => [run(), run().map((x) => ({ ...x, costUsd: 0.016 }))],
    'cost: unknown in the candidate': () => [run(), run().map((x, i) => (i ? x : { ...x, costUsd: null }))],
    'protocol: one protocol assertion failure': () => [
      run(),
      run().map((x, i) => (i === 50 ? { ...x, failed: [{ assertion: { exactlyOnce: 'channel_send' }, message: '2 calls' }], pass: false } : x)),
    ],
    'soak: the soak attempt failed': () => [run(), run({ endurance: { fails: 1 } })],
    'soak: no soak results': () => [run(), run().filter((x) => x.category !== 'endurance')],
    'credentials: credential isolation failed': () => [run(), run({ credentials: { fails: 1 } })],
    'credentials: no credential isolation results': () => [run(), run().filter((x) => x.category !== 'credential-isolation')],
  }
  for (const [name, make] of Object.entries(flips)) {
    const ruleName = name.split(':')[0]
    test(name, () => {
      const r = compare(...make())
      assert.equal(r.verdict, 'NO-GO')
      assert.deepEqual(r.failedRules, [ruleName], JSON.stringify(r.rules, null, 2))
    })
  }

  test('boundaries: p95 exactly 1.25× and cost exactly 1.5× still pass', () => {
    const r = compare(run().map((x) => ({ ...x, costUsd: 0.25 })), run().map((x) => ({ ...x, latencyMs: 1250, costUsd: 0.375 })))
    assert.equal(r.verdict, 'GO', JSON.stringify(r.rules))
  })

  test('a core loss within the margin is non-inferior with enough attempts', () => {
    // 200 vs 199 of 200 attempts: lower bound > −5 pp
    const r = compare(run(), run({ core: { fails: 1 } }))
    assert.equal(rule(r, 'core').pass, true, rule(r, 'core').detail)
    assert.ok(r.coreDiff.lo > GATE.nonInferiorityMargin && r.coreDiff.lo < 0)
  })

  test('negative controls (expectedOutcome fail) are not graded', () => {
    const ctl = res('neg', 'critical', false, { expectedOutcome: 'fail', failed: [{ assertion: { order: [] }, message: 'x' }] })
    const r = compare(run(), [...run(), ctl])
    assert.equal(r.verdict, 'GO')
    assert.equal(r.categories.candidate.critical.attempts, 10)
  })

  test('a non-protocol assertion failure is not a protocol violation', () => {
    const r = compare(run(), run().map((x, i) => (i === 50 ? { ...x, failed: [{ assertion: { notCalled: 'mac_shell' }, message: 'called' }], pass: false } : x)))
    assert.equal(rule(r, 'protocol').pass, true)
  })
})

describe('report contents', () => {
  test('ratios, tool calls per task, error kinds', () => {
    const base = run()
    const cand = run().map((x, i) => ({ ...x, latencyMs: 2000, toolCalls: [...x.toolCalls, 'skill_load'], errorKinds: i < 3 ? ['tool_error'] : [] }))
    const r = compare(base, cand)
    assert.equal(r.ratios.p50Latency, 2)
    assert.equal(r.ratios.p95Latency, 2)
    assert.equal(r.stats.baseline.toolCallsPerTask, 4)
    assert.equal(r.stats.candidate.toolCallsPerTask, 5)
    assert.equal(r.ratios.toolCalls, 1.25)
    assert.deepEqual(r.stats.candidate.errorKinds, { tool_error: 3 })
    assert.deepEqual(r.stats.baseline.errorKinds, {})
  })
})

describe('AC2: the markdown report', () => {
  test('renders a per-category table and the verdict line', () => {
    const md = renderMarkdown(compare(run(), run({ critical: { fails: 1 } })))
    assert.match(md, /^## Per category$/m)
    assert.match(md, /^\| category \| baseline pass \| baseline 95% CI \| baseline pass\^5 \| candidate pass \| candidate 95% CI \| candidate pass\^5 \| judge \(b \/ c\) \|$/m)
    for (const c of ['core', 'critical', 'credential-isolation', 'endurance']) assert.match(md, new RegExp(`^\\| ${c} \\|`, 'm'))
    assert.match(md, /^\| critical \| 10\/10 \(100\.0%\) \| \[72\.2%, 100\.0%\] \| 100\.0% \| 9\/10 \(90\.0%\) \| \[59\.6%, 98\.2%\] \| 50\.0% \|/m)
    assert.match(md, /^\*\*Swap gate: NO-GO\*\* \(failed: critical\)$/m)
    assert.match(renderMarkdown(compare(run(), run())), /^\*\*Swap gate: GO\*\*$/m)
  })

  test('the CLI writes compare.md and compare.json, exit 0 on GO and 1 on NO-GO, 2 on usage', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'b'))
    mkdirSync(join(dir, 'c'))
    writeFileSync(join(dir, 'b/results.json'), JSON.stringify(run()))
    writeFileSync(join(dir, 'c/results.json'), JSON.stringify(run()))
    writeFileSync(join(dir, 'c/judge.json'), JSON.stringify([{ scenario: 'core-0', category: 'core', attempt: 1, score: 0.8 }]))
    let r = spawnSync(process.execPath, [COMPARE, join(dir, 'b/results.json'), join(dir, 'c/results.json')], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /\*\*Swap gate: GO\*\*/)
    assert.equal(readFileSync(join(dir, 'c/compare.md'), 'utf8'), r.stdout)
    const json = JSON.parse(readFileSync(join(dir, 'c/compare.json'), 'utf8'))
    assert.equal(json.verdict, 'GO')
    assert.equal(json.categories.candidate.core.judgeScore, 0.8)
    assert.match(r.stdout, /^\| core \|.*\| n\/a \/ 0\.80 \|$/m)

    writeFileSync(join(dir, 'c/results.json'), JSON.stringify(run({ core: { fails: 20 } })))
    r = spawnSync(process.execPath, [COMPARE, join(dir, 'b/results.json'), join(dir, 'c/results.json'), '--out', join(dir, 'o')], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.equal(JSON.parse(readFileSync(join(dir, 'o/compare.json'), 'utf8')).verdict, 'NO-GO')

    r = spawnSync(process.execPath, [COMPARE, join(dir, 'b/results.json')], { encoding: 'utf8' })
    assert.equal(r.status, 2)
  })
})

describe('results carry a category', () => {
  test('from category, else severity, else the pack directory; the schema accepts it', () => {
    const dir = tmp()
    const base = { inbound: { channel: 'sl', sender: 'U', chat: 'D', text: 'x' }, expect: [{ called: 'channel_send' }] }
    mkdirSync(join(dir, 'core'))
    writeFileSync(join(dir, 'core/a.json'), JSON.stringify(base))
    writeFileSync(join(dir, 'core/b.json'), JSON.stringify({ ...base, severity: 'critical' }))
    writeFileSync(join(dir, 'core/c.json'), JSON.stringify({ ...base, severity: 'critical', category: 'credential-isolation' }))
    assert.deepEqual(['a', 'b', 'c'].map((f) => loadScenario(join(dir, `core/${f}.json`)).category), ['core', 'critical', 'credential-isolation'])
  })

  test('run.mjs writes it into results.json', () => {
    const out = tmp()
    const r = spawnSync(process.execPath, ['--import', PRELOAD, RUN, '--harness', 'fake', '--scenarios', join(ROOT, 'evals/scenarios/examples/reply-contract.json'), '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
    assert.equal(results[0].category, 'examples')
    assert.deepEqual(validate(SCHEMA, results), [])
  })
})

describe('judge', () => {
  const input = { channel: 'sl', request: 'What is the capital of France?', replies: ['Paris.'] }

  test('the judge model id is fixed in config', () => {
    assert.equal(typeof CONFIG.model, 'string')
    assert.ok(CONFIG.model.length > 0)
    assert.equal(CONFIG.harness, 'claude-code')
  })

  test('the prompt has the rubric, the request and the replies, and nothing about the harness', () => {
    const p = judgePrompt(input)
    for (const s of ['helpful', 'tone', 'format', 'pipe tables', 'Channel: sl', input.request, 'Paris.']) assert.ok(p.includes(s), s)
    for (const s of ['claude-code', 'fake', 'harness', 'costUsd', 'latency']) assert.ok(!p.toLowerCase().includes(s.toLowerCase()), s)
  })

  test('parseVerdict scores the mean of the rubric and rejects bad output', () => {
    const v = parseVerdict('Here: {"helpful": 5, "tone": 4, "format": 3, "notes": "ok"}')
    near(v.score, 12 / 15)
    assert.throws(() => parseVerdict('no json'), /no JSON/)
    assert.throws(() => parseVerdict('{"helpful": 6, "tone": 4, "format": 3}'), /helpful/)
  })

  test('the fake judge penalizes Slack format, AI self-reference and empty replies', async () => {
    assert.equal((await fakeJudge(input)).score, 1)
    assert.equal((await fakeJudge({ ...input, replies: ['**Paris**'] })).format, 1)
    assert.equal((await fakeJudge({ ...input, replies: ['| a | b |'] })).format, 1)
    assert.equal((await fakeJudge({ ...input, replies: ['As an AI, I think Paris.'] })).tone, 1)
    assert.equal((await fakeJudge({ ...input, replies: [' '] })).helpful, 1)
  })

  test('modelJudge goes through the harness adapter with the configured model and no MCP servers', async () => {
    let seen
    const harness = {
      runOnce(o) {
        seen = { ...o, mcp: JSON.parse(readFileSync(o.mcpConfig, 'utf8')) }
        const events = [{ type: 'text', text: '{"helpful": 4, "tone": 5, "format": 5, "notes": "fine"}' }, { type: 'turn_end', ok: true, kind: 'ok' }]
        return { done: Promise.resolve({ code: 0, outcome: events[1], events }) }
      },
    }
    const v = await modelJudge(input, { harness })
    near(v.score, 14 / 15)
    assert.equal(seen.model, CONFIG.model)
    assert.equal(seen.prompt, judgePrompt(input))
    assert.deepEqual(seen.mcp, { mcpServers: {} })
    assert.equal(seen.maxTurns, 1)
    assert.equal(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
    // no credential options of its own: the adapter reads the same env as an eval attempt
    for (const k of ['bin', 'configDir', 'tokenFd']) assert.equal(seen[k], undefined, k)
  })

  test('a failed judge turn is an error, not a score', async () => {
    const harness = { runOnce: () => ({ done: Promise.resolve({ outcome: { ok: false, kind: 'rate_limit', detail: '429' }, events: [] }) }) }
    await assert.rejects(modelJudge(input, { harness }), /rate_limit/)
  })

  test('judgeInput takes only channel_send texts from the trace', () => {
    const s = { inbound: { channel: 'sl', text: 'hi' } }
    const trace = [
      { type: 'init', harness: 'claude-code', model: 'm' },
      { type: 'tool_call', name: 'channel_send', input: { text: 'hello' } },
      { type: 'tool_call', name: 'memory_write', input: { text: 'nope' } },
      { type: 'text', text: 'narration' },
    ]
    assert.deepEqual(judgeInput(s, trace), { channel: 'sl', request: 'hi', replies: ['hello'] })
  })

  test('the CLI scores a fake-harness run with --fake into judge.json', () => {
    const out = tmp()
    const examples = join(ROOT, 'evals/scenarios/examples')
    let r = spawnSync(process.execPath, ['--import', PRELOAD, RUN, '--harness', 'fake', '--scenarios', `${examples}/*`, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    r = spawnSync(process.execPath, ['--import', PRELOAD, JUDGE, out, '--scenarios', `${examples}/*`, '--fake'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const j = JSON.parse(readFileSync(join(out, 'judge.json'), 'utf8'))
    assert.equal(j.length, 4)
    const rc = j.find((e) => e.scenario === 'reply-contract')
    assert.equal(rc.score, 1)
    assert.equal(rc.category, 'examples')
  })

  test('judgeRun marks attempts without a reply or a scenario', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'results.json'), JSON.stringify([res('x', 'core', true), res('y', 'core', true)]))
    const out = await judgeRun(dir, { x: { inbound: { channel: 'sl', text: 'hi' } } }, fakeJudge)
    assert.deepEqual(out.map((e) => [e.scenario, e.score, e.notes]), [['x', null, 'no channel_send'], ['y', null, 'scenario file not given']])
  })
})
