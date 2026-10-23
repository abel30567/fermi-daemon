#!/usr/bin/env node
// sentinel-home.mjs <cmd> [args...] — runs cmd (npm test: the root suite) with HOME in a temp
// dir whose ~/.pi/agent/auth.json and ~/.codex/auth.json are sentinels, chmod 000, so a test
// or library that reads or copies a real credential file fails with EACCES. Exits 1 if a
// sentinel is then missing, changed or no longer 000, else with cmd's status.
// CODEX_HOME and PI_CODING_AGENT_DIR are unset, and NODE_NO_WARNINGS=1 keeps Node's own
// warnings (they vary by version) out of the helper scripts' output.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: sentinel-home.mjs <cmd> [args...]')
  process.exit(2)
}
const home = mkdtempSync(join(tmpdir(), 'sentinel-home-'))
const content = JSON.stringify({ SENTINEL: randomBytes(8).toString('hex') })
const files = ['.pi/agent/auth.json', '.codex/auth.json'].map((f) => join(home, f))
for (const f of files) {
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, content)
  chmodSync(f, 0o000)
}

const env = { ...process.env, HOME: home, NODE_NO_WARNINGS: '1' }
delete env.CODEX_HOME
delete env.PI_CODING_AGENT_DIR
const r = spawnSync(cmd, args, { stdio: 'inherit', env })

const bad = files.filter((f) => {
  try {
    if ((statSync(f).mode & 0o777) !== 0) return true
    chmodSync(f, 0o600)
    return readFileSync(f, 'utf8') !== content
  } catch {
    return true // removed
  }
})
rmSync(home, { recursive: true, force: true })
if (bad.length) {
  console.error(`sentinel-home: ${bad.map((f) => f.slice(home.length + 1)).join(', ')} was removed, changed or made readable`)
  process.exit(1)
}
if (r.error) console.error(`sentinel-home: ${r.error.message}`)
process.exit(r.status ?? 1)
