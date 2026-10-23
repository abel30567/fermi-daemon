#!/usr/bin/env node
// Live behavioural evals: run the daemon drain against an isolated local Fermi and
// grade the normalized trace and the resulting state. See evals/README.md.
//
//   node evals/run.mjs --harness <adapter|fake> [--model <id>] --scenarios <glob>... \
//     [-k <n>] [--out <dir>] [--worker <fermi-mcp checkout>] [--timeout-ms <ms>] [--fake-script <key>]
//
// Exit 0 when every attempt's outcome is the expected one, 1 otherwise, 2 on a
// usage error or a non-localhost URL.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadHarness } from '../harness/index.mjs'
import { assertLocalUrls } from './lib/net.mjs'
import { runAttempt, summarize } from './lib/runner.mjs'
import { expandScenarios, expandVariants, loadScenario } from './lib/scenario.mjs'

// URL-valued env the runner, wrangler or the harness would inherit. Any of them
// pointing off-box means production could be reached, so the run refuses to start.
const GUARDED_ENV = ['FERMI_URL', 'MACOS_MCP_URL', 'SLACK_API_BASE', 'TELEGRAM_API_BASE', 'DISCORD_API_BASE', 'TWILIO_API_BASE', 'ANTHROPIC_API_BASE']

function parseArgs(argv) {
  const o = { k: 1, scenarios: [], timeoutMs: 300_000 }
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
    else if (a === '--fake-script') o.fakeScript = val()
    else if (a === '--scenarios') {
      o.scenarios.push(val())
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) o.scenarios.push(argv[++i])
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!o.harness) throw new Error('--harness is required')
  if (!o.scenarios.length) throw new Error('--scenarios is required')
  if (!(Number.isInteger(o.k) && o.k > 0)) throw new Error('-k must be a positive integer')
  // Only the fake harness may run against the in-process fake target; real grades need the eval worker.
  if (o.harness !== 'fake' && !o.worker) throw new Error(`--harness ${o.harness} needs --worker <fermi-mcp checkout>`)
  if (o.fakeScript && o.harness !== 'fake') throw new Error('--fake-script needs --harness fake')
  return o
}

// --fake-script <key>: play `fake.<key>` (a scripted misbehaviour, e.g. "negative")
// instead of `fake.script`; every such attempt is expected to fail its assertions.
function withFakeScript(s, key) {
  if (!Array.isArray(s.fake?.[key])) throw new Error(`${s.name}: no fake.${key} script`)
  return { ...s, fake: { ...s.fake, script: s.fake[key] }, expectOutcome: 'fail' }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
    assertLocalUrls(Object.fromEntries(GUARDED_ENV.map((k) => [k, process.env[k] || null])))
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
  // A scenario that lists `harnesses` only runs under those; elsewhere it is reported as skipped.
  const skipped = scenarios
    .filter((s) => s.harnesses && !s.harnesses.includes(opts.harness))
    .map((s) => ({ scenario: s.name, reason: `harnesses: ${s.harnesses.join(', ')}` }))
  scenarios = scenarios.filter((s) => !s.harnesses || s.harnesses.includes(opts.harness))
  for (const s of skipped) console.log(`SKIP ${s.scenario} (${s.reason})`)
  const harness = opts.harness === 'fake' ? await import('./harness/fake.mjs') : await loadHarness(opts.harness)
  const out = opts.out ?? join('runs', `evals-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(out, { recursive: true })

  const startedAt = new Date().toISOString()
  const results = []
  for (const scenario of scenarios)
    for (let attempt = 1; attempt <= opts.k; attempt++) {
      const r = await runAttempt({ scenario, attempt, harness, model: opts.model, worker: opts.worker, timeoutMs: opts.timeoutMs, outDir: out })
      results.push(r)
      const tag = r.pass ? 'PASS' : r.expectedOutcome === 'fail' ? 'FAIL (expected)' : 'FAIL'
      console.log(`${tag} ${r.scenario} #${attempt} ${r.latencyMs}ms ${r.failed.map((f) => f.message).join(' | ')}`.trimEnd())
    }
  const summary = summarize(results, {
    harness: opts.harness,
    model: opts.model ?? null,
    k: opts.k,
    target: opts.worker ? 'wrangler' : 'fake',
    startedAt,
    finishedAt: new Date().toISOString(),
    skipped,
  })
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`${summary.passed}/${summary.attempts} passed, ${summary.expectedFailures} expected failure(s), ${summary.unexpected.length} unexpected, ${skipped.length} skipped → ${out}`)
  return summary.ok ? 0 : 1
}

process.exitCode = await main()
