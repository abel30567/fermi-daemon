// DMN-25: the pi adapter's eval sandbox. Against test/conformance/fake-pi.mjs,
// with HOME pointed at a fake "real" home whose ~/.pi/agent/mcp.json names a
// production URL and is unreadable (chmod 000), so any read of it throws.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn25-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dirname(fileURLToPath(import.meta.url)), 'conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

const SENTINEL = 'https://fermi.production.example/mcp?SENTINEL'
const AUTH = '{"anthropic":{"type":"oauth","access":"sentinel-access"}}'
const realHome = tmp()
const realAgent = join(realHome, '.pi/agent')
const realMcp = join(realAgent, 'mcp.json')
const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }

before(() => {
  mkdirSync(realAgent, { recursive: true })
  writeFileSync(realMcp, JSON.stringify({ mcpServers: { fermi: { url: SENTINEL } } }))
  chmodSync(realMcp, 0o000)
  writeFileSync(join(realAgent, 'auth.json'), AUTH)
  process.env.HOME = realHome
  process.env.PI_CODING_AGENT_DIR = realAgent // an ambient override must not win either
})
after(() => {
  chmodSync(realMcp, 0o600)
  for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v)
})

const evalConfig = (url = 'http://127.0.0.1:4321/mcp') => {
  const f = join(tmp(), 'mcp.json')
  writeFileSync(f, JSON.stringify({ mcpServers: { fermi: { type: 'http', url } } }))
  return f
}
const seenIn = (dir) => JSON.parse(readFileSync(join(dir, 'mcp-seen.json'), 'utf8'))

describe('AC1: pi sees only the eval MCP server', () => {
  test('runOnce: HOME is the sandbox, mcp.json holds only the localhost server, the real one is never read', async () => {
    const fakeDir = tmp()
    const sandboxHome = tmp()
    const run = pi.runOnce({ bin, prompt: 'mcp', mcpConfig: evalConfig(), sandboxHome, env: { FAKE_DIR: fakeDir } })
    const res = await run.done
    assert.equal(res.outcome?.ok, true, res.stderr)
    const seen = seenIn(fakeDir)
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.ok(!seen.mcp.includes('SENTINEL'))
    assert.equal(seen.auth, AUTH, 'auth.json is copied in for inference login')
  })

  test('through the eval runner: the runner passes sandboxHome and pi gets the runner proxy only', async () => {
    const fakeDir = tmp()
    const harness = { runOnce: (o) => pi.runOnce({ ...o, bin, prompt: 'mcp', env: { ...o.env, FAKE_DIR: fakeDir } }) }
    const scenario = { name: 'pi-sandbox', inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }, expect: [] }
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    const seen = seenIn(fakeDir)
    const servers = JSON.parse(seen.mcp).mcpServers
    assert.deepEqual(Object.keys(servers), ['fermi'])
    assert.match(servers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.ok(!existsSync(seen.home), 'the runner removes the sandbox HOME after the attempt')
  })
})

describe('AC2: the sandbox auth.json is removed when the attempt ends', () => {
  test('runOnce', async () => {
    const sandboxHome = tmp()
    const res = await pi.runOnce({ bin, prompt: 'turn', mcpConfig: evalConfig(), sandboxHome }).done
    assert.equal(res.outcome?.ok, true, res.stderr)
    assert.ok(!existsSync(join(sandboxHome, '.pi/agent/auth.json')))
    assert.ok(existsSync(join(realAgent, 'auth.json')), 'the real auth.json is untouched')
  })

  test('startSession, after close', async () => {
    const sandboxHome = tmp()
    const auth = join(sandboxHome, '.pi/agent/auth.json')
    const s = pi.startSession({ bin, mcpConfig: evalConfig(), sandboxHome })
    assert.ok(existsSync(auth), 'present while pi runs')
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    s.send('turn')
    assert.equal((await ended).ok, true)
    const exited = once(s.events, 'exit')
    s.close('SIGTERM')
    await exited
    assert.ok(!existsSync(auth))
  })
})

describe('AC3: a non-localhost MCP URL refuses to start', () => {
  for (const url of [SENTINEL, 'http://10.0.0.5:8080/mcp', 'http://localhost.evil.example/mcp', 'not a url']) {
    test(url, () => {
      const sandboxHome = tmp()
      assert.throws(() => pi.runOnce({ bin, prompt: 'turn', mcpConfig: evalConfig(url), sandboxHome }), /refusing to start: non-localhost/)
      assert.ok(!existsSync(join(sandboxHome, '.pi')), 'nothing written, no credential copied')
    })
  }
  test('a server without a url (stdio command) is refused too', () => {
    assert.throws(() => pi.piMcpConfig({ mcpServers: { x: { command: 'npx', args: ['some-mcp'] } } }), /non-localhost/)
  })
  test('mcpConfig without sandboxHome is still refused', () => {
    assert.throws(() => pi.runOnce({ bin, prompt: 'turn', mcpConfig: evalConfig() }), /mcpConfig without sandboxHome/)
  })
})
