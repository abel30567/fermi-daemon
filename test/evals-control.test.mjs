import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { sandboxBackend } from '../harness/sandbox.mjs'
import { evaluate } from '../evals/lib/assertions.mjs'
import { DRAIN_PROMPT, EVAL_ALLOWED_TOOLS, EVAL_OVERLAY, runAttempt } from '../evals/lib/runner.mjs'
import { loadPrompt } from '../lib/prompt.mjs'
import { expandScenarios, isNegativeControl, loadScenario, webhookRequest } from '../evals/lib/scenario.mjs'
import { TURNS } from '../evals/lib/session.mjs'
import * as fake from '../evals/harness/fake.mjs'

const RUN = join(ROOT, 'evals/run.mjs')
const CONTROL = join(ROOT, 'evals/scenarios/control')
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn13-'))
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))
const readTrace = (...p) => readFileSync(join(...p), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const GUARDED = ['FERMI_URL', 'MACOS_MCP_URL', 'SLACK_API_BASE', 'TELEGRAM_API_BASE', 'DISCORD_API_BASE', 'TWILIO_API_BASE', 'ANTHROPIC_API_BASE']
const runCli = (args) => {
  const env = { ...process.env }
  for (const k of GUARDED) delete env[k]
  return spawnSync(process.execPath, ['--import', PRELOAD, RUN, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
}

// For each negative control, the assertions the scripted misbehaviour must trip.
const NEGATIVES = {
  'cancelled-by-user-negative': ['task.status', 'argsMatch', 'outbox.count', 'argsMatch'],
  'model-switch-ordering-negative': ['order'],
  'emergency-stop-mid-task-negative': ['task.status', 'argsMatch', 'argsMatch', 'notCalled'],
  'teams-reply-shell-negative': ['exactlyOnce', 'argsMatch', 'notCalled', 'notCalled', 'teams.count'],
  'audio-transcribe-negative': ['argsMatch', 'order'],
  'deferred-schedule-list-negative': ['order'],
  'ask-instead-of-grind-negative': ['exactlyOnce', 'argsMatch', 'notCalled', 'maxToolCalls'],
}

describe('DMN-13 AC1: the control pack passes against the fake harness, every scenario with a negative control', () => {
  // teams-reply-shell really runs tools/teams-send.sh, which needs the OS sandbox.
  const NO_SANDBOX = sandboxBackend() ? false : `needs an OS sandbox; ${process.platform} has none`
  test('7 scenarios pass and their 7 negative controls fail on the intended assertions, exit 0', { skip: NO_SANDBOX }, () => {
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--scenarios', `${CONTROL}/*`, '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const summary = readJson(out, 'summary.json')
    assert.equal(summary.attempts, 14)
    assert.equal(summary.passed, 7)
    assert.equal(summary.expectedFailures, 7)
    assert.deepEqual(summary.unexpected, [])
    assert.deepEqual(summary.skipped, [])
    const results = readJson(out, 'results.json')
    for (const res of results) {
      const neg = NEGATIVES[res.scenario]
      if (!neg) {
        assert.equal(res.pass, true, `${res.scenario}: ${JSON.stringify(res.failed)}`)
        assert.ok(NEGATIVES[`${res.scenario}-negative`], `${res.scenario} has no negative control`)
        assert.deepEqual(res.errorKinds, [], res.scenario)
        continue
      }
      assert.equal(res.pass, false, res.scenario)
      assert.deepEqual(res.failed.map((f) => Object.keys(f.assertion ?? {})[0]), neg, `${res.scenario}: ${JSON.stringify(res.failed)}`)
    }
  })

  test('each negative control is its scenario with only the fake script changed', () => {
    for (const neg of Object.keys(NEGATIVES)) {
      const { name: _n, description: _d, expectOutcome, fake: badFake, ...bad } = readJson(CONTROL, `${neg}.json`)
      const { name: _m, description: _e, fake: goodFake, ...good } = readJson(CONTROL, `${neg.replace(/-negative$/, '')}.json`)
      assert.equal(expectOutcome, 'fail', neg)
      assert.deepEqual(bad, good, neg)
      assert.notDeepEqual(badFake, goodFake, neg)
    }
  })
})

describe('session mode (evals/lib/session.mjs)', () => {
  test('emergency stop: the turn is interrupted after the in-flight tool, cleanup and a later turn run in the same session', async () => {
    const out = tmp()
    const scenario = loadScenario(join(CONTROL, 'emergency-stop-mid-task.json'))
    const r = await runAttempt({ scenario, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    const trace = readTrace(out, scenario.name, '1', 'trace.jsonl')
    const ends = trace.filter((e) => e.type === 'turn_end')
    assert.deepEqual(ends.map((e) => [e.ok, e.interrupted ?? false]), [[false, true], [true, false], [true, false]])
    assert.equal(trace.filter((e) => e.type === 'init').length, 1) // one session, not three
    // The steps scripted after the interrupted call never ran.
    const first = trace.slice(0, trace.indexOf(ends[0]))
    assert.equal(first.at(-1).type, 'tool_result')
    assert.ok(!first.some((e) => e.type === 'tool_call' && e.name === 'task_complete'))
    assert.deepEqual(trace.filter((e) => e.type === 'text').map((e) => e.text), ['OK'])
  })

  test('the session gets the rendered drain.md as its system prompt and the warm-worker turn texts in order', async () => {
    const seen = { sends: [] }
    const spy = {
      startSession: (o) => {
        seen.opts = o
        const s = fake.startSession(o)
        const send = s.send
        s.send = (text) => (seen.sends.push(text), send(text))
        return s
      },
    }
    const scenario = loadScenario(join(CONTROL, 'emergency-stop-mid-task.json'))
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(seen.opts.systemPrompt, loadPrompt(DRAIN_PROMPT, EVAL_OVERLAY))
    assert.deepEqual(seen.opts.allowedTools, EVAL_ALLOWED_TOOLS)
    assert.deepEqual(seen.sends, [TURNS.drain(), TURNS.stop(scenario.inbound), TURNS.keepalive()])
    assert.match(seen.sends[1], /channel "sl" chat_id "D0EVAL"/)
  })

  test('a session that dies before a turn fails the attempt', async () => {
    const dying = {
      startSession: () => {
        const events = new EventEmitter()
        let alive = true
        return {
          events,
          get alive() {
            return alive
          },
          send: () => {
            setImmediate(() => {
              events.emit('event', { type: 'turn_end', ok: true, kind: 'ok', detail: '', durationMs: 0, raw: null })
              alive = false
            })
            return true
          },
          interrupt: () => true,
          close: () => {},
        }
      },
    }
    const scenario = loadScenario(join(CONTROL, 'emergency-stop-mid-task.json'))
    const r = await runAttempt({ scenario, attempt: 1, harness: dying, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, false)
    assert.ok(r.failed.some((f) => /session died before turn 2 \(stop\)/.test(f.message)), JSON.stringify(r.failed))
  })

  test("the turn texts match warm-worker.mjs's", () => {
    const src = readFileSync(join(ROOT, 'warm-worker.mjs'), 'utf8')
    const pieces = [
      TURNS.drain(),
      TURNS.keepalive(),
      ...TURNS.stop({ channel: '${channel}', chat: '${chat_id}' }).split('\n'),
      TURNS.teams({ sender: 'S', text: 'T' }).split('\n')[0],
      /Reply by running.*?Teams card\). /.exec(TURNS.teams({ sender: 'S', text: 'T' }))[0],
      /These messages are NOT queue tasks.*?for them\./.exec(TURNS.teams({ sender: 'S', text: 'T' }))[0],
    ]
    for (const p of pieces) assert.ok(src.includes(p), `warm-worker.mjs no longer sends: ${p}`)
  })

  test('a Teams inbound needs a teams session turn and is never posted to a webhook', () => {
    assert.equal(webhookRequest({ channel: 'teams', sender: 'x', chat: 'y', text: 'z' }, {}), null)
    const dir = tmp()
    const bad = { inbound: { channel: 'teams', sender: 'x', chat: 'y', text: 'z' }, expect: [{ called: 'Bash' }] }
    writeFileSync(join(dir, 'a.json'), JSON.stringify(bad))
    assert.throws(() => loadScenario(join(dir, 'a.json')), /teams inbound needs a session with a teams turn/)
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...bad, session: [{ turn: 'nope' }] }))
    assert.throws(() => loadScenario(join(dir, 'b.json')), /session must be a non-empty list/)
  })

  test('the Teams scenarios run under any harness (DMN-22: a sandboxed shell exists)', () => {
    for (const f of ['teams-reply-shell', 'teams-reply-shell-negative']) assert.equal(loadScenario(join(CONTROL, `${f}.json`)).harnesses, undefined, f)
  })

  test('a scenario whose harnesses exclude --harness is skipped, not failed, and summary.json lists the skips', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'fake-only.json'), JSON.stringify({ ...readJson(CONTROL, 'teams-reply-shell.json'), name: 'fake-only', harnesses: ['fake'] }))
    const out = tmp()
    const r = runCli(['--harness', 'claude-code', '--worker', tmp(), '--scenarios', `${dir}/*`, '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /SKIP fake-only \(harnesses: fake\)/)
    const summary = readJson(out, 'summary.json')
    assert.equal(summary.attempts, 0)
    assert.deepEqual(summary.unexpected, [])
    assert.deepEqual(summary.skipped.map((s) => s.scenario), ['fake-only'])
    assert.deepEqual(readJson(out, 'results.json'), [])
  })

  test('harnesses must be a non-empty list of names', () => {
    const dir = tmp()
    const base = { inbound: { channel: 'sl', sender: 'x', chat: 'y', text: 'z' }, expect: [{ called: 'channel_send' }] }
    for (const harnesses of [[], 'fake', [1]]) {
      writeFileSync(join(dir, 'h.json'), JSON.stringify({ ...base, harnesses }))
      assert.throws(() => loadScenario(join(dir, 'h.json')), /harnesses must be a non-empty list/, JSON.stringify(harnesses))
    }
  })
})

describe('order assertion with argument matchers', () => {
  const trace = [
    { type: 'tool_call', name: 'mac_shell', input: { command: 'curl -s http://127.0.0.1:8791/model' } },
    { type: 'tool_call', name: 'channel_send', input: { text: 'ok' } },
    { type: 'tool_call', name: 'mac_shell', input: { command: 'curl -s -X POST http://127.0.0.1:8791/model' } },
  ]
  const run = (order) => evaluate([{ order }], { trace, state: {}, scenario: {}, latencyMs: 0 })
  test('a { tool, args } entry matches only a call with those args', () => {
    assert.deepEqual(run(['channel_send', { tool: 'mac_shell', args: { command: '/-X POST/' } }]), [])
    assert.equal(run([{ tool: 'mac_shell', args: { command: '/-X POST/' } }, 'channel_send']).length, 1)
    assert.deepEqual(run(['mac_shell', 'channel_send', 'mac_shell']), [])
  })
})

describe('DMN-22 rulings: audio via any shell tool, negative controls only under the fake', () => {
  const audio = loadScenario(join(CONTROL, 'audio-transcribe.json'))
  const grade = (shell, input, reply) => {
    const trace = [
      { type: 'tool_call', name: 'task_claim', input: {} },
      { type: 'tool_call', name: shell, input },
      { type: 'tool_call', name: 'channel_send', input: { text: reply } },
      { type: 'tool_call', name: 'task_complete', input: {} },
    ]
    return evaluate(audio.expect.filter((a) => a.argsMatch || a.order), { trace, state: {}, scenario: audio, latencyMs: 0 })
  }
  const cmd = 'tools/transcribe.sh media/eval-voice-note.m4a en'
  const REPLY = 'The capital of France is Paris.'
  test('transcribe.sh on the saved media path passes through Bash, bash, mac_shell or execute', () => {
    for (const shell of ['Bash', 'bash', 'mac_shell']) assert.deepEqual(grade(shell, { command: `~/fermi-daemon/${cmd}` }, REPLY), [], shell)
    assert.deepEqual(grade('Bash', { command: cmd }, REPLY), [], 'relative, from the daemon dir')
    assert.deepEqual(grade('execute', { code: `~/fermi-daemon/${cmd}` }, REPLY), [], 'any argument name')
  })
  test('another tool, another file or a reply without the transcript content fails', () => {
    assert.ok(grade('fs_read', { command: `~/fermi-daemon/${cmd}` }, REPLY).length)
    assert.ok(grade('Bash', { command: 'tools/transcribe.sh media/other.m4a' }, REPLY).length)
    assert.ok(grade('Bash', { command: cmd }, "Sorry, I can't listen to audio.").length)
  })

  test('isNegativeControl: negative: true, or the negative-X / X-negative / X-neg naming, variants by base name', () => {
    for (const name of ['negative-fs-read-notes', 'teams-reply-shell-negative', 'bootstrap-first-neg', 'bootstrap-first-neg~para']) assert.equal(isNegativeControl({ name }), true, name)
    for (const name of ['fs-read-notes', 'negativity', 'neg-x', 'bootstrap-first~neg']) assert.equal(isNegativeControl({ name }), false, name)
    assert.equal(isNegativeControl({ name: 'plain', negative: true }), true)
    assert.equal(isNegativeControl({ name: 'x-neg', negative: false }), false)
  })

  test('in every pack, the expectOutcome "fail" scenarios are exactly the negative controls', () => {
    const files = expandScenarios([join(ROOT, 'evals/scenarios/*/*')])
    assert.ok(files.length > 50, String(files.length))
    for (const f of files) {
      const s = loadScenario(f)
      assert.equal(isNegativeControl(s), s.expectOutcome === 'fail', f)
    }
  })

  test('a non-fake harness skips every negative control as "negative control", not unexpected; the fake runs them', () => {
    const dir = tmp()
    const pos = readJson(CONTROL, 'audio-transcribe.json')
    const neg = readJson(CONTROL, 'audio-transcribe-negative.json')
    for (const name of ['a-neg', 'negative-b', 'c-negative']) writeFileSync(join(dir, `${name}.json`), JSON.stringify({ ...neg, name }))
    writeFileSync(join(dir, 'd.json'), JSON.stringify({ ...neg, name: 'd', negative: true }))
    writeFileSync(join(dir, 'e.json'), JSON.stringify({ ...pos, name: 'e', harnesses: ['fake'] }))
    const out = tmp()
    const r = runCli(['--harness', 'claude-code', '--worker', tmp(), '--scenarios', `${dir}/*`, '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    for (const n of ['a-neg', 'negative-b', 'c-negative', 'd']) assert.match(r.stdout, new RegExp(`SKIP ${n} \\(negative control\\)`))
    const summary = readJson(out, 'summary.json')
    assert.equal(summary.attempts, 0)
    assert.deepEqual(summary.unexpected, [])
    assert.deepEqual(Object.fromEntries(summary.skipped.map((s) => [s.scenario, s.reason])), {
      'a-neg': 'negative control',
      'negative-b': 'negative control',
      'c-negative': 'negative control',
      d: 'negative control',
      e: 'harnesses: fake',
    })
    const fakeOut = tmp()
    const f = runCli(['--harness', 'fake', '--scenarios', `${dir}/*`, '--out', fakeOut])
    assert.equal(f.status, 0, f.stdout + f.stderr)
    assert.deepEqual(readJson(fakeOut, 'summary.json').skipped, [])
    assert.equal(readJson(fakeOut, 'summary.json').expectedFailures, 4)
  })

  test('negative must be a boolean', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'n.json'), JSON.stringify({ inbound: { channel: 'sl', sender: 'x', chat: 'y', text: 'z' }, expect: [{ called: 'channel_send' }], negative: 'yes' }))
    assert.throws(() => loadScenario(join(dir, 'n.json')), /negative must be a boolean/)
  })
})
