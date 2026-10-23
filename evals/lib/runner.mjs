// One scenario attempt: fresh fakes + eval target + fault proxy, enqueue the
// inbound message through the channel webhook, run one drain through the
// harness adapter with prompts/drain.md (rendered with the eval overlay), then dump state and grade the trace.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPrompt } from '../../lib/prompt.mjs'
import { evaluate } from './assertions.mjs'
import { mcpConnect, resultText } from './mcp-client.mjs'
import { startFakeTarget } from './fake-target.mjs'
import { startFakes } from './fakes.mjs'
import { startMcpProxy } from './mcp-proxy.mjs'
import { assertLocalUrls } from './net.mjs'
import { seedFixture, webhookRequest } from './scenario.mjs'
import { runSession } from './session.mjs'
import { startWranglerTarget } from './wrangler-target.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DRAIN_PROMPT = join(ROOT, 'prompts/drain.md')
// Placeholder owner, call list and channel ids, matching the scenario fixtures; never the private prompts/local.json.
export const EVAL_OVERLAY = join(ROOT, 'evals/fixtures/prompt-overlay.json')

// Fake credentials for the eval worker; the fakes accept anything.
const EVAL_SECRETS = {
  SLACK_BOT_TOKEN: 'xoxb-eval-fake',
  SLACK_BRIDGE_SECRET: 'eval-sl-bridge-secret',
  WA_WEBHOOK_SECRET: 'eval-wa-bridge-secret',
  TELEGRAM_BOT_TOKEN: '1000:eval-fake',
  DISCORD_BOT_TOKEN: 'eval-discord-fake',
  TWILIO_ACCOUNT_SID: 'ACeval',
  TWILIO_AUTH_TOKEN: 'eval-twilio-fake',
  TWILIO_FROM_NUMBER: '+15555550199',
  MACOS_MCP_TOKEN: 'eval-mac-fake',
  FERMI_BEARER_TOKEN: 'eval-bearer-fake',
}

// `fixtures.secrets` ({ name, value }) go in through the target's own secret_set,
// opted in to secret_resolve; the high-risk approval token is replayed once.
async function seedSecrets(url, secrets = []) {
  if (!secrets.length) return
  const mcp = await mcpConnect(`${url}/mcp`, { clientName: 'fermi-eval-seed' })
  for (const { name, value } of secrets) {
    const args = { name, value, scope: 'app', allowed_capabilities: ['secret_resolve'] }
    let r = await mcp.callTool('secret_set', args)
    const token = /"status":"pending_approval"/.test(resultText(r)) && JSON.parse(resultText(r)).token
    if (token) r = await mcp.callTool('secret_set', { ...args, approval_token: token })
    if (r.isError || /"error"|pending_approval/.test(resultText(r))) throw new Error(`secret_set ${name}: ${resultText(r).slice(0, 200)}`)
  }
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
  try {
    const fakes = await startFakes({ mac: { canned: scenario.fixtures?.mac } })
    closers.push(fakes.close)
    const env = { ...fakes.env, ...EVAL_SECRETS }
    assertLocalUrls(urlEntries(env))
    const target = worker ? await startWranglerTarget({ worker, env, logDir: dir }) : await startFakeTarget({ env })
    closers.push(target.close)
    assertLocalUrls({ target: target.url })
    await target.seed(seedFixture(scenario.fixtures, scenario.inbound))
    await seedSecrets(target.url, scenario.fixtures?.secrets)
    const proxy = await startMcpProxy({ target: target.url, faults: scenario.faults })
    closers.push(proxy.close)
    const mcpConfig = { mcpServers: { fermi: { type: 'http', url: `${proxy.url}/mcp` } } }
    assertLocalUrls(Object.fromEntries(Object.entries(mcpConfig.mcpServers).map(([k, s]) => [`mcp:${k}`, s.url])))
    const mcpConfigFile = join(dir, 'mcp.json')
    writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2))

    const t0 = Date.now()
    const hook = webhookRequest(scenario.inbound, EVAL_SECRETS)
    if (hook) {
      const res = await fetch(target.url + hook.path, { method: 'POST', headers: hook.headers, body: JSON.stringify(hook.body) })
      if (!res.ok) throw new Error(`webhook ${hook.path} → HTTP ${res.status}`)
    }
    fakes.setPhase('drain')

    const drainPrompt = loadPrompt(DRAIN_PROMPT, EVAL_OVERLAY)
    const harnessOpts = {
      model,
      cwd: dir,
      mcpConfig: mcpConfigFile,
      allowedTools: ['mcp__fermi__*'],
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, // no claude.ai connectors (the production Fermi) next to the eval server
    }
    // A `session` scenario runs warm-worker turns in one session with drain.md as the system prompt (session.mjs).
    const run = scenario.session
      ? runSession(harness, { ...harnessOpts, systemPrompt: drainPrompt, script: scenario.fake?.turns }, { turns: scenario.session, inbound: scenario.inbound })
      : harness.runOnce({ ...harnessOpts, prompt: drainPrompt, script: scenario.fake?.script }) // the fake harness's script; real adapters ignore it
    run.events.on('event', (ev) => {
      trace.push(ev)
      appendFileSync(join(dir, 'trace.jsonl'), JSON.stringify(ev) + '\n')
    })
    run.events.on('raw', (line) => appendFileSync(join(dir, 'raw.log'), line + '\n'))
    run.events.on('stderr', (s) => appendFileSync(join(dir, 'stderr.log'), s))
    let timer
    const timedOut = await Promise.race([
      run.done.then(() => false),
      new Promise((r) => (timer = setTimeout(() => r(true), timeoutMs))),
    ])
    clearTimeout(timer)
    if (timedOut) {
      errorKinds.add('timeout')
      run.close('SIGTERM')
    }
    latencyMs = Date.now() - t0

    const state = { ...(await target.dump()), fakes: fakes.record() }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2))
    failed = evaluate(scenario.expect, { trace, state, scenario, latencyMs })
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
    if (ev.type === 'turn_end' && !ev.ok && !ev.interrupted) {
      errorKinds.add(ev.kind)
      failed.push({ assertion: null, message: `harness turn ended with ${ev.kind}: ${ev.detail}` })
    }
  }
  const ends = trace.filter((e) => e.type === 'turn_end')
  const sum = (k) => (ends.some((e) => e[k] != null) ? ends.reduce((a, e) => a + (e[k] ?? 0), 0) : null)
  const inputTokens = sum('inputTokens')
  const outputTokens = sum('outputTokens')
  return {
    scenario: scenario.name,
    ...(scenario.category != null && { category: String(scenario.category) }),
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
