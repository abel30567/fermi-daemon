import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, openSync, closeSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import http from 'node:http'
import { loadHarness, bareToolName } from '../harness/index.mjs'
import { normalizeEvent, startSession, runOnce } from '../harness/claude-code.mjs'
import { ROOT, runWorker, sim } from './run-worker.mjs'

const FAKE = join(ROOT, 'test/fixtures/fake-claude.mjs')
const STREAM = join(ROOT, 'test/fixtures/claude-stream.jsonl')
const GOLDEN = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/claude-stream.events.golden.json'), 'utf8'))
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }
const records = (dir) =>
  readFileSync(join(dir, 'turns.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn3-'))
const script = (path, body) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const until = async (cond, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// The argv warm-worker.mjs spawned claude with before DMN-3 (origin/main @ 7913c2e).
const TODAY_WARM_ARGV = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--model', 'claude-sonnet-5',
  '--setting-sources', 'project,local',
  '--append-system-prompt', 'test prompt\n',
  '--allowedTools', 'Bash,mcp__claude_ai_Fermi,mcp__playwright,mcp__claude_ai_Google_Calendar',
]

describe('AC1: HARNESS unset spawns claude with today\'s argv', { concurrency: true }, () => {
  test('default bin (~/.local/bin/claude)', async () => {
    const { events, log } = await runWorker({ result: SUCCESS, pending: 0, durationMs: 1000 })
    const spawns = events.filter((e) => e.kind === 'spawn')
    assert.equal(spawns.length, 1, log)
    assert.equal(spawns[0].bin, 'default')
    assert.deepEqual(spawns[0].argv, TODAY_WARM_ARGV)
    assert.match(spawns[0].cwd, /\/fermi-daemon$/)
    assert.deepEqual(spawns[0].env, {}) // no harness env vars added by default
  })

  test('CLAUDE_BIN picks the binary, argv unchanged', async () => {
    const alt = script(join(tmp(), 'hbar'), `FAKE_BIN=hbar exec "${process.execPath}" "${FAKE}" "$@"`)
    const { events, log } = await runWorker({ result: SUCCESS, pending: 0, durationMs: 1000, env: { CLAUDE_BIN: alt } })
    const spawns = events.filter((e) => e.kind === 'spawn')
    assert.equal(spawns.length, 1, log)
    assert.equal(spawns[0].bin, 'hbar')
    assert.deepEqual(spawns[0].argv, TODAY_WARM_ARGV)
  })

  test('HARNESS selects the adapter; an unknown one is an error', async () => {
    assert.equal((await loadHarness()).name, 'claude-code')
    assert.equal((await loadHarness('claude-code')).name, 'claude-code')
    await assert.rejects(loadHarness('nope'), /unknown HARNESS "nope"/)
  })
})

describe('DMN-5: HARNESS=pi spawns pi in RPC mode', () => {
  test('PI_BIN picks the binary; argv is the pi trial\'s', async () => {
    const pi = script(join(tmp(), 'pi'), `FAKE_BIN=pi exec "${process.execPath}" "${FAKE}" "$@"`)
    // Run until the fake has recorded its spawn (not a fixed window: slow under load).
    const spawned = ({ home }) => until(() => existsSync(join(home, 'turns.log')) && records(home).some((e) => e.kind === 'spawn'), 15000).catch(() => {})
    const { events, log } = await runWorker({ result: SUCCESS, pending: 0, durationMs: 0, env: { HARNESS: 'pi', PI_BIN: pi }, act: spawned })
    const spawns = events.filter((e) => e.kind === 'spawn')
    assert.equal(spawns.length, 1, log)
    assert.equal(spawns[0].bin, 'pi')
    assert.deepEqual(spawns[0].argv, [
      '--mode', 'rpc',
      '--model', 'anthropic/claude-sonnet-5',
      '--append-system-prompt', 'test prompt\n',
    ])
    assert.match(spawns[0].cwd, /\/fermi-daemon$/)
    assert.equal((await loadHarness('pi')).name, 'pi')
  })
})

describe('AC2: recorded Claude stream → normalized events (golden)', () => {
  const lines = readFileSync(STREAM, 'utf8').trim().split('\n')

  test('normalizeEvent over the fixture equals the golden sequence', () => {
    const got = lines.flatMap((l) => normalizeEvent(JSON.parse(l)))
    assert.deepEqual(got, GOLDEN)
    assert.deepEqual(
      got.map((e) => (e.type === 'tool_call' ? `call:${e.name}` : e.type === 'tool_result' ? `result:${e.ok}` : e.type)),
      [
        'init',
        'call:task_claim', 'result:true',
        'call:context_bootstrap', 'result:true',
        'text', 'call:Bash', 'result:true',
        'call:Bash', 'result:false',
        'call:skill_load', 'result:true',
        'call:browser_navigate', 'result:true',
        'call:Read', 'result:true',
        'call:channel_send', 'result:true',
        'call:task_complete', 'result:true',
        'text',
        'turn_end',
      ],
    )
    const end = got.at(-1)
    assert.deepEqual(
      { ok: end.ok, kind: end.kind, costUsd: end.costUsd, inputTokens: end.inputTokens, outputTokens: end.outputTokens, durationMs: end.durationMs },
      { ok: true, kind: 'ok', costUsd: 0.0812, inputTokens: 1234, outputTokens: 567, durationMs: 41234 },
    )
    assert.deepEqual(end.raw, JSON.parse(lines.at(-1)))
  })

  test('turn_end kind comes from classifyResult', () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/blocking-limit-result.json'), 'utf8'))
    const [end] = normalizeEvent(fixture)
    assert.equal(end.type, 'turn_end')
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'spend_limit')
  })

  test('bareToolName strips MCP server prefixes', () => {
    assert.equal(bareToolName('mcp__claude_ai_Fermi__skill_load'), 'skill_load')
    assert.equal(bareToolName('mcp__fermi__task_claim'), 'task_claim')
    assert.equal(bareToolName('mcp__playwright__browser_navigate'), 'browser_navigate')
    assert.equal(bareToolName('Bash'), 'Bash')
  })

  test('the warm worker writes the raw log and the normalized log for a drain turn', async () => {
    const { runs, log } = await runWorker({ result: SUCCESS, durationMs: 1500, env: { FAKE_STREAM: STREAM } })
    const first = Object.keys(runs).filter((f) => /^warm-\d+\.log$/.test(f)).sort()[0]
    assert.ok(first, log)
    assert.equal(runs[first], readFileSync(STREAM, 'utf8'))
    const normalized = runs[first.replace(/\.log$/, '.events.jsonl')]
    assert.deepEqual(normalized.trim().split('\n').map((l) => JSON.parse(l)), GOLDEN)
  })

  test('runOnce: box-runner argv, prompt on stdin, events plus outcome', async () => {
    const dir = tmp()
    const bin = script(join(dir, 'claude'), `printf '%s\\n' "$@" > "${dir}/argv"; cat > "${dir}/stdin"; cat "${STREAM}"`)
    const run = runOnce({ bin, prompt: 'do the task', skipPermissions: true, mcpConfig: '/work/.mcp.json', cwd: dir })
    const streamed = []
    run.events.on('event', (e) => streamed.push(e))
    const { code, outcome, events } = await run.done
    assert.equal(code, 0)
    assert.deepEqual(readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n'), [
      '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', '/work/.mcp.json', '--strict-mcp-config',
    ])
    assert.equal(readFileSync(join(dir, 'stdin'), 'utf8'), 'do the task')
    assert.deepEqual(events, GOLDEN)
    assert.deepEqual(streamed, GOLDEN)
    assert.equal(outcome, events.at(-1))
  })

  test('bin, configDir, tokenFd and scrubSubprocessEnv reach the child', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'token'), 'tok-123')
    const fd = openSync(join(dir, 'token'), 'r')
    const bin = script(
      join(dir, 'claude'),
      `env | grep -E '^CLAUDE_' | sort > "${dir}/env"; cat <&$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR > "${dir}/tok"; cat "${STREAM}"`,
    )
    const { code } = await runOnce({ bin, prompt: 'x', configDir: '/cfg', tokenFd: fd, scrubSubprocessEnv: true, cwd: dir, env: { CLAUDE_X: '1' } }).done
    closeSync(fd)
    assert.equal(code, 0)
    const keys = /^(CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR|CLAUDE_CODE_SUBPROCESS_ENV_SCRUB|CLAUDE_CONFIG_DIR|CLAUDE_X)=/
    assert.deepEqual(readFileSync(join(dir, 'env'), 'utf8').trim().split('\n').filter((l) => keys.test(l)), [
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=' + fd,
      'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1',
      'CLAUDE_CONFIG_DIR=/cfg',
      'CLAUDE_X=1',
    ])
    assert.equal(readFileSync(join(dir, 'tok'), 'utf8'), 'tok-123')
  })
})

describe('AC3: interrupt sends today\'s control_request and the session survives', { concurrency: true }, () => {
  const isTodaysInterrupt = (msg) =>
    assert.ok(
      Object.keys(msg).join() === 'type,request_id,request' &&
        msg.type === 'control_request' &&
        /^stop_\d+$/.test(msg.request_id) &&
        JSON.stringify(msg.request) === '{"subtype":"interrupt"}',
      JSON.stringify(msg),
    )

  test('adapter session: interrupt ends the turn, the next turn runs on the same process', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'result.json'), JSON.stringify(SUCCESS))
    const bin = script(join(dir, 'claude'), `exec "${process.execPath}" "${FAKE}" "$@"`)
    const s = startSession({
      bin, model: 'm', systemPrompt: 'p', cwd: dir,
      env: { FAKE_DIR: dir, FAKE_RESULT: join(dir, 'result.json'), FAKE_DELAY_MS: '1500' },
    })
    const ends = []
    s.events.on('event', (e) => e.type === 'turn_end' && ends.push({ t: Date.now(), ...e }))
    const t0 = Date.now()
    s.send('There are pending tasks in the queue.')
    await until(() => existsSync(join(dir, 'turns.log')) && records(dir).some((r) => r.kind === 'turn'))
    assert.equal(s.interrupt(), true)
    await until(() => ends.length === 1)
    assert.ok(ends[0].t - t0 < 1500, 'interrupt ended the turn early')
    assert.equal(ends[0].ok, false)
    assert.equal(s.alive, true)
    s.send('Keep-alive. Reply with exactly: OK')
    await until(() => ends.length === 2)
    assert.equal(ends[1].ok, true)
    s.close()
    const recs = records(dir)
    assert.equal(recs.filter((r) => r.kind === 'spawn').length, 1)
    assert.equal(new Set(recs.map((r) => r.pid)).size, 1)
    const controls = recs.filter((r) => r.kind === 'control')
    assert.equal(controls.length, 1)
    isTodaysInterrupt(controls[0].msg)
  })

  test('warm worker: POST /abort interrupts the drain turn, cleanup runs in the same session', async () => {
    let abort
    const { events, log } = await runWorker({
      result: SUCCESS,
      durationMs: 6000,
      env: { FAKE_DELAY_MS: '1000' },
      act: async ({ log, home }) => {
        await until(() => /control endpoint on 127\.0\.0\.1:\d+/.test(log()))
        const port = /control endpoint on 127\.0\.0\.1:(\d+)/.exec(log())[1]
        await until(() => existsSync(join(home, 'turns.log')) && records(home).some((r) => r.drain), 5000)
        abort = await fetch(`http://127.0.0.1:${port}/abort`, {
          method: 'POST',
          body: JSON.stringify({ channel: 'wa', chat_id: '+15555550100' }),
        }).then((r) => r.json())
      },
    })
    assert.deepEqual(abort, { ok: true, interrupted: true }, log)
    assert.match(log, /sent interrupt to claude/)
    assert.equal(events.filter((e) => e.kind === 'spawn').length, 1, log)
    const ci = events.findIndex((e) => e.kind === 'control')
    isTodaysInterrupt(events[ci].msg)
    const cleanup = events.slice(ci + 1).find((e) => e.kind === 'turn')
    assert.ok(cleanup && !cleanup.drain, 'emergency-stop cleanup turn ran after the interrupt\n' + log)
    assert.equal(cleanup.pid, events[0].pid)
    assert.match(log, /emergency-stop cleanup for wa\/\+15555550100/)
  })
})

describe('AC4: narrator posts the same progress lines from the normalized log as from the raw log', () => {
  async function narrate(files) {
    const home = tmp()
    const runs = join(home, 'fermi-daemon/runs')
    mkdirSync(runs, { recursive: true })
    const posts = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (req.url === '/admin/narrate') posts.push(JSON.parse(body))
        res.end('{}')
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    writeFileSync(join(home, 'fermi-daemon/.env'), `FERMI_URL=http://127.0.0.1:${server.address().port}\nFERMI_BEARER_TOKEN=test\n`)
    for (const [name, content] of Object.entries(files)) writeFileSync(join(runs, name), content)
    const py = spawn('python3', [join(ROOT, 'narrator.py'), join(realpathSync(runs), 'warm-1.log')], {
      env: { PATH: process.env.PATH, HOME: home, NARRATOR_MIN_INTERVAL: '0' },
      stdio: 'ignore',
    })
    const [code] = await once(py, 'exit')
    server.close()
    assert.equal(code, 0)
    return posts
  }

  test('same fixture, raw vs normalized', async () => {
    const raw = readFileSync(STREAM, 'utf8')
    const normalized = GOLDEN.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const fromRaw = await narrate({ 'warm-1.log': raw })
    // An empty raw log next to the events log proves the narrator read the events log.
    const fromEvents = await narrate({ 'warm-1.log': '', 'warm-1.events.jsonl': normalized })
    assert.deepEqual(fromRaw.map((p) => p.text), [
      '⚙️ Running `ls -la ~/Downloads`',
      '⚙️ Running `API_TOKEN=«redacted» curl -s https://example.com/api`',
      '📚 Loading skill `web-forms`',
      '🌐 Browsing `https://example.com/form`',
      '📖 Reading `.../answers.md`',
    ])
    assert.ok(fromRaw.every((p) => p.channel === 'wa' && p.chat_id === '+15555550100'))
    assert.deepEqual(fromEvents, fromRaw)
  })
})
