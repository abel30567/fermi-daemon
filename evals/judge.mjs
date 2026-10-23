#!/usr/bin/env node
// Rubric-based quality score of the replies (channel_send texts) in an eval run.
// The score is reported by evals/compare.mjs, never gated: assertions decide pass/fail.
//
//   node evals/judge.mjs <run dir> --scenarios <glob>... [--fake] [--judge-auth none|fd|keychain|proxy]
//   node evals/judge.mjs --calibrate [--fake] [--judge-auth none|fd|keychain|proxy]
//   node evals/judge.mjs --regrade <run dir> [--scenarios <glob>...] [--fake] [--judge-auth none|fd|keychain|proxy]
//
// Writes <run dir>/judge.json: one entry per attempt in results.json,
// { scenario, category, attempt, score (0..1, null without a reply), helpful, tone, format, notes }.
//
// The judge model and its harness are fixed in evals/judge.config.json, so every
// run is scored by the same judge. The call goes through the harness adapter
// (harness/index.mjs) exactly as an eval attempt does: the same sandbox env (nothing
// ambient) and the same auth modes (lib/auth.mjs), with the same isolation: no tools
// (--tools ""), strict MCP with no servers, setting sources project,local, inside
// the OS sandbox (harness/sandbox.mjs) behind the egress proxy. The judge sees
// only the user's message, the channel and the reply texts: never the harness,
// model, trace or cost, so it is blind to which harness produced the reply.
// --fake scores with fakeJudge (deterministic, no inference), for tests.
//
// --calibrate asks the semantic judge (lib/semantic.mjs, same model and isolation)
// every case of test/fixtures/semantic/*.json and prints its confusion table. Exit 1
// when its accuracy is below the threshold, so semantic assertions would be disabled.
//
// --regrade grades a finished run again from its recorded traces and state with the
// current assertions and semantic judge, without re-running the harness (lib/regrade.mjs),
// → <run dir>/regraded.json: results.json's schema plus regradedAt and assertionsVersion.
// Scenarios default to every file under evals/scenarios/.
//
// The judge's credential is --judge-auth (createJudgeAuth: default keychain on macOS for a
// Claude judge model, else required; CI uses fd), never the run's harness auth. --auth is
// an alias kept for older command lines.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHarness } from '../harness/index.mjs'
import { createSandbox } from '../harness/sandbox.mjs'
import { startEgressProxy } from './lib/egress-proxy.mjs'
import { createJudgeAuth } from './lib/auth.mjs'
import { assertLocalUrls } from './lib/net.mjs'
import { regradeRun } from './lib/regrade.mjs'
import { expandScenarios, expandVariants, loadScenario } from './lib/scenario.mjs'
import { fakeAsk, prepareSemantic, semanticPrompt, semanticSpecs } from './lib/semantic.mjs'

export const CONFIG = JSON.parse(readFileSync(new URL('./judge.config.json', import.meta.url), 'utf8'))

export const RUBRIC = `Score the assistant's reply to the user's message on three criteria, each an integer 1-5:
- helpful: it answers or acts on what was asked, correctly and completely, without padding.
- tone: warm, direct and concise, like a capable personal assistant; it never calls itself an AI or a language model.
- format: it follows the channel's format rules (below), and is short enough for a chat message.
Format rules by channel:
- sl (Slack mrkdwn): no pipe tables, no "#" headers, no "**bold**" (use *bold*).
- every channel: plain chat text, no preamble like "Sure! Here is".`

// The judge's prompt. It must only contain what a user would see.
export function judgePrompt({ channel, request, replies }) {
  return [
    RUBRIC,
    '',
    `Channel: ${channel}`,
    'User message:',
    '<<<',
    request,
    '>>>',
    `Assistant repl${replies.length === 1 ? 'y' : 'ies'}:`,
    ...replies.flatMap((r) => ['<<<', r, '>>>']),
    '',
    'Answer with only a JSON object: {"helpful": n, "tone": n, "format": n, "notes": "<one sentence>"}',
  ].join('\n')
}

const DIMS = ['helpful', 'tone', 'format']

// { helpful, tone, format, notes, score } from the judge's text; score = mean / 5.
export function parseVerdict(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`judge: no JSON object in ${JSON.stringify(String(text).slice(0, 200))}`)
  const v = JSON.parse(m[0])
  for (const d of DIMS) if (!(Number.isInteger(v[d]) && v[d] >= 1 && v[d] <= 5)) throw new Error(`judge: ${d} must be an integer 1-5, got ${JSON.stringify(v[d])}`)
  return { helpful: v.helpful, tone: v.tone, format: v.format, notes: String(v.notes ?? ''), score: (v.helpful + v.tone + v.format) / 15 }
}

// The real judge: one sandboxed runOnce through the configured adapter, no tools, no MCP servers.
// `auth`: createAuth() for the judge's harness and model (default: none).
export async function modelJudge(input, opts) {
  return parseVerdict(await judgeTurn(judgePrompt(input), opts))
}

// The semantic judge's ask (lib/semantic.mjs createSemanticJudge): the same sandboxed turn.
export const semanticAsk = (opts) => ({ question, text }) => judgeTurn(semanticPrompt(question, text), opts)

// One prompt to the judge model → its reply text.
export async function judgeTurn(prompt, { config = CONFIG, harness, auth } = {}) {
  harness ??= await loadHarness(config.harness)
  const { secrets, localPorts = [], egressAllow = [], env: authEnv = {}, ...authOpts } = auth?.attempt() ?? {} // secrets: never handed on
  assertLocalUrls(Object.fromEntries(Object.entries(authEnv).filter(([, v]) => /^[a-z]+:\/\//i.test(String(v)))))
  const cwd = mkdtempSync(join(tmpdir(), 'eval-judge-'))
  const egress = await startEgressProxy({ local: egressAllow })
  try {
    const mcpConfig = join(cwd, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }))
    const sandbox = createSandbox({ root: join(cwd, 'home'), localPorts, egressProxy: egress.url })
    const run = harness.runOnce({
      prompt,
      model: config.model,
      cwd,
      mcpConfig,
      maxTurns: 1,
      sandbox,
      tools: [], // --tools "": no built-ins at all
      strictMcpConfig: true,
      settingSources: 'project,local',
      permissionMode: 'default',
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CONFIG_DIR: join(sandbox.root, '.claude'), ...authEnv },
      ...authOpts, // tokenPipe, scrubSubprocessEnv, provider
    })
    let timer
    const res = await Promise.race([run.done, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`judge timed out after ${config.timeoutMs} ms`)), config.timeoutMs)))]).finally(() => (clearTimeout(timer), run.close?.('SIGTERM')))
    if (res.outcome && !res.outcome.ok) throw new Error(`judge turn ended with ${res.outcome.kind}: ${res.outcome.detail}`)
    return res.events.filter((e) => e.type === 'text').map((e) => e.text).join('\n')
  } finally {
    await egress.close().catch(() => {})
    rmSync(cwd, { recursive: true, force: true })
  }
}

// Deterministic stand-in for tests: rule checks instead of a model.
export async function fakeJudge({ channel, replies }) {
  const text = replies.join('\n')
  const formatBad = (channel === 'sl' && (/^\s*\|.*\|\s*$/m.test(text) || /^#{1,6}\s/m.test(text) || /\*\*/.test(text))) || /^(sure|certainly)!?\s+here/i.test(text)
  const v = {
    helpful: text.trim() ? 5 : 1,
    tone: /\bas an ai\b|\blanguage model\b/i.test(text) ? 1 : 5,
    format: formatBad ? 1 : 5,
  }
  return { ...v, notes: 'fake judge', score: (v.helpful + v.tone + v.format) / 15 }
}

// The judge input for one attempt: its scenario's inbound message and the channel_send texts of its trace.
export function judgeInput(scenario, trace) {
  return {
    channel: scenario.inbound.channel,
    request: scenario.inbound.text,
    replies: trace.filter((e) => e.type === 'tool_call' && e.name === 'channel_send' && typeof e.input?.text === 'string').map((e) => e.input.text),
  }
}

const readTrace = (file) => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

// Score every attempt of a run dir. `scenarios` maps a scenario name to the loaded scenario.
export async function judgeRun(runDir, scenarios, judge = modelJudge) {
  const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'))
  const out = []
  for (const r of results) {
    const entry = { scenario: r.scenario, category: r.category ?? null, attempt: r.attempt, score: null }
    const s = scenarios[r.scenario]
    if (!s) entry.notes = 'scenario file not given'
    else if (r.status === 'invalid') entry.notes = 'invalid attempt, not judged'
    else {
      const input = judgeInput(s, readTrace(join(runDir, r.scenario, String(r.attempt), 'trace.jsonl')))
      if (!input.replies.length) entry.notes = 'no channel_send'
      else
        try {
          Object.assign(entry, await judge(input))
        } catch (err) {
          entry.notes = String(err?.message ?? err)
        }
    }
    out.push(entry)
  }
  return out
}

// The calibrated semantic judge (null below the threshold): the fake one, or the configured model with `auth`.
async function semanticJudge({ fake, auth }) {
  console.log(`calibrating ${fake ? 'the fake semantic judge' : `${CONFIG.harness} ${CONFIG.model}`}`)
  const model = fake ? 'fake' : `${CONFIG.harness}-${CONFIG.model}`
  return prepareSemantic({ ask: fake ? fakeAsk() : semanticAsk({ auth }), model, cacheFile: fake ? null : semanticCacheFile() })
}

// The scenarios (and variants) of `files` by name, and the names more than one file holds.
function scenariosByName(files) {
  const byName = {}
  const dup = new Set()
  for (const f of files)
    for (const s of expandVariants(loadScenario(f))) {
      if (byName[s.name]) dup.add(s.name)
      byName[s.name] = s
    }
  return { byName, dup }
}

async function regrade(runDir, { patterns, fake, mode }) {
  let before, scenarios, semantic, auth
  try {
    before = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'))
    const { byName, dup } = scenariosByName(expandScenarios(patterns.length ? patterns : [fileURLToPath(new URL('./scenarios/*/*', import.meta.url))]))
    const ambiguous = [...new Set(before.map((r) => r.scenario).filter((n) => dup.has(n)))]
    if (ambiguous.length) throw new Error(`scenario ${ambiguous.join(', ')} is in more than one file: pass --scenarios`)
    scenarios = byName
    semantic = before.some((r) => scenarios[r.scenario] && semanticSpecs(scenarios[r.scenario].expect).length)
    if (semantic && !fake) auth = createJudgeAuth({ mode, harness: CONFIG.harness, model: CONFIG.model })
  } catch (err) {
    return usage(err.message)
  }
  const judge = semantic ? (await semanticJudge({ fake, auth })).judge : null
  let out
  try {
    out = await regradeRun(runDir, scenarios, { judge })
  } catch (err) {
    return usage(err.message)
  }
  writeFileSync(join(runDir, 'regraded.json'), JSON.stringify(out, null, 2) + '\n')
  const flipped = out.map((r, i) => [before[i], r]).filter(([b, r]) => b.pass !== r.pass)
  for (const [b, r] of flipped) console.log(`CHANGED ${r.scenario} #${r.attempt}: ${b.pass ? 'PASS' : 'FAIL'} → ${r.pass ? 'PASS' : 'FAIL'} ${r.failed.map((f) => f.message).join(' | ')}`.trimEnd())
  console.log(`regraded ${out.length} attempt(s), ${flipped.length} changed, ${!semantic ? 'no semantic assertions' : judge ? 'semantic judge enabled' : 'semantic judge disabled'} → ${join(runDir, 'regraded.json')}`)
  return 0
}

async function main(argv) {
  let runDir
  let fake = false
  let calibrateOnly = false
  let regradeDir
  let mode // --judge-auth; undefined: createJudgeAuth's default
  const patterns = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--fake') fake = true
    else if (a === '--calibrate') calibrateOnly = true
    else if (a === '--regrade' && i + 1 < argv.length) regradeDir = argv[++i]
    else if ((a === '--judge-auth' || a === '--auth') && i + 1 < argv.length) mode = argv[++i]
    else if (a === '--scenarios') while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) patterns.push(argv[++i])
    else if (!a.startsWith('-') && runDir == null) runDir = a
    else return usage(`unknown argument ${a}`)
  }
  if (regradeDir != null) return runDir == null ? regrade(regradeDir, { patterns, fake, mode }) : usage(`unknown argument ${runDir}`)
  if (calibrateOnly) {
    let auth
    try {
      if (!fake) auth = createJudgeAuth({ mode, harness: CONFIG.harness, model: CONFIG.model })
    } catch (err) {
      return usage(err.message)
    }
    const { calibration } = await semanticJudge({ fake, auth })
    return calibration.enabled ? 0 : 1
  }
  if (!runDir || !patterns.length) return usage('needs <run dir> --scenarios <glob>...')
  let scenarios, auth
  try {
    scenarios = Object.fromEntries(expandScenarios(patterns).map(loadScenario).map((s) => [s.name, s]))
    if (!fake) auth = createJudgeAuth({ mode, harness: CONFIG.harness, model: CONFIG.model })
  } catch (err) {
    return usage(err.message)
  }
  const out = await judgeRun(runDir, scenarios, fake ? fakeJudge : (input) => modelJudge(input, { auth }))
  writeFileSync(join(runDir, 'judge.json'), JSON.stringify(out, null, 2) + '\n')
  const scored = out.filter((e) => e.score != null)
  console.log(`judged ${scored.length}/${out.length} attempt(s) with ${fake ? 'the fake judge' : `${CONFIG.harness} ${CONFIG.model}`} → ${join(runDir, 'judge.json')}`)
  return 0
}

// The real semantic judge's answer cache, one file per judge model.
export const semanticCacheFile = (config = CONFIG) => join('runs', 'semantic-cache', `${config.harness}-${config.model}.json`)

function usage(msg) {
  console.error(
    `judge: ${msg}\nusage: node evals/judge.mjs <run dir> --scenarios <glob>... [--fake] [--judge-auth none|fd|keychain|proxy]\n       node evals/judge.mjs --calibrate [--fake] [--judge-auth none|fd|keychain|proxy]\n       node evals/judge.mjs --regrade <run dir> [--scenarios <glob>...] [--fake] [--judge-auth none|fd|keychain|proxy]`,
  )
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main(process.argv.slice(2))
