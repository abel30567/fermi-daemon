// DMN-16: the evals workflow's guards (.github/workflows/evals.yml), the smoke list (evals/smoke.json)
// and what scripts/evals-ci.sh leaves for upload: never transcripts; publicly only compare.md and summary.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
// DMN-58: the caller's env minus a token fd it may export (the orchestrator's worker wrapper does, by
// design), which evals-ci.sh run would otherwise read as the eval token.
const scrubbed = (env = process.env) => {
  const { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: _, ...rest } = env
  return rest
}
const evalsCi = (args, { env = scrubbed(), stdio } = {}) => spawnSync('bash', [join(ROOT, 'scripts/evals-ci.sh'), ...args], { encoding: 'utf8', env, stdio })
const ci = (...args) => evalsCi(args)

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

// DMN-58: CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR exported by whoever runs the suite.
const FD_VAR = 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
const runCell = (dir) => ['run', '--entry', '{"harness":"fake"}', '--cell', 'examples', '-k', '1', '--out', join(dir, 'out'), '--artifacts', join(dir, 'cell'), '--scenarios', 'evals/scenarios/examples/*']
const tokenFile = (dir, token) => {
  writeFileSync(join(dir, 'token'), token)
  return openSync(join(dir, 'token'), 'r')
}

test('DMN-58 closed fd: the tests ignore it, and evals-ci.sh given it directly still fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn58-'))
  // what a worker's gate run did before: the variable reaches evals-ci.sh, fd 3 is closed there
  const r = evalsCi(runCell(dir), { env: { ...scrubbed(), [FD_VAR]: '3' } })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /Bad file descriptor/)
  assert.ok(!existsSync(join(dir, 'cell')), 'nothing runs without the token it was promised')
})

test('DMN-58 valid readable fd: the tests do not hand an inherited one to evals-ci.sh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn58-'))
  const fd = tokenFile(dir, 'dmn58-inherited-token')
  const saved = process.env[FD_VAR]
  process.env[FD_VAR] = '3'
  try {
    const r = evalsCi(runCell(dir), { stdio: ['ignore', 'pipe', 'pipe', fd] })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(readFileSync(join(dir, 'cell/fake-default/examples/outcome'), 'utf8'), 'success\n')
    assert.doesNotMatch(r.stdout, /with the token/)
  } finally {
    if (saved === undefined) delete process.env[FD_VAR]
    else process.env[FD_VAR] = saved
    closeSync(fd)
  }
})

test('DMN-58 valid readable fd, used for real: the token reaches run.mjs and the scan on fresh fds, never argv, env or logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn58-'))
  const token = 'dmn58-handoff-token-7f3a9c'
  const fd = tokenFile(dir, token)
  // a `node` shim on PATH records what evals-ci.sh hands evals/run.mjs; everything else runs on the real node
  const bin = join(dir, 'bin')
  const probe = join(dir, 'probe')
  mkdirSync(bin)
  mkdirSync(probe)
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = evals/run.mjs ]; then',
      '  printf "%s\\n" "$*" > "$PROBE/argv"',
      '  env > "$PROBE/env"',
      '  cat <&"$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" > "$PROBE/fd"',
      '  { : <&5; } 2>/dev/null && echo open > "$PROBE/fd5" || echo closed > "$PROBE/fd5"',
      '  exit 0',
      'fi',
      'exec "$REAL_NODE" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // the original fd is 5, so the fresh pipe (3) is distinguishable from it
  const env = { ...scrubbed(), [FD_VAR]: '5', PATH: `${bin}:${process.env.PATH}`, PROBE: probe, REAL_NODE: process.execPath }
  const r = evalsCi(runCell(dir), { env, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', fd] })
  closeSync(fd)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /scan-secrets: 0 finding\(s\) .*\(with the token\)/)
  assert.equal(readFileSync(join(probe, 'fd'), 'utf8'), token)
  assert.equal(readFileSync(join(probe, 'fd5'), 'utf8'), 'closed\n')
  const argv = readFileSync(join(probe, 'argv'), 'utf8')
  assert.match(argv, /--auth fd --judge-auth fd/)
  assert.ok(!argv.includes(token), 'argv')
  const childEnv = readFileSync(join(probe, 'env'), 'utf8')
  assert.match(childEnv, new RegExp(`^${FD_VAR}=3$`, 'm'))
  assert.ok(!childEnv.includes(token), 'env')
  for (const d of ['out', 'cell']) for (const f of files(join(dir, d))) assert.ok(!readFileSync(join(dir, d, f), 'utf8').includes(token), f)
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), 'output')
})

test('DMN-58 exported but empty: evals-ci.sh runs without auth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn58-'))
  const r = evalsCi(runCell(dir), { env: { ...scrubbed(), [FD_VAR]: '' } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(dir, 'cell/fake-default/examples/outcome'), 'utf8'), 'success\n')
  assert.doesNotMatch(r.stdout, /with the token/)
})

test('DMN-58 inherited by nested child processes: a nested run of these tests passes with the variable on a closed fd, a valid fd or empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn58-'))
  const fd = tokenFile(dir, 'dmn58-nested-token')
  const { NODE_TEST_CONTEXT: _, ...base } = process.env
  const cases = [
    ['closed fd', '3', undefined],
    ['valid fd', '3', ['ignore', 'pipe', 'pipe', fd]],
    ['empty', '', undefined],
  ]
  try {
    for (const [label, value, stdio] of cases) {
      const r = spawnSync(process.execPath, ['--test-reporter=tap', '--test-name-pattern=^evals-ci\\.sh run leaves', fileURLToPath(import.meta.url)], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...base, [FD_VAR]: value },
        stdio,
      })
      assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`)
      assert.match(r.stdout, /^# pass 1$/m, label)
      assert.match(r.stdout, /^# fail 0$/m, label)
    }
  } finally {
    closeSync(fd)
  }
})
