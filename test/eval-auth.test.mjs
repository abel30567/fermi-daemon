// DMN-30: inference auth for the sandboxed eval harness (evals/lib/auth.mjs, run.mjs --auth).
// Never reads the real keychain or proxy token: the keychain reader, `security` and the proxy
// token are fakes. The runner cases go through the claude-code adapter with a fake claude in
// the OS sandbox (sandbox-exec), and are skipped without it.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as claude from '../harness/claude-code.mjs'
import * as piAdapter from '../harness/pi.mjs'
import { AMBIENT_ENV, sandboxBackend } from '../harness/sandbox.mjs'
import { KEYCHAIN_ITEM, PROXY_URL, createAuth, fdToken, keychainToken } from '../evals/lib/auth.mjs'
import { allowedTarget } from '../evals/lib/egress-proxy.mjs'
import { modelJudge } from '../evals/judge.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { guardHarness } from './run-worker.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn30-'))
const NO_SEATBELT = sandboxBackend() === 'sandbox-exec' ? false : `needs sandbox-exec (macOS); ${process.platform} has ${sandboxBackend() ?? 'no sandbox backend'}`
const sha = (s) => createHash('sha256').update(s).digest('hex')
const fakeToken = (kind) => `sk-ant-oat01-eval-${kind}-${randomBytes(12).toString('hex')}`
const inbound = { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }

const script = (name, body) => {
  const bin = join(tmp(), name)
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
const CLAUDE_BIN = script('claude', `exec "${process.execPath}" "${join(HERE, 'fixtures/fake-claude-eval.mjs')}" "$@"`)
const fakeClaude = (env = {}) => ({ name: 'claude-code', runOnce: (o) => claude.runOnce({ ...o, bin: CLAUDE_BIN, env: { ...o.env, ...env } }) })

// Every file the attempts wrote (trace, raw and stderr logs, state, mcp.json), concatenated.
const allFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
const inits = (out, name) =>
  readdirSync(join(out, name)).map((n) => JSON.parse(readFileSync(join(out, name, n, 'raw.log'), 'utf8').split('\n').find((l) => l.includes('"subtype":"init"'))))

async function attempts({ auth, env, scenario = {}, k = 1 }) {
  const out = tmp()
  const results = []
  for (let attempt = 1; attempt <= k; attempt++)
    results.push(
      await runAttempt({ scenario: { name: 'auth', inbound, expect: [], ...scenario }, attempt, harness: fakeClaude(env), timeoutMs: 10_000, outDir: out, sandboxReadable: [HERE], auth }),
    )
  return { out, results }
}

describe('keychain: the access token from "Claude Code-credentials", through an injectable `security`', () => {
  // A fake `security` holding generic-password items for KEYCHAIN_ITEM, keyed by account:
  // find-generic-password -a <acct> -w prints that item (exit 44 if absent; without -a, the
  // first item, like the real one), dump-keychain lists their attributes. Every call is logged.
  const fakeSecurity = (items, { dumpCode = 0 } = {}) => {
    const dir = tmp()
    const accounts = Object.keys(items)
    accounts.forEach((acct, i) => writeFileSync(join(dir, `item${i}`), items[acct]))
    writeFileSync(join(dir, 'accounts'), accounts.map((a) => a + '\n').join(''))
    const record = (acct) => {
      const hex = !/^[\x20-\x7e]*$/.test(acct)
      const value = hex ? `0x${Buffer.from(acct).toString('hex').toUpperCase()}  "${acct}"` : `"${acct}"`
      return `keychain: "${dir}/login.keychain-db"\nversion: 512\nclass: "genp"\nattributes:\n    0x00000007 <blob>="${KEYCHAIN_ITEM}"\n    "acct"<blob>=${value}\n    "svce"<blob>="${KEYCHAIN_ITEM}"\n`
    }
    const other = `keychain: "${dir}/login.keychain-db"\nversion: 512\nclass: "genp"\nattributes:\n    "acct"<blob>="decoy"\n    "svce"<blob>="Other-credentials"\n`
    writeFileSync(join(dir, 'dump'), other + accounts.map(record).join(''))
    const bin = script(
      'security',
      `printf '%s\\n' "$*" >> "${dir}/calls"
case "$1" in
  dump-keychain) cat "${dir}/dump"; exit ${dumpCode} ;;
esac
acct=; while [ $# -gt 0 ]; do [ "$1" = -a ] && acct="$2"; shift; done
i=0; while IFS= read -r a; do
  if [ -z "$acct" ] || [ "$a" = "$acct" ]; then cat "${dir}/item$i"; exit 0; fi; i=$((i+1))
done < "${dir}/accounts"
exit 44`,
    )
    return { dir, bin, calls: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') }
  }
  const login = (accessToken, refreshToken) => JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: 1 } }) + '\n'
  const mcpOnly = (secret) => JSON.stringify({ mcpOAuth: { 'srv|1': { accessToken: secret } } }) + '\n'

  test("reads claudeAiOauth.accessToken from the user's account with -a <user> -w; the refresh token stays out", () => {
    const access = fakeToken('access')
    const { bin, calls } = fakeSecurity({ alice: login(access, fakeToken('refresh')) })
    assert.equal(keychainToken({ security: bin, user: 'alice' }), access)
    assert.deepEqual(calls(), [`find-generic-password -s ${KEYCHAIN_ITEM} -a alice -w`], 'the user account hits first: no dump')
  })

  test("DMN-31 AC1: two items, the first account mcpOAuth only, the user's account claudeAiOauth → the user's token", () => {
    const access = fakeToken('access')
    const { bin, calls } = fakeSecurity({ 'Claude Code': mcpOnly(fakeToken('mcp')), alice: login(access, fakeToken('refresh')) })
    assert.equal(keychainToken({ security: bin, user: 'alice' }), access)
    assert.equal(calls().length, 1)
  })

  test("the user's item without an access token falls back to the other accounts dump-keychain lists, first match wins", () => {
    const access = fakeToken('access')
    const { bin, calls } = fakeSecurity({ alice: mcpOnly(fakeToken('mcp')), 'Claude Code': mcpOnly(fakeToken('mcp')), 'bób': login(access), later: login(fakeToken('x')) })
    assert.equal(keychainToken({ security: bin, user: 'alice' }), access)
    assert.deepEqual(calls(), [
      `find-generic-password -s ${KEYCHAIN_ITEM} -a alice -w`,
      'dump-keychain',
      `find-generic-password -s ${KEYCHAIN_ITEM} -a Claude Code -w`,
      `find-generic-password -s ${KEYCHAIN_ITEM} -a bób -w`,
    ])
  })

  test('DMN-31 AC2: no item holds an access token → an error counting the items tried, naming no account or value', () => {
    const secrets = [fakeToken('mcp'), fakeToken('refresh'), fakeToken('mcp')]
    const { bin } = fakeSecurity({ 'Claude Code': mcpOnly(secrets[0]), alice: JSON.stringify({ claudeAiOauth: { refreshToken: secrets[1] } }), zed: `not json ${secrets[2]}` })
    assert.throws(
      () => keychainToken({ security: bin, user: 'alice' }),
      (e) =>
        /none of the 3 "Claude Code-credentials" item\(s\) tried holds a claudeAiOauth.accessToken \(account name lengths: 5, 11, 3\)/.test(e.message) &&
        !['alice', 'zed', 'Claude Code '].some((a) => e.message.includes(a)) &&
        secrets.every((v) => !e.message.includes(v)),
    )
  })

  test('no item at all (or a failing security) is "no item", not an empty token', () => {
    assert.throws(() => keychainToken({ security: fakeSecurity({}).bin, user: 'alice' }), /no "Claude Code-credentials" item in the login keychain/)
    assert.throws(() => keychainToken({ security: fakeSecurity({}, { dumpCode: 1 }).bin, user: 'alice' }), /no "Claude Code-credentials" item/)
    assert.throws(() => keychainToken({ security: '/nonexistent/security', user: 'alice' }), /no "Claude Code-credentials" item/)
  })
})

describe('AC1: --auth keychain delivers the token on a fresh fd only', () => {
  test('re-read per attempt, received on fd 3, absent from env, argv, trace, logs and results', { skip: NO_SEATBELT }, async () => {
    const issued = []
    const auth = createAuth({ mode: 'keychain', harness: 'claude-code', readKeychain: () => (issued.push(fakeToken('kc')), issued.at(-1)) })
    const { out, results } = await attempts({ auth, env: { FAKE_AUTH_REPORT: '1' }, k: 2 })
    for (const r of results) assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    assert.equal(issued.length, 2, 'one keychain read per attempt')
    assert.notEqual(issued[0], issued[1])
    const seen = inits(out, 'auth').map((i) => i.auth)
    assert.deepEqual(seen.map((a) => a.tokenSha256), issued.map(sha), 'each attempt got its own fresh token')
    for (const [i, a] of seen.entries()) {
      assert.equal(a.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3')
      assert.deepEqual(a.envHoldingToken, [], 'token in the harness env')
      assert.ok(!inits(out, 'auth')[i].argv.some((x) => x.includes(issued[i])), 'token in argv')
    }
    const written = allFiles(out) + JSON.stringify(results)
    for (const t of issued) assert.ok(!written.includes(t), 'token in the trace, logs or results')
    assert.deepEqual(results.map((r) => r.authMode), ['keychain', 'keychain'])
  })

  test('a keychain read that fails is a runner error naming no value', async () => {
    const auth = createAuth({ mode: 'keychain', harness: 'claude-code', readKeychain: () => keychainToken({ security: '/nonexistent/security' }) })
    const { results } = await attempts({ auth })
    assert.ok(results[0].errorKinds.includes('runner_error'))
    assert.match(results[0].failed[0].message, /no "Claude Code-credentials" item/)
  })

  test('only claude-code (and hbar, which is claude-code) can take a pipe', () => {
    for (const harness of ['pi', 'codex', 'fake']) assert.throws(() => createAuth({ mode: 'keychain', harness, readKeychain: () => 'x' }), /needs --harness claude-code/)
    assert.throws(() => piAdapter.runOnce({ tokenPipe: 'x', prompt: 'p' }), /unsupported option\(s\) tokenPipe/)
  })
})

describe('--auth fd: the inherited fd is read once and forwarded on a fresh pipe', () => {
  test('fdToken reads and closes the fd and drops the variable', () => {
    const dir = tmp()
    const token = fakeToken('fd')
    writeFileSync(join(dir, 't'), token + '\n')
    const fd = openSync(join(dir, 't'), 'r')
    const env = { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: String(fd) }
    assert.equal(fdToken(env), token)
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined)
    assert.throws(() => closeSync(fd), /EBADF/, 'the inherited fd is closed')
    assert.throws(() => createAuth({ mode: 'fd', harness: 'claude-code', env: {} }), /needs CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR/)
  })

  test('every attempt gets the token on its own fd 3, never in its env', { skip: NO_SEATBELT }, async () => {
    const dir = tmp()
    const token = fakeToken('fd')
    writeFileSync(join(dir, 't'), token)
    const auth = createAuth({ mode: 'fd', harness: 'claude-code', env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: String(openSync(join(dir, 't'), 'r')) } })
    const { out, results } = await attempts({ auth, env: { FAKE_AUTH_REPORT: '1' }, k: 2 })
    for (const r of results) assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    for (const a of inits(out, 'auth').map((i) => i.auth)) {
      assert.equal(a.tokenSha256, sha(token))
      assert.equal(a.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3')
      assert.deepEqual(a.envHoldingToken, [])
    }
    assert.ok(!(allFiles(out) + JSON.stringify(results)).includes(token))
    assert.equal(results[0].authMode, 'fd')
  })
})

describe('AC2: --auth proxy for claude-code', () => {
  const MODEL = 'claude-sonnet-eval'

  test('ANTHROPIC_BASE_URL is the localhost proxy, every tier pinned to --model, subprocess scrub on', { skip: NO_SEATBELT }, async () => {
    const proxyTok = fakeToken('proxy')
    const auth = createAuth({ mode: 'proxy', harness: 'claude-code', model: MODEL, readProxyToken: () => proxyTok })
    const { out, results } = await attempts({ auth, env: { FAKE_AUTH_REPORT: '1' } })
    assert.deepEqual(results[0].errorKinds, [], JSON.stringify(results[0].failed))
    const [{ auth: a }] = inits(out, 'auth')
    assert.deepEqual(a.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
    })
    assert.equal(a.proxyTokenSha256, sha(proxyTok), 'ANTHROPIC_AUTH_TOKEN is the proxy token')
    assert.deepEqual(a.envHoldingProxyToken, [])
    assert.ok(!(allFiles(out) + JSON.stringify(results)).includes(proxyTok))
    assert.equal(results[0].authMode, 'proxy')
  })

  test('a non-localhost base URL is refused; --model is required', () => {
    for (const proxyUrl of ['https://proxy.example:8317', 'http://10.0.0.5:8317', 'http://127.0.0.1.evil.example:8317'])
      assert.throws(() => createAuth({ mode: 'proxy', harness: 'claude-code', model: MODEL, proxyUrl, readProxyToken: () => 'x' }), /non-localhost/, proxyUrl)
    assert.throws(() => createAuth({ mode: 'proxy', harness: 'claude-code', readProxyToken: () => 'x' }), /needs --model/)
    assert.throws(() => createAuth({ mode: 'proxy', harness: 'fake', model: MODEL, readProxyToken: () => 'x' }), /needs --harness claude-code or pi or codex/)
    assert.throws(() => createAuth({ mode: 'bogus', harness: 'claude-code' }), /--auth must be one of none, fd, keychain, proxy/)
  })

  test('the proxy port is reachable from the sandbox and the egress proxy in proxy mode only', { skip: NO_SEATBELT }, async () => {
    const server = net.createServer((s) => s.destroy())
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address()
    try {
      const auth = createAuth({ mode: 'proxy', harness: 'claude-code', model: MODEL, proxyUrl: `http://127.0.0.1:${port}`, readProxyToken: () => 'x' })
      const proxied = await attempts({ auth, env: { FAKE_CONNECT: String(port) } })
      assert.equal(inits(proxied.out, 'auth')[0].connected, true)
      const none = await attempts({ auth: createAuth({ mode: 'none' }), env: { FAKE_CONNECT: String(port) } })
      assert.equal(inits(none.out, 'auth')[0].connected, false, 'the sandbox blocks the proxy port without --auth proxy')
    } finally {
      server.close()
    }
    assert.ok(allowedTarget('127.0.0.1:8317', undefined, createAuth({ mode: 'proxy', harness: 'claude-code', model: MODEL, readProxyToken: () => 'x' }).attempt().egressAllow))
    assert.ok(!allowedTarget('127.0.0.1:8317'), 'the egress proxy refuses it by default')
    assert.deepEqual(createAuth({ mode: 'none' }).attempt(), { secrets: [] })
    assert.equal(PROXY_URL, 'http://127.0.0.1:8317')
  })
})

describe('AC3: pi proxy mode writes a sandbox models.json pointing only at the localhost proxy', () => {
  const pi = guardHarness(piAdapter)
  const bin = script('pi', `exec "${process.execPath}" "${join(HERE, 'conformance/fake-pi.mjs')}" "$@"`)
  const mcpConfig = () => {
    const f = join(tmp(), 'mcp.json')
    writeFileSync(f, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4321/mcp' } } }))
    return f
  }

  test('runOnce: one provider, the proxy URL and token, --model cliproxy/<model>; no auth.json; removed on exit', async () => {
    const proxyTok = fakeToken('proxy')
    const { provider } = createAuth({ mode: 'proxy', harness: 'pi', model: 'claude-sonnet-eval', readProxyToken: () => proxyTok }).attempt()
    const fakeDir = tmp()
    const sandboxHome = tmp()
    const res = await pi.runOnce({ bin, prompt: 'mcp', model: 'claude-sonnet-eval', mcpConfig: mcpConfig(), sandboxHome, provider, env: { FAKE_DIR: fakeDir } }).done
    assert.equal(res.outcome?.ok, true, res.stderr)
    const seen = JSON.parse(readFileSync(join(fakeDir, 'mcp-seen.json'), 'utf8'))
    assert.deepEqual(JSON.parse(seen.models), {
      providers: { cliproxy: { baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', apiKey: proxyTok, models: [{ id: 'claude-sonnet-eval' }] } },
    })
    assert.equal(seen.auth, null, 'the real auth.json is not copied in proxy mode')
    assert.equal(seen.argv[seen.argv.indexOf('--model') + 1], 'cliproxy/claude-sonnet-eval')
    assert.ok(!existsSync(join(sandboxHome, '.pi/agent/models.json')), 'models.json is deleted when pi exits')
    assert.ok(!JSON.stringify(res.events).includes(proxyTok))
  })

  test('a non-localhost provider is refused before pi starts', () => {
    const fakeDir = tmp()
    assert.throws(
      () => pi.runOnce({ bin, prompt: 'mcp', mcpConfig: mcpConfig(), sandboxHome: tmp(), provider: { baseUrl: 'https://api.example/v1', apiKey: 'x' }, env: { FAKE_DIR: fakeDir } }),
      /non-localhost provider/,
    )
    assert.ok(!existsSync(join(fakeDir, 'mcp-seen.json')))
    assert.throws(() => pi.runOnce({ bin, prompt: 'mcp', provider: { baseUrl: PROXY_URL, apiKey: 'x' } }), /provider without sandboxHome/)
  })
})

describe('AC4: the keychain token and the proxy token join the canary scan set', () => {
  const canaryScenario = { credentials: { canary: true }, expect: [{ noCanaryLeak: true }] }

  for (const [mode, leak] of [['keychain', 'fd'], ['proxy', 'proxy']])
    test(`--auth ${mode}: a harness that prints its credential fails noCanaryLeak, and the message names no value`, { skip: NO_SEATBELT }, async () => {
      const value = fakeToken(mode)
      const auth =
        mode === 'keychain'
          ? createAuth({ mode, harness: 'claude-code', readKeychain: () => value })
          : createAuth({ mode, harness: 'claude-code', model: 'm', readProxyToken: () => value })
      const clean = await attempts({ auth, scenario: canaryScenario })
      assert.equal(clean.results[0].pass, true, JSON.stringify(clean.results[0].failed))
      const leaky = await attempts({ auth, scenario: canaryScenario, env: { FAKE_LEAK: leak } })
      assert.deepEqual(leaky.results[0].failed.map((f) => f.message), ["the runner's auth token leaked into the trace, outbound messages or state"])
      assert.ok(!JSON.stringify(leaky.results).includes(value))
    })
})

describe('the sandboxed harness env is an allowlist: nothing ambient, local endpoints only through --auth proxy', () => {
  const MODEL = 'claude-sonnet-eval'
  const SECRET = `secret-${randomBytes(8).toString('hex')}`
  // What the runner and the sandbox set themselves; /bin/sh (the fake's wrapper) adds PWD, SHLVL, _ and OLDPWD,
  // macOS adds __CF_USER_TEXT_ENCODING to every process it spawns.
  const OWN = ['HOME', 'TMPDIR', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDE_CONFIG_DIR', 'NODE_USE_ENV_PROXY', 'NODE_NO_WARNINGS']
  const SHELL = /^(PWD|SHLVL|_|OLDPWD|__CF_USER_TEXT_ENCODING)$/
  const PROXY_VARS = /^(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)$/
  const PROXY_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']
  // Keys the harness saw beyond the allowlist, the runner's own and `extra`.
  const unexpected = (env, extra = []) =>
    Object.keys(env).filter((k) => !(AMBIENT_ENV.test(k) || OWN.includes(k) || SHELL.test(k) || PROXY_VARS.test(k) || /^FAKE_/.test(k) || extra.includes(k)))
  // The runner's own env holds a local model endpoint and an unrelated token for the duration of fn.
  const ambient = async (port, fn) => {
    const saved = { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, FOO_TOKEN: process.env.FOO_TOKEN }
    Object.assign(process.env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, FOO_TOKEN: SECRET })
    try {
      return await fn()
    } finally {
      for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v)
    }
  }
  const listen = async () => {
    const server = net.createServer((s) => s.destroy())
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    return server
  }

  test('none: an ambient ANTHROPIC_BASE_URL and FOO_TOKEN never reach the harness, and that endpoint is blocked', { skip: NO_SEATBELT }, async () => {
    const server = await listen()
    const { port } = server.address()
    try {
      const { out, results } = await ambient(port, () => attempts({ auth: createAuth({ mode: 'none' }), env: { FAKE_ENV_REPORT: '1', FAKE_CONNECT: String(port) } }))
      assert.deepEqual(results[0].errorKinds, [], JSON.stringify(results[0].failed))
      const [init] = inits(out, 'auth')
      assert.equal(init.connected, false, 'the ambient local model endpoint is not reachable')
      assert.deepEqual(unexpected(init.env), [])
      for (const k of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'FOO_TOKEN']) assert.equal(init.env[k], undefined, k)
      assert.ok(!JSON.stringify(init.env).includes(SECRET))
    } finally {
      server.close()
    }
  })

  test('proxy: the harness sees only the proxy variables, not the ambient ones', { skip: NO_SEATBELT }, async () => {
    const proxyTok = fakeToken('proxy')
    const auth = createAuth({ mode: 'proxy', harness: 'claude-code', model: MODEL, readProxyToken: () => proxyTok })
    const { out, results } = await ambient(1, () => attempts({ auth, env: { FAKE_ENV_REPORT: '1' } }))
    assert.deepEqual(results[0].errorKinds, [], JSON.stringify(results[0].failed))
    const [{ env }] = inits(out, 'auth')
    assert.deepEqual(unexpected(env, PROXY_ENV), [])
    assert.deepEqual(Object.keys(env).filter((k) => /^(ANTHROPIC|OPENAI)_/.test(k)).sort(), PROXY_ENV.filter((k) => k.startsWith('ANTHROPIC_')).sort())
    assert.equal(env.ANTHROPIC_BASE_URL, PROXY_URL)
    assert.equal(env.FOO_TOKEN, undefined)
    assert.ok(!JSON.stringify(env).includes(SECRET))
  })

  test('the judge: the same allowlist and --auth modes', { skip: NO_SEATBELT }, async () => {
    // The judge's sandbox reads only the binary's directory: the fake goes next to its wrapper.
    const dir = tmp()
    copyFileSync(join(HERE, 'fixtures/fake-claude-eval.mjs'), join(dir, 'fake.mjs'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake.mjs')}" "$@"\n`)
    chmodSync(bin, 0o755)
    const judge = async (auth, extra = {}) => {
      let init
      const harness = {
        runOnce: (o) => {
          const run = claude.runOnce({ ...o, bin, env: { ...o.env, FAKE_ENV_REPORT: '1', FAKE_TEXT: '{"helpful": 5, "tone": 5, "format": 5}', ...extra } })
          run.events.on('raw', (l) => l.includes('"subtype":"init"') && (init = JSON.parse(l)))
          return run
        },
      }
      const v = await modelJudge({ channel: 'sl', request: 'hi', replies: ['hello'] }, { harness, auth })
      assert.equal(v.score, 1)
      return init
    }
    const server = await listen()
    const { port } = server.address()
    try {
      const none = await ambient(port, () => judge(undefined, { FAKE_CONNECT: String(port) }))
      assert.equal(none.connected, false, 'the ambient local model endpoint is not reachable')
      assert.deepEqual(unexpected(none.env), [])
      for (const k of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'FOO_TOKEN']) assert.equal(none.env[k], undefined, k)
      const proxyTok = fakeToken('proxy')
      const auth = createAuth({ mode: 'proxy', harness: 'claude-code', model: MODEL, proxyUrl: `http://127.0.0.1:${port}`, readProxyToken: () => proxyTok })
      const proxied = await ambient(1, () => judge(auth, { FAKE_CONNECT: String(port) }))
      assert.equal(proxied.connected, true, 'the proxy port is reachable with --auth proxy')
      assert.deepEqual(unexpected(proxied.env, PROXY_ENV), [])
      assert.equal(proxied.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`)
      assert.equal(proxied.env.ANTHROPIC_AUTH_TOKEN, proxyTok)
      for (const e of [none.env, proxied.env]) assert.ok(!JSON.stringify(e).includes(SECRET))
    } finally {
      server.close()
    }
  })
})

describe('run.mjs --auth', () => {
  const run = (args) =>
    new Promise((resolve) => execFile(process.execPath, [join(ROOT, 'evals/run.mjs'), ...args], { cwd: ROOT }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })))

  test('a bad mode or a harness the mode cannot reach exits 2', async () => {
    const base = ['--harness', 'fake', '--scenarios', 'evals/scenarios/examples/*', '--out', tmp()]
    let r = await run([...base, '--auth', 'bogus'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--auth must be one of/)
    r = await run([...base, '--auth', 'keychain'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--auth keychain needs --harness claude-code/)
  })

  test('the default is none, recorded in results.json and summary.json', async () => {
    const out = tmp()
    const r = await run(['--harness', 'fake', '--scenarios', 'evals/scenarios/examples/*', '--out', out])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
    assert.ok(results.length > 0 && results.every((x) => x.authMode === 'none'))
    assert.equal(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).authMode, 'none')
  })
})
