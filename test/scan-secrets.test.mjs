// DMN-16: scripts/scan-secrets.mjs fails a run whose log or outputs hold the CI token (read
// from an fd) or a secret-shaped string, and never prints the value it found.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanText } from '../scripts/scan-secrets.mjs'

const SCAN = join(dirname(fileURLToPath(import.meta.url)), '../scripts/scan-secrets.mjs')
// Not secret-shaped on purpose, so only the literal token match can catch it.
const fakeToken = () => `fake-oauth-${randomBytes(16).toString('hex')}`

// A run dir as the workflow scans it: run log, summary.json, compare.md.
function runDir(logLine) {
  const dir = mkdtempSync(join(tmpdir(), 'dmn16-scan-'))
  mkdirSync(join(dir, 'artifacts'))
  writeFileSync(join(dir, 'run.log'), `PASS reply-contract #1 812ms\n${logLine}\n1/1 passed\n`)
  writeFileSync(join(dir, 'artifacts/summary.json'), JSON.stringify({ passed: 1, attempts: 1, workerCommit: 'a'.repeat(40) }) + '\n')
  writeFileSync(join(dir, 'artifacts/compare.md'), '# Eval comparison\n\n| core | 1/1 |\n')
  return dir
}

const scan = (dir) => spawnSync(process.execPath, [SCAN, join(dir, 'run.log'), join(dir, 'artifacts')], { encoding: 'utf8' })

// The token on fd 3, a pipe fed by printf (a bash builtin), as scripts/evals-ci.sh hands it over.
const scanWithToken = (dir, token) =>
  spawnSync('bash', ['-c', `exec 3< <(printf '%s' "$1"); shift; exec "$@"`, 'scan', token, process.execPath, SCAN, '--token-fd', '3', join(dir, 'run.log'), join(dir, 'artifacts')], {
    encoding: 'utf8',
  })

test('a fixture that echoes the fake token fails the scan, without printing the token', () => {
  const token = fakeToken()
  const r = scanWithToken(runDir(`debug: CLAUDE_CODE_OAUTH_TOKEN=${token}`), token)
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /run\.log:2: the OAuth token/)
  assert.ok(!(r.stdout + r.stderr).includes(token), 'the scanner printed the token')
})

test('the token in an artifact fails the scan', () => {
  const token = fakeToken()
  const dir = runDir('ok')
  writeFileSync(join(dir, 'artifacts/compare.md'), `leaked ${token}\n`)
  const r = scanWithToken(dir, token)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /compare\.md:1: the OAuth token/)
})

test('a clean run passes, with and without the token', () => {
  const dir = runDir('FAIL bootstrap-first #2 900ms 1 value(s) leaked into the trace')
  assert.equal(scanWithToken(dir, fakeToken()).status, 0)
  assert.equal(scan(dir).status, 0)
})

test('a secret-shaped string fails the scan without the token', () => {
  const r = scan(runDir(`key sk-ant-oat01-${randomBytes(12).toString('hex')}`))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /anthropic key/)
})

test('secret shapes', () => {
  const kinds = (s) => scanText(s).map((h) => h.kind)
  assert.deepEqual(kinds(`ghp_${'A'.repeat(36)}`), ['github token'])
  assert.deepEqual(kinds(`xoxb-1234567890-abcdef`), ['slack token'])
  assert.deepEqual(kinds('AKIAABCDEFGHIJKLMNOP'), ['aws access key'])
  assert.deepEqual(kinds('-----BEGIN OPENSSH PRIVATE KEY-----'), ['private key'])
  assert.deepEqual(kinds(`Authorization: Bearer ${'x'.repeat(24)}`), ['bearer token'])
  // what summary.json and compare.md legitimately hold
  assert.deepEqual(kinds(`workerCommit ${'0123456789abcdef'.repeat(2)}01234567 claude-opus-5-5 task-skill-load`), [])
})

test('an unreadable --token-fd or a missing path is a usage error', () => {
  assert.equal(spawnSync(process.execPath, [SCAN, '--token-fd', '9', '/dev/null']).status, 2)
  assert.equal(spawnSync(process.execPath, [SCAN, '/nonexistent/dmn16']).status, 2)
  assert.equal(spawnSync(process.execPath, [SCAN]).status, 2)
})
