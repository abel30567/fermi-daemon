// One scenario attempt: fresh fakes + eval target + fault proxy, enqueue the
// inbound message through the channel webhook, run one drain through the
// harness adapter with prompts/drain.md, then dump state and grade the trace.
// A scenario with `session` runs in one warm session instead (see runSession).
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate } from './assertions.mjs'
import { startFakeTarget } from './fake-target.mjs'
import { startFakes } from './fakes.mjs'
import { startMcpProxy } from './mcp-proxy.mjs'
import { assertLocalUrls } from './net.mjs'
import { seedFixture, webhookRequest } from './scenario.mjs'
import { startWranglerTarget } from './wrangler-target.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DRAIN_PROMPT = join(ROOT, 'prompts/drain.md')

// Fake credentials for the eval worker; the fakes accept anything.
const EVAL_SECRETS = {
  SLACK_BOT_TOKEN: 'xoxb-eval-fake',
  SLACK_BRIDGE_SECRET: 'eval-sl-bridge-secret',
  TELEGRAM_BOT_TOKEN: '1000:eval-fake',
  DISCORD_BOT_TOKEN: 'eval-discord-fake',
  TWILIO_ACCOUNT_SID: 'ACeval',
  TWILIO_AUTH_TOKEN: 'eval-twilio-fake',
  TWILIO_FROM_NUMBER: '+15555550199',
  MACOS_MCP_TOKEN: 'eval-mac-fake',
  FERMI_BEARER_TOKEN: 'eval-bearer-fake',
}

// The warm worker's drain turn (warm-worker.mjs), sent once per task in session mode.
export const DRAIN_TURN =
  'There are pending tasks in the queue. Claim and process every pending task now (claim one at a time, bootstrap, reply, complete), looping until task_claim returns empty. Then stop.'

// An fd the harness reads its (fake) OAuth token from, as the warm worker hands
// over the real one. The file is unlinked at once; only the open fd remains.
function tokenFd(token) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-token-'))
  const file = join(dir, 'token')
  writeFileSync(file, token, { mode: 0o600 })
  const fd = openSync(file, 'r')
  rmSync(dir, { recursive: true, force: true })
  return fd
}

const urlEntries = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => /^[a-z]+:\/\//i.test(String(v))))

export async function runAttempt({ scenario, attempt, harness, model, worker, timeoutMs, outDir }) {
  const dir = join(outDir, scenario.name, String(attempt))
  mkdirSync(dir, { recursive: true })
  const closers = []
  const trace = []
  const errorKinds = new Set()
  let failed = []
  let latencyMs = 0
  let taskLatencies
  const retried = new Set() // error turn_ends the session re-drained after
  try {
    const fakes = await startFakes({ mac: { canned: scenario.fixtures?.mac } })
    closers.push(fakes.close)
    const env = { ...fakes.env, ...EVAL_SECRETS }
    assertLocalUrls(urlEntries(env))
    const target = worker ? await startWranglerTarget({ worker, env, logDir: dir }) : await startFakeTarget({ env, tools: scenario.fixtures?.tools })
    closers.push(target.close)
    assertLocalUrls({ target: target.url })
    await target.seed(seedFixture(scenario.fixtures))
    const proxy = await startMcpProxy({ target: target.url, faults: scenario.faults })
    closers.push(proxy.close)
    const mcpConfig = { mcpServers: { fermi: { type: 'http', url: `${proxy.url}/mcp` } } }
    assertLocalUrls(Object.fromEntries(Object.entries(mcpConfig.mcpServers).map(([k, s]) => [`mcp:${k}`, s.url])))
    const mcpConfigFile = join(dir, 'mcp.json')
    writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2))

    const t0 = Date.now()
    // Enqueue one inbound message the way the bridge does; later traffic is the drain's.
    const enqueue = async (inbound) => {
      fakes.setPhase('inbound')
      const hook = webhookRequest(inbound, EVAL_SECRETS)
      const res = await fetch(target.url + hook.path, { method: 'POST', headers: hook.headers, body: JSON.stringify(hook.body) })
      if (!res.ok) throw new Error(`webhook ${hook.path} → HTTP ${res.status}`)
      fakes.setPhase('drain')
    }

    const opts = {
      model,
      cwd: dir,
      mcpConfig: mcpConfigFile,
      allowedTools: ['mcp__fermi__*'],
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, // no claude.ai connectors (the production Fermi) next to the eval server
      script: scenario.fake?.script, // the fake harness's script; real adapters ignore it
    }
    if (scenario.credentials?.token != null) {
      opts.tokenFd = tokenFd(scenario.credentials.token)
      closers.push(async () => closeSync(opts.tokenFd))
    }
    const record = (events) => {
      events.on('event', (ev) => {
        trace.push(ev)
        appendFileSync(join(dir, 'trace.jsonl'), JSON.stringify(ev) + '\n')
      })
      events.on('raw', (line) => appendFileSync(join(dir, 'raw.log'), line + '\n'))
      events.on('stderr', (s) => appendFileSync(join(dir, 'stderr.log'), s))
    }
    let timedOut
    if (scenario.session) {
      ;({ timedOut, taskLatencies } = await runSession({ harness, opts, scenario, enqueue, record, retried, deadline: t0 + timeoutMs }))
    } else {
      await enqueue(scenario.inbound)
      const run = harness.runOnce({ prompt: readFileSync(DRAIN_PROMPT, 'utf8'), ...opts })
      record(run.events)
      let timer
      timedOut = await Promise.race([
        run.done.then(() => false),
        new Promise((r) => (timer = setTimeout(() => r(true), timeoutMs))),
      ])
      clearTimeout(timer)
      if (timedOut) run.close('SIGTERM')
    }
    if (timedOut) errorKinds.add('timeout')
    latencyMs = Date.now() - t0

    const state = { ...(await target.dump()), fakes: fakes.record() }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2))
    failed = evaluate(scenario.expect, { trace, state, scenario, latencyMs, taskLatencies })
  } catch (err) {
    errorKinds.add('runner_error')
    failed.push({ assertion: null, message: String(err?.message ?? err) })
  } finally {
    for (const close of closers.reverse()) await close().catch(() => {})
  }

  // A run that never finished cleanly is never graded green, whatever its trace.
  if (errorKinds.has('timeout')) failed.push({ assertion: null, message: `harness timed out after ${timeoutMs} ms` })
  for (const ev of trace) {
    if (ev.type === 'tool_result' && !ev.ok) errorKinds.add('tool_error')
    if (ev.type === 'turn_end' && !ev.ok) {
      errorKinds.add(ev.kind)
      // A warm session re-drains after an error turn, like the warm worker after its backoff.
      if (!retried.has(ev)) failed.push({ assertion: null, message: `harness turn ended with ${ev.kind}: ${ev.detail}` })
    }
  }
  const ends = trace.filter((e) => e.type === 'turn_end')
  const sum = (k) => (ends.some((e) => e[k] != null) ? ends.reduce((a, e) => a + (e[k] ?? 0), 0) : null)
  const inputTokens = sum('inputTokens')
  const outputTokens = sum('outputTokens')
  return {
    scenario: scenario.name,
    attempt,
    pass: failed.length === 0,
    expectedOutcome: scenario.expectOutcome ?? 'pass',
    failed: failed.map((f) => ({ assertion: f.assertion, message: f.message })),
    latencyMs,
    toolCalls: trace.filter((e) => e.type === 'tool_call').map((e) => e.name),
    tokens: inputTokens == null && outputTokens == null ? null : { input: inputTokens, output: outputTokens },
    costUsd: sum('costUsd'),
    errorKinds: [...errorKinds],
  }
}

// Session mode: `session: { tasks?: n, redrain?: k }`. One warm session (the
// warm worker's shape: prompts/drain.md as the system prompt) gets n inbound
// messages one at a time (`${n}` in inbound.text is the message's number), one
// DRAIN_TURN each. After an error turn it re-sends the drain turn, up to k times
// per message. → { timedOut, taskLatencies } (enqueue → that message's last turn_end).
async function runSession({ harness, opts, scenario, enqueue, record, retried, deadline }) {
  const { tasks = 1, redrain = 0 } = scenario.session
  const session = harness.startSession({ ...opts, systemPrompt: readFileSync(DRAIN_PROMPT, 'utf8') })
  record(session.events)
  const turn = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => (session.events.off('event', on), resolve(null)), Math.max(0, deadline - Date.now()))
      const on = (ev) => {
        if (ev.type !== 'turn_end') return
        clearTimeout(timer)
        session.events.off('event', on)
        resolve(ev)
      }
      session.events.on('event', on)
      session.send(DRAIN_TURN)
    })
  const taskLatencies = []
  try {
    for (let i = 1; i <= tasks; i++) {
      const t = Date.now()
      await enqueue({ ...scenario.inbound, text: scenario.inbound.text.replaceAll('${n}', String(i)), message_id: `eval-${t}-${i}` })
      let end = await turn()
      for (let k = 0; end && !end.ok && k < redrain; k++) {
        retried.add(end)
        end = await turn()
      }
      if (!end) return { timedOut: true, taskLatencies }
      taskLatencies.push(Date.now() - t)
    }
    return { timedOut: false, taskLatencies }
  } finally {
    session.close('SIGTERM')
  }
}

export function summarize(results, meta) {
  const byScenario = {}
  for (const r of results) {
    const s = (byScenario[r.scenario] ??= { attempts: 0, passes: 0, expectedOutcome: r.expectedOutcome })
    s.attempts++
    if (r.pass) s.passes++
  }
  for (const s of Object.values(byScenario)) s.passRate = s.passes / s.attempts
  const unexpected = results.filter((r) => r.pass !== (r.expectedOutcome === 'pass'))
  return {
    ...meta,
    scenarios: Object.keys(byScenario).length,
    attempts: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    expectedFailures: results.filter((r) => !r.pass && r.expectedOutcome === 'fail').length,
    unexpected: unexpected.map((r) => ({ scenario: r.scenario, attempt: r.attempt, pass: r.pass })),
    ok: unexpected.length === 0,
    byScenario,
  }
}
