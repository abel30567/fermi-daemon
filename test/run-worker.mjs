// Runs the real warm-worker.mjs against a fake harness (test/fixtures/fake-claude.mjs)
// and a fake Fermi server, in a throwaway HOME.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Time is scaled 60x: 10 simulated minutes = 10 s, 30 s base backoff = 500 ms.
const SCALE = 60
export const sim = (ms) => Math.round(ms / SCALE)

// `env` adds/overrides worker env vars; `prompt` is prompts/drain.md, `overlay` (if set) prompts/local.json; `act({ log, home })` runs alongside the
// worker (log() is its output so far). Returns the fake harness's records and
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

  const child = spawn(process.execPath, [worker], {
    env: {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise((r) => child.on('exit', r)) // the worker may exit on its own (refusing to start)
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  await Promise.all([new Promise((r) => setTimeout(r, durationMs)), act?.({ log: () => log, home })])
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
