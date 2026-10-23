// Re-grade a finished run from its recorded traces and state with the current
// assertions and semantic judge, without re-running the harness (evals/judge.mjs --regrade).
//
// Every results.json entry is graded again from <run>/<scenario>/<attempt>/trace.jsonl
// and state.json with its scenario's current `expect`. The runner's own failures
// (timeout, error turns, isolation breach: `assertion: null`) are kept as recorded.
// Kept as recorded too: an invalid or setup_error attempt (never graded), one whose runner errored
// (it may have no state), and the assertions whose input is never written to the
// attempt dir (NOT_REPLAYABLE: the canary, per-task latencies).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluate, semanticOutcome } from './assertions.mjs'
import { judgeSemantic } from './semantic.mjs'

export const NOT_REPLAYABLE = ['noCanaryLeak', 'latencyDrift']

const SOURCES = ['./assertions.mjs', './semantic.mjs'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))

// The assertions an entry was graded with: the grading code and the scenario's expect.
export const assertionsVersion = (expect) => createHash('sha256').update(JSON.stringify([...SOURCES, expect])).digest('hex').slice(0, 12)

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const readTrace = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// → the regraded results.json entries. `scenarios` maps a scenario name to the loaded
// scenario; `judge`: lib/semantic.mjs createSemanticJudge() (null: regex only, "disabled").
export async function regradeRun(runDir, scenarios, { judge = null, now = new Date() } = {}) {
  const results = readJson(join(runDir, 'results.json'))
  const missing = [...new Set(results.map((r) => r.scenario).filter((n) => !scenarios[n]))]
  if (missing.length) throw new Error(`no scenario file for ${missing.join(', ')}`)
  const regradedAt = now.toISOString()
  const out = []
  for (const r of results) {
    const s = scenarios[r.scenario]
    const stamp = { regradedAt, assertionsVersion: assertionsVersion(s.expect) }
    if (r.status === 'invalid' || r.status === 'setup_error' || r.errorKinds?.includes('runner_error')) {
      out.push({ ...r, ...stamp })
      continue
    }
    const dir = join(runDir, r.scenario, String(r.attempt))
    const trace = readTrace(join(dir, 'trace.jsonl'))
    const ctx = { trace, state: readJson(join(dir, 'state.json')), scenario: s, latencyMs: r.latencyMs }
    ctx.semantic = await judgeSemantic(s.expect, trace, judge)
    const failed = []
    for (const a of s.expect)
      if (NOT_REPLAYABLE.includes(Object.keys(a)[0])) failed.push(...r.failed.filter((f) => f.assertion && same(f.assertion, a)))
      else failed.push(...evaluate([a], ctx))
    failed.push(...r.failed.filter((f) => f.assertion === null))
    const { semantic: _, ...rest } = r
    out.push({
      ...rest,
      pass: failed.length === 0,
      failed: failed.map((f) => ({ assertion: f.assertion, message: f.message })),
      ...(ctx.semantic.size && { semantic: [...ctx.semantic.keys()].map((spec) => semanticOutcome(spec, ctx)) }),
      ...stamp,
    })
  }
  return out
}
