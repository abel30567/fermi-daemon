import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, runWorker } from './run-worker.mjs'

const RUN_ONCE = join(ROOT, 'bin/run-once.mjs')
const FAKE_ONCE = join(ROOT, 'test/fixtures/fake-claude-once.mjs')
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Runs bin/run-once.mjs as poll.sh does (cwd = daemon home, a claimed lane)
// against fake-claude-once.mjs. `act(child, dir)` runs while it is up.
async function runOnceCli({ args = [], env = {}, act } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dmn7-'))
  mkdirSync(join(dir, 'prompts'))
  mkdirSync(join(dir, 'runs'))
  mkdirSync(join(dir, 'lanes/1'), { recursive: true })
  writeFileSync(join(dir, 'prompts/drain.md'), 'drain the queue\n')
  const bin = join(dir, 'claude')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ONCE}" "$@"\n`)
  chmodSync(bin, 0o755)
  const child = spawn(
    process.execPath,
    [RUN_ONCE, '--prompt', 'prompts/drain.md', '--log', 'runs/r.log', '--lane', join(dir, 'lanes/1'), ...args],
    { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CLAUDE_BIN: bin, FAKE_DIR: dir, ...env }, stdio: 'ignore' },
  )
  writeFileSync(join(dir, 'lanes/1/pid'), String(child.pid))
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  await act?.(child, dir)
  const { code } = await exited
  const log = existsSync(join(dir, 'runs/r.log')) ? readFileSync(join(dir, 'runs/r.log'), 'utf8') : ''
  const spawns = existsSync(join(dir, 'once.log'))
    ? readFileSync(join(dir, 'once.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : []
  const harnessPid = Number(log.match(/^run-once: harness pid (\d+)$/m)?.[1])
  return { dir, code, log, spawns, harnessPid, laneGone: !existsSync(join(dir, 'lanes/1')) }
}

const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)

describe('AC1: cold argv has the warm worker\'s settings surface', () => {
  test('setting sources and allowed tools match a live warm spawn; no skip-permissions', async () => {
    const [warm, cold] = await Promise.all([
      runWorker({ result: SUCCESS, pending: 0, durationMs: 1000 }),
      runOnceCli({ args: ['--model', 'claude-opus-4-6[1m]', '--max-turns', '50', '--timeout-s', '60'] }),
    ])
    const warmArgv = warm.events.find((e) => e.kind === 'spawn').argv
    assert.equal(cold.spawns.length, 1, cold.log)
    const coldArgv = cold.spawns[0].argv
    for (const f of ['--setting-sources', '--allowedTools']) {
      assert.ok(flag(warmArgv, f), `warm argv has ${f}`)
      assert.equal(flag(coldArgv, f), flag(warmArgv, f), f)
    }
    assert.ok(!coldArgv.includes('--dangerously-skip-permissions'))
    assert.deepEqual(coldArgv, [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--model', 'claude-opus-4-6[1m]',
      '--max-turns', '50',
      '--setting-sources', 'project,local',
      '--allowedTools', 'Bash,mcp__claude_ai_Fermi,mcp__playwright,mcp__claude_ai_Google_Calendar',
    ])
    assert.equal(cold.spawns[0].prompt, 'drain the queue\n') // prompt file on stdin
    assert.equal(cold.spawns[0].cwd, realpathSync(cold.dir))
  })

  test('success: stream-json in the log, harness exit code, lane removed, no session.id', async () => {
    const r = await runOnceCli()
    assert.equal(r.code, 0)
    assert.match(r.log, /"type":"system","subtype":"init"/)
    assert.match(r.log, /RESULT: shipped the fix/)
    assert.match(r.log, /^run-once: exit 0$/m)
    assert.ok(r.laneGone)
    assert.ok(!existsSync(join(r.dir, 'session.id')))
  })

  test('harness failure: its exit code and stderr pass through, lane removed', async () => {
    const r = await runOnceCli({ env: { FAKE_ONCE: 'crash' } })
    assert.equal(r.code, 3)
    assert.match(r.log, /boom: harness crashed/)
    assert.ok(r.laneGone)
  })
})

describe('session.id handling (heartbeat runs)', () => {
  test('an existing session.id becomes --resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmn7-s-'))
    writeFileSync(join(dir, 'session.id'), 'prev-123\n')
    const r = await runOnceCli({ args: ['--session', join(dir, 'session.id')] })
    assert.equal(flag(r.spawns[0].argv, '--resume'), 'prev-123')
    assert.equal(readFileSync(join(dir, 'session.id'), 'utf8'), 'fake\n')
  })

  test('no --session: no --resume', async () => {
    const r = await runOnceCli()
    assert.ok(!r.spawns[0].argv.includes('--resume'))
  })
})

describe('AC2: watchdog kill and lane cleanup', () => {
  test('a run over --timeout-s is killed: exit 124, harness dead, lane removed, session not stored', async () => {
    const t0 = Date.now()
    const r = await runOnceCli({
      args: ['--timeout-s', '1', '--session', 'session.id'],
      env: { FAKE_ONCE: 'slow', FAKE_STALL_MS: '30000' },
    })
    assert.equal(r.code, 124)
    assert.ok(Date.now() - t0 < 10_000, 'killed well before the stall ends')
    assert.match(r.log, /^run-once: watchdog: killing harness after 1s$/m)
    assert.ok(r.harnessPid > 0, r.log)
    assert.ok(!alive(r.harnessPid), 'harness process is gone')
    assert.ok(r.laneGone)
    assert.ok(!existsSync(join(r.dir, 'session.id')))
  })

  test('a harness that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmn7-k-'))
    const stubborn = join(dir, 'claude')
    writeFileSync(stubborn, `#!/bin/sh\ntrap '' TERM\necho '{"type":"system","subtype":"init","session_id":"s"}'\nexec sleep 30\n`)
    chmodSync(stubborn, 0o755)
    const t0 = Date.now()
    const r = await runOnceCli({ args: ['--timeout-s', '1'], env: { CLAUDE_BIN: stubborn } })
    assert.equal(r.code, 124)
    assert.ok(Date.now() - t0 < 10_000)
    assert.ok(!alive(r.harnessPid))
    assert.ok(r.laneGone)
  })

  test('SIGTERM from poll.sh\'s reaper stops the harness and removes the lane', async () => {
    const r = await runOnceCli({
      env: { FAKE_ONCE: 'slow', FAKE_STALL_MS: '30000' },
      act: async (child, dir) => {
        const logFile = join(dir, 'runs/r.log')
        for (const t0 = Date.now(); !(existsSync(logFile) && /tool_result/.test(readFileSync(logFile, 'utf8'))); ) {
          if (Date.now() - t0 > 5000) throw new Error('run never started')
          await new Promise((res) => setTimeout(res, 20))
        }
        child.kill('SIGTERM')
      },
    })
    assert.equal(r.code, 143)
    assert.match(r.log, /^run-once: SIGTERM: stopping harness$/m)
    await new Promise((res) => setTimeout(res, 200))
    assert.ok(!alive(r.harnessPid))
    assert.ok(r.laneGone)
  })
})

// Runs poll.sh in a fake $HOME with the warm worker down (fake pgrep) and an
// unreachable queue (fake curl), so it goes straight to the heartbeat spawn.
// Fake nodes answer -v with their version and record any other argv.
function pollSh({ env = {}, pathNode } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of ['logs', 'runs', 'prompts']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n')
  const fake = (path, body) => (writeFileSync(path, `#!/bin/sh\n${body}\n`), chmodSync(path, 0o755), path)
  fake(join(bin, 'pgrep'), 'exit 1')
  fake(join(bin, 'curl'), 'exit 7')
  const node = (name, version) =>
    fake(join(home, name), `[ "$1" = -v ] && { echo ${version}; exit 0; }\nprintf '%s\\n' "$@" > "$FAKE_DIR/${name}.argv"\necho "${name} stderr" >&2`)
  const nodes = { old: node('node14', 'v14.15.1'), new: node('node22', 'v22.3.0') }
  if (pathNode) fake(join(bin, 'node'), `exec "${nodes[pathNode]}" "$@"`)
  const r = spawnSync('/bin/zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: home, ...(typeof env === 'function' ? env(nodes) : env) },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  return { ...r, home, daemon, pollLog, lanes: readdirSync(join(daemon, 'lanes')) }
}

async function waitFor(path) {
  for (const t0 = Date.now(); !existsSync(path); await new Promise((res) => setTimeout(res, 20)))
    if (Date.now() - t0 > 5000) throw new Error(`${path} never appeared`)
  await new Promise((res) => setTimeout(res, 50))
  return readFileSync(path, 'utf8')
}

describe('poll.sh node resolution for the cold path', () => {
  test('NODE_BIN pointing at node 14: one error line in poll.log, exit 1, no lane, no spawn', () => {
    const r = pollSh({ env: (n) => ({ NODE_BIN: n.old }) })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.pollLog, /ERROR: node '.*node14' is v14\.15\.1; bin\/run-once\.mjs needs node >= 22 \(set NODE_BIN in \.env\) — not spawning heartbeat\.md/)
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.ok(!existsSync(join(r.home, 'node14.argv')))
    assert.deepEqual(readdirSync(join(r.daemon, 'runs')), [])
  })

  test('without NODE_BIN, an old node on PATH is refused the same way', () => {
    const r = pollSh({ pathNode: 'old' })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.pollLog, /ERROR: node '.*\/bin\/node' is v14\.15\.1;/)
    assert.deepEqual(r.lanes, [])
  })

  test('NODE_BIN is honoured over PATH, and run-once stdout/stderr land in the run log', async () => {
    const r = pollSh({ pathNode: 'old', env: (n) => ({ NODE_BIN: n.new }) })
    assert.equal(r.status, 0, r.stderr)
    const argv = (await waitFor(join(r.home, 'node22.argv'))).trim().split('\n')
    assert.equal(argv[0], join(r.daemon, 'bin/run-once.mjs'))
    assert.equal(argv[argv.indexOf('--prompt') + 1], 'prompts/heartbeat.md')
    assert.equal(argv[argv.indexOf('--session') + 1], 'session.id')
    assert.ok(!existsSync(join(r.home, 'node14.argv')), 'PATH node not used')
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    assert.deepEqual(r.lanes, ['1'])
    const log = argv[argv.indexOf('--log') + 1]
    assert.match(await waitFor(join(r.daemon, log)), /node22 stderr/)
  })
})
