// DMN-50: cloud task envelope verification (lib/task-envelope.mjs) and the agent run
// sandbox policy (lib/run-policy.mjs), one test per edge-case row of issue #112.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createVerifier, envelopeConfig, sign, DEFAULT_TTL_MS, DEFAULT_SKEW_MS } from '../lib/task-envelope.mjs'
import { runPolicy, SANDBOX_EXEC, UNSANDBOXED_BANNER } from '../lib/run-policy.mjs'

const KEY = randomBytes(32).toString('hex')
const PREV = randomBytes(32).toString('hex')
const NOW = 1_800_000_000_000
const nonceAt = (ms) => `${Math.floor(ms / 1000)}.${randomBytes(16).toString('hex')}`
const signed = (key, { id = 't1', payload = '{"prompt":"hi"}', nonce = nonceAt(NOW) } = {}) => ({
  id,
  payload,
  envelope: { v: 1, nonce, sig: sign(key, id, nonce, payload) },
})

describe('task envelope', () => {
  test('a task signed with the current key is accepted, its replay refused', () => {
    const verify = createVerifier({ keys: [KEY], enforce: true })
    const t = signed(KEY)
    assert.deepEqual(verify(t, NOW), { ok: true })
    assert.deepEqual(verify(t, NOW + 1000), { ok: false, reason: 'replayed nonce' })
  })

  test('forged: wrong key, tampered payload, tampered id, tampered nonce are refused', () => {
    const verify = createVerifier({ keys: [KEY], enforce: true })
    const bad = { ok: false, reason: 'bad signature' }
    assert.deepEqual(verify(signed(randomBytes(32).toString('hex')), NOW), bad)
    assert.deepEqual(verify({ ...signed(KEY), payload: '{"prompt":"rm -rf ~"}' }, NOW), bad)
    assert.deepEqual(verify({ ...signed(KEY), id: 't2' }, NOW), bad)
    const t = signed(KEY)
    assert.deepEqual(verify({ ...t, envelope: { ...t.envelope, nonce: nonceAt(NOW) } }, NOW), bad)
    assert.deepEqual(verify({ ...t, envelope: { ...t.envelope, v: 2 } }, NOW), { ok: false, reason: 'malformed envelope' })
  })

  test('key rotation: current and previous keys are accepted, a dropped key is not', () => {
    const verify = createVerifier(envelopeConfig({ FERMI_ENVELOPE_ENFORCE: '1', FERMI_ENVELOPE_KEY: KEY, FERMI_ENVELOPE_KEY_PREV: PREV }))
    assert.equal(verify(signed(KEY), NOW).ok, true)
    assert.equal(verify(signed(PREV), NOW).ok, true)
    const afterRotation = createVerifier(envelopeConfig({ FERMI_ENVELOPE_ENFORCE: '1', FERMI_ENVELOPE_KEY: KEY }))
    assert.deepEqual(afterRotation(signed(PREV), NOW), { ok: false, reason: 'bad signature' })
  })

  test('clock skew on the nonce TTL: ±30s tolerated, beyond refused', () => {
    const verify = createVerifier({ keys: [KEY], enforce: true })
    const at = (ms) => verify(signed(KEY, { nonce: nonceAt(ms) }), NOW)
    assert.equal(at(NOW + DEFAULT_SKEW_MS).ok, true, 'signer clock 30s ahead')
    assert.deepEqual(at(NOW + DEFAULT_SKEW_MS + 2000), { ok: false, reason: 'nonce timestamp is in the future' })
    assert.equal(at(NOW - DEFAULT_TTL_MS - DEFAULT_SKEW_MS).ok, true, 'oldest accepted: TTL + skew')
    assert.deepEqual(at(NOW - DEFAULT_TTL_MS - DEFAULT_SKEW_MS - 2000), { ok: false, reason: 'nonce expired' })
  })

  test('a nonce stays refused for its whole window, then expires by timestamp', () => {
    const verify = createVerifier({ keys: [KEY], enforce: true, ttlMs: 60_000, skewMs: 0 })
    const t = signed(KEY)
    assert.equal(verify(t, NOW).ok, true)
    assert.deepEqual(verify(t, NOW + 59_000), { ok: false, reason: 'replayed nonce' })
    assert.deepEqual(verify(t, NOW + 61_000), { ok: false, reason: 'nonce expired' })
  })

  test('huge payload (16 MiB) verifies, and one flipped byte is refused', () => {
    const verify = createVerifier({ keys: [KEY], enforce: true })
    const payload = JSON.stringify({ prompt: 'x'.repeat(16 * 1024 * 1024) })
    const t = signed(KEY, { payload })
    const flipped = { ...t, payload: payload.slice(0, -3) + 'y"}', envelope: { ...t.envelope } }
    assert.deepEqual(verify(flipped, NOW), { ok: false, reason: 'bad signature' })
    assert.deepEqual(verify(t, NOW), { ok: true })
  })

  test('grace mode on (default): an unsigned task is accepted with a warning; a forged one is still refused', () => {
    for (const env of [{}, { FERMI_ENVELOPE_ENFORCE: '0' }, { FERMI_ENVELOPE_ENFORCE: '0', FERMI_ENVELOPE_KEY: KEY }]) {
      const verify = createVerifier(envelopeConfig(env))
      const r = verify({ id: 't1', payload: '{}' }, NOW)
      assert.equal(r.ok, true)
      assert.match(r.warning, /UNSIGNED TASK ACCEPTED/)
    }
    const verify = createVerifier(envelopeConfig({ FERMI_ENVELOPE_KEY: KEY }))
    assert.deepEqual(verify(signed(PREV), NOW), { ok: false, reason: 'bad signature' })
  })

  test('grace mode off (FERMI_ENVELOPE_ENFORCE=1): an unsigned task is refused; enforce without a key will not start', () => {
    const verify = createVerifier(envelopeConfig({ FERMI_ENVELOPE_ENFORCE: '1', FERMI_ENVELOPE_KEY: KEY }))
    assert.deepEqual(verify({ id: 't1', payload: '{}' }, NOW), { ok: false, reason: 'unsigned task (no envelope)' })
    assert.throws(() => envelopeConfig({ FERMI_ENVELOPE_ENFORCE: '1' }), /needs FERMI_ENVELOPE_KEY/)
    assert.throws(() => envelopeConfig({ FERMI_ENVELOPE_KEY: 'short' }), /at least 32 bytes of hex/)
  })
})

describe('run policy sandbox', () => {
  test('sandboxed process cannot write ~/Desktop, but can write its workdir', { skip: !existsSync(SANDBOX_EXEC) && 'no sandbox-exec' }, () => {
    const workdir = mkdtempSync(join(tmpdir(), 'dmn50-'))
    // The real Desktop: npm test points HOME at a sentinel dir, which would prove nothing.
    const desktop = join(userInfo().homedir, 'Desktop')
    const target = join(desktop, `dmn50-sandbox-probe-${randomBytes(6).toString('hex')}`)
    const inside = join(workdir, 'ok.txt')
    try {
      const { sandboxed, wrap } = runPolicy({ workdir, env: {} })
      assert.equal(sandboxed, true)
      const run = (path) => {
        const [cmd, argv] = wrap('/bin/sh', ['-c', 'echo probe > "$1"', 'sh', path])
        return spawnSync(cmd, argv, { encoding: 'utf8' })
      }
      const out = run(target)
      assert.notEqual(out.status, 0, 'write to ~/Desktop must fail')
      assert.match(out.stderr, /Operation not permitted/)
      assert.equal(existsSync(target), false)
      const ok = run(inside)
      assert.equal(ok.status, 0, ok.stderr)
      assert.equal(readFileSync(inside, 'utf8'), 'probe\n')
    } finally {
      rmSync(target, { force: true })
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  test('sandboxed process cannot reach the network outside the allowlist', { skip: !existsSync(SANDBOX_EXEC) && 'no sandbox-exec' }, () => {
    const workdir = mkdtempSync(join(tmpdir(), 'dmn50-'))
    try {
      const { wrap } = runPolicy({ workdir, env: {} })
      const js = "require('net').connect(443, '1.1.1.1').on('connect', () => process.exit(0)).on('error', (e) => { console.error(e.code); process.exit(3) })"
      const [cmd, argv] = wrap(process.execPath, ['-e', js])
      const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 10_000 })
      assert.equal(r.status, 3, r.stderr)
      assert.match(r.stderr, /EPERM/)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  test('no sandbox available: refuses, unless FERMI_ALLOW_UNSANDBOXED=1, which returns the warning banner', () => {
    const workdir = tmpdir()
    for (const o of [{ platform: 'linux' }, { platform: 'darwin', sandboxExec: '/nonexistent/sandbox-exec' }]) {
      assert.throws(() => runPolicy({ workdir, env: {}, ...o }), /refusing to run the agent unsandboxed/)
      const p = runPolicy({ workdir, env: { FERMI_ALLOW_UNSANDBOXED: '1' }, ...o })
      assert.equal(p.sandboxed, false)
      assert.equal(p.banner, UNSANDBOXED_BANNER)
      assert.deepEqual(p.wrap('/bin/echo', ['x']), ['/bin/echo', ['x']])
    }
  })
})
