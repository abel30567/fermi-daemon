#!/usr/bin/env node
// Compare two eval runs (a baseline harness and a candidate) and decide the swap
// gate. See evals/README.md.
//
//   node evals/compare.mjs <baseline results.json> <candidate results.json> [--out <dir>]
//
// Prints the markdown report and writes <out>/compare.md and <out>/compare.json
// (default out: the candidate's directory). If a run's directory has a judge.json
// (evals/judge.mjs), its mean quality score is reported; it never gates.
// Invalid attempts (status "invalid", infrastructure-limited: evals/lib/runner.mjs) are
// left out of every rate and counted per category; when more than 10% of a category's
// attempts in either run are invalid, the verdict is INCONCLUSIVE.
// Setup errors (status "setup_error": a seeded fixture section never landed on the eval
// target) are left out of every rate the same way and counted per category.
// A category with a graded attempt whose semantic assertion ran with the judge
// disabled (judge: "disabled", calibration below 97%: evals/lib/semantic.mjs) is
// INCONCLUSIVE too: that attempt was graded on the regex alone.
// Exit 0 on GO, 1 on NO-GO, 2 on a usage error, 3 on INCONCLUSIVE.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The swap gate's thresholds and the categories it reads.
export const GATE = {
  k: 5, // critical needs pass^5 = 100%
  criticalCategory: 'critical',
  coreCategory: 'core',
  nonInferiorityMargin: -0.05, // lower 95% bound of (candidate − baseline) core pass rate must exceed this
  maxP95LatencyRatio: 1.25,
  maxCostRatio: 1.5,
  soakCategory: 'endurance', // evals/scenarios/endurance/ (DMN-14)
  credentialCategory: 'credential-isolation',
  maxInvalidShare: 0.1, // more invalid attempts than this in a category → INCONCLUSIVE
}

export const SEMANTIC_DISABLED = 'semantic judge disabled (calibration < 97%)'
const semanticDisabled = (r) => (r.semantic ?? []).some((s) => s.judge === 'disabled')

// Failed assertions that mean the delivery protocol (claim → one reply to the
// task's chat → complete) was broken, not just a weaker answer.
export const PROTOCOL_ASSERTIONS = ['order', 'exactlyOnce', 'outbox.count', 'task.status']

const Z95 = 1.959963984540054

// Wilson score interval for s successes out of n (95% by default).
export function wilson(s, n, z = Z95) {
  if (!n) return null
  const p = s / n
  const z2 = z * z
  const den = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

// 95% interval for p1 − p2 (Newcombe's hybrid score method, from the Wilson intervals).
export function diffInterval(s1, n1, s2, n2) {
  if (!n1 || !n2) return null
  const p1 = s1 / n1
  const p2 = s2 / n2
  const w1 = wilson(s1, n1)
  const w2 = wilson(s2, n2)
  const d = p1 - p2
  return { diff: d, lo: d - Math.hypot(p1 - w1.lo, w2.hi - p2), hi: d + Math.hypot(w1.hi - p1, p2 - w2.lo) }
}

const choose = (n, k) => {
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return r
}

// Unbiased pass^k estimate for one scenario: P(k attempts drawn from its n all pass). null if n < k.
export function passK(passes, attempts, k) {
  return attempts < k ? null : choose(passes, k) / choose(attempts, k)
}

// Nearest-rank percentile.
export function percentile(xs, q) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

const ratio = (a, b) => (a == null || b == null ? null : b === 0 ? (a === 0 ? 1 : Infinity) : a / b)
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null)

// Negative controls (expectedOutcome "fail") grade the grader, not the harness, so they are left out.
// Invalid and setup_error attempts were never graded, so they are left out too (and counted per category).
const controls = (results) => results.filter((r) => r.expectedOutcome !== 'fail')
const invalid = (r) => r.status === 'invalid'
const setupError = (r) => r.status === 'setup_error'
const graded = (results) => controls(results).filter((r) => !invalid(r) && !setupError(r))

function categories(results, k, judge) {
  const out = {}
  for (const r of controls(results)) {
    const c = (out[r.category ?? 'uncategorized'] ??= { attempts: 0, passes: 0, invalidAttempts: 0, setupErrorAttempts: 0, semanticDisabledAttempts: 0, scenarios: {} })
    if (invalid(r)) {
      c.invalidAttempts++
      continue
    }
    if (setupError(r)) {
      c.setupErrorAttempts++
      continue
    }
    c.attempts++
    if (semanticDisabled(r)) c.semanticDisabledAttempts++
    if (r.pass) c.passes++
    const s = (c.scenarios[r.scenario] ??= { attempts: 0, passes: 0 })
    s.attempts++
    if (r.pass) s.passes++
  }
  for (const [name, c] of Object.entries(out)) {
    const per = Object.values(c.scenarios).map((s) => passK(s.passes, s.attempts, k))
    c.passRate = c.attempts ? c.passes / c.attempts : null
    c.wilson = wilson(c.passes, c.attempts)
    c.passK = !per.length || per.some((v) => v == null) ? null : mean(per)
    c.minAttempts = per.length ? Math.min(...Object.values(c.scenarios).map((s) => s.attempts)) : 0
    c.invalidShare = c.invalidAttempts / (c.attempts + c.invalidAttempts)
    const scores = (judge ?? []).filter((j) => (j.category ?? 'uncategorized') === name && j.score != null && c.scenarios[j.scenario]).map((j) => j.score)
    c.judgeScore = mean(scores)
  }
  return out
}

function runStats(results) {
  const g = graded(results)
  const costs = g.map((r) => r.costUsd)
  const errorKinds = {}
  for (const r of g) for (const k of r.errorKinds ?? []) errorKinds[k] = (errorKinds[k] ?? 0) + 1
  const lat = g.map((r) => r.latencyMs)
  return {
    attempts: g.length,
    p50LatencyMs: percentile(lat, 0.5),
    p95LatencyMs: percentile(lat, 0.95),
    // Unknown when any attempt has no cost: a partial mean would understate it.
    costPerTaskUsd: costs.length && costs.every((c) => c != null) ? mean(costs) : null,
    toolCallsPerTask: mean(g.map((r) => r.toolCalls?.length ?? 0)),
    errorKinds,
    protocolViolations: g.filter((r) => (r.failed ?? []).some((f) => f.assertion && PROTOCOL_ASSERTIONS.includes(Object.keys(f.assertion)[0]))).length,
  }
}

const allPass = (c) => (c ? c.attempts > 0 && c.passes === c.attempts : false)

// Compare two runs' results.json arrays. Returns the full report as JSON.
export function compare(baseline, candidate, { k = GATE.k, judge = {} } = {}) {
  const cats = { baseline: categories(baseline, k, judge.baseline), candidate: categories(candidate, k, judge.candidate) }
  const stats = { baseline: runStats(baseline), candidate: runStats(candidate) }
  const B = cats.baseline
  const C = cats.candidate
  const core = B[GATE.coreCategory] && C[GATE.coreCategory] ? diffInterval(C[GATE.coreCategory].passes, C[GATE.coreCategory].attempts, B[GATE.coreCategory].passes, B[GATE.coreCategory].attempts) : null
  const ratios = {
    p50Latency: ratio(stats.candidate.p50LatencyMs, stats.baseline.p50LatencyMs),
    p95Latency: ratio(stats.candidate.p95LatencyMs, stats.baseline.p95LatencyMs),
    cost: ratio(stats.candidate.costPerTaskUsd, stats.baseline.costPerTaskUsd),
    toolCalls: ratio(stats.candidate.toolCallsPerTask, stats.baseline.toolCallsPerTask),
  }
  const crit = C[GATE.criticalCategory]
  const fmt = (x, d = 2) => (x == null ? 'n/a' : Number.isFinite(x) ? x.toFixed(d) : String(x))
  const rules = [
    {
      rule: 'critical',
      label: `critical pass^${k} = 100%`,
      pass: !!crit && crit.minAttempts >= k && crit.passK === 1,
      detail: !crit ? 'no critical results' : crit.minAttempts < k ? `a scenario has ${crit.minAttempts} < ${k} attempts` : `pass^${k} = ${fmt(crit.passK, 3)}`,
    },
    {
      rule: 'core',
      label: `core non-inferior (lower 95% bound > ${GATE.nonInferiorityMargin * 100} pp)`,
      pass: !!core && core.lo > GATE.nonInferiorityMargin,
      detail: core ? `diff ${fmt(core.diff * 100, 1)} pp, 95% CI [${fmt(core.lo * 100, 1)}, ${fmt(core.hi * 100, 1)}] pp` : 'core missing in a run',
    },
    {
      rule: 'latency',
      label: `p95 latency ≤ ${GATE.maxP95LatencyRatio}×`,
      pass: ratios.p95Latency != null && ratios.p95Latency <= GATE.maxP95LatencyRatio,
      detail: `${fmt(ratios.p95Latency)}×`,
    },
    {
      rule: 'cost',
      label: `cost ≤ ${GATE.maxCostRatio}×`,
      pass: ratios.cost != null && ratios.cost <= GATE.maxCostRatio,
      detail: ratios.cost == null ? 'cost unknown in a run' : `${fmt(ratios.cost)}×`,
    },
    {
      rule: 'protocol',
      label: 'zero protocol violations',
      pass: stats.candidate.protocolViolations === 0,
      detail: `${stats.candidate.protocolViolations} attempt(s)`,
    },
    { rule: 'soak', label: 'soak passes', pass: allPass(C[GATE.soakCategory]), detail: C[GATE.soakCategory] ? `${C[GATE.soakCategory].passes}/${C[GATE.soakCategory].attempts}` : `no ${GATE.soakCategory} results` },
    {
      rule: 'credentials',
      label: 'credential isolation passes',
      pass: allPass(C[GATE.credentialCategory]),
      detail: C[GATE.credentialCategory] ? `${C[GATE.credentialCategory].passes}/${C[GATE.credentialCategory].attempts}` : `no ${GATE.credentialCategory} results`,
    },
  ]
  const inconclusive = Object.entries(cats).flatMap(([run, cs]) =>
    Object.entries(cs)
      .filter(([, c]) => c.invalidShare > GATE.maxInvalidShare)
      .map(([category, c]) => ({ run, category, invalidAttempts: c.invalidAttempts, attempts: c.attempts + c.invalidAttempts })),
  )
  for (const [run, cs] of Object.entries(cats))
    for (const [category, c] of Object.entries(cs))
      if (c.semanticDisabledAttempts) inconclusive.push({ run, category, reason: SEMANTIC_DISABLED, semanticDisabledAttempts: c.semanticDisabledAttempts, attempts: c.attempts })
  return {
    k,
    gate: GATE,
    categories: cats,
    stats,
    ratios,
    coreDiff: core,
    rules,
    verdict: inconclusive.length ? 'INCONCLUSIVE' : rules.every((r) => r.pass) ? 'GO' : 'NO-GO',
    inconclusive,
    failedRules: rules.filter((r) => !r.pass).map((r) => r.rule),
  }
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
const ci = (w) => (w ? `[${pct(w.lo)}, ${pct(w.hi)}]` : 'n/a')
const num = (x, d = 2) => (x == null ? 'n/a' : Number.isFinite(x) ? x.toFixed(d) : String(x))
const setupErrors = (cs) => Object.values(cs).reduce((a, c) => a + c.setupErrorAttempts, 0)
const times = (x) => (x == null ? 'n/a' : `${num(x)}×`)

export function verdictLine(report) {
  if (report.verdict === 'INCONCLUSIVE') {
    const inv = report.inconclusive.filter((x) => !x.reason)
    const sem = report.inconclusive.filter((x) => x.reason === SEMANTIC_DISABLED)
    const why = [
      inv.length && `> ${pct(GATE.maxInvalidShare)} invalid: ${inv.map((x) => `${x.run} ${x.category} ${x.invalidAttempts}/${x.attempts}`).join(', ')}`,
      sem.length && `${SEMANTIC_DISABLED}: ${sem.map((x) => `${x.run} ${x.category} ${x.semanticDisabledAttempts}/${x.attempts}`).join(', ')}`,
    ].filter(Boolean)
    return `**Swap gate: INCONCLUSIVE** (${why.join('; ')})`
  }
  return report.verdict === 'GO' ? '**Swap gate: GO**' : `**Swap gate: NO-GO** (failed: ${report.failedRules.join(', ')})`
}

export function renderMarkdown(report) {
  const { categories: cats, stats, ratios, k } = report
  const names = [...new Set([...Object.keys(cats.baseline), ...Object.keys(cats.candidate)])].sort()
  const cell = (c, f) => (c ? f(c) : '–')
  const kinds = [...new Set([...Object.keys(stats.baseline.errorKinds), ...Object.keys(stats.candidate.errorKinds)])].sort()
  const lines = [
    '# Eval comparison: baseline vs candidate',
    '',
    verdictLine(report),
    '',
    '## Per category',
    '',
    `| category | baseline pass | baseline 95% CI | baseline pass^${k} | candidate pass | candidate 95% CI | candidate pass^${k} | judge (b / c) | invalid (b / c) |`,
    '|---|---|---|---|---|---|---|---|---|',
    ...names.map((n) => {
      const b = cats.baseline[n]
      const c = cats.candidate[n]
      const frac = (x) => `${x.passes}/${x.attempts} (${pct(x.passRate)})`
      return `| ${n} | ${cell(b, frac)} | ${cell(b, (x) => ci(x.wilson))} | ${cell(b, (x) => pct(x.passK))} | ${cell(c, frac)} | ${cell(c, (x) => ci(x.wilson))} | ${cell(c, (x) => pct(x.passK))} | ${num(b?.judgeScore)} / ${num(c?.judgeScore)} | ${b?.invalidAttempts ?? '–'} / ${c?.invalidAttempts ?? '–'} |`
    }),
    '',
    `Setup errors (seed did not land, never graded): baseline ${setupErrors(cats.baseline)}, candidate ${setupErrors(cats.candidate)}`,
    '',
    '## Latency, cost, tool calls',
    '',
    '| metric | baseline | candidate | ratio |',
    '|---|---|---|---|',
    `| p50 latency (ms) | ${num(stats.baseline.p50LatencyMs, 0)} | ${num(stats.candidate.p50LatencyMs, 0)} | ${times(ratios.p50Latency)} |`,
    `| p95 latency (ms) | ${num(stats.baseline.p95LatencyMs, 0)} | ${num(stats.candidate.p95LatencyMs, 0)} | ${times(ratios.p95Latency)} |`,
    `| cost per task (USD) | ${num(stats.baseline.costPerTaskUsd, 4)} | ${num(stats.candidate.costPerTaskUsd, 4)} | ${times(ratios.cost)} |`,
    `| tool calls per task | ${num(stats.baseline.toolCallsPerTask)} | ${num(stats.candidate.toolCallsPerTask)} | ${times(ratios.toolCalls)} |`,
    `| protocol violations | ${stats.baseline.protocolViolations} | ${stats.candidate.protocolViolations} | |`,
    '',
    '## Error kinds',
    '',
    '| kind | baseline | candidate |',
    '|---|---|---|',
    ...(kinds.length ? kinds.map((e) => `| ${e} | ${stats.baseline.errorKinds[e] ?? 0} | ${stats.candidate.errorKinds[e] ?? 0} |`) : ['| none | 0 | 0 |']),
    '',
    '## Swap gate',
    '',
    '| rule | result | detail |',
    '|---|---|---|',
    ...report.rules.map((r) => `| ${r.label} | ${r.pass ? 'pass' : 'FAIL'} | ${r.detail} |`),
    '',
    verdictLine(report),
    '',
  ]
  return lines.join('\n')
}

function main(argv) {
  const files = []
  let out
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && i + 1 < argv.length) out = argv[++i]
    else if (argv[i].startsWith('-')) return usage(`unknown argument ${argv[i]}`)
    else files.push(argv[i])
  }
  if (files.length !== 2) return usage('needs <baseline results.json> <candidate results.json>')
  let runs
  try {
    runs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')))
  } catch (err) {
    return usage(err.message)
  }
  if (!runs.every(Array.isArray)) return usage('a results file is not a results.json array')
  const judgeOf = (f) => {
    const p = join(dirname(f), 'judge.json')
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
  }
  const report = compare(runs[0], runs[1], { judge: { baseline: judgeOf(files[0]), candidate: judgeOf(files[1]) } })
  const md = renderMarkdown(report)
  out ??= dirname(files[1])
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'compare.md'), md)
  writeFileSync(join(out, 'compare.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(md)
  return report.verdict === 'GO' ? 0 : report.verdict === 'INCONCLUSIVE' ? 3 : 1
}

function usage(msg) {
  console.error(`compare: ${msg}\nusage: node evals/compare.mjs <baseline results.json> <candidate results.json> [--out <dir>]`)
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2))
