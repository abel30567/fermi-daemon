#!/usr/bin/env node
// Live behavioural evals: run the daemon drain against an isolated local Fermi and
// grade the normalized trace and the resulting state. See evals/README.md.
//
//   node evals/run.mjs --harness <adapter|fake> [--model <id>] --scenarios <glob>... \
//     [-k <n>] [--out <dir>] [--worker <fermi-mcp checkout>] [--timeout-ms <ms>] [--fake-script <key>] [--weekly] \
//     [--auth none|fd|keychain|proxy] [--infra-retries <n>] [--min-gap-ms <ms>]
//
// --auth decides how the sandboxed harness gets inference credentials (lib/auth.mjs).
// When a scenario has semantic assertions, the semantic judge (lib/semantic.mjs) is
// calibrated first; below its accuracy threshold they grade on their regex alone.
// --harness fake uses the fake judge (calibration labels, no inference).
// An attempt that hits a rate/spend limit or a 5xx is re-run up to --infra-retries times
// (default 3), then recorded as status "invalid" (lib/runner.mjs runAttempt). Attempts on
// one --auth backend run one at a time across processes, --min-gap-ms apart (lib/pacing.mjs).
// Scenarios with `"schedule": "weekly"` (the soak) are skipped unless --weekly is given.
// Exit 0 when every attempt's outcome is the expected one, 1 otherwise, 2 on a
// usage error or a non-localhost URL.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadHarness } from '../harness/index.mjs'
import { sandboxBackend } from '../harness/sandbox.mjs'
import { internalToolCalls } from './lib/assertions.mjs'
import { CONFIG as JUDGE, semanticAsk, semanticCacheFile } from './judge.mjs'
import { createAuth } from './lib/auth.mjs'
import { assertLocalUrls } from './lib/net.mjs'
import { createPacer } from './lib/pacing.mjs'
import { runAttempt, summarize } from './lib/runner.mjs'
import { expandScenarios, expandVariants, isNegativeControl, loadScenario } from './lib/scenario.mjs'
import { fakeAsk, prepareSemantic, semanticSpecs } from './lib/semantic.mjs'

// URL-valued env the runner, wrangler or the harness would inherit. Any of them
// pointing off-box means production could be reached, so the run refuses to start.
const GUARDED_ENV = ['FERMI_URL', 'MACOS_MCP_URL', 'SLACK_API_BASE', 'TELEGRAM_API_BASE', 'DISCORD_API_BASE', 'TWILIO_API_BASE', 'ANTHROPIC_API_BASE']

function parseArgs(argv) {
  const o = { k: 1, scenarios: [], timeoutMs: 300_000, auth: 'none', infraRetries: 3, minGapMs: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--harness') o.harness = val()
    else if (a === '--model') o.model = val()
    else if (a === '-k') o.k = Number(val())
    else if (a === '--out') o.out = val()
    else if (a === '--worker') o.worker = val()
    else if (a === '--timeout-ms') o.timeoutMs = Number(val())
    else if (a === '--weekly') o.weekly = true
    else if (a === '--fake-script') o.fakeScript = val()
    else if (a === '--auth') o.auth = val()
    else if (a === '--infra-retries') o.infraRetries = Number(val())
    else if (a === '--min-gap-ms') o.minGapMs = Number(val())
    else if (a === '--scenarios') {
      o.scenarios.push(val())
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) o.scenarios.push(argv[++i])
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!o.harness) throw new Error('--harness is required')
  if (!o.scenarios.length) throw new Error('--scenarios is required')
  if (!(Number.isInteger(o.k) && o.k > 0)) throw new Error('-k must be a positive integer')
  if (!(Number.isInteger(o.infraRetries) && o.infraRetries >= 0)) throw new Error('--infra-retries must be a non-negative integer')
  if (!(Number.isFinite(o.minGapMs) && o.minGapMs >= 0)) throw new Error('--min-gap-ms must be a non-negative number')
  // Only the fake harness may run against the in-process fake target; real grades need the eval worker.
  if (o.harness !== 'fake' && !o.worker) throw new Error(`--harness ${o.harness} needs --worker <fermi-mcp checkout>`)
  if (o.fakeScript && o.harness !== 'fake') throw new Error('--fake-script needs --harness fake')
  // A real harness only ever runs inside the OS sandbox (harness/sandbox.mjs).
  if (o.harness !== 'fake' && !sandboxBackend()) throw new Error(`--harness ${o.harness} needs an OS sandbox (sandbox-exec on macOS, bwrap on Linux); none found`)
  return o
}

// --fake-script <key>: play `fake.<key>` (a scripted misbehaviour, e.g. "negative")
// instead of `fake.script`; every such attempt is expected to fail its assertions.
function withFakeScript(s, key) {
  if (!Array.isArray(s.fake?.[key])) throw new Error(`${s.name}: no fake.${key} script`)
  return { ...s, fake: { ...s.fake, script: s.fake[key] }, expectOutcome: 'fail' }
}

// The harness's own tool calls (ToolSearch, Bash, …) from the attempt's trace.jsonl, reported
// apart from the Fermi calls the budgets count, so deferred tool loading stays visible.
function internalCalls(out, r) {
  const file = join(out, r.scenario, String(r.attempt), 'trace.jsonl')
  if (!existsSync(file)) return []
  return internalToolCalls(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
}

async function main() {
  let opts, auth
  try {
    opts = parseArgs(process.argv.slice(2))
    assertLocalUrls(Object.fromEntries(GUARDED_ENV.map((k) => [k, process.env[k] || null])))
    auth = createAuth({ mode: opts.auth, harness: opts.harness, model: opts.model })
  } catch (err) {
    console.error(`evals: ${err.message}`)
    return 2
  }
  const files = expandScenarios(opts.scenarios)
  if (!files.length) {
    console.error(`evals: no scenario files match ${opts.scenarios.join(' ')}`)
    return 2
  }
  let scenarios
  try {
    scenarios = files.flatMap((f) => expandVariants(loadScenario(f)))
    if (opts.fakeScript) scenarios = scenarios.map((s) => withFakeScript(s, opts.fakeScript))
  } catch (err) {
    console.error(`evals: ${err.message}`)
    return 2
  }
  const weekly = scenarios.filter((s) => s.schedule === 'weekly')
  if (!opts.weekly && weekly.length) {
    console.log(`skipping ${weekly.length} weekly scenario(s) (${weekly.map((s) => s.name).join(', ')}); pass --weekly to run them`)
    scenarios = scenarios.filter((s) => s.schedule !== 'weekly')
    if (!scenarios.length) {
      console.error('evals: every matching scenario is weekly; pass --weekly to run them')
      return 2
    }
  }
  // A scenario that lists `harnesses` only runs under those, and a negative control (scripted
  // misbehaviour, meaningless under a real model) only under the fake; elsewhere either is reported as skipped.
  const skipReason = (s) =>
    s.harnesses && !s.harnesses.includes(opts.harness)
      ? `harnesses: ${s.harnesses.join(', ')}`
      : opts.harness !== 'fake' && isNegativeControl(s)
        ? 'negative control'
        : null
  const skipped = scenarios.filter(skipReason).map((s) => ({ scenario: s.name, reason: skipReason(s) }))
  scenarios = scenarios.filter((s) => !skipReason(s))
  for (const s of skipped) console.log(`SKIP ${s.scenario} (${s.reason})`)
  const harness = opts.harness === 'fake' ? await import('./harness/fake.mjs') : await loadHarness(opts.harness)
  const out = opts.out ?? join('runs', `evals-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(out, { recursive: true })
  const pacer = createPacer({ backend: auth.mode, minGapMs: opts.minGapMs })
  let semantic = null
  if (scenarios.some((s) => semanticSpecs(s.expect).length)) {
    let ask
    if (opts.harness === 'fake') ask = fakeAsk()
    else {
      // The judge's own credential, for its fixed model: a proxy credential pins every tier to one model.
      let judgeAuth = auth
      try {
        if (auth.mode === 'proxy') judgeAuth = createAuth({ mode: 'proxy', harness: JUDGE.harness, model: JUDGE.model })
      } catch (err) {
        console.error(`evals: semantic judge: ${err.message}`)
        return 2
      }
      ask = semanticAsk({ auth: judgeAuth })
    }
    // Calibration's inference holds the backend lock like an attempt.
    semantic = await pacer.run(() => prepareSemantic({ ask, cacheFile: opts.harness === 'fake' ? null : semanticCacheFile() }))
  }

  const startedAt = new Date().toISOString()
  const results = []
  for (const scenario of scenarios)
    for (let attempt = 1; attempt <= opts.k; attempt++) {
      const onInfraRetry = (x) => console.log(`RETRY ${scenario.name} #${attempt} (${x.retry}/${opts.infraRetries}) ${x.kind}, waiting ${Math.round(x.waitMs / 1000)}s: ${x.detail}`)
      const r = await runAttempt({ scenario, attempt, harness, model: opts.model, worker: opts.worker, timeoutMs: opts.timeoutMs, outDir: out, auth, semanticJudge: semantic?.judge, infraRetries: opts.infraRetries, pace: pacer.run, onInfraRetry })
      r.internalToolCalls = internalCalls(out, r)
      results.push(r)
      const tag = r.status === 'invalid' ? 'INVALID' : r.pass ? 'PASS' : r.expectedOutcome === 'fail' ? 'FAIL (expected)' : 'FAIL'
      console.log(`${tag} ${r.scenario} #${attempt} ${r.latencyMs}ms ${r.failed.map((f) => f.message).join(' | ')}`.trimEnd())
    }
  const summary = summarize(results, {
    harness: opts.harness,
    model: opts.model ?? null,
    authMode: auth.mode,
    k: opts.k,
    target: opts.worker ? 'wrangler' : 'fake',
    startedAt,
    finishedAt: new Date().toISOString(),
    skipped,
    semanticJudge: semantic?.calibration ?? null, // null: no semantic assertions in this run
  })
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`${summary.passed}/${summary.attempts} passed, ${summary.expectedFailures} expected failure(s), ${summary.unexpected.length} unexpected, ${summary.invalid.length} invalid, ${skipped.length} skipped → ${out}`)
  return summary.ok ? 0 : 1
}

process.exitCode = await main()
