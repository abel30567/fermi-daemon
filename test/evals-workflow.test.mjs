// DMN-16: the evals workflow's guards (.github/workflows/evals.yml), the smoke list (evals/smoke.json)
// and what scripts/evals-ci.sh leaves for upload: never transcripts; publicly only compare.md and summary.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = readFileSync(join(ROOT, '.github/workflows/evals.yml'), 'utf8')

test('PR runs: ready_for_review and synchronize only, drafts and forks skipped, superseded runs cancelled', () => {
  assert.match(WF, /pull_request:\n\s+types: \[ready_for_review, synchronize\]\n/)
  assert.match(WF, /concurrency:\n\s+group: evals-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}\n\s+cancel-in-progress: true\n/)
  const job = WF.match(/\n {4}if: >-\n((?: {6}.*\n)+)/)?.[1]
  assert.ok(job, 'job-level if')
  assert.match(job, /github\.event_name != 'pull_request' \|\|/)
  assert.match(job, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository && !github\.event\.pull_request\.draft/)
})

test('job setup: evals environment, scrubbed subprocess env, actions pinned by SHA', () => {
  assert.match(WF, /\n {4}environment: evals\n/)
  assert.match(WF, /\n {4}runs-on: ubuntu-latest\n/)
  assert.match(WF, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'/)
  const refs = [...WF.matchAll(/\buses: (\S+)/g)].map((m) => m[1])
  assert.equal(refs.length, 10)
  for (const ref of refs) assert.match(ref, /@[0-9a-f]{40}$/, ref)
})

test('the token is only ever an fd: one secret read into the run step, unset before anything starts', () => {
  const uses = [...WF.matchAll(/secrets\.CLAUDE_CODE_OAUTH_TOKEN\b(.*)/g)].map((m) => m[1])
  assert.deepEqual(uses, [" != '' }}", ' }}'], 'the presence check and the run step only')
  assert.match(WF, /EVAL_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}\n/)
  assert.match(WF, /exec 3< <\(printf '%s' "\$EVAL_TOKEN"\)\n\s+unset EVAL_TOKEN\n/)
  assert.match(WF, /CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 bash scripts\/evals-ci\.sh run /)
  // the report job has no environment, so no secret at all
  const report = WF.slice(WF.indexOf('\n  report:\n'))
  assert.doesNotMatch(report, /secrets\.|environment:/)
})

test('weekly: one run cell per pack × harness, each well under the 6 h runner limit, then one report job', () => {
  assert.match(WF, /\n  run:\n {4}needs: plan\n/)
  assert.match(WF, /\n {6}fail-fast: false\n {6}matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}\n/)
  const timeouts = [...WF.matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1]))
  assert.ok(timeouts.every((t) => t <= 240), String(timeouts))
  assert.match(WF, /\n  report:\n {4}needs: \[plan, run\]\n {4}if: \$\{\{ !cancelled\(\) && needs\.plan\.outputs\.ok == 'true' \}\}\n/)
  assert.match(WF, /find evals\/scenarios -mindepth 1 -maxdepth 1 -type d/)
})

test('only scanned dirs are uploaded: the cells for 1 day, the public report for 30', () => {
  const paths = [...WF.matchAll(/\n\s+path: (.*)/g)].map((m) => m[1])
  assert.deepEqual(paths, ['fermi-mcp', '${{ runner.temp }}/evals-cell', '${{ runner.temp }}/evals-cells', '${{ runner.temp }}/evals-artifacts'])
  assert.match(WF, /path: \$\{\{ runner\.temp \}\}\/evals-cell\n {10}if-no-files-found: error\n {10}retention-days: 1\n/)
  assert.match(WF, /path: \$\{\{ runner\.temp \}\}\/evals-artifacts\n {10}if-no-files-found: error\n {10}retention-days: 30\n/)
})

test('the PR smoke is the 15 base scenarios of evals/smoke.json, without their variants', () => {
  const { scenarios } = JSON.parse(readFileSync(join(ROOT, 'evals/smoke.json'), 'utf8'))
  assert.equal(scenarios.length, 15)
  assert.equal(new Set(scenarios).size, 15)
  for (const f of scenarios) assert.ok(existsSync(join(ROOT, f)), f)
  assert.equal(scenarios.filter((f) => f.startsWith('evals/scenarios/critical/')).length, 7)
  assert.equal(scenarios.filter((f) => f.startsWith('evals/scenarios/core/')).length, 8)
  assert.match(WF, /entries=\$\(jq -c '\[\.baseline\]' evals\/matrix\.json\) cells=\$smoke k=3 flags=--no-variants title='Evals smoke'/)
  const out = mkdtempSync(join(tmpdir(), 'dmn16-smoke-'))
  const r = spawnSync('node', [join(ROOT, 'evals/run.mjs'), '--harness', 'fake', '--no-variants', '--out', out, '--scenarios', ...scenarios], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
  assert.equal(summary.scenarios, 15)
  assert.ok(Object.keys(summary.byScenario).every((n) => !n.includes('~')))
})

const files = (d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(d, join(e.parentPath, e.name))).sort()
const ci = (...args) => spawnSync('bash', [join(ROOT, 'scripts/evals-ci.sh'), ...args], { encoding: 'utf8' })

test('evals-ci.sh run leaves results, summary and outcome per cell for the report job, never transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn16-ci-'))
  const out = join(dir, 'out')
  const r = ci('run', '--entry', '{"harness":"fake","model":"m2"}', '--cell', 'examples', '-k', '2', '--out', out, '--artifacts', join(dir, 'cell'), '--scenarios', 'evals/scenarios/examples/*')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(files(join(dir, 'cell')), ['fake-m2/examples/outcome', 'fake-m2/examples/results.json', 'fake-m2/examples/summary.json'])
  assert.equal(readFileSync(join(dir, 'cell/fake-m2/examples/outcome'), 'utf8'), 'success\n')
  // the transcripts stay in the run dir
  assert.ok(files(out).some((f) => f.endsWith('trace.jsonl')))
  assert.match(r.stdout, /scan-secrets: 0 finding\(s\)/)
})

test('evals-ci.sh report joins each harness\'s cells, compares with the baseline and leaves only compare.md and summary.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn16-ci-'))
  const cells = join(dir, 'cells')
  for (const entry of ['{"harness":"fake"}', '{"harness":"fake","model":"m2"}'])
    for (const cell of ['examples', 'control']) {
      const r = ci('run', '--entry', entry, '--cell', cell, '-k', '1', '--out', join(dir, 'o'), '--artifacts', cells, '--scenarios', `evals/scenarios/${cell}/*`)
      assert.equal(r.status, 0, r.stdout + r.stderr)
    }
  const out = join(dir, 'out')
  const art = join(dir, 'artifacts')
  const r = ci('report', '--entries', '[{"harness":"fake"},{"harness":"fake","model":"m2"}]', '--cells', 'examples control', '--in', cells, '--out', out, '--artifacts', art, '--title', 'Evals test')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(files(art), ['fake-default/compare.md', 'fake-default/control/summary.json', 'fake-default/examples/summary.json', 'fake-m2/compare.md', 'fake-m2/control/summary.json', 'fake-m2/examples/summary.json'])
  // the joined run holds both cells' attempts
  assert.equal(JSON.parse(readFileSync(join(out, 'fake-m2/results.json'), 'utf8')).length, 4 + 14)
  assert.equal(readFileSync(join(out, 'outcome'), 'utf8'), 'success\n')
  const comment = readFileSync(join(out, 'comment.md'), 'utf8')
  assert.match(comment, /^## Evals test: success\n/)
  assert.match(comment, /\| fake \| m2 \| examples \| 3\/4 \| 0 \| 0 \| 0 \| 0 \|/)
  assert.match(r.stdout, /scan-secrets: 0 finding\(s\)/)
})

test('evals-ci.sh: a failed or missing cell makes the report\'s outcome failure, and both stages still exit 0 on a clean scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn16-ci-'))
  const cells = join(dir, 'cells')
  // run.mjs exits 2 on an unknown harness, before writing any results
  const r1 = ci('run', '--entry', '{"harness":"no-such-harness"}', '--cell', 'examples', '-k', '1', '--out', join(dir, 'o'), '--artifacts', cells, '--scenarios', 'evals/scenarios/examples/*')
  assert.equal(r1.status, 0, r1.stdout + r1.stderr)
  assert.deepEqual(files(cells), ['no-such-harness-default/examples/outcome'])
  assert.equal(readFileSync(join(cells, 'no-such-harness-default/examples/outcome'), 'utf8'), 'failure\n')
  const out = join(dir, 'out')
  const r2 = ci('report', '--entries', '[{"harness":"no-such-harness"}]', '--cells', 'examples critical', '--in', cells, '--out', out, '--artifacts', join(dir, 'a'))
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
  assert.equal(readFileSync(join(out, 'outcome'), 'utf8'), 'failure\n')
  assert.match(readFileSync(join(out, 'comment.md'), 'utf8'), /\| no-such-harness-default \| \| critical \| no results \(see the job log\) \|/)
})
