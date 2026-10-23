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
import { internalToolCalls } from '../evals/lib/assertions.mjs'
import { allowedBuiltins, checkMcpConfig, isolationBreach, plantSandboxCanary, surfaceDelta } from '../evals/lib/isolation.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
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
const fakeClaude = (env = {}) => ({ name: 'claude-code', runOnce: (o) => claude.runOnce({ ...o, bin: CLAUDE_BIN, env: { ...o.env, ...env } }) })
const claudeAttempt = (scenario, env, outDir = tmp()) =>
  runAttempt({ scenario: { name: 'iso', inbound, expect: [], ...scenario }, attempt: 1, harness: fakeClaude(env), timeoutMs: 10_000, outDir, sandboxReadable: [HERE] }).then((r) => ({
    r,
    raw: existsSync(join(outDir, 'iso/1/raw.log')) ? readFileSync(join(outDir, 'iso/1/raw.log'), 'utf8') : '',
  }))
const argvOf = (raw) => JSON.parse(raw.split('\n').find((l) => l.includes('"subtype":"init"'))).argv
const flag = (argv, f) => argv[argv.indexOf(f) + 1]

describe('AC1: the claude-code eval argv', () => {
  test('through the runner: --setting-sources project,local, --strict-mcp-config, --tools Bash,ToolSearch (production), never bypassPermissions', { skip: NO_SEATBELT }, async () => {
    const { r, raw } = await claudeAttempt({}, { FAKE_INIT_TOOLS: '["Bash","mcp__fermi__task_claim"]' })
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    const argv = argvOf(raw)
    assert.equal(flag(argv, '--setting-sources'), 'project,local')
    assert.ok(argv.includes('--strict-mcp-config'))
    assert.ok(argv.includes('--tools'))
    assert.equal(flag(argv, '--tools'), 'Bash,ToolSearch', 'the production surface: a shell next to fermi, whose tools stay deferred')
    assert.equal(flag(argv, '--permission-mode'), 'default')
    assert.ok(!argv.some((a) => /bypassPermissions|dangerously-skip-permissions/.test(a)), argv.join(' '))
  })

  test('a scenario that narrows tools to [] gets --tools ToolSearch: no host tool', { skip: NO_SEATBELT }, async () => {
    const { r, raw } = await claudeAttempt({ tools: [] })
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    assert.equal(flag(argvOf(raw), '--tools'), 'ToolSearch')
  })

  test('an init listing ToolSearch + Bash passes; its ToolSearch call is an internalToolCall', { skip: NO_SEATBELT }, async () => {
    const out = tmp()
    const { r } = await claudeAttempt({}, { FAKE_INIT_TOOLS: '["Bash","ToolSearch","mcp__fermi__task_claim"]', FAKE_TOOL_CALLS: '["ToolSearch","mcp__fermi__task_claim"]' }, out)
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    assert.deepEqual(r.builtinTools, ['Bash', 'ToolSearch'])
    assert.deepEqual(r.surfaceDelta, { added: [], removed: [] }, 'ToolSearch is not surface')
    const trace = readFileSync(join(out, 'iso/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(internalToolCalls(trace), ['ToolSearch'])
  })

  test('an init listing Read next to ToolSearch + Bash breaches', { skip: NO_SEATBELT }, async () => {
    const { r } = await claudeAttempt({}, { FAKE_INIT_TOOLS: '["Bash","ToolSearch","Read","mcp__fermi__task_claim"]' })
    assert.ok(r.errorKinds.includes('isolation_breach'), JSON.stringify(r))
  })

  test('results record builtinTools and surfaceDelta against production', { skip: NO_SEATBELT }, async () => {
    const { r } = await claudeAttempt({}, { FAKE_INIT_TOOLS: '["Bash","mcp__fermi__task_claim"]' })
    assert.deepEqual(r.builtinTools, ['Bash'])
    assert.deepEqual(r.surfaceDelta, { added: [], removed: [] })
  })

  test('the session args get the same restrictions from the runner options', async () => {
    let seen
    const spy = { runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    await runAttempt({ scenario: { name: 'iso', inbound, expect: [], fake: { script: [] } }, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    const a = claude.sessionArgs(seen)
    assert.equal(flag(a, '--setting-sources'), 'project,local')
    assert.ok(a.includes('--strict-mcp-config'))
    assert.equal(flag(a, '--tools'), 'Bash,ToolSearch')
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

  test('fake harness: an init listing a built-in outside the production surface aborts the attempt as isolation_breach', async () => {
    const r = await fakeAttempt({ fake: { builtins: ['Bash', 'Read'], script: [{ tool: 'task_claim', args: {} }] } })
    assert.equal(r.pass, false)
    assert.ok(r.errorKinds.includes('isolation_breach'), JSON.stringify(r))
    assert.ok(r.failed.some((f) => /isolation breach.*: Read$/.test(f.message)), JSON.stringify(r.failed))
    assert.deepEqual(r.toolCalls, [], 'aborted at init, before any tool call')
  })

  test('Bash passes by default (the production surface) and breaches once the scenario narrows tools to []', async () => {
    const ok = await fakeAttempt({ fake: { builtins: ['Bash'], script: [{ tool: 'task_claim', args: {} }] } })
    assert.equal(ok.pass, true, JSON.stringify(ok.failed))
    const narrowed = await fakeAttempt({ tools: [], fake: { builtins: ['Bash'], script: [{ tool: 'task_claim', args: {} }] } })
    assert.ok(narrowed.errorKinds.includes('isolation_breach'), JSON.stringify(narrowed))
  })

  test('pi and codex: their irreducible built-ins are allowed and recorded, anything more breaches', async () => {
    for (const [name, builtins, added] of [
      ['pi', pi.PI_BUILTINS, ['read', 'edit', 'write']],
      ['codex', codex.CODEX_BUILTINS, ['apply_patch']],
    ]) {
      const harness = { name, runOnce: (o) => fake.runOnce({ ...o, builtins }) }
      const r = await runAttempt({ scenario: { name: 'iso', inbound, expect: [{ called: 'task_claim' }], fake: { script: [{ tool: 'task_claim', args: {} }] } }, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
      assert.equal(r.pass, true, `${name}: ${JSON.stringify(r.failed)}`)
      assert.deepEqual(r.builtinTools, builtins)
      assert.deepEqual(r.surfaceDelta, { added, removed: [] })
      const extra = { name, runOnce: (o) => fake.runOnce({ ...o, builtins: [...builtins, 'WebFetch'] }) }
      const b = await runAttempt({ scenario: { name: 'iso', inbound, expect: [], fake: { script: [] } }, attempt: 1, harness: extra, timeoutMs: 10_000, outDir: tmp() })
      assert.ok(b.errorKinds.includes('isolation_breach'), `${name}: ${JSON.stringify(b)}`)
    }
  })

  test('a breach is never an expected outcome, not even for a negative control', async () => {
    const r = await fakeAttempt({ expectOutcome: 'fail', fake: { builtins: ['Read'], script: [] } })
    assert.equal(summarize([{ ...r, expectedOutcome: 'fail' }], {}).ok, false)
  })

  test('claude-code: an init listing a built-in beyond Bash kills the harness mid-run', { skip: NO_SEATBELT }, async () => {
    const t0 = Date.now()
    const { r } = await claudeAttempt({}, { FAKE_INIT_TOOLS: '["Bash","Read","mcp__fermi__task_claim"]', FAKE_SLEEP_MS: '8000' })
    assert.ok(r.errorKinds.includes('isolation_breach'), JSON.stringify(r))
    assert.ok(!r.errorKinds.includes('timeout'))
    assert.ok(Date.now() - t0 < 5000, 'aborted, not waited out')
  })

  test('isolationBreach: built-ins, MCP servers and a missing tool list', () => {
    assert.equal(isolationBreach({ tools: ['mcp__fermi__task_claim'], mcpServers: ['fermi'] }), null)
    assert.equal(isolationBreach({ tools: ['bash', 'mcp__fermi__x'] }), null, 'Bash by default, case-insensitive')
    assert.match(isolationBreach({ tools: ['Bash', 'Read'] }), /: Read$/)
    assert.match(isolationBreach({ tools: ['Bash'] }, { allowed: [] }), /: Bash$/)
    assert.equal(isolationBreach({ tools: ['Bash', 'ToolSearch', 'mcp__fermi__x'] }, { allowed: allowedBuiltins('claude-code') }), null)
    assert.match(isolationBreach({ tools: ['Bash', 'ToolSearch', 'Read'] }, { allowed: allowedBuiltins('claude-code') }), /: Read$/)
    assert.match(isolationBreach({ tools: ['ToolSearch'] }, { allowed: allowedBuiltins('pi') }), /: ToolSearch$/, 'claude-code only')
    assert.match(isolationBreach({ tools: pi.PI_BUILTINS }), /: read, edit, write$/)
    assert.equal(isolationBreach({ tools: pi.PI_BUILTINS }, { allowed: allowedBuiltins('pi') }), null)
    assert.equal(isolationBreach({ tools: codex.CODEX_BUILTINS }, { allowed: allowedBuiltins('codex', []) }), null, 'irreducible even when narrowed')
    assert.match(isolationBreach({ tools: [...codex.CODEX_BUILTINS, 'Read'] }, { allowed: allowedBuiltins('codex') }), /: Read$/)
    assert.match(isolationBreach({ tools: ['mcp__fermi__x'], mcpServers: ['fermi', 'claude.ai Fermi'] }), /exactly \{fermi\}/)
    assert.match(isolationBreach({ tools: ['mcp__fermi__x', 'mcp__playwright__y'] }), /playwright/)
    assert.match(isolationBreach({ tools: [], mcpServers: [] }), /exactly \{fermi\}/)
    assert.match(isolationBreach({ type: 'init' }), /no tool list/)
  })

  test('scenario tools may only narrow the production surface', () => {
    assert.deepEqual(allowedBuiltins('claude-code'), ['Bash', 'ToolSearch'])
    assert.deepEqual(allowedBuiltins('claude-code', []), ['ToolSearch'])
    assert.throws(() => allowedBuiltins('claude-code', ['Read']), /only narrow/)
    const dir = tmp()
    const file = join(dir, 's.json')
    writeFileSync(file, JSON.stringify({ name: 's', inbound, expect: [{ called: 'task_claim' }], tools: ['Read'] }))
    assert.throws(() => loadScenario(file), /only narrow the production surface/)
  })

  test('surfaceDelta: built-ins added to and missing from production', () => {
    assert.deepEqual(surfaceDelta(['Bash']), { added: [], removed: [] })
    assert.deepEqual(surfaceDelta([]), { added: [], removed: ['Bash'] })
    assert.deepEqual(surfaceDelta(['bash', 'apply_patch']), { added: ['apply_patch'], removed: [] })
    assert.deepEqual(surfaceDelta(['ToolSearch']), { added: [], removed: ['Bash'] })
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

describe('sandbox canary: a read of the real $HOME is a breach', () => {
  const canaryAttempt = (harness) =>
    runAttempt({
      scenario: { name: 'canary', inbound, expect: [], fake: { script: [{ shell: `cat "${REAL_HOME}"/.fermi-sandbox-canary-*`, exec: true }] } },
      attempt: 1,
      harness,
      timeoutMs: 10_000,
      outDir: tmp(),
    })

  test('inside the sandbox the canary cannot be read: no breach', { skip: NO_SEATBELT }, async () => {
    const r = await canaryAttempt(fake)
    assert.ok(!r.errorKinds.includes('isolation_breach'), JSON.stringify(r.failed))
  })

  test('a harness that escaped the sandbox reads it: isolation_breach', async () => {
    const leaky = { runOnce: (o) => fake.runOnce({ ...o, sandbox: { ...o.sandbox, wrap: (b, a) => [b, a] } }) }
    const r = await canaryAttempt(leaky)
    assert.ok(r.errorKinds.includes('isolation_breach'), JSON.stringify(r))
    assert.ok(r.failed.some((f) => /sandbox canary/.test(f.message)))
  })

  test('plantSandboxCanary writes a 0600 token file, sees the token in an event and removes it', () => {
    const c = plantSandboxCanary(tmp())
    assert.equal(readFileSync(c.path, 'utf8').trim(), c.token)
    assert.ok(c.seen({ type: 'tool_result', content: `x ${c.token} y` }))
    assert.ok(!c.seen({ type: 'tool_result', content: 'nothing' }))
    c.remove()
    assert.ok(!existsSync(c.path))
  })
})

describe('codex: its own sandbox is off only inside ours', () => {
  // A fake codex that copies the config.toml codex would read to $FAKE_OUT and exits.
  const bin = join(tmp(), 'codex')
  writeFileSync(bin, '#!/bin/sh\ncat > /dev/null\ncp "$CODEX_HOME/config.toml" "$FAKE_OUT"\n')
  chmodSync(bin, 0o755)
  const configOf = async (sandbox) => {
    const dir = sandbox?.root ?? tmp()
    const mcpConfig = join(dir, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { url: 'http://127.0.0.1:1/mcp' } } }))
    const out = join(dir, 'config.copy')
    await codex.runOnce({ bin, prompt: 'p', cwd: dir, mcpConfig, sandbox, env: { FAKE_OUT: out } }).done
    return readFileSync(out, 'utf8')
  }

  test('with our sandbox: sandbox_mode = "danger-full-access" and codex spawned through sandbox.wrap', async () => {
    const real = createSandbox({ root: tmp() })
    const calls = []
    const sandbox = { ...real, wrap: (b, a) => (calls.push(b), real.backend ? real.wrap(b, a) : [b, a]) }
    assert.match(await configOf(sandbox), /^sandbox_mode = "danger-full-access"$/m)
    assert.deepEqual(calls, [bin], 'the setting is only ever used under our wrapper')
  })

  test('without our sandbox: codex keeps its own sandbox (no sandbox_mode)', async () => {
    assert.doesNotMatch(await configOf(undefined), /sandbox_mode/)
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
