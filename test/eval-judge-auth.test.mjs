// DMN-37: the judge's own auth (--judge-auth, independent of --auth), calibration once per
// process, and judge.mjs --regrade. Fake auth readers and fake judges only: no keychain, no proxy.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { CONFIG, semanticAsk } from '../evals/judge.mjs'
import { PROXY_URL, createAuth, createJudgeAuth } from '../evals/lib/auth.mjs'
import { validate } from '../evals/lib/json-schema.mjs'
import { NOT_REPLAYABLE, regradeRun } from '../evals/lib/regrade.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import { createSemanticJudge, fakeAsk, prepareSemantic } from '../evals/lib/semantic.mjs'
import * as fake from '../evals/harness/fake.mjs'

const RUN = join(ROOT, 'evals/run.mjs')
const JUDGE = join(ROOT, 'evals/judge.mjs')
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'evals/schema/results.schema.json'), 'utf8'))
const JOB = join(ROOT, 'evals/scenarios/core/job-no-promise-on-failure.json')
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn37-'))
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))
const GUARDED = ['FERMI_URL', 'MACOS_MCP_URL', 'SLACK_API_BASE', 'TELEGRAM_API_BASE', 'DISCORD_API_BASE', 'TWILIO_API_BASE', 'ANTHROPIC_API_BASE']
const cli = (file, args) => {
  const env = { ...process.env }
  for (const k of GUARDED) delete env[k]
  return spawnSync(process.execPath, ['--import', PRELOAD, file, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
}

describe('AC1: the judge has its own auth, independent of the harness --auth', () => {
  const readKeychain = () => 'kc-judge-token'
  const readProxyToken = () => 'proxy-harness-token'

  test('--auth proxy --judge-auth keychain: judge calls go through the keychain, harness calls through the proxy', async () => {
    const harnessAuth = createAuth({ mode: 'proxy', harness: 'claude-code', model: 'gpt-5-eval', readProxyToken })
    const judgeAuth = createJudgeAuth({ mode: 'keychain', harness: CONFIG.harness, model: CONFIG.model, harnessAuth, readKeychain, readProxyToken })
    const harnessCalls = []
    const harness = { ...fake, runOnce: (o) => (harnessCalls.push(o), fake.runOnce(o)) }
    const judgeCalls = []
    const ask = fakeAsk()
    const judgeHarness = {
      runOnce(o) {
        judgeCalls.push(o)
        const [, question, , text] = /^Question: (.*)\n(TEXT-[0-9a-f]{16})\n([\s\S]*?)\n\2\n/m.exec(o.prompt)
        return {
          done: ask({ question, text }).then((answer) => {
            const events = [{ type: 'text', text: answer }, { type: 'turn_end', ok: true, kind: 'ok' }]
            return { code: 0, outcome: events[1], events }
          }),
        }
      },
    }
    const semanticJudge = createSemanticJudge({ ask: semanticAsk({ harness: judgeHarness, auth: judgeAuth }) })
    const r = await runAttempt({ scenario: loadScenario(JOB), attempt: 1, harness, timeoutMs: 10_000, outDir: tmp(), auth: harnessAuth, semanticJudge })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(r.authMode, 'proxy')
    assert.equal(r.semantic[0].judge, 'pass')

    assert.equal(harnessCalls.length, 1)
    const [h] = harnessCalls
    assert.equal(h.env.ANTHROPIC_BASE_URL, PROXY_URL)
    assert.equal(h.env.ANTHROPIC_AUTH_TOKEN, 'proxy-harness-token')
    assert.equal(h.tokenPipe, undefined)

    assert.ok(judgeCalls.length >= 1)
    for (const j of judgeCalls) {
      assert.equal(j.model, CONFIG.model)
      assert.equal(j.tokenPipe, 'kc-judge-token')
      assert.equal(j.env.ANTHROPIC_BASE_URL, undefined)
      assert.equal(j.env.ANTHROPIC_AUTH_TOKEN, undefined)
      assert.doesNotMatch(JSON.stringify(j), /proxy-harness-token/)
    }
  })

  test('default: keychain on macOS for a Claude judge model, otherwise a clear error', () => {
    const base = { harness: CONFIG.harness, model: CONFIG.model, readKeychain: () => 'kc' }
    assert.equal(createJudgeAuth({ ...base, platform: 'darwin' }).mode, 'keychain')
    assert.equal(createJudgeAuth({ ...base, platform: 'darwin' }).attempt().tokenPipe, 'kc')
    assert.throws(() => createJudgeAuth({ ...base, platform: 'linux' }), /--judge-auth is required for judge model claude-opus-5-5 on linux .*CI passes --judge-auth fd/)
    assert.throws(() => createJudgeAuth({ ...base, model: 'gpt-5', platform: 'darwin' }), /--judge-auth is required for judge model gpt-5/)
    assert.throws(() => createJudgeAuth({ ...base, mode: 'bogus' }), /--judge-auth must be one of none, fd, keychain, proxy/)
    assert.throws(() => createJudgeAuth({ ...base, mode: 'keychain', harness: 'pi' }), /^Error: --judge-auth keychain needs --harness claude-code/)
  })

  test('--judge-auth fd shares the run\'s --auth fd token (an fd is read once); any other pairing is its own credential', () => {
    const harnessAuth = { mode: 'fd', attempt: () => ({ tokenPipe: 't', secrets: ['t'] }) }
    assert.equal(createJudgeAuth({ mode: 'fd', harness: CONFIG.harness, model: CONFIG.model, harnessAuth }), harnessAuth)
    const kc = createJudgeAuth({ mode: 'keychain', harness: CONFIG.harness, model: CONFIG.model, harnessAuth, readKeychain: () => 'kc' })
    assert.notEqual(kc, harnessAuth)
    assert.throws(() => createJudgeAuth({ mode: 'fd', harness: CONFIG.harness, model: CONFIG.model, env: {} }), /--judge-auth fd needs CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR/)
  })

  test('judge.mjs rejects a bad --judge-auth before any judge call', () => {
    const r = cli(JUDGE, ['--calibrate', '--judge-auth', 'bogus'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--judge-auth must be one of/)
  })
})

describe('calibration runs once per process, per judge model and calibration set', () => {
  const cases = [
    { question: 'Q?', text: 'a', answer: 'yes' },
    { question: 'Q?', text: 'b', answer: 'no' },
  ]
  const quiet = { log: () => {}, warn: () => {} }

  test('the same model and set calibrate once; another model or set calibrates again', async () => {
    let asked = 0
    const ask = async ({ text }) => (asked++, text === 'a' ? 'yes' : 'no')
    const model = `test-model-${process.pid}-${Date.now()}`
    const first = await prepareSemantic({ ask, model, cases, ...quiet })
    assert.equal(first.calibration.accuracy, 1)
    assert.equal(asked, 2)
    assert.equal(await prepareSemantic({ ask, model, cases, ...quiet }), first)
    assert.equal(asked, 2)
    await prepareSemantic({ ask, model: `${model}-b`, cases, ...quiet })
    assert.equal(asked, 4)
    await prepareSemantic({ ask, model, cases: [...cases, { question: 'Q?', text: 'c', answer: 'no' }], ...quiet })
    assert.equal(asked, 7)
    await prepareSemantic({ ask, cases, ...quiet }) // no model: never cached
    assert.equal(asked, 9)
  })
})

describe('AC2: --regrade re-grades a recorded run with the current assertions', () => {
  const FILES = [
    JOB,
    join(ROOT, 'evals/scenarios/core/job-no-promise-on-failure-neg.json'),
    join(ROOT, 'evals/scenarios/examples/reply-contract.json'),
    join(ROOT, 'evals/scenarios/credential-isolation/negative-echo-oauth-env.json'), // fails noCanaryLeak: not replayable, kept
  ]
  // A fixture results dir: a fake-harness run of FILES.
  const fixtureRun = () => {
    const out = tmp()
    const r = cli(RUN, ['--harness', 'fake', '--scenarios', ...FILES, '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return out
  }
  // FILES copied to a dir, `edit(name, scenario)` applied to each.
  const scenarioCopies = (edit = () => {}) => {
    const dir = tmp()
    for (const f of FILES) {
      const s = JSON.parse(readFileSync(f, 'utf8'))
      edit(basename(f, '.json'), s)
      writeFileSync(join(dir, basename(f)), JSON.stringify(s))
    }
    return join(dir, '*.json')
  }
  const strip = ({ regradedAt, assertionsVersion, ...r }) => r

  test('with unchanged assertions it reproduces every original grade, in results.json\'s schema plus regradedAt and assertionsVersion', () => {
    const out = fixtureRun()
    const r = cli(JUDGE, ['--regrade', out, '--fake', '--scenarios', scenarioCopies()])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /regraded 4 attempt\(s\), 0 changed, semantic judge enabled/)
    const original = readJson(out, 'results.json')
    const regraded = readJson(out, 'regraded.json')
    assert.deepEqual(regraded.map(strip), original)
    assert.deepEqual(validate(SCHEMA, regraded), [])
    for (const e of regraded) {
      assert.ok(!Number.isNaN(Date.parse(e.regradedAt)))
      assert.match(e.assertionsVersion, /^[0-9a-f]{12}$/)
    }
    const neg = regraded.find((e) => e.scenario === 'negative-echo-oauth-env')
    assert.equal(neg.pass, false)
    assert.ok(neg.failed.some((f) => f.assertion && NOT_REPLAYABLE.includes(Object.keys(f.assertion)[0])))
  })

  test('a modified assertion fixture changes the grades it touches, and only those', () => {
    const out = fixtureRun()
    const edited = scenarioCopies((name, s) => {
      if (name === 'reply-contract') s.expect.push({ notCalled: 'channel_send' })
      if (name === 'job-no-promise-on-failure') s.expect.find((a) => a.semantic).semantic.expect = 'yes'
    })
    const r = cli(JUDGE, ['--regrade', out, '--fake', '--scenarios', edited])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /regraded 4 attempt\(s\), 2 changed/)
    assert.match(r.stdout, /CHANGED reply-contract #1: PASS → FAIL .*channel_send/)
    assert.match(r.stdout, /CHANGED job-no-promise-on-failure #1: PASS → FAIL .*semantic: judge answered \["no"\]/)
    const original = readJson(out, 'results.json')
    const regraded = readJson(out, 'regraded.json')
    const by = (rs, n) => rs.find((e) => e.scenario === n)
    assert.equal(by(regraded, 'reply-contract').pass, false)
    assert.deepEqual(by(regraded, 'reply-contract').failed.map((f) => f.assertion), [{ notCalled: 'channel_send' }])
    assert.equal(by(regraded, 'job-no-promise-on-failure').semantic[0].judge, 'fail')
    for (const n of ['job-no-promise-on-failure-neg', 'negative-echo-oauth-env']) assert.deepEqual(strip(by(regraded, n)), by(original, n))
    assert.deepEqual(validate(SCHEMA, regraded), [])
  })

  test('invalid and runner-error attempts are kept as recorded; a scenario with no file is a usage error', async () => {
    const out = fixtureRun()
    const results = readJson(out, 'results.json')
    results[0] = { ...results[0], pass: null, status: 'invalid', invalidReason: 'rate_limit after 3 infra retries: x' }
    results[1] = { ...results[1], pass: false, errorKinds: ['runner_error'], failed: [{ assertion: null, message: 'boom' }] }
    writeFileSync(join(out, 'results.json'), JSON.stringify(results))
    const scenarios = Object.fromEntries(FILES.map(loadScenario).map((s) => [s.name, s]))
    const regraded = await regradeRun(out, scenarios, { judge: createSemanticJudge({ ask: fakeAsk() }) })
    assert.deepEqual(regraded.slice(0, 2).map(strip), results.slice(0, 2))
    await assert.rejects(regradeRun(out, {}), /no scenario file for /)
    const r = cli(JUDGE, ['--regrade', out, '--fake', '--scenarios', FILES[0]])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no scenario file for /)
  })

  test('without --scenarios, a scenario name two packs share is a usage error, not a guess', () => {
    const out = tmp()
    mkdirSync(join(out, 'phone-confirm-before-dial', '1'), { recursive: true })
    writeFileSync(join(out, 'results.json'), JSON.stringify([{ scenario: 'phone-confirm-before-dial', attempt: 1, pass: true, status: 'valid', failed: [], errorKinds: [] }]))
    const r = cli(JUDGE, ['--regrade', out, '--fake'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /scenario phone-confirm-before-dial is in more than one file: pass --scenarios/)
  })
})
