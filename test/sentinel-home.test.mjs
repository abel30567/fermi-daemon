// DMN-1: npm test runs the suite through scripts/sentinel-home.mjs, a temp HOME whose
// ~/.pi/agent/auth.json and ~/.codex/auth.json are unreadable sentinels. This checks the
// guard itself: a command that reads, copies or touches a sentinel fails the run.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('../scripts/sentinel-home.mjs', import.meta.url))
const guarded = (script) => spawnSync(process.execPath, [GUARD, process.execPath, '-e', script], { encoding: 'utf8' })
const fs = `const fs = require('node:fs'), h = process.env.HOME;`

describe('the sentinel HOME guard (scripts/sentinel-home.mjs)', () => {
  test('the suite runs under it', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.match(pkg.scripts.test, /node scripts\/sentinel-home\.mjs node --test /)
  })

  test('a command that leaves the sentinels alone passes, with HOME the temp dir and NODE_NO_WARNINGS=1', () => {
    const r = guarded(`${fs} if (h === ${JSON.stringify(process.env.HOME)} || process.env.NODE_NO_WARNINGS !== '1' || process.env.CODEX_HOME || process.env.PI_CODING_AGENT_DIR) process.exit(9); fs.statSync(h + '/.pi/agent/auth.json')`)
    assert.equal(r.status, 0, r.stderr)
  })

  for (const f of ['.pi/agent/auth.json', '.codex/auth.json']) {
    test(`reading or copying ~/${f} fails`, () => {
      for (const op of [`fs.readFileSync(h + '/${f}')`, `fs.copyFileSync(h + '/${f}', h + '/copy.json')`]) {
        const r = guarded(`${fs} ${op}`)
        assert.notEqual(r.status, 0, op)
        assert.match(r.stderr, /EACCES/, op)
      }
    })

    test(`changing, removing or chmod-ing ~/${f} fails the run even when the command exits 0`, () => {
      for (const op of [`fs.rmSync(h + '/${f}')`, `fs.chmodSync(h + '/${f}', 0o600)`, `fs.chmodSync(h + '/${f}', 0o600); fs.writeFileSync(h + '/${f}', 'x'); fs.chmodSync(h + '/${f}', 0)`]) {
        const r = guarded(`${fs} ${op}`)
        assert.equal(r.status, 1, op)
        assert.match(r.stderr, new RegExp(`sentinel-home: ${f.replace(/\./g, '\\.')} was removed, changed or made readable`), op)
      }
    })
  }
})
