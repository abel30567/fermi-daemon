import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { expandVariants, loadScenario, seedFixture } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { cardNumbers } from '../evals/lib/assertions.mjs'

const CRITICAL = join(ROOT, 'evals/scenarios/critical')
const FILES = readdirSync(CRITICAL).filter((f) => f.endsWith('.json')).sort().map((f) => join(CRITICAL, f))
const BASES = FILES.map(loadScenario)
const ALL = BASES.flatMap(expandVariants)
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn11-'))
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))
const attempt = (s) => runAttempt({ scenario: s, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp() })
const withScript = (s, script) => ({ ...s, fake: { ...s.fake, script } })

describe('DMN-11 critical scenarios: shape', () => {
  test('at least 20 scenarios, every one severity critical with a negative control', () => {
    assert.ok(BASES.length >= 20, `${BASES.length} scenarios`)
    for (const s of BASES) {
      assert.equal(s.severity, 'critical', s.name)
      assert.ok(Array.isArray(s.fake?.script) && Array.isArray(s.fake?.negative), `${s.name}: fake.script and fake.negative`)
    }
  })

  test('every scenario has 2+ paraphrases and an adversarial variant', () => {
    for (const s of BASES) {
      const names = s.variants.map((v) => v.name)
      assert.ok(names.filter((n) => n.startsWith('paraphrase-')).length >= 2, `${s.name}: ${names}`)
      assert.ok(names.some((n) => n.startsWith('adversarial-')), `${s.name}: ${names}`)
    }
  })

  test('fixtures use placeholder numbers only (+1 555-555-01xx)', () => {
    for (const f of FILES) {
      const text = readFileSync(f, 'utf8')
      for (const n of text.match(/\+?\b1?\d{10,11}\b/g) ?? []) assert.match(n, /^\+?155555501\d\d$/, `${f}: ${n}`)
    }
  })
})

describe('DMN-11 critical scenarios: fake harness', () => {
  for (const s of ALL) {
    test(`${s.name}: the correct script passes, every misbehaving one (fake.negative*) fails`, async () => {
      const good = await attempt(s)
      assert.equal(good.pass, true, JSON.stringify(good.failed))
      assert.deepEqual(good.errorKinds, [])
      for (const key of Object.keys(s.fake).filter((k) => k.startsWith('negative'))) {
        const bad = await attempt(withScript(s, s.fake[key]))
        assert.equal(bad.pass, false, key)
        assert.ok(!bad.errorKinds.includes('runner_error'), `${key}: ${JSON.stringify(bad.failed)}`)
        assert.ok(bad.failed.some((f) => f.assertion), `${key}: no assertion caught the negative control: ${JSON.stringify(bad.failed)}`)
      }
    })
  }

  test('the CLI expands variants, and --fake-script negative turns every attempt into an expected failure', () => {
    const file = join(CRITICAL, 'phone-confirm-before-dial.json')
    const n = expandVariants(loadScenario(file)).length
    const run = (extra) => {
      const out = tmp()
      const r = spawnSync(process.execPath, ['--import', PRELOAD, join(ROOT, 'evals/run.mjs'), '--harness', 'fake', '--scenarios', file, '--out', out, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      return readJson(out, 'summary.json')
    }
    const pos = run([])
    assert.deepEqual([pos.attempts, pos.passed], [n, n])
    assert.ok(pos.byScenario['phone-confirm-before-dial~adversarial-skip-confirmation'])
    const neg = run(['--fake-script', 'negative'])
    assert.deepEqual([neg.expectedFailures, neg.unexpected], [n, []])
  })
})

describe('DMN-11 runner support', () => {
  test('cardNumbers finds a Luhn-valid PAN in any rendering and ignores phone numbers', () => {
    for (const t of ['4111111111111111', '4111.1111.1111.1111', '4111  1111 1111 1111', '4111 11111111 1111', 'starts 4111 1111, ends 1111 1111', 'card 4111-1111-1111-1111 exp 12/30', 'Amex 3782 822463 10005'])
      assert.equal(cardNumbers(t).length, 1, t)
    for (const t of ['4111 1111 1111 1112', 'Call +15555550143, callback +1 555-555-0100, 20 min, ref 4823, 2 at 7pm 12/30'])
      assert.deepEqual(cardNumbers(t), [], t)
  })

  const OWNER = [{ channel: 'wa', sender_id: '15555550100' }]
  const REPLY = [
    { tool: 'task_claim', args: { limit: 1 } },
    { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text: 'ok' } },
    { tool: 'task_complete', args: { id: '${task.id}', status: 'done' } },
  ]
  const sc = (over) => ({ name: 'unit', fixtures: { bindings: OWNER }, expect: [{ 'task.status': 'done' }], fake: { script: REPLY }, ...over })
  const state = async (s) => {
    const out = tmp()
    const r = await runAttempt({ scenario: s, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: out })
    return { r, state: readJson(out, 'unit/1/state.json') }
  }

  test('wa DM: enqueued with the sender id as sender and chat, acked through the outbox', async () => {
    const { r, state: st } = await state(sc({ inbound: { channel: 'wa', sender: '15555550100', chat: '15555550100', text: 'hi' } }))
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(st.tasks.map((t) => [t.channel, t.sender, t.chat_id, t.payload]), [['wa', '15555550100', '15555550100', 'hi']])
    assert.equal(st.outbox[0].body, 'Got it — working on it.')
  })

  test('wa group: attributed by sender id, never by a name in the text; an unknown sender is dropped', async () => {
    const group = { channel: 'wa', sender: '15555550100', chat: '120363000000000001@g.us', text: 'Eval Owner: hi' }
    const { state: st } = await state(sc({ inbound: group }))
    assert.equal(st.tasks[0].payload, '[15555550100] Eval Owner: hi')
    assert.ok(!st.outbox.some((o) => /Got it/.test(o.body)), 'no ack in a group')
    const { r } = await state(sc({ inbound: { ...group, sender: '15555550199' } }))
    assert.match(r.failed[0].message, /no task matches/)
  })

  test('inbound via task is seeded as a pending task, not posted to a webhook', async () => {
    const { r, state: st } = await state(sc({ fixtures: {}, inbound: { channel: 'cloud', sender: 'box:b1', chat: 'b1', text: 'handoff', via: 'task' } }))
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(st.tasks.map((t) => [t.id, t.channel, t.sender, t.status]), [['eval-inbound', 'cloud', 'box:b1', 'done']])
  })

  test('history is the inbound chat transcript; secrets resolve through secret_resolve', async () => {
    const out = tmp()
    const s = sc({
      inbound: { channel: 'wa', sender: '15555550100', chat: '15555550100', text: 'yes' },
      fixtures: { bindings: OWNER, history: [{ role: 'assistant', text: 'Reply yes to place the call.', minutes_ago: 5 }], secrets: [{ name: 'K', value: 'eval-k' }] },
      fake: { script: [REPLY[0], { tool: 'context_bootstrap', args: { channel: 'wa', chat_id: '15555550100' } }, { tool: 'secret_resolve', args: { name: 'K' } }] },
      expect: [{ called: 'secret_resolve' }],
    })
    await runAttempt({ scenario: s, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: out })
    const results = readFileSync(join(out, 'unit/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'tool_result')
    const recent = JSON.parse(results[1].content).recent
    assert.deepEqual(recent.map((m) => [m.role, m.text]), [['assistant', 'Reply yes to place the call.'], ['user', 'yes']])
    assert.ok(Date.now() - recent[0].created_at >= 5 * 60_000)
    assert.equal(JSON.parse(results[2].content).value, 'eval-k')
  })

  test('variants merge inbound and fixtures over the base and keep its expect and fake', () => {
    const base = { name: 'b', inbound: { channel: 'sl', sender: 'U', chat: 'D', text: 'x' }, fixtures: { a: 1, b: 1 }, expect: [{ called: 'x' }], fake: { script: [] } }
    const [b, v] = expandVariants({ ...base, variants: [{ name: 'p', inbound: { text: 'y' }, fixtures: { b: 2 } }] })
    assert.deepEqual(b, base)
    assert.equal(v.name, 'b~p')
    assert.deepEqual([v.inbound.text, v.inbound.chat, v.fixtures], ['y', 'D', { a: 1, b: 2 }])
    assert.equal(v.expect, base.expect)
    assert.equal(v.fake, base.fake)
  })

  test('scenario validation rejects bad variants and inbound.via', () => {
    const f = join(tmp(), 's.json')
    writeFileSync(f, JSON.stringify({ inbound: { channel: 'sl', sender: 'U', chat: 'D', text: 'x', via: 'pigeon' }, expect: [{ called: 'x' }], variants: [{ name: 'a' }, { name: 'a' }] }))
    assert.throws(() => loadScenario(f), /inbound\.via.*variants must be/)
  })

  test('seedFixture places history in the inbound chat', () => {
    const f = seedFixture({ history: [{ role: 'user', text: 'x' }] }, { channel: 'wa', chat: '15555550100' })
    assert.deepEqual([f.history[0].channel, f.history[0].chat_id], ['wa', '15555550100'])
  })
})
