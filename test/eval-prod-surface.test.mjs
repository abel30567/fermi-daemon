// DMN-22: the eval harness runs on the production tool surface. The runner builds a
// sandbox daemon dir per attempt (<sandbox HOME>/fermi-daemon: prompts/, the real
// tools/teams-send.sh posting to a fake Teams endpoint, a fake tools/transcribe.sh,
// media/ and media/out/), the harness's Bash runs there, and the harness gets the
// production allowlist (lib/run-policy.mjs). The sandboxed cases need sandbox-exec
// (macOS) and are skipped elsewhere.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as claude from '../harness/claude-code.mjs'
import { sandboxBackend } from '../harness/sandbox.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { evaluate } from '../evals/lib/assertions.mjs'
import { EVAL_ALLOWED_TOOLS, createDaemonDir, runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import { ALLOWED_TOOLS } from '../lib/run-policy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn22-'))
const NO_SEATBELT = sandboxBackend() === 'sandbox-exec' ? false : `needs sandbox-exec (macOS); ${process.platform} has ${sandboxBackend() ?? 'no sandbox backend'}`
const TEAMS = join(ROOT, 'evals/scenarios/control/teams-reply-shell.json')
const readTrace = (...p) => readFileSync(join(...p), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const results = (trace) => trace.filter((e) => e.type === 'tool_result')
// A tool result without Node's own warning lines ("(node:<pid>) ...", "[UNDICI-...]" and the
// "(Use `node --trace-warnings ...`" hint after them), which vary by Node version.
const noNodeWarnings = (s) => s.split('\n').filter((l) => !/^(\(node:|\[UNDICI-|\(Use `node --trace-warnings)/.test(l)).join('\n')

// Every entry under `dir` → { relative path: "type size mtime" }, symlinks not followed.
function snapshot(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    out[p.slice(base.length + 1)] = `${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'} ${st.isDirectory() ? '' : st.size} ${st.mtimeMs}`
    if (st.isDirectory()) snapshot(p, base, out)
  }
  return out
}

describe('AC1: the Teams scenario passes with a harness that really runs tools/teams-send.sh through Bash', () => {
  test('the scripted Bash call posts to the fake Teams endpoint, which records it; teams.count is 1', { skip: NO_SEATBELT }, async () => {
    const out = tmp()
    const scenario = loadScenario(TEAMS)
    assert.deepEqual(scenario.fake.turns[0], [{ shell: "~/fermi-daemon/tools/teams-send.sh 'Paris.'", exec: true }])
    const r = await runAttempt({ scenario, attempt: 1, harness: fake, timeoutMs: 20_000, outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(r.errorKinds, [])
    const [res] = results(readTrace(out, scenario.name, '1', 'trace.jsonl'))
    assert.deepEqual([res.ok, noNodeWarnings(res.content).trim()], [true, 'sent (200)'])
    const posts = JSON.parse(readFileSync(join(out, scenario.name, '1', 'state.json'), 'utf8')).fakes.teams
    assert.equal(posts.length, 1)
    assert.equal(posts[0].method, 'POST')
    assert.equal(posts[0].body.attachments[0].content.body[0].text, 'Paris.')
  })

  test('teams.count counts the endpoint POSTs (eq / min / max)', () => {
    const state = { fakes: { teams: [{ method: 'POST' }, { method: 'GET' }] } }
    const run = (spec) => evaluate([{ 'teams.count': spec }], { trace: [], state, scenario: {}, latencyMs: 0 })
    assert.deepEqual(run(1), [])
    assert.deepEqual(run({ min: 1, max: 1 }), [])
    assert.match(run(0)[0].message, /^teams\.count: expected 0, got 1$/)
    assert.match(run({ min: 2 })[0].message, /expected at least 2, got 1/)
    assert.deepEqual(evaluate([{ 'teams.count': 0 }], { trace: [], state: {}, scenario: {}, latencyMs: 0 }), [])
  })
})

describe('AC2: an attempt writes no file outside its sandbox dir', () => {
  test('$HOME (with a decoy daemon dir) is byte-for-byte the same after Teams, transcription, media/out and an outside write', { skip: NO_SEATBELT }, async (t) => {
    // A stand-in $HOME with a decoy daemon dir whose teams-outbound.url is not local:
    // the harness must use the sandbox's, and an inherited DAEMON_HOME must not leak in.
    const home = tmp()
    writeFileSync(join(home, '.profile'), 'export X=1\n')
    mkdirSync(join(home, 'fermi-daemon/tools'), { recursive: true })
    writeFileSync(join(home, 'fermi-daemon/teams-outbound.url'), 'https://prod.example.invalid/teams\n')
    const saved = { HOME: process.env.HOME, DAEMON_HOME: process.env.DAEMON_HOME }
    process.env.HOME = home
    process.env.DAEMON_HOME = join(home, 'fermi-daemon')
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v)
    })
    const before = snapshot(home)
    const base = loadScenario(TEAMS)
    const scenario = {
      ...base,
      name: 'dmn22-home',
      inbound: { ...base.inbound, attachment: { kind: 'audio', file: 'note.m4a' } },
      fixtures: { transcript: "It's the capital of France." },
      expect: [{ 'teams.count': 1 }],
      fake: {
        turns: [
          [
            { shell: `~/fermi-daemon/tools/teams-send.sh 'Paris.' && test -s "$TMPDIR/teams-send-last.txt" && pwd`, exec: true },
            { shell: '~/fermi-daemon/tools/transcribe.sh ~/fermi-daemon/media/note.m4a en', exec: true },
            { shell: 'echo png > media/out/chart.png && ls media/out', exec: true },
            { shell: `echo leak > "${home}/leak"`, exec: true },
          ],
        ],
      },
    }
    const out = tmp()
    const r = await runAttempt({ scenario, attempt: 1, harness: fake, timeoutMs: 20_000, outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    const [send, transcribe, media, leak] = results(readTrace(out, scenario.name, '1', 'trace.jsonl'))
    assert.equal(send.ok, true, send.content)
    assert.match(noNodeWarnings(send.content), /^sent \(200\)\n\/.+\/eval-home-[^/]+\/fermi-daemon\n$/) // the cwd is the sandbox daemon dir
    assert.deepEqual([transcribe.ok, transcribe.content], [true, "It's the capital of France.\n"])
    assert.deepEqual([media.ok, media.content], [true, 'chart.png\n'])
    assert.equal(leak.ok, false)
    assert.match(leak.content, /Operation not permitted/)
    assert.deepEqual(snapshot(home), before)
    assert.ok(!existsSync(join(home, 'leak')))
  })
})

describe('AC3: the runner refuses a non-local teams-outbound.url', () => {
  test('createDaemonDir throws before any harness starts on a non-localhost or missing URL', () => {
    for (const teamsUrl of ['https://prod-00.westus.logic.azure.com/workflows/x/triggers/manual/paths/invoke?sig=y', 'http://10.0.0.5:80/teams', undefined])
      assert.throws(() => createDaemonDir(tmp(), { teamsUrl }), /refusing to start: non-localhost URL\(s\) configured: teams-outbound\.url=/, String(teamsUrl))
  })

  test('a local URL builds the daemon dir: prompts without the private overlay, the real teams-send.sh, the fake transcribe.sh, media/out', () => {
    const home = tmp()
    const dir = createDaemonDir(home, { teamsUrl: 'http://127.0.0.1:9/teams', transcript: 'hi', attachment: { kind: 'audio', file: '../../note.m4a' } })
    assert.equal(dir, join(home, 'fermi-daemon'))
    assert.equal(readFileSync(join(dir, 'teams-outbound.url'), 'utf8'), 'http://127.0.0.1:9/teams\n')
    assert.equal(readFileSync(join(dir, 'prompts/drain.md'), 'utf8'), readFileSync(join(ROOT, 'prompts/drain.md'), 'utf8'))
    assert.equal(readFileSync(join(dir, 'prompts/local.json'), 'utf8'), readFileSync(join(ROOT, 'evals/fixtures/prompt-overlay.json'), 'utf8'))
    assert.equal(readFileSync(join(dir, 'tools/teams-send.sh'), 'utf8'), readFileSync(join(ROOT, 'tools/teams-send.sh'), 'utf8'))
    assert.ok(lstatSync(join(dir, 'tools/teams-send.sh')).mode & 0o100)
    assert.ok(lstatSync(join(dir, 'media/out')).isDirectory())
    assert.ok(existsSync(join(dir, 'media/note.m4a'))) // the basename only: nothing escapes media/
    const transcribe = join(dir, 'tools/transcribe.sh')
    assert.equal(execFileSync(transcribe, [join(dir, 'media/note.m4a')], { encoding: 'utf8' }), 'hi\n')
    assert.throws(() => execFileSync(transcribe, [join(dir, 'media/missing.m4a')], { stdio: 'pipe' }), /no such file/)
    const quoted = createDaemonDir(tmp(), { teamsUrl: 'http://localhost:9/t', transcript: `it's "$HOME" \`x\`` })
    assert.equal(execFileSync(join(quoted, 'tools/transcribe.sh'), [join(dir, 'media/note.m4a')], { encoding: 'utf8' }), 'it\'s "$HOME" `x`\n')
    const none = createDaemonDir(tmp(), { teamsUrl: 'http://127.0.0.1:9/t' })
    assert.throws(() => execFileSync(join(none, 'tools/transcribe.sh'), [join(dir, 'media/note.m4a')], { stdio: 'pipe' }), /no fixtures\.transcript/)
  })
})

describe('the production allowlist, cwd and HOME', () => {
  test("EVAL_ALLOWED_TOOLS is run-policy's ALLOWED_TOOLS with the Fermi grant on the eval server", () => {
    assert.equal(ALLOWED_TOOLS, 'Bash,mcp__claude_ai_Fermi,mcp__playwright,mcp__claude_ai_Google_Calendar')
    assert.deepEqual(EVAL_ALLOWED_TOOLS, ['Bash', 'mcp__fermi', 'mcp__playwright', 'mcp__claude_ai_Google_Calendar'])
  })

  test('the harness runs in the sandbox daemon dir with the sandbox as HOME', async () => {
    let seen
    const spy = { runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    const scenario = { name: 'spy', inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }, expect: [], fake: { script: [] } }
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(seen.allowedTools, EVAL_ALLOWED_TOOLS)
    assert.equal(seen.cwd, join(seen.sandbox.root, 'fermi-daemon'))
    assert.equal(seen.sandbox.env.HOME, seen.sandbox.root)
  })

  test('claude-code through the runner gets --allowedTools Bash,mcp__fermi,… next to --tools Bash,ToolSearch', { skip: NO_SEATBELT }, async () => {
    const bin = join(tmp(), 'claude')
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'fixtures/fake-claude-eval.mjs')}" "$@"\n`)
    chmodSync(bin, 0o755)
    const harness = { name: 'claude-code', runOnce: (o) => claude.runOnce({ ...o, bin, env: { ...o.env, FAKE_INIT_TOOLS: '["Bash","mcp__fermi__task_claim"]' } }) }
    const out = tmp()
    const scenario = { name: 'argv', inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }, expect: [] }
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out, sandboxReadable: [HERE] })
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    const raw = readFileSync(join(out, 'argv/1/raw.log'), 'utf8')
    const argv = JSON.parse(raw.split('\n').find((l) => l.includes('"subtype":"init"'))).argv
    assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Bash,mcp__fermi,mcp__playwright,mcp__claude_ai_Google_Calendar')
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Bash,ToolSearch')
  })
})
