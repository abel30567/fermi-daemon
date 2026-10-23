// The conformance suite (./suite.mjs) for the codex adapter, against ./fake-codex.mjs,
// plus the codex-only pieces: exec's JSONL stream and the per-run CODEX_HOME for mcpConfig.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformance } from './suite.mjs'
import { createExecNormalizer, codexConfig, oneShotArgs, runOnce, startSession } from '../../harness/codex.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const bins = mkdtempSync(join(tmpdir(), 'dmn6-bin-'))
const fake = join(HERE, 'fake-codex.mjs')
const script = (name, body) => {
  const p = join(bins, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const bin = script('codex', `exec "${process.execPath}" "${fake}" "$@"`)

runConformance(() => import('../../harness/codex.mjs'), { name: 'codex', options: { bin } }, {
  expectedFail: {
    credential_isolation:
      'SWAP-GATE BLOCKER: codex takes its credential only from CODEX_HOME/auth.json (readable by its shell tool) or OPENAI_API_KEY in the env; no fd handoff, so the adapter refuses tokenFd (see harness/codex.mjs)',
  },
})

describe('codex adapter', () => {
  test('exec: a recorded no-credential stream ends as one auth turn_end', () => {
    const norm = createExecNormalizer()
    norm.start()
    const lines = readFileSync(join(HERE, '../fixtures/harness/codex/exec-auth.jsonl'), 'utf8').trim().split('\n')
    const evs = lines.flatMap((l) => norm.normalize(JSON.parse(l)))
    assert.deepEqual(evs.map((e) => `${e.type}/${e.ok}/${e.kind}`), ['turn_end/false/auth'])
  })

  test('exec argv: prompt on stdin, system prompt as developer_instructions', () => {
    assert.deepEqual(oneShotArgs({ model: 'gpt-x', systemPrompt: 'be "brief"\n', skipPermissions: true }), [
      'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '--model', 'gpt-x', '-c', 'developer_instructions="be \\"brief\\"\\n"', '-',
    ])
  })

  test('mcpConfig: refuses non-localhost and non-http servers', () => {
    const cfg = (servers) => JSON.stringify({ mcpServers: servers })
    assert.throws(() => codexConfig(cfg({ fermi: { type: 'http', url: 'https://fermi.example.com/mcp' } })), /refusing non-localhost MCP URL fermi=/)
    assert.throws(() => codexConfig(cfg({ x: { command: 'npx', args: ['x'] } })), /has no url/)
    const dir = mkdtempSync(join(tmpdir(), 'dmn6-'))
    assert.throws(() => runOnce({ bin, cwd: dir, prompt: 'turn', mcpConfig: cfg({ fermi: { url: 'http://10.0.0.5/mcp' } }) }), /refusing non-localhost/)
  })

  test('mcpConfig: a per-run CODEX_HOME with the servers and only auth.json from the real one, removed after exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmn6-'))
    const real = join(dir, 'real-codex-home')
    mkdirSync(real)
    writeFileSync(join(real, 'auth.json'), '{"tokens":"fake"}')
    writeFileSync(join(real, 'config.toml'), '[mcp_servers.prod]\nurl = "https://fermi.example.com/mcp"\n')
    const spy = script('codex-spy', `echo "$CODEX_HOME" > "$FAKE_DIR/home-path"; cp -R "$CODEX_HOME" "$FAKE_DIR/home"; exec "${process.execPath}" "${fake}" "$@"`)
    const mcpConfig = join(dir, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer eval' } } } }))
    const { outcome } = await runOnce({ bin: spy, cwd: dir, prompt: 'turn', mcpConfig, env: { FAKE_DIR: dir, CODEX_HOME: real } }).done
    assert.equal(outcome.ok, true)
    assert.deepEqual(readFileSync(join(dir, 'home/auth.json'), 'utf8'), '{"tokens":"fake"}')
    const toml = readFileSync(join(dir, 'home/config.toml'), 'utf8')
    assert.match(toml, /\[mcp_servers\."fermi"\]\nurl = "http:\/\/127\.0\.0\.1:4100\/mcp"\nhttp_headers = \{ "Authorization" = "Bearer eval" \}/)
    assert.match(toml, /^apps = false$/m)
    assert.doesNotMatch(toml, /prod|example\.com/)
    const home = readFileSync(join(dir, 'home-path'), 'utf8').trim()
    assert.notEqual(home, real)
    assert.equal(existsSync(home), false, 'the per-run CODEX_HOME (holding the auth copy) is removed')
  })

  test('mcpConfig: an object is accepted; anything else is refused with a clear message', () => {
    assert.match(codexConfig({ mcpServers: { fermi: { url: 'http://127.0.0.1:4100/mcp' } } }), /\[mcp_servers\."fermi"\]\nurl = "http:\/\/127\.0\.0\.1:4100\/mcp"/)
    assert.throws(() => codexConfig({ mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' } } }), /refusing non-localhost/)
    assert.throws(() => codexConfig(42), /mcpConfig must be a path, a JSON string or an object/)
  })

  // Every exit path removes the per-run CODEX_HOME (and its auth.json copy). Each case runs
  // with its own TMPDIR so a leftover codex-home-* is attributable to it.
  describe('per-run CODEX_HOME is removed on every exit path', () => {
    const withTmp = async (fn) => {
      const saved = process.env.TMPDIR
      const tmp = mkdtempSync(join(tmpdir(), 'dmn6-tmp-'))
      const real = join(tmp, 'real-codex-home')
      mkdirSync(real)
      writeFileSync(join(real, 'auth.json'), '{"tokens":"fake"}')
      process.env.TMPDIR = tmp
      try {
        await fn({ mcpConfig: { mcpServers: { fermi: { url: 'http://127.0.0.1:4100/mcp' } } }, env: { CODEX_HOME: real } })
      } finally {
        process.env.TMPDIR = saved
      }
      assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith('codex-home-')), [], 'no codex-home-* left behind')
    }

    test('runOnce: missing binary resolves done (no crash) with the spawn error', () =>
      withTmp(async (o) => {
        const r = await runOnce({ ...o, bin: '/nonexistent/codex', prompt: 'x' }).done
        assert.equal(r.outcome, null)
        assert.match(r.stderr, /ENOENT/)
      }))

    test('runOnce: nonexistent cwd', () =>
      withTmp(async (o) => {
        const r = await runOnce({ ...o, bin, cwd: '/nonexistent/dir', prompt: 'x' }).done
        assert.match(r.stderr, /ENOENT/)
      }))

    test('runOnce: spawn throws synchronously', () =>
      withTmp(async (o) => {
        assert.throws(() => runOnce({ ...o, bin: 'co\0dex', prompt: 'x' }), /null bytes/)
      }))

    test('runOnce: codex crashes (killed by a signal, no output)', () =>
      withTmp(async (o) => {
        const r = await runOnce({ ...o, bin: script('codex-crash', 'kill -9 $$'), prompt: 'x' }).done
        assert.equal(r.outcome, null)
      }))

    test('runOnce: codex exits non-zero', () =>
      withTmp(async (o) => {
        const r = await runOnce({ ...o, bin: script('codex-fail', 'exit 3'), prompt: 'x' }).done
        assert.equal(r.code, 3)
      }))

    test('startSession: missing binary emits exit and refuses sends', () =>
      withTmp(async (o) => {
        const s = startSession({ ...o, bin: '/nonexistent/codex' })
        assert.equal(s.send('turn'), false)
        await new Promise((resolve) => s.events.once('exit', resolve))
        assert.equal(s.alive, false)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }))

    test('startSession: codex dies mid-handshake, the pending send ends its turn', () =>
      withTmp(async (o) => {
        const s = startSession({ ...o, bin: script('codex-die', 'read line; exit 1') })
        const ends = []
        s.events.on('event', (ev) => ev.type === 'turn_end' && ends.push(ev))
        assert.equal(s.send('turn'), true)
        await new Promise((resolve) => s.events.once('exit', resolve))
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(ends.length, 1)
        assert.equal(ends[0].ok, false)
      }))

    test('startSession: closed by the caller', () =>
      withTmp(async (o) => {
        const s = startSession({ ...o, bin })
        await new Promise((resolve) => s.events.on('event', (ev) => ev.type === 'init' && resolve()))
        s.close('SIGKILL')
        await new Promise((resolve) => s.events.once('exit', resolve))
        await new Promise((resolve) => setTimeout(resolve, 50))
      }))
  })
})
