// Runs the real warm-worker.mjs against a fake harness (test/fixtures/fake-claude.mjs)
// and a fake Fermi server, in a throwaway HOME.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Time is scaled 60x: 10 simulated minutes = 10 s, 30 s base backoff = 500 ms.
const SCALE = 60
export const sim = (ms) => Math.round(ms / SCALE)

export const until = async (cond, ms = 20_000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// Taken at load: a test may point TMPDIR at a nested dir while it runs.
const FAKE_ROOTS = [realpathSync(tmpdir()), realpathSync(join(ROOT, 'test/fixtures'))]

// Throws unless the harness binary a test is about to spawn resolves inside the
// temp dir or test/fixtures, so no test can launch the real installed claude.
// A bare name (PATH lookup) throws; a missing path passes, since spawning it
// can only fail with ENOENT.
export function assertFakeHarness(bin) {
  if (!bin?.includes('/')) throw new Error(`test would spawn harness ${JSON.stringify(bin)} from PATH; point CLAUDE_BIN at a fake`)
  let real
  try {
    real = realpathSync(bin)
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  if (!FAKE_ROOTS.some((r) => real.startsWith(r + sep))) throw new Error(`test would spawn a real harness: ${bin} -> ${real}`)
}

// The binary each adapter spawns when no `bin` is given (mirrors harness/*.mjs).
const DEFAULT_BIN = {
  'claude-code': (env) => env.CLAUDE_BIN || join(env.HOME, '.local/bin/claude'),
  pi: (env) => env.PI_BIN || 'pi',
  codex: (env) => env.CODEX_BIN || 'codex',
}

// The harness binary a warm-worker / run-once child with this env would spawn.
export const harnessBin = (env) => DEFAULT_BIN[env.HARNESS || 'claude-code'](env)

// `adapter` with runOnce/startSession passed through assertFakeHarness, for
// tests that drive an adapter directly.
export const guardHarness = (adapter) => ({
  ...adapter,
  runOnce: (o = {}) => (assertFakeHarness(o.bin || DEFAULT_BIN[adapter.name](process.env)), adapter.runOnce(o)),
  startSession: (o = {}) => (assertFakeHarness(o.bin || DEFAULT_BIN[adapter.name](process.env)), adapter.startSession(o)),
})

// `env` adds/overrides worker env vars; `prompt` is prompts/drain.md, `overlay` (if set) prompts/local.json; `act({ log, home, narrations })` runs
// alongside the worker (log() is its output so far). Returns the fake harness's records and
// the worker's runs/ files.
export async function runWorker({ result, errors, claim, durationMs, pending = 1, env = {}, act, prompt = 'test prompt\n', overlay, worker = join(ROOT, 'warm-worker.mjs') }) {
  const home = mkdtempSync(join(tmpdir(), 'dmn2-'))
  const daemon = join(home, 'fermi-daemon')
  mkdirSync(join(daemon, 'prompts'), { recursive: true })
  mkdirSync(join(daemon, 'runs'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  writeFileSync(join(daemon, 'prompts/drain.md'), prompt)
  if (overlay) writeFileSync(join(daemon, 'prompts/local.json'), JSON.stringify(overlay))
  const resultFile = join(home, 'result.json')
  writeFileSync(resultFile, JSON.stringify(result))
  const claudeBin = join(home, '.local/bin/claude')
  writeFileSync(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/fixtures/fake-claude.mjs')}" "$@"\n`)
  chmodSync(claudeBin, 0o755)

  const childEnv = {
    PATH: process.env.PATH,
    HOME: home,
    WARM_POLL_MS: String(sim(1000)),
    WARM_CONTROL_PORT: '0',
    WARM_BACKOFF_BASE_MS: String(sim(30_000)),
    WARM_BACKOFF_MAX_MS: String(sim(1_800_000)),
    FAKE_DIR: home,
    FAKE_RESULT: resultFile,
    FAKE_DELAY_MS: String(sim(3000)), // the incident's turns took ~4 s end to end
    ...(errors != null && { FAKE_ERRORS: String(errors) }),
    ...(claim && { FAKE_CLAIM: '1' }),
    ...env,
  }
  assertFakeHarness(harnessBin(childEnv))

  const narrations = []
  const server = http.createServer((req, res) => {
    if (req.url === '/admin/tasks/pending') return res.end(JSON.stringify({ pending }))
    if (req.url === '/admin/narrate') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        narrations.push(JSON.parse(body))
        res.end('{}')
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:${server.address().port}\nFERMI_BEARER_TOKEN=test\n`)

  const child = spawn(process.execPath, [worker], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((r) => child.on('exit', r)) // the worker may exit on its own (refusing to start)
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  await Promise.all([new Promise((r) => setTimeout(r, durationMs)), act?.({ log: () => log, home, narrations })])
  child.kill('SIGTERM')
  await exited
  server.close()
  const turnsLog = join(home, 'turns.log')
  const events = existsSync(turnsLog)
    ? readFileSync(turnsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  const runs = Object.fromEntries(readdirSync(join(daemon, 'runs')).map((f) => [f, readFileSync(join(daemon, 'runs', f), 'utf8')]))
  rmSync(home, { recursive: true, force: true })
  return { events, drains: events.filter((e) => e.drain), narrations, log, runs }
}
