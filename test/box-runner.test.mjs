// box-runner.mjs end to end: the real runner against a fake Fermi /box gateway
// and a fake one-shot harness (test/fixtures/fake-claude-once.mjs).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { ROOT, assertFakeHarness } from './run-worker.mjs'
import { classifyResult } from '../lib/turn-outcome.mjs'
import { sandboxBackend } from '../harness/sandbox.mjs'

const FAKE = join(ROOT, 'test/fixtures/fake-claude-once.mjs')

// Runs box-runner for one task; resolves with the gateway calls, the fake
// harness's spawn records and the runner's output once the runner exits.
// A `slow` harness stalls until the gateway gets a stuck note.
async function runBox({ mode = 'success', env = {}, runner = join(ROOT, 'box-runner.mjs'), payload = { prompt: 'do it', proof_contract: 'free text' }, envelope, setup } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dmn8-')))
  const work = join(home, 'work')
  mkdirSync(work)
  setup?.(work)
  const bin = join(home, 'claude')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
  assertFakeHarness({ CLAUDE_BIN: bin, ...env }.CLAUDE_BIN) // box-runner falls back to `claude` on PATH
  const calls = []
  let polls = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = req.headers['content-type'] === 'application/json'
      calls.push({ path: req.url, body: json ? JSON.parse(body) : body })
      if (calls.at(-1).body.note?.startsWith('⚠️ possibly stuck')) writeFileSync(join(home, 'stuck'), '')
      const reply = (o) => res.end(JSON.stringify(o))
      if (req.url === '/box/inference-auth') return reply({ ok: true, secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', CPA_API_KEY: 'cpa' } })
      if (req.url === '/box/poll')
        return reply(polls++ ? {} : { task: { id: 't1', payload: JSON.stringify(payload), ...(envelope && { envelope }) } })
      reply({ ok: true })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const child = spawn(process.execPath, [runner], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      FERMI_URL: `http://127.0.0.1:${server.address().port}`,
      FERMI_BOX_TOKEN: 'box-token',
      WORKDIR: work,
      CLAUDE_BIN: bin,
      FAKE_DIR: home,
      FAKE_ONCE: mode,
      FAKE_STALL_FILE: join(home, 'stuck'),
      POLL_MS: '50',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const code = await new Promise((r) => child.on('exit', r))
  server.close()
  const log = join(home, 'once.log')
  const spawns = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  const completes = calls.filter((c) => c.path === '/box/complete').map((c) => c.body)
  const notes = calls.filter((c) => c.path === '/box/report').map((c) => c.body.note)
  return { code, out, home, work, bin, calls, spawns, completes, notes }
}

describe('AC1: exit reasons and results from the fake harness', () => {
  test('success → done with the RESULT: line and the cost', async () => {
    const r = await runBox()
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(r.completes, [{ task_id: 't1', status: 'done', result: 'shipped the fix', inference_cost_usd: 0.4321 }])
    assert.match(r.spawns[0].prompt, /^do it\n/)
    assert.match(r.spawns[0].prompt, /End your final message with a line "RESULT: <one-sentence outcome>"\./)
  })

  test('429 → failed with exit reason `harness api_error 429`, matching the route-health regex', async () => {
    const r = await runBox({ mode: '429' })
    assert.equal(r.code, 0, r.out)
    assert.equal(r.completes.length, 1, r.out)
    const { status, result, inference_cost_usd } = r.completes[0]
    assert.equal(status, 'failed')
    assert.match(result, /^harness api_error 429: API Error: 429 /)
    assert.match(result, /^harness api_error/)
    assert.equal(inference_cost_usd, 0)
  })

  test('spend limit with no status → `harness api_error spend_limit`', async () => {
    const r = await runBox({ mode: 'spend' })
    assert.equal(r.completes[0].status, 'failed', r.out)
    assert.match(r.completes[0].result, /^harness api_error spend_limit: You've hit your monthly spend limit/)
  })

  const failed = async (ev) => {
    const r = await runBox({ mode: 'result', env: { FAKE_ONCE_RESULT: JSON.stringify(ev) } })
    assert.equal(r.completes.length, 1, r.out)
    assert.equal(r.completes[0].status, 'failed', r.out)
    return r.completes[0].result
  }
  const errorResult = (result, extra = {}) => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: null, result, ...extra })

  test('real spend cap blocking compaction (blocking-limit fixture) → `harness api_error spend_limit`', async () => {
    const ev = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/blocking-limit-result.json'), 'utf8'))
    assert.match(await failed(ev), /^harness api_error spend_limit: Prompt is too long · automatic compaction failed/)
  })

  test('rate limit with no status → `harness api_error rate_limit`', async () => {
    assert.match(await failed(errorResult('Claude AI usage limit reached|1760000000')), /^harness api_error rate_limit: Claude AI usage limit reached/)
  })

  test('auth error with no status → `harness api_error auth`', async () => {
    assert.match(await failed(errorResult('Invalid API key · Please run /login')), /^harness api_error auth: Invalid API key/)
  })

  test('auth error with a status → `harness api_error 401`', async () => {
    assert.match(await failed(errorResult('API Error: 401 OAuth token has expired', { api_error_status: 401 })), /^harness api_error 401: API Error: 401/)
  })

  test('API error with no status → `harness api_error api_error`', async () => {
    assert.match(await failed(errorResult('API Error: Overloaded')), /^harness api_error api_error: API Error: Overloaded/)
  })

  test('context overflow is not a route error → `harness context_overflow`', async () => {
    const result = await failed(errorResult('Prompt is too long'))
    assert.match(result, /^harness context_overflow: Prompt is too long/)
    assert.doesNotMatch(result, /^harness api_error/)
  })

  test('crash → failed with `harness exited <code>` and the stderr tail', async () => {
    const r = await runBox({ mode: 'crash' })
    assert.equal(r.completes[0].status, 'failed', r.out)
    assert.equal(r.completes[0].result, 'harness exited 3: boom: harness crashed\n')
  })

  // The sandbox wrapper (sandbox-exec 71, bwrap 1) reports the failed exec instead of spawn's ENOENT.
  test('missing harness binary → `harness exited <code>` naming it, not a runner crash', async () => {
    const r = await runBox({ env: { CLAUDE_BIN: '/nonexistent/claude' } })
    assert.equal(r.code, 0, r.out)
    assert.equal(r.spawns.length, 0)
    assert.equal(r.completes[0].status, 'failed', r.out)
    assert.match(r.completes[0].result, /^harness exited \d+: [^]*\/nonexistent\/claude/)
  })
})

describe('AC2: argv and env for the claude route are unchanged', () => {
  test('claude route argv (origin/main @ 13dec96), CLAUDE_BIN, cwd and env', async () => {
    const r = await runBox()
    assert.equal(r.spawns.length, 1)
    assert.deepEqual(r.spawns[0].argv, [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      join(r.work, '.mcp.json'),
      '--strict-mcp-config',
    ])
    assert.equal(r.spawns[0].cwd, r.work)
    assert.deepEqual(r.spawns[0].env, { IS_SANDBOX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
  })

  test('proxy route: keys harnessEnv() deletes stay out of the harness env', async () => {
    const r = await runBox({ env: { ROUTE: 'codex', CPA_DIR: join(tmpdir(), 'dmn8-cpa'), CPA_BIN: '/usr/bin/true', CLAUDE_CODE_OAUTH_TOKEN: 'leak' } })
    assert.equal(r.completes[0].status, 'done', r.out)
    assert.deepEqual(r.spawns[0].env, {
      IS_SANDBOX: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
      ANTHROPIC_MODEL: 'gpt-5.6-sol',
    })
  })
})

describe('progress and stuck notes', () => {
  test('`working:` notes count turns and name the last tool; a stall gets one stuck note', async () => {
    const r = await runBox({ mode: 'slow', env: { PROGRESS_MS: '100', STUCK_MS: '2000' } })
    assert.equal(r.completes[0].status, 'done', r.out)
    assert.ok(r.notes.includes('working: turns=2, last tool=Bash'), r.notes.join('\n'))
    const stuck = r.notes.filter((n) => n.startsWith('⚠️ possibly stuck'))
    assert.equal(stuck.length, 1, r.notes.join('\n'))
    assert.match(stuck[0], /^⚠️ possibly stuck: no harness output for \d+s \(turns=2, last tool=Bash\)$/)
  })
})

// Every `result` event the fixtures in test/fixtures/ hold or emit: JSON and
// JSONL files as stored, the fake harnesses by running each of their result paths.
function fixtureResults() {
  const dir = join(ROOT, 'test/fixtures')
  const found = []
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect)
    else if (v?.type === 'result') found.push(v)
  }
  const lines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json')) collect(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    else if (f.endsWith('.jsonl')) collect(lines(readFileSync(join(dir, f), 'utf8')))
  }
  const run = (script, env, input = '') => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'dmn8-fx-'))
    writeFileSync(join(fakeDir, 'turns.log'), '')
    const r = spawnSync(process.execPath, [join(dir, script)], { input, env: { PATH: process.env.PATH, FAKE_DIR: fakeDir, ...env } })
    collect(lines(String(r.stdout)))
  }
  for (const mode of ['success', '429', 'spend']) run('fake-claude-once.mjs', { FAKE_ONCE: mode })
  const drain = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'pending tasks' }] } })
  const interrupt = JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } })
  const FAKE_RESULT = join(dir, 'blocking-limit-result.json')
  run('fake-claude.mjs', { FAKE_RESULT, FAKE_ERRORS: '0' }, `${drain}\n`)
  run('fake-claude.mjs', { FAKE_RESULT, FAKE_DELAY_MS: '60000' }, `${drain}\n${interrupt}\n`)
  return found
}

test("box-runner's inline classifyResult agrees with lib/turn-outcome.mjs on every result fixture", () => {
  const src = readFileSync(join(ROOT, 'box-runner.mjs'), 'utf8').match(/^function classifyResult\(ev\) \{\n[\s\S]*?\n\}$/m)
  assert.ok(src, 'box-runner.mjs defines function classifyResult(ev)')
  const inline = new Function(`${src[0]}\nreturn classifyResult`)()
  const results = fixtureResults()
  const kinds = new Set(results.map((ev) => classifyResult(ev).kind))
  assert.ok(results.length >= 7, `found ${results.length} result fixtures`)
  for (const k of ['ok', 'spend_limit', 'rate_limit', 'unknown_error']) assert.ok(kinds.has(k), `fixtures cover ${k}: ${[...kinds]}`)
  for (const ev of results) {
    const { retryAfterMs, ...lib } = classifyResult(ev)
    assert.deepEqual(inline(ev), lib, JSON.stringify(ev).slice(0, 300))
  }
})

// DMN-54: remote strings (branch, proof command) never reach a shell.
const inlineFn = (name) => {
  const src = readFileSync(join(ROOT, 'box-runner.mjs'), 'utf8').match(new RegExp(`^function ${name}\\(\\w+\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm'))
  assert.ok(src, `box-runner.mjs defines function ${name}`)
  return new Function(`${src[0]}\nreturn ${name}`)()
}

describe('DMN-54: ref validation, argv git and proof commands', () => {
  test('validRef: ref regex edges', () => {
    const validRef = inlineFn('validRef')
    for (const ok of ['main', 'feature/dmn-54', 'release/v1.2.3', 'user/a_b/c', 'HEAD', 'v1.0'])
      assert.equal(validRef(ok), true, ok)
    for (const bad of ['', '-x', '--upload-pack=touch /tmp/p', 'a..b', '..', 'main~1', 'main^', 'main@{1}', 'main; rm -rf /', 'a b', '$(id)', '`id`', 'a\nb', 'a|b', 'a&b', 'mäin', undefined, null, 1, ['main']])
      assert.equal(validRef(bad), false, JSON.stringify(bad))
  })

  test('proofArgv: plain words split to argv; empty or shell syntax → null', () => {
    const proofArgv = inlineFn('proofArgv')
    assert.deepEqual(proofArgv('npm test -- date.test.ts'), ['npm', 'test', '--', 'date.test.ts'])
    assert.deepEqual(proofArgv('npm run lint:readme'), ['npm', 'run', 'lint:readme'])
    for (const bad of ['', '   ', 'true; touch p', 'a && b', 'a | b', 'echo $HOME', 'echo `id`', 'a > f', "echo 'x'", 'a\nb', 'ls *.ts', undefined, ['npm', 'test']])
      assert.equal(proofArgv(bad), null, JSON.stringify(bad))
  })

  test("branch `main; rm -rf /` is rejected before any exec: no harness spawn, task failed", async () => {
    const r = await runBox({ payload: { prompt: 'do it', proof_contract: 'free text', repo: 'o/r', branch: 'main; rm -rf /' } })
    assert.equal(r.code, 0, r.out)
    assert.equal(r.spawns.length, 0)
    assert.equal(r.completes.length, 1, r.out)
    assert.equal(r.completes[0].status, 'failed')
    assert.match(r.completes[0].result, /^invalid branch "main; rm -rf \/"/)
  })

  test('edge: legit ref with slashes → out.diff generated against origin/<ref>', async () => {
    const branch = 'feature/dmn-54.v2'
    const r = await runBox({
      payload: { prompt: 'do it', proof_contract: 'free text', repo: 'o/r', branch },
      setup: (work) => {
        const repo = join(work, 'repo')
        mkdirSync(repo)
        const git = (...a) => {
          const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo })
          assert.equal(g.status, 0, String(g.stderr))
        }
        git('init', '-q')
        writeFileSync(join(repo, 'a.txt'), 'a\n')
        git('add', '.')
        git('commit', '-qm', 'a')
        git('update-ref', `refs/remotes/origin/${branch}`, 'HEAD')
        writeFileSync(join(repo, 'b.txt'), 'dmn54 change\n')
        git('add', '.')
        git('commit', '-qm', 'b')
      },
    })
    assert.equal(r.completes[0].status, 'done', r.out)
    const diff = readFileSync(join(r.work, 'artifacts', 'out.diff'), 'utf8')
    assert.match(diff, /^diff --git a\/b\.txt b\/b\.txt/)
    assert.match(diff, /\+dmn54 change/)
    assert.doesNotMatch(diff, /a\.txt/)
  })

  test('edge: empty proof command → not executed, no corrective rerun, task done', async () => {
    const r = await runBox({ payload: { prompt: 'do it', proof_contract: JSON.stringify({ kind: 'test', cmd: '' }) } })
    assert.equal(r.completes[0].status, 'done', r.out)
    assert.equal(r.spawns.length, 1)
    assert.match(r.out, /proof command "" is empty or not a plain argv/)
  })

  test('proof command with shell syntax never reaches a shell', async () => {
    const r = await runBox({ payload: { prompt: 'do it', proof_contract: JSON.stringify({ kind: 'test', cmd: 'true; touch pwned' }) } })
    assert.equal(r.completes[0].status, 'done', r.out)
    assert.equal(r.spawns.length, 1)
    assert.equal(existsSync(join(r.work, 'pwned')), false)
  })

  test('plain proof command runs via argv: `false` fails → one corrective rerun → failed', async () => {
    const r = await runBox({ payload: { prompt: 'do it', proof_contract: JSON.stringify({ kind: 'test', cmd: 'false' }) } })
    assert.equal(r.spawns.length, 2, r.out)
    assert.equal(r.completes[0].status, 'failed')
    assert.match(r.completes[0].result, /proof contract unsatisfied after corrective rerun: proof command 'false' failed/)
  })

  // bwrap bind-mounts WORKDIR, so the sandboxed agent cannot remove it (rmdir of a mount point is EBUSY).
  test('edge: workdir missing after the run → runner still completes instead of crashing', { skip: process.platform === 'linux' && sandboxBackend() === 'bwrap' && 'bwrap: WORKDIR is a mount point' }, async () => {
    const r = await runBox({ env: { FAKE_RM_CWD: '1' }, payload: { prompt: 'do it', proof_contract: 'free text', repo: 'o/r', branch: 'main' } })
    assert.equal(existsSync(r.work), false)
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(r.completes, [{ task_id: 't1', status: 'done', result: 'shipped the fix', inference_cost_usd: 0.4321 }])
  })
})

describe('DMN-50: the runner verifies the task envelope before the harness runs', () => {
  const KEY = 'ab'.repeat(32)
  test('a forged envelope is refused without spawning; an unsigned task runs with a grace warning', async () => {
    const forged = await runBox({ env: { FERMI_ENVELOPE_KEY: KEY }, envelope: { v: 1, nonce: `${Math.floor(Date.now() / 1000)}.${'0'.repeat(32)}`, sig: 'AAAA' } })
    assert.equal(forged.code, 0, forged.out)
    assert.equal(forged.spawns.length, 0)
    assert.deepEqual(forged.completes, [{ task_id: 't1', status: 'failed', result: 'refused: task envelope: bad signature', inference_cost_usd: 0 }])
    const unsigned = await runBox({ env: { FERMI_ENVELOPE_KEY: KEY } })
    assert.equal(unsigned.spawns.length, 1, unsigned.out)
    assert.ok(unsigned.notes.some((n) => /t1: UNSIGNED TASK ACCEPTED \(grace mode/.test(n)), unsigned.notes.join('\n'))
    assert.equal(unsigned.completes[0].status, 'done')
  })

  // The spawn record itself is written to HOME, so a recorded spawn proves HOME stays writable.
  test('the harness runs in the OS sandbox: it cannot write outside WORKDIR and HOME', { skip: !sandboxBackend() && 'no OS sandbox' }, async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dmn50-out-')))
    try {
      const r = await runBox({ env: { FAKE_PROBE_WRITE: join(outside, 'x') } })
      assert.equal(r.spawns.length, 1, r.out)
      assert.equal(r.spawns[0].probe, process.platform === 'darwin' ? 'EPERM' : 'EROFS')
      assert.equal(existsSync(join(outside, 'x')), false)
      assert.equal(r.completes[0].status, 'done', r.out)
      assert.ok(!r.notes.some((n) => /UNSANDBOXED/i.test(n)), r.notes.join('\n'))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('DMN-54: fermi-runner.service.template is unprivileged and sandboxed', () => {
  const unit = join(ROOT, 'systemd/fermi-runner.service.template')
  const service = () => {
    const text = readFileSync(unit, 'utf8')
    const body = text.split(/^\[Service\]$/m)[1].split(/^\[/m)[0]
    const kv = {}
    for (const line of body.split('\n')) {
      const m = line.match(/^([A-Za-z]+)=(.*)$/)
      if (m) (kv[m[1]] ??= []).push(m[2])
    }
    return kv
  }

  test('User=fermi, NoNewPrivileges, PrivateTmp, ProtectSystem=strict, one writable tree holding WORKDIR', () => {
    const s = service()
    assert.deepEqual(s.User, ['fermi'])
    assert.deepEqual(s.NoNewPrivileges, ['yes'])
    assert.deepEqual(s.PrivateTmp, ['yes'])
    assert.deepEqual(s.ProtectSystem, ['strict'])
    assert.deepEqual(s.ReadWritePaths, ['/var/fermi'])
    const env = Object.fromEntries(s.Environment.map((e) => e.split('=')))
    for (const k of ['WORKDIR', 'HOME', 'CPA_DIR']) assert.ok(env[k].startsWith('/var/fermi/'), `${k}=${env[k]}`)
    // Only the explicitly "+"-privileged helpers (mkdir, power-off) run as root.
    assert.ok(!s.ExecStart[0].startsWith('+'))
    assert.match(s.ExecStartPre[0], /^\+\/usr\/bin\/install -d -o fermi -g fermi .*\/var\/fermi\/work/)
    assert.match(s.ExecStopPost[0], /^\+\/bin\/sh -c /)
  })

  test('ExecStopPost: power off on exit 0, delayed power off on failure, nothing on SIGTERM stop', () => {
    const script = service().ExecStopPost[0].match(/^\+\/bin\/sh -c '(.*)'$/)[1]
    const dir = mkdtempSync(join(tmpdir(), 'dmn54-'))
    writeFileSync(join(dir, 'shutdown'), `#!/bin/sh\necho "$@" >> "${join(dir, 'calls')}"\n`)
    chmodSync(join(dir, 'shutdown'), 0o755)
    const run = (env) => {
      spawnSync('/bin/sh', ['-c', script], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env } })
      const calls = join(dir, 'calls')
      const out = existsSync(calls) ? readFileSync(calls, 'utf8').trim() : ''
      writeFileSync(calls, '')
      return out
    }
    assert.equal(run({ SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0' }), '-h now')
    assert.equal(run({ SERVICE_RESULT: 'exit-code', EXIT_CODE: 'exited', EXIT_STATUS: '1' }), '-h +2')
    assert.equal(run({ SERVICE_RESULT: 'success', EXIT_CODE: 'killed', EXIT_STATUS: 'TERM' }), '')
  })

  test('systemd-analyze verify (when available)', (t) => {
    const probe = spawnSync('systemd-analyze', ['--version'])
    if (probe.error) return t.skip('systemd-analyze not installed')
    const dir = mkdtempSync(join(tmpdir(), 'dmn54-unit-'))
    const file = join(dir, 'fermi-runner.service')
    writeFileSync(file, readFileSync(unit))
    const r = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' })
    // Only syntax errors in our file count; missing binaries/users on a CI host do not.
    const ours = r.stderr.split('\n').filter((l) => l.includes(file) && !/not executable|No such file|Failed to resolve|Unknown user|Command .* is not/.test(l))
    assert.deepEqual(ours, [], r.stderr)
  })
})
