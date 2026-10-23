// The conformance suite (./suite.mjs) for the codex adapter, against ./fake-codex.mjs,
// plus the codex-only pieces: exec's JSONL stream and the per-run CODEX_HOME for mcpConfig.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformance } from './suite.mjs'
import { createExecNormalizer, codexConfig, oneShotArgs, runOnce } from '../../harness/codex.mjs'

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
})
