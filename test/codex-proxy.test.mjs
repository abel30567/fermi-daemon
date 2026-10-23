// DMN-33: codex under --auth proxy. A per-attempt CODEX_HOME/config.toml whose only
// model provider is the localhost CLIProxyAPI, the token only in the provider's env var,
// no ChatGPT auth.json. The last case runs the real codex (skipped without codex 0.163.0
// and sandbox-exec) against a local capture server: no inference, no ChatGPT auth.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as codex from '../harness/codex.mjs'
import { sandboxBackend } from '../harness/sandbox.mjs'
import { PROXY_URL, createAuth } from '../evals/lib/auth.mjs'
import { readBody, serve } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const MODEL = 'gpt-5.6-sol'
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn33-'))
const sha = (s) => createHash('sha256').update(s).digest('hex')
const fakeToken = () => `cpa-eval-proxy-${randomBytes(12).toString('hex')}`
const inbound = { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }
const NO_SEATBELT = sandboxBackend() === 'sandbox-exec' ? false : `needs sandbox-exec (macOS); ${process.platform} has ${sandboxBackend() ?? 'no sandbox backend'}`
const allFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

// A fake `codex exec`: reports on stderr what it was given (argv, the sha256 of the provider key,
// which env vars hold that key, its config.toml, whether an auth.json is there), then ends the
// turn; with FAKE_LEAK it first prints the key as an agent message.
const spyDir = tmp()
writeFileSync(
  join(spyDir, 'spy.mjs'),
  `import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const key = process.env.${codex.PROXY_ENV_KEY}
const home = process.env.CODEX_HOME
process.stderr.write('SPY ' + JSON.stringify({
  argv: process.argv.slice(2),
  keySha256: key ? createHash('sha256').update(key).digest('hex') : null,
  envHoldingKey: Object.keys(process.env).filter((k) => key && process.env[k].includes(key)),
  config: readFileSync(join(home, 'config.toml'), 'utf8'),
  authJson: existsSync(join(home, 'auth.json')),
}) + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (process.env.FAKE_LEAK) out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'my key is ' + key } })
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
`,
)
const SPY = join(spyDir, 'codex')
writeFileSync(SPY, `#!/bin/sh\ncat > /dev/null\nexec "${process.execPath}" "${join(spyDir, 'spy.mjs')}" "$@"\n`)
chmodSync(SPY, 0o755)
const spyReport = (stderr) => JSON.parse(/^SPY (.*)$/m.exec(stderr)[1])

describe('AC1: the generated config.toml points only at the localhost proxy', () => {
  test('one provider, cliproxy, at <proxy>/v1 over the Responses API, the key by env var name only', () => {
    const toml = codex.codexConfig({ mcpServers: {} }, { sandboxMode: 'danger-full-access', provider: { baseUrl: `${PROXY_URL}/v1`, apiKey: 'secret' }, model: MODEL })
    assert.equal(
      toml,
      [
        'sandbox_mode = "danger-full-access"',
        'model_provider = "cliproxy"',
        `model = "${MODEL}"`,
        '',
        '[model_providers.cliproxy]',
        'name = "cliproxy"',
        'base_url = "http://127.0.0.1:8317/v1"',
        'env_key = "CLIPROXY_API_KEY"',
        'wire_api = "responses"',
        '',
        '[shell_environment_policy]',
        'exclude = ["CLIPROXY_API_KEY"]',
        '',
        '[features]',
        'apps = false',
        'plugins = false',
        'browser_use = false',
        'computer_use = false',
      ].join('\n') + '\n',
    )
    assert.ok(!toml.includes('secret'), 'the key itself is never written')
  })

  test('a non-localhost base URL is refused, by the adapter and by createAuth, before codex starts', () => {
    const dir = tmp()
    for (const baseUrl of ['https://api.openai.com/v1', 'http://10.0.0.5:8317/v1', 'http://127.0.0.1.evil.example:8317/v1', 'chatgpt.com']) {
      assert.throws(() => codex.codexConfig({ mcpServers: {} }, { provider: { baseUrl, apiKey: 'x' } }), /refusing non-localhost provider/, baseUrl)
      assert.throws(() => codex.runOnce({ bin: SPY, cwd: dir, prompt: 'p', mcpConfig: { mcpServers: {} }, provider: { baseUrl, apiKey: 'x' } }), /refusing non-localhost provider/)
    }
    for (const proxyUrl of ['https://proxy.example:8317', 'http://10.0.0.5:8317'])
      assert.throws(() => createAuth({ mode: 'proxy', harness: 'codex', model: MODEL, proxyUrl, readProxyToken: () => 'x' }), /non-localhost/)
    assert.throws(() => createAuth({ mode: 'proxy', harness: 'codex', readProxyToken: () => 'x' }), /needs --model/)
    assert.throws(() => codex.runOnce({ bin: SPY, prompt: 'p', provider: { baseUrl: `${PROXY_URL}/v1`, apiKey: 'x' } }), /provider without mcpConfig/)
    for (const mode of ['fd', 'keychain']) assert.throws(() => createAuth({ mode, harness: 'codex', readKeychain: () => 'x' }), /needs --harness claude-code/)
  })

  test('createAuth: codex gets the pi-shaped provider and the proxy port, and the token joins the scan set', () => {
    const token = fakeToken()
    const a = createAuth({ mode: 'proxy', harness: 'codex', model: MODEL, readProxyToken: () => token }).attempt()
    assert.deepEqual(a, { localPorts: ['8317'], egressAllow: ['127.0.0.1:8317'], secrets: [token], provider: { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: token } })
  })

  test('no auth.json is copied in proxy mode, even with an authFile; without one the real CODEX_HOME\'s is never copied', async () => {
    const dir = tmp()
    const real = join(dir, 'real-codex-home')
    mkdirSync(real)
    writeFileSync(join(real, 'auth.json'), '{"tokens":"chatgpt"}')
    const authFile = join(dir, 'stub-auth.json')
    writeFileSync(authFile, '{"tokens":"stub"}')
    const token = fakeToken()
    const provider = { baseUrl: `${PROXY_URL}/v1`, apiKey: token }
    const r = await codex.runOnce({ bin: SPY, cwd: dir, prompt: 'p', model: MODEL, mcpConfig: { mcpServers: {} }, provider, authFile, env: { CODEX_HOME: real } }).done
    const seen = spyReport(r.stderr)
    assert.equal(seen.authJson, false)
    assert.equal(seen.keySha256, sha(token))
    assert.deepEqual(seen.envHoldingKey, ['CLIPROXY_API_KEY'])
    const plain = await codex.runOnce({ bin: SPY, cwd: dir, prompt: 'p', mcpConfig: { mcpServers: {} }, authFile, env: { CODEX_HOME: real } }).done
    assert.equal(spyReport(plain.stderr).authJson, true, 'without a provider the authFile copy stays')
    const none = await codex.runOnce({ bin: SPY, cwd: dir, prompt: 'p', mcpConfig: { mcpServers: {} }, env: { CODEX_HOME: real } }).done
    assert.equal(spyReport(none.stderr).authJson, false, 'no authFile: no auth.json, whatever CODEX_HOME holds')
  })
})

describe('AC3: the proxy token stays out of argv, logs and results', () => {
  const spyHarness = (env = {}) => ({ name: 'codex', runOnce: (o) => codex.runOnce({ ...o, bin: SPY, env: { ...o.env, ...env } }) })
  const attempt = async ({ token, env, scenario = {} }) => {
    const out = tmp()
    const auth = createAuth({ mode: 'proxy', harness: 'codex', model: MODEL, readProxyToken: () => token })
    const result = await runAttempt({ scenario: { name: 'auth', inbound, expect: [], ...scenario }, attempt: 1, harness: spyHarness(env), model: MODEL, timeoutMs: 10_000, outDir: out, sandboxReadable: [spyDir], auth })
    return { out, result }
  }

  test('runner → sandboxed codex: the key only in CLIPROXY_API_KEY, never in argv, the attempt dir or the result', { skip: NO_SEATBELT }, async () => {
    const token = fakeToken()
    const { out, result } = await attempt({ token })
    assert.deepEqual(result.errorKinds, [], JSON.stringify(result.failed))
    assert.equal(result.authMode, 'proxy')
    const seen = spyReport(readFileSync(join(out, 'auth/1/stderr.log'), 'utf8'))
    assert.equal(seen.keySha256, sha(token))
    assert.deepEqual(seen.envHoldingKey, ['CLIPROXY_API_KEY'])
    assert.equal(seen.authJson, false)
    assert.match(seen.config, /^model_provider = "cliproxy"$/m)
    assert.match(seen.config, /^base_url = "http:\/\/127\.0\.0\.1:8317\/v1"$/m)
    assert.ok(!seen.argv.join(' ').includes(token), 'argv')
    assert.ok(!(allFiles(out) + JSON.stringify(result)).includes(token), 'logs, trace, state and results')
  })

  test('a codex that prints the proxy token fails noCanaryLeak, and the message names no value', { skip: NO_SEATBELT }, async () => {
    const token = fakeToken()
    const scenario = { credentials: { canary: true }, expect: [{ noCanaryLeak: true }] }
    const clean = await attempt({ token, scenario })
    assert.equal(clean.result.pass, true, JSON.stringify(clean.result.failed))
    const leaky = await attempt({ token, scenario, env: { FAKE_LEAK: '1' } })
    assert.deepEqual(leaky.result.failed.map((f) => f.message), ["the runner's auth token leaked into the trace, outbound messages or state"])
    assert.ok(!JSON.stringify(leaky.result).includes(token))
  })
})

// The real codex, through the eval runner and its sandbox, with --auth proxy aimed at a
// capture server: its first model request must reach it (and nothing else: no /models,
// no ChatGPT host through the egress proxy). The server answers 400, so no inference runs.
const codexVersion = (() => {
  try {
    return /\d+\.\d+\.\d+/.exec(execFileSync(process.env.CODEX_BIN || 'codex', ['--version'], { encoding: 'utf8' }))?.[0]
  } catch {
    return null
  }
})()
const NO_REAL_CODEX = NO_SEATBELT || (codexVersion === '0.163.0' ? false : `needs codex 0.163.0 on PATH (found ${codexVersion ?? 'none'})`)

describe('AC2: real codex sends its first model request to the local capture server', () => {
  test('POST /v1/responses with --model and the proxy token; no ChatGPT startup calls', { skip: NO_REAL_CODEX, timeout: 120_000 }, async () => {
    const token = fakeToken()
    const requests = []
    const cap = await serve(async (req, res) => {
      const body = await readBody(req)
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, model: body ? JSON.parse(body).model : null })
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'capture server: no inference', type: 'invalid_request_error' } }))
    })
    const out = tmp()
    try {
      const auth = createAuth({ mode: 'proxy', harness: 'codex', model: MODEL, proxyUrl: cap.url, readProxyToken: () => token })
      const result = await runAttempt({ scenario: { name: 'real', inbound, expect: [] }, attempt: 1, harness: codex, model: MODEL, timeoutMs: 60_000, outDir: out, auth })
      assert.ok(requests.length > 0, `codex never reached the capture server: ${JSON.stringify(result.failed)}`)
      assert.deepEqual(requests[0], { method: 'POST', url: '/v1/responses', authorization: `Bearer ${token}`, model: MODEL })
      assert.deepEqual([...new Set(requests.map((r) => `${r.method} ${r.url}`))], ['POST /v1/responses'], 'no model refresh or other startup call')
      const trace = readFileSync(join(out, 'real/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual(trace.filter((e) => e.source === 'egress'), [], 'no ChatGPT host tried through the egress proxy')
      assert.ok(!(allFiles(out) + JSON.stringify(result)).includes(token), 'the token is in no log or result')
    } finally {
      await cap.close()
    }
  })
})
