// DMN-16: the evals workflow's guards (.github/workflows/evals.yml) and what scripts/evals-ci.sh
// leaves for upload: only summary.json and compare.md per entry, never transcripts.
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
  assert.equal(refs.length, 5)
  for (const ref of refs) assert.match(ref, /@[0-9a-f]{40}$/, ref)
})

test('the token is only ever an fd: one secret read into the run step, unset before anything starts', () => {
  const uses = [...WF.matchAll(/secrets\.CLAUDE_CODE_OAUTH_TOKEN\b(.*)/g)].map((m) => m[1])
  assert.deepEqual(uses, [" != '' }}", ' }}'], 'the presence check and the run step only')
  assert.match(WF, /EVAL_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}\n/)
  assert.match(WF, /exec 3< <\(printf '%s' "\$EVAL_TOKEN"\)\n\s+unset EVAL_TOKEN\n/)
  assert.match(WF, /CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 bash scripts\/evals-ci\.sh/)
})

test('only the scanned artifacts dir is uploaded', () => {
  const paths = [...WF.matchAll(/\n\s+path: (.*)/g)].map((m) => m[1])
  assert.deepEqual(paths, ['fermi-mcp', '${{ runner.temp }}/evals-artifacts'])
})

test('evals-ci.sh leaves only summary.json and compare.md per entry for upload, and a clean scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn16-ci-'))
  const out = join(dir, 'out')
  const art = join(dir, 'artifacts')
  const r = spawnSync('bash', [join(ROOT, 'scripts/evals-ci.sh'), '--entries', '[{"harness":"fake"},{"harness":"fake","model":"m2"}]', '-k', '2', '--out', out, '--artifacts', art, '--title', 'Evals test', '--scenarios', 'evals/scenarios/examples/*'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const files = (d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(d, join(e.parentPath, e.name))).sort()
  assert.deepEqual(files(art), ['fake-default/compare.md', 'fake-default/summary.json', 'fake-m2/compare.md', 'fake-m2/summary.json'])
  // the transcripts stay in the run dir
  assert.ok(files(out).some((f) => f.endsWith('trace.jsonl')))
  assert.equal(readFileSync(join(out, 'outcome'), 'utf8'), 'success\n')
  const comment = readFileSync(join(out, 'comment.md'), 'utf8')
  assert.match(comment, /^## Evals test: success\n/)
  assert.match(comment, /\| fake \| m2 \| 6\/8 \| 0 \| 0 \| 0 \| 0 \|/)
  assert.match(r.stdout, /scan-secrets: 0 finding\(s\)/)
})

test('evals-ci.sh records a failed run as the outcome and still exits 0 on a clean scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn16-ci-'))
  const out = join(dir, 'out')
  // run.mjs exits 2 on an unknown harness, before writing any results
  const r = spawnSync('bash', [join(ROOT, 'scripts/evals-ci.sh'), '--entries', '[{"harness":"no-such-harness"}]', '-k', '1', '--out', out, '--artifacts', join(dir, 'a'), '--scenarios', 'evals/scenarios/examples/*'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(out, 'outcome'), 'utf8'), 'failure\n')
  assert.ok(!existsSync(join(dir, 'a', 'no-such-harness-default')))
  assert.match(readFileSync(join(out, 'comment.md'), 'utf8'), /no results \(see the run log\)/)
})
