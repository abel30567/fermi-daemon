// DMN-38: after seeding, the runner reads every fixture section back through the eval
// target; one the worker dropped is a setup_error, never graded. summary.json records
// the --worker checkout's commit and dirty flag.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { compare, renderMarkdown } from '../evals/compare.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { validate } from '../evals/lib/json-schema.mjs'
import { startFakeTarget } from '../evals/lib/fake-target.mjs'
import { runAttempt, summarize } from '../evals/lib/runner.mjs'
import { seedFixture } from '../evals/lib/scenario.mjs'
import { missingSections } from '../evals/lib/seed-check.mjs'
import { workerCheckout } from '../evals/lib/wrangler-target.mjs'

const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'evals/schema/results.schema.json'), 'utf8'))
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn38-'))

// The phone confirmation the live run lost: the "yes" only means something with the history.
const scenario = {
  name: 'phone-yes',
  category: 'critical',
  fixtures: {
    bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }],
    memories: [{ kind: 'fact', body: 'The owner prefers calls before noon.' }],
    history: [
      { role: 'user', text: 'Call the dentist to move my appointment.', minutes_ago: 3 },
      { role: 'assistant', text: 'Reply yes to place the call to +15555550100.', minutes_ago: 2 },
    ],
  },
  inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes' },
  expect: [{ called: 'conversation_history' }],
  fake: {
    script: [
      { tool: 'task_claim', args: { limit: 1 } },
      { tool: 'conversation_history', args: { channel: '${task.channel}', chat_id: '${task.chat_id}' } },
      { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'r' } },
    ],
  },
}

// A stale worker: its eval-seed ignores the `conversation` block (pre-MCP-24).
const staleTarget = async (opts) => {
  const t = await startFakeTarget(opts)
  return { ...t, seed: ({ conversation, ...rest }) => t.seed(rest) }
}
const attempt = (opts = {}) => runAttempt({ scenario, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp(), ...opts })

describe('AC1: a seed section the worker dropped is a setup_error, not a graded failure', () => {
  test('a stale worker that drops `conversation` → status setup_error, pass null, the harness never runs', async () => {
    const outDir = tmp()
    const r = await attempt({ outDir, startTarget: staleTarget })
    assert.equal(r.status, 'setup_error')
    assert.equal(r.pass, null)
    assert.deepEqual(r.errorKinds, ['setup_error'])
    assert.equal(r.failed.length, 1)
    assert.match(r.failed[0].message, /conversation \(conversation_history sl\/D0EVAL\): 2\/2 missing/)
    assert.deepEqual(r.toolCalls, [])
    assert.equal(existsSync(join(outDir, 'phone-yes/1/trace.jsonl')), false)
    assert.deepEqual(validate(SCHEMA, [r]), [])

    const s = summarize([r], {})
    assert.deepEqual([s.passed, s.failed, s.unexpected, s.invalid, s.ok], [0, 0, [], [], false])
    assert.deepEqual(s.setupErrors, [{ scenario: 'phone-yes', attempt: 1, reason: r.failed[0].message }])
    assert.deepEqual([s.byScenario['phone-yes'].attempts, s.byScenario['phone-yes'].setupErrors], [0, 1])
  })

  test('the same scenario on a worker that keeps every section is graded normally', async () => {
    const r = await attempt()
    assert.equal(r.status, 'valid')
    assert.equal(r.pass, true, JSON.stringify(r.failed))
  })

  test('missingSections names each dropped section', () => {
    const f = seedFixture({ ...scenario.fixtures, profile: { agent: 'a', user: 'u' }, skills: [{ slug: 'call', body: '' }], tasks: [{ id: 't1', channel: 'sl', sender: 's', chat_id: 'c', payload: 'p' }] }, scenario.inbound)
    const full = {
      profile: { agent: 'a', user: 'u' },
      memories: [{ body: 'The owner prefers calls before noon.' }],
      skills: [{ slug: 'call' }],
      allowlist: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }],
      tasks: [{ id: 't1' }],
    }
    const history = f.conversation.history.map((t) => ({ role: t.role, body: t.text })) // the real worker's shape
    assert.deepEqual(missingSections(f, full, history), [])
    assert.deepEqual(missingSections(f, {}, []), [
      'profile: 2/2 missing',
      'memories: 1/1 missing',
      'skills: 1/1 missing',
      'allowlist: 1/1 missing',
      'tasks: 1/1 missing',
      'conversation (conversation_history sl/D0EVAL): 2/2 missing',
    ])
    assert.deepEqual(missingSections(f, full, history.slice(1)), ['conversation (conversation_history sl/D0EVAL): 1/2 missing'])
  })

  test('compare.mjs leaves setup errors out of every rate and reports their count', async () => {
    const good = await attempt()
    const bad = await attempt({ startTarget: staleTarget })
    const baseline = Array.from({ length: 5 }, (_, i) => ({ ...good, attempt: i + 1 }))
    const candidate = [...baseline, ...Array.from({ length: 3 }, (_, i) => ({ ...bad, attempt: 6 + i }))]
    const report = compare(baseline, candidate)
    const c = report.categories.candidate.critical
    assert.deepEqual([c.attempts, c.passes, c.passRate, c.setupErrorAttempts, c.invalidAttempts], [5, 5, 1, 3, 0])
    assert.equal(report.stats.candidate.attempts, 5)
    assert.match(renderMarkdown(report), /^Setup errors \(seed did not land, never graded\): baseline 0, candidate 3$/m)
  })
})

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=master', ...args], { cwd, encoding: 'utf8' }).trim()
function repo() {
  const dir = tmp()
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'README'), 'x\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const runCli = (args) => spawnSync(process.execPath, ['--import', PRELOAD, join(ROOT, 'evals/run.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })

describe('AC2: summary.json records the worker checkout', () => {
  test('workerCommit is the checkout HEAD and workerDirty its dirty flag', () => {
    const worker = repo()
    const head = git(worker, 'rev-parse', 'HEAD')
    const run = () => {
      const out = tmp()
      runCli(['--harness', 'fake', '--worker', worker, '--scenarios', join(ROOT, 'evals/scenarios/examples/reply-contract.json'), '--out', out])
      return JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    }
    let s = run()
    assert.deepEqual([s.workerCommit, s.workerDirty], [head, false])
    writeFileSync(join(worker, 'README'), 'changed\n')
    s = run()
    assert.deepEqual([s.workerCommit, s.workerDirty], [head, true])
  })

  test('without --worker (or outside git) both are null', async () => {
    const out = tmp()
    runCli(['--harness', 'fake', '--scenarios', join(ROOT, 'evals/scenarios/examples/reply-contract.json'), '--out', out])
    const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    assert.deepEqual([s.workerCommit, s.workerDirty], [null, null])
    assert.deepEqual(await workerCheckout(tmp()), { commit: null, dirty: null, behind: null })
  })

  test('a checkout behind origin/master is counted and warned about; no origin → behind null', async () => {
    const origin = repo()
    const worker = tmp()
    git(worker, 'clone', '-q', origin, '.')
    writeFileSync(join(origin, 'NEW'), 'y\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', 'ahead')
    assert.equal((await workerCheckout(worker)).behind, 1)
    assert.equal((await workerCheckout(origin)).behind, null)
    const r = runCli(['--harness', 'fake', '--worker', worker, '--scenarios', join(ROOT, 'evals/scenarios/examples/reply-contract.json'), '--out', tmp()])
    assert.match(r.stderr, /WARNING: --worker .* is 1 commit\(s\) behind origin\/master/)
  })
})
