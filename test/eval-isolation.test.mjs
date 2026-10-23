// DMN-26: eval harness isolation. The claude-code eval argv, the OS sandbox
// (harness/sandbox.mjs) every adapter spawns through, the per-attempt isolation
// assertion (evals/lib/isolation.mjs) and the breach canaries. The sandbox cases
// need sandbox-exec (macOS) and are skipped elsewhere.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as claude from '../harness/claude-code.mjs'
import * as codex from '../harness/codex.mjs'
import * as pi from '../harness/pi.mjs'
import { createSandbox, sandboxBackend } from '../harness/sandbox.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { allowedTarget, startEgressProxy } from '../evals/lib/egress-proxy.mjs'
import { checkMcpConfig, isolationBreach } from '../evals/lib/isolation.mjs'
import { runAttempt, summarize } from '../evals/lib/runner.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn26-'))
const SEATBELT = sandboxBackend() === 'sandbox-exec'
const NO_SEATBELT = SEATBELT ? false : `needs sandbox-exec (macOS); ${process.platform} has ${sandboxBackend() ?? 'no sandbox backend'}`
const REAL_HOME = userInfo().homedir
const inbound = { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }

// A /bin/sh wrapper that execs a node fake, as the conformance suites do.
const fakeBin = (name, script) => {
  const bin = join(tmp(), name)
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}
const CLAUDE_BIN = fakeBin('claude', join(HERE, 'fixtures/fake-claude-eval.mjs'))
const fakeClaude = (env = {}) => ({ runOnce: (o) => claude.runOnce({ ...o, bin: CLAUDE_BIN, env: { ...o.env, ...env } }) })
const claudeAttempt = (scenario, env, outDir = tmp()) =>
  runAttempt({ scenario: { name: 'iso', inbound, expect: [], ...scenario }, attempt: 1, harness: fakeClaude(env), timeoutMs: 10_000, outDir, sandboxReadable: [HERE] }).then((r) => ({
    r,
    raw: existsSync(join(outDir, 'iso/1/raw.log')) ? readFileSync(join(outDir, 'iso/1/raw.log'), 'utf8') : '',
  }))
const argvOf = (raw) => JSON.parse(raw.split('\n').find((l) => l.includes('"subtype":"init"'))).argv
const flag = (argv, f) => argv[argv.indexOf(f) + 1]

describe('AC1: the claude-code eval argv', () => {
  test('through the runner: --setting-sources project,local, --strict-mcp-config, --tools "", never bypassPermissions', { skip: NO_SEATBELT }, async () => {
    const { r, raw } = await claudeAttempt({})
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    const argv = argvOf(raw)
    assert.equal(flag(argv, '--setting-sources'), 'project,local')
    assert.ok(argv.includes('--strict-mcp-config'))
    assert.ok(argv.includes('--tools'))
    assert.equal(flag(argv, '--tools'), '', '--tools "": no built-in tools')
    assert.equal(flag(argv, '--permission-mode'), 'default')
    assert.ok(!argv.some((a) => /bypassPermissions|dangerously-skip-permissions/.test(a)), argv.join(' '))
  })

  test('a scenario that declares tools: ["Bash"] gets --tools Bash', { skip: NO_SEATBELT }, async () => {
    const { r, raw } = await claudeAttempt({ tools: ['Bash'] }, { FAKE_INIT_TOOLS: '["Bash","mcp__fermi__task_claim"]' })
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    assert.equal(flag(argvOf(raw), '--tools'), 'Bash')
  })

  test('the session args get the same restrictions from the runner options', async () => {
    let seen
    const spy = { runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    await runAttempt({ scenario: { name: 'iso', inbound, expect: [], fake: { script: [] } }, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    const a = claude.sessionArgs(seen)
    assert.equal(flag(a, '--setting-sources'), 'project,local')
    assert.ok(a.includes('--strict-mcp-config'))
    assert.equal(flag(a, '--tools'), '')
    assert.equal(flag(a, '--permission-mode'), 'default')
    assert.ok(!a.some((x) => /bypassPermissions|dangerously-skip-permissions/.test(x)))
    assert.equal(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
    assert.equal(seen.skipPermissions, undefined)
  })

  test('the warm worker (no eval options) keeps its argv', () => {
    const a = claude.sessionArgs({ model: 'm', systemPrompt: 'p', allowedTools: ['Bash', 'mcp__claude_ai_Fermi__*'] })
    assert.ok(!a.includes('--tools') && !a.includes('--strict-mcp-config') && !a.includes('--permission-mode'), a.join(' '))
  })
})

describe('AC2: a sandboxed stand-in harness (/bin/sh)', () => {
  test('cannot write outside its sandbox or read ~/.ssh, ~/.claude, ~/fermi-daemon; can reach its 127.0.0.1 port only', { skip: NO_SEATBELT }, async (t) => {
    // A home with the three targets planted, so a denied read is the sandbox and not a missing file;
    // it stands in as $HOME, and the real home is denied too.
    const home = tmp()
    for (const [d, f] of [['.ssh', 'id_ed25519'], ['.claude', 'settings.json'], ['fermi-daemon', 'poll.sh']]) {
      mkdirSync(join(home, d))
      writeFileSync(join(home, d, f), 'secret\n')
    }
    const saved = process.env.HOME
    process.env.HOME = home
    t.after(() => (process.env.HOME = saved))
    const allowed = await listen()
    const other = await listen()
    t.after(() => (allowed.close(), other.close()))
    const root = tmp()
    const box = createSandbox({ root, localPorts: [allowed.port] })
    const rand = randomBytes(6).toString('hex')
    const outside = [join(REAL_HOME, `eval-breach-${rand}`), join(home, `eval-breach-${rand}`), join(tmpdir(), `eval-breach-${rand}`), `/tmp/eval-breach-${rand}`]
    t.after(() => outside.forEach((f) => rmSync(f, { force: true })))
    // Async, so this process's own 127.0.0.1 servers can answer meanwhile.
    const run = (cmd, argv, o = {}) =>
      new Promise((resolve) => execFile(cmd, argv, { encoding: 'utf8', ...o }, (err, stdout) => resolve({ status: err ? (err.code ?? 1) : 0, stdout })))
    const sh = (script) => run(...box.wrap('/bin/sh', ['-c', script]), { cwd: box.root, env: { ...process.env, ...box.env } })
    const plain = (script) => run('/bin/sh', ['-c', script])

    assert.equal((await sh(`echo ok > "${join(box.root, 'inside')}" && cat "${join(box.root, 'inside')}" && echo ok > "$TMPDIR/t"`)).status, 0, 'writes inside the sandbox and its tmp work')
    for (const f of outside) {
      const r = await sh(`echo pwned > "${f}"`)
      assert.notEqual(r.status, 0, `write ${f}`)
      assert.ok(!existsSync(f), `${f} was not created`)
    }
    for (const p of ['.ssh/id_ed25519', '.claude/settings.json', 'fermi-daemon/poll.sh']) {
      const f = join(home, p)
      assert.equal((await plain(`cat "${f}"`)).status, 0, `control: ${f} is readable unsandboxed`)
      assert.notEqual((await sh(`cat "${f}"`)).status, 0, `read ${f}`)
      assert.notEqual((await sh(`ls "${dirname(f)}"`)).status, 0, `list ${dirname(f)}`)
    }
    // The real home is denied by the same rule (the live daemon checkout is not probed, even sandboxed).
    for (const d of ['.ssh', '.claude']) assert.notEqual((await sh(`ls "${join(REAL_HOME, d)}"`)).status, 0, `list the real ~/${d}`)
    assert.equal((await sh(`/usr/bin/curl -sf -m 5 http://127.0.0.1:${allowed.port}/`)).stdout, 'hi', 'reaches its 127.0.0.1 port')
    assert.equal((await plain(`/usr/bin/curl -sf -m 5 http://127.0.0.1:${other.port}/`)).stdout, 'hi', 'control: the other port answers unsandboxed')
    assert.notEqual((await sh(`/usr/bin/curl -sf -m 5 http://127.0.0.1:${other.port}/`)).status, 0, 'any other localhost port is denied')
  })

  test('without a sandbox backend, wrap refuses instead of running unsandboxed', () => {
    const box = createSandbox({ root: tmp(), platform: 'win32' })
    assert.throws(() => box.wrap('/bin/sh', []), /refusing to run the harness unsandboxed/)
  })
})

const listen = () =>
  new Promise((resolve) => {
    const s = http.createServer((q, res) => res.end('hi')).listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() }))
  })

describe('AC3: the isolation assertion', () => {
  const fakeAttempt = (scenario) =>
    runAttempt({ scenario: { name: 'iso', inbound, expect: [{ called: 'task_claim' }], fake: { script: [{ tool: 'task_claim', args: {} }] }, ...scenario }, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: tmp() })

  test('fake harness: an init listing Bash the scenario did not declare aborts the attempt as isolation_breach', async () => {
    const r = await fakeAttempt({ fake: { builtins: ['Bash'], script: [{ tool: 'task_claim', args: {} }] } })
    assert.equal(r.pass, false)
    assert.ok(r.errorKinds.includes('isolation_breach'), JSON.stringify(r))
    assert.ok(r.failed.some((f) => /isolation breach.*Bash/.test(f.message)))
    assert.deepEqual(r.toolCalls, [], 'aborted at init, before any tool call')
  })

  test('the same init passes when the scenario declares tools: ["Bash"]', async () => {
    const r = await fakeAttempt({ tools: ['Bash'], fake: { builtins: ['Bash'], script: [{ tool: 'task_claim', args: {} }] } })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
  })

  test('a breach is never an expected outcome, not even for a negative control', async () => {
    const r = await fakeAttempt({ expectOutcome: 'fail', fake: { builtins: ['Bash'], script: [] } })
    assert.equal(summarize([{ ...r, expectedOutcome: 'fail' }], {}).ok, false)
  })

  test('claude-code: an init listing Bash kills the harness mid-run', { skip: NO_SEATBELT }, async () => {
    const t0 = Date.now()
    const { r } = await claudeAttempt({}, { FAKE_INIT_TOOLS: '["Bash","mcp__fermi__task_claim"]', FAKE_SLEEP_MS: '8000' })
    assert.ok(r.errorKinds.includes('isolation_breach'), JSON.stringify(r))
    assert.ok(!r.errorKinds.includes('timeout'))
    assert.ok(Date.now() - t0 < 5000, 'aborted, not waited out')
  })

  test('isolationBreach: built-ins, MCP servers and a missing tool list', () => {
    assert.equal(isolationBreach({ tools: ['mcp__fermi__task_claim'], mcpServers: ['fermi'] }), null)
    assert.equal(isolationBreach({ tools: ['bash', 'mcp__fermi__x'] }, { tools: ['Bash'] }), null, 'case-insensitive')
    assert.match(isolationBreach({ tools: ['Bash', 'Read'] }, { tools: ['Bash'] }), /Read/)
    assert.match(isolationBreach({ tools: pi.PI_BUILTINS }), /read, bash, edit, write/)
    assert.match(isolationBreach({ tools: codex.CODEX_BUILTINS }), /Bash, apply_patch/)
    assert.match(isolationBreach({ tools: ['mcp__fermi__x'], mcpServers: ['fermi', 'claude.ai Fermi'] }), /exactly \{fermi\}/)
    assert.match(isolationBreach({ tools: ['mcp__fermi__x', 'mcp__playwright__y'] }), /playwright/)
    assert.match(isolationBreach({ tools: [], mcpServers: [] }), /exactly \{fermi\}/)
    assert.match(isolationBreach({ type: 'init' }), /no tool list/)
  })

  test('checkMcpConfig: exactly { fermi → 127.0.0.1 }', () => {
    checkMcpConfig({ mcpServers: { fermi: { url: 'http://127.0.0.1:1234/mcp' } } })
    for (const bad of [{ fermi: { url: 'http://localhost:1/mcp' } }, { fermi: { url: 'https://fermi.example/mcp' } }, { fermi: { url: 'http://127.0.0.1:1/mcp' }, other: { url: 'http://127.0.0.1:2/mcp' } }, {}])
      assert.throws(() => checkMcpConfig({ mcpServers: bad }), /exactly \{fermi → 127\.0\.0\.1\}/)
  })
})

describe('breach canary: the fake harness Bash call runs under the sandbox', () => {
  test('a scripted write to ~/eval-breach-<rand> fails; a write inside the sandbox works', { skip: NO_SEATBELT }, async (t) => {
    const target = join(REAL_HOME, `eval-breach-${randomBytes(6).toString('hex')}`)
    t.after(() => rmSync(target, { force: true }))
    const out = tmp()
    const scenario = {
      name: 'canary',
      inbound,
      tools: ['Bash'],
      expect: [],
      fake: { builtins: ['Bash'], script: [{ shell: `echo pwned > "${target}"`, exec: true }, { shell: 'echo ok > "$HOME/inside" && cat "$HOME/inside"', exec: true }] },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness: fake, timeoutMs: 10_000, outDir: out })
    assert.deepEqual(r.errorKinds.filter((k) => k !== 'tool_error'), [], JSON.stringify(r.failed))
    assert.ok(!existsSync(target), `${target} must not exist`)
    const results = readFileSync(join(out, 'canary/1/trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.type === 'tool_result')
    assert.equal(results[0].ok, false)
    assert.match(results[0].content, /Operation not permitted/)
    assert.deepEqual([results[1].ok, results[1].content.trim()], [true, 'ok'])
  })

  test('without a sandbox, an exec shell step is refused, not run', async (t) => {
    const target = join(tmp(), 'ran')
    const out = tmp()
    const harness = { runOnce: (o) => fake.runOnce({ ...o, sandbox: undefined }) }
    const scenario = { name: 'nobox', inbound, tools: ['Bash'], expect: [], fake: { builtins: ['Bash'], script: [{ shell: `touch "${target}"`, exec: true }] } }
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out })
    assert.ok(!existsSync(target))
    const res = readFileSync(join(out, 'nobox/1/trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.type === 'tool_result')
    assert.deepEqual([res.ok, res.content], [false, 'fake harness: exec needs a sandbox'])
  })
})

describe('AC4: every adapter spawns through the same sandbox wrapper', () => {
  const FAKES = {
    'claude-code': [claude, fakeBin('claude', join(HERE, 'conformance/fake-claude-code.mjs'))],
    pi: [pi, fakeBin('pi', join(HERE, 'conformance/fake-pi.mjs'))],
    codex: [codex, fakeBin('codex', join(HERE, 'conformance/fake-codex.mjs'))],
  }
  for (const [name, [adapter, bin]] of Object.entries(FAKES)) {
    test(`${name}: runOnce and startSession call sandbox.wrap and run inside it`, async () => {
      const real = createSandbox({ root: tmp(), readable: [HERE] })
      const calls = []
      const sandbox = { ...real, wrap: (b, a) => (calls.push(b), real.backend ? real.wrap(b, a) : [b, a]) }
      const o = { bin, model: 'm', systemPrompt: 'p', cwd: real.root, sandbox, env: { FAKE_DIR: real.root } }
      const res = await adapter.runOnce({ ...o, prompt: 'turn' }).done
      assert.equal(res.outcome?.ok, true, res.stderr)
      const s = adapter.startSession(o)
      const end = new Promise((r) => s.events.on('event', (e) => e.type === 'turn_end' && r(e)))
      s.send('turn')
      assert.equal((await end).ok, true)
      s.close('SIGTERM')
      assert.deepEqual(calls, [bin, bin])
    })
  }

  test('the runner hands every harness the attempt sandbox (HOME and TMPDIR inside it, egress through the proxy)', async () => {
    let seen
    const spy = { runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    const r = await runAttempt({ scenario: { name: 'iso', inbound, expect: [], fake: { script: [] } }, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    assert.equal(typeof seen.sandbox?.wrap, 'function')
    assert.equal(seen.sandbox.env.HOME, seen.sandbox.root)
    assert.equal(seen.sandbox.env.TMPDIR, join(seen.sandbox.root, 'tmp'))
    assert.match(seen.sandbox.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, join(seen.sandbox.root, '.claude'))
  })
})

describe('the egress proxy', () => {
  test('allows only the model endpoints on :443', () => {
    for (const ok of ['api.anthropic.com:443', 'chatgpt.com:443', 'api.openai.com:443', 'api.x.ai:443', 'API.Anthropic.com:443']) assert.ok(allowedTarget(ok), ok)
    for (const bad of ['api.anthropic.com:80', 'evil.example:443', 'api.anthropic.com.evil.example:443', '127.0.0.1:8791', 'github.com:443', '']) assert.ok(!allowedTarget(bad), bad)
  })

  test('a CONNECT to any other host gets a 403 and is reported', async (t) => {
    const denied = []
    const p = await startEgressProxy({ onDeny: (d) => denied.push(d) })
    t.after(p.close)
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(p.port, '127.0.0.1', () => s.write('CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n'))
      let buf = ''
      s.on('data', (d) => (buf += d))
      s.on('end', () => resolve(buf))
      s.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 403/)
    assert.deepEqual(denied, ['CONNECT evil.example:443'])
  })
})
