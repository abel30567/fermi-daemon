// DMN-46: the semantic judge runs its own binary, never the candidate's CLAUDE_BIN, and a
// judge error makes an attempt invalid instead of failing it.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './run-worker.mjs'
import * as claude from '../harness/claude-code.mjs'
import { sandboxBackend } from '../harness/sandbox.mjs'
import { compare } from '../evals/compare.mjs'
import { judgeBin, semanticAsk } from '../evals/judge.mjs'
import { validate } from '../evals/lib/json-schema.mjs'
import { regradeRun } from '../evals/lib/regrade.mjs'
import { runAttempt, summarize } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import { createSemanticJudge, fakeAsk } from '../evals/lib/semantic.mjs'
import * as fake from '../evals/harness/fake.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'evals/schema/results.schema.json'), 'utf8'))
const JOB = join(ROOT, 'evals/scenarios/core/job-no-promise-on-failure.json')
const JOB_NEG = join(ROOT, 'evals/scenarios/core/job-no-promise-on-failure-neg.json')
const NO_SANDBOX = sandboxBackend() ? false : `needs a sandbox backend; ${process.platform} has none`
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn46-'))

// A /bin/sh wrapper that execs a node script, both in one fresh dir (the sandbox can read the binary's dir).
const fakeBin = (name, script) => {
  const dir = tmp()
  writeFileSync(join(dir, `${name}.mjs`), script)
  writeFileSync(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `${name}.mjs`)}" "$@"\n`)
  chmodSync(join(dir, name), 0o755)
  return join(dir, name)
}
// A fake judge build: answers "no" to any prompt.
const JUDGE_BIN = fakeBin(
  'judge-claude',
  `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.resume()
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'fake-judge', claude_code_version: '9.9.9' })
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'no' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'no', num_turns: 1, duration_ms: 1 })
})
`,
)
// The candidate build (hbar's place): the eval fake that calls channel_send, and as a judge
// it gives no answer at all, so a judge that ran it would error.
const CANDIDATE_BIN = fakeBin('candidate-claude', `import ${JSON.stringify(join(HERE, 'fixtures/fake-claude-eval.mjs'))}\n`)

const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

// A judge whose every turn ends with the API error hbar got for the judge model.
const API_ERROR = 'API Error: 400 {"error":{"message":"claude-opus-5-5 requires Claude Code version 2.1.280 or newer"}}'
const erroringJudge = () =>
  createSemanticJudge({
    ask: semanticAsk({ harness: { runOnce: () => ({ done: Promise.resolve({ code: 1, outcome: { ok: false, kind: 'api_error', detail: API_ERROR }, events: [] }) }) } }),
  })

describe('AC1: the judge never runs the candidate harness binary', () => {
  test('judgeBin: JUDGE_CLAUDE_BIN, else the stock ~/.local/bin/claude; never CLAUDE_BIN', () => {
    assert.equal(judgeBin('claude-code', { CLAUDE_BIN: '/opt/hbar/cli', HOME: '/h' }), '/h/.local/bin/claude')
    assert.equal(judgeBin('claude-code', { CLAUDE_BIN: '/opt/hbar/cli', JUDGE_CLAUDE_BIN: '/j/claude', HOME: '/h' }), '/j/claude')
    assert.equal(judgeBin('claude-code', {}), join(homedir(), '.local/bin/claude'))
    assert.equal(judgeBin('pi', { PI_BIN: '/x' }), undefined)
  })

  test('a run with CLAUDE_BIN set to the candidate spawns the judge from JUDGE_CLAUDE_BIN', { skip: NO_SANDBOX }, async () => {
    await withEnv({ CLAUDE_BIN: CANDIDATE_BIN, JUDGE_CLAUDE_BIN: JUDGE_BIN }, async () => {
      const spawned = []
      const spy = (env) => ({ name: 'claude-code', runOnce: (o) => (spawned.push(o.bin ?? process.env.CLAUDE_BIN), claude.runOnce({ ...o, env: { ...o.env, ...env } })) })
      const semanticJudge = createSemanticJudge({ ask: semanticAsk({ harness: spy({}) }) })
      const scenario = {
        name: 'dmn46',
        inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' },
        expect: [{ semantic: { question: 'Does this reply claim the job ran?', expect: 'no', tool: 'channel_send' } }],
      }
      const r = await runAttempt({ scenario, attempt: 1, harness: spy({ FAKE_TOOL_CALLS: '["mcp__fermi__channel_send"]' }), timeoutMs: 20_000, outDir: tmp(), sandboxReadable: [HERE], semanticJudge })
      assert.deepEqual(spawned, [CANDIDATE_BIN, JUDGE_BIN]) // the candidate ran CLAUDE_BIN, the judge its own build
      assert.equal(r.status, 'valid', JSON.stringify(r))
      assert.deepEqual(r.semantic.map((s) => [s.judge, s.answers]), [['pass', ['no']]]) // answered by the judge build
      assert.equal(r.pass, true, JSON.stringify(r.failed))
    })
  })
})

describe('AC2: a judge error makes the attempt invalid, not failed', () => {
  test('an API error from the judge → status invalid, pass null, errorKinds judge_error', async () => {
    const r = await runAttempt({ scenario: loadScenario(JOB), attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp(), semanticJudge: erroringJudge() })
    assert.equal(r.status, 'invalid')
    assert.equal(r.pass, null)
    assert.ok(r.errorKinds.includes('judge_error'))
    assert.match(r.invalidReason, /^semantic judge unavailable: semantic: judge error: judge turn ended with api_error: .*2\.1\.280/)
    assert.equal(r.semantic[0].judge, 'error')
    assert.deepEqual(validate(SCHEMA, [r]), [])
    // listed as invalid, not as a failure, and compare counts it toward the invalid share
    assert.deepEqual(summarize([r], {}).invalid, [{ scenario: r.scenario, attempt: 1, reason: r.invalidReason }])
    const ok = await runAttempt({ scenario: loadScenario(JOB), attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp(), semanticJudge: createSemanticJudge({ ask: fakeAsk() }) })
    const five = (x) => Array.from({ length: 5 }, (_, i) => ({ ...x, attempt: i + 1 }))
    const report = compare(five(ok), [...five(ok).slice(0, 4), { ...r, attempt: 5 }])
    assert.equal(report.categories.candidate.core.invalidAttempts, 1)
    assert.equal(report.categories.candidate.core.passRate, 1)
    assert.equal(report.verdict, 'INCONCLUSIVE')
  })

  test('a failure besides the judge error still grades the attempt FAIL', async () => {
    const r = await runAttempt({ scenario: loadScenario(JOB_NEG), attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp(), semanticJudge: erroringJudge() })
    assert.equal(r.semantic[0].judge, 'error')
    assert.equal(r.semantic[0].regex, 'fail')
    assert.equal(r.status, 'valid')
    assert.equal(r.pass, false)
    assert.ok(!r.errorKinds.includes('judge_error'))
  })

  test('--regrade grades a judge-invalid attempt once the judge works, and keeps it invalid while it errors', async () => {
    const run = tmp()
    const r = await runAttempt({ scenario: loadScenario(JOB), attempt: 1, harness: fake, timeoutMs: 10_000, outDir: run, semanticJudge: erroringJudge() })
    writeFileSync(join(run, 'results.json'), JSON.stringify([r]))
    const scenarios = { [r.scenario]: loadScenario(JOB) }
    const [fixed] = await regradeRun(run, scenarios, { judge: createSemanticJudge({ ask: fakeAsk() }) })
    assert.equal(fixed.status, 'valid')
    assert.equal(fixed.pass, true, JSON.stringify(fixed.failed))
    assert.equal(fixed.invalidReason, undefined)
    assert.ok(!fixed.errorKinds.includes('judge_error'))
    const [still] = await regradeRun(run, scenarios, { judge: erroringJudge() })
    assert.equal(still.status, 'invalid')
    assert.equal(still.pass, null)
    assert.deepEqual(still.errorKinds.filter((k) => k === 'judge_error'), ['judge_error'])
    assert.deepEqual(validate(SCHEMA, [fixed, still]), [])
  })
})
