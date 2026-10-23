// The real eval target: fermi-mcp's packages/worker/wrangler.eval.jsonc (MCP-11)
// under `wrangler dev --local` from the checkout given by --worker, on a free
// port with its own --persist-to dir, so every scenario attempt starts empty.
// Seeding and dumping go through MCP-11's eval-seed.mjs / eval-dump.mjs.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { freePort, sleep } from './net.mjs'

const run = promisify(execFile)

export function workerDir(checkout) {
  for (const d of [join(checkout, 'packages/worker'), checkout])
    if (existsSync(join(d, 'wrangler.eval.jsonc'))) return d
  throw new Error(`no wrangler.eval.jsonc under ${checkout} (need a fermi-mcp checkout with MCP-11)`)
}

export async function startWranglerTarget({ worker, env, logDir, bootTimeoutMs = 90_000 }) {
  const cwd = workerDir(worker)
  const state = mkdtempSync(join(tmpdir(), 'fermi-eval-state-'))
  const envFile = join(state, 'eval.env')
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const log = openSync(join(logDir, 'wrangler.log'), 'a')
  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--config', 'wrangler.eval.jsonc', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--env-file', envFile],
    { cwd, stdio: ['ignore', log, log], detached: true },
  )
  let exited = false
  child.on('exit', () => (exited = true))
  const close = async () => {
    if (exited) return
    try {
      process.kill(-child.pid, 'SIGTERM') // wrangler + workerd
    } catch {}
    for (let i = 0; i < 50 && !exited; i++) await sleep(100)
    if (!exited) try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }

  for (const t0 = Date.now(); ; await sleep(500)) {
    if (exited) throw new Error(`wrangler dev exited during boot (see ${join(logDir, 'wrangler.log')})`)
    if (Date.now() - t0 > bootTimeoutMs) {
      await close()
      throw new Error(`eval target did not answer ${url}/health within ${bootTimeoutMs} ms`)
    }
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) break
  }

  return {
    url,
    async seed(fixture) {
      // eval-seed.mjs has no conversation section yet; failing beats grading without the history.
      if (fixture.history) throw new Error('fixtures.history is not supported by the eval worker seed (eval-seed.mjs) yet')
      const file = join(state, 'fixture.json')
      writeFileSync(file, JSON.stringify(fixture))
      await run(process.execPath, ['scripts/eval-seed.mjs', file, '--persist-to', state, '--url', url], { cwd })
    },
    async dump() {
      const { stdout } = await run(process.execPath, ['scripts/eval-dump.mjs', '--persist-to', state], { cwd, maxBuffer: 64 << 20 })
      return JSON.parse(stdout)
    },
    close,
  }
}
