// box-runner.mjs end to end: the real runner against a fake Fermi /box gateway
// and a fake one-shot harness (test/fixtures/fake-claude-once.mjs).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { ROOT } from './run-worker.mjs'

const FAKE = join(ROOT, 'test/fixtures/fake-claude-once.mjs')

// Runs box-runner for one task; resolves with the gateway calls, the fake
// harness's spawn records and the runner's output once the runner exits.
async function runBox({ mode = 'success', env = {}, runner = join(ROOT, 'box-runner.mjs') } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dmn8-')))
  const work = join(home, 'work')
  mkdirSync(work)
  const bin = join(home, 'claude')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
  const calls = []
  let polls = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = req.headers['content-type'] === 'application/json'
      calls.push({ path: req.url, body: json ? JSON.parse(body) : body })
      const reply = (o) => res.end(JSON.stringify(o))
      if (req.url === '/box/inference-auth') return reply({ ok: true, secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', CPA_API_KEY: 'cpa' } })
      if (req.url === '/box/poll')
        return reply(polls++ ? {} : { task: { id: 't1', payload: JSON.stringify({ prompt: 'do it', proof_contract: 'free text' }) } })
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
  return { code, out, work, bin, spawns, completes, notes }
}

describe('AC1: exit reasons and results from the fake harness', { concurrency: true }, () => {
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

  test('spend limit with no status → `harness spend_limit`', async () => {
    const r = await runBox({ mode: 'spend' })
    assert.equal(r.completes[0].status, 'failed', r.out)
    assert.match(r.completes[0].result, /^harness spend_limit: You've hit your monthly spend limit/)
  })

  test('crash → failed with `harness exited <code>` and the stderr tail', async () => {
    const r = await runBox({ mode: 'crash' })
    assert.equal(r.completes[0].status, 'failed', r.out)
    assert.equal(r.completes[0].result, 'harness exited 3: boom: harness crashed\n')
  })

  test('missing harness binary → `harness exited 127`, not a runner crash', async () => {
    const r = await runBox({ env: { CLAUDE_BIN: '/nonexistent/claude' } })
    assert.equal(r.code, 0, r.out)
    assert.equal(r.spawns.length, 0)
    assert.equal(r.completes[0].status, 'failed', r.out)
    assert.match(r.completes[0].result, /^harness exited 127: Error: spawn \/nonexistent\/claude ENOENT/)
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
    const r = await runBox({ mode: 'slow', env: { FAKE_STALL_MS: '1500', PROGRESS_MS: '100', STUCK_MS: '600' } })
    assert.equal(r.completes[0].status, 'done', r.out)
    assert.ok(r.notes.includes('working: turns=2, last tool=Bash'), r.notes.join('\n'))
    const stuck = r.notes.filter((n) => n.startsWith('⚠️ possibly stuck'))
    assert.equal(stuck.length, 1, r.notes.join('\n'))
    assert.match(stuck[0], /^⚠️ possibly stuck: no harness output for \d+s \(turns=2, last tool=Bash\)$/)
  })
})
