// Harness conformance suite: the daemon's contract for a harness adapter
// (harness/index.mjs), proven against a fake harness binary that replays
// fixture streams in the harness's native protocol. No inference.
//
// runConformance(adapterFactory, fakeHarness, { expectedFail })
//   adapterFactory  () => the adapter module (or a promise of it)
//   fakeHarness     { name, options }: options are the adapter options that run
//                   the fake (e.g. { bin }). A turn whose text (one-shot: prompt)
//                   is <fixture> makes the fake replay
//                   test/fixtures/harness/<name>/<fixture>.jsonl. Every fake
//                   provides turn, tools, slow, hang, crash, credentials, secrets
//                   and error-<kind> per ERROR_KINDS; see fake-claude-code.mjs.
//   expectedFail    { [case key]: reason } for cases the adapter structurally
//                   cannot meet; they run as todo.
// Timeout and crash (cases 6, 7) run through harness/supervise.mjs, which turns
// process-level failures into turn outcomes the same way for every adapter.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import http from 'node:http'
import { supervise } from '../../harness/supervise.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
export const ERROR_KINDS = ['auth', 'spend_limit', 'rate_limit', 'context_overflow', 'api_error', 'unknown_error']

const until = async (cond, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 200))
const isEnd = (e) => e.type === 'turn_end'
const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function runConformance(adapterFactory, fakeHarness, { expectedFail = {} } = {}) {
  let adapter
  const dirs = []
  const opts = (extra) => {
    const dir = mkdtempSync(join(tmpdir(), 'dmn4-'))
    dirs.push(dir)
    return { model: 'm', systemPrompt: 'p', cwd: dir, env: { FAKE_DIR: dir }, ...fakeHarness.options, ...extra }
  }
  // A session that records its events; turn(name) sends one turn and resolves
  // with its events up to (and including) the first turn_end after the send.
  const sessions = []
  const open = (o = opts(), supervision) => {
    let s = adapter.startSession(o)
    if (supervision) s = supervise(s, supervision)
    const r = { s, dir: o.cwd, events: [], raw: [], exited: false }
    s.events.on('event', (e) => r.events.push(e))
    s.events.on('raw', (l) => r.raw.push(l))
    s.events.on('exit', () => (r.exited = true))
    r.turn = async (name, ms) => {
      const from = r.events.length
      s.send(name)
      await until(() => r.events.slice(from).some(isEnd), ms)
      const evs = r.events.slice(from)
      return evs.slice(0, evs.findIndex(isEnd) + 1)
    }
    sessions.push(s)
    return r
  }
  const contractCase = (key, title, fn) =>
    test(title, expectedFail[key] ? { todo: expectedFail[key] } : {}, async () => {
      adapter = await adapterFactory()
      try {
        await fn()
      } finally {
        for (const s of sessions.splice(0)) {
          s.close('SIGKILL')
          if (running(s.pid)) process.kill(s.pid, 'SIGKILL') // even if the adapter's close() is broken
        }
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
      }
    })

  describe(`harness conformance: ${fakeHarness.name}`, () => {
    contractCase('turn_end', '1. one turn_end per turn', async () => {
      const r = open()
      const turns = ['turn', 'tools', 'turn']
      for (const name of turns) await r.turn(name)
      await settle()
      assert.equal(r.events.filter(isEnd).length, turns.length)

      const { outcome, events } = await adapter.runOnce({ ...opts(), prompt: 'tools' }).done
      assert.equal(events.filter(isEnd).length, 1)
      assert.equal(outcome, events.find(isEnd))
      assert.equal(outcome.ok, true)
    })

    contractCase('interrupt', '2. an interrupt mid-turn ends the turn; the next send works in the same session', async () => {
      const r = open()
      const from = r.events.length
      r.s.send('slow') // the fake sleeps 10 s mid-turn
      await until(() => r.events.slice(from).some((e) => e.type === 'text'))
      const t0 = Date.now()
      r.s.interrupt()
      await until(() => r.events.slice(from).some(isEnd), 3000)
      assert.ok(Date.now() - t0 < 2000, 'the interrupt ended the turn early')
      assert.equal(r.events.slice(from).find(isEnd).ok, false)
      assert.equal(r.s.alive, true)
      const next = await r.turn('turn')
      assert.equal(next.at(-1).ok, true)
      assert.equal(r.exited, false, 'same process')
      assert.ok(!r.events.some((e) => e.type === 'text' && e.text === 'late'), 'the interrupted turn did not resume')
    })

    contractCase('tool_names', '3. tool names are normalized', async () => {
      const calls = (await open().turn('tools')).filter((e) => e.type === 'tool_call')
      assert.deepEqual(calls.map((c) => c.name), ['task_claim', 'skill_load', 'browser_navigate', 'Bash'])
      assert.ok(calls.every((c) => typeof c.rawName === 'string' && c.rawName.endsWith(c.name)))
    })

    contractCase('tool_result_id', '4. tool_result is correlated by id', async () => {
      const evs = await open().turn('tools')
      const calls = evs.filter((e) => e.type === 'tool_call')
      const results = evs.filter((e) => e.type === 'tool_result')
      assert.equal(new Set(calls.map((c) => c.id)).size, 4, 'tool_call ids are unique')
      // The fixture runs calls 1 and 2 in parallel and returns 2 before 1.
      const callOf = results.map((r) => calls.findIndex((c) => c.id === r.id))
      assert.deepEqual(callOf, [0, 2, 1, 3])
      results.forEach((r, i) => assert.ok(evs.indexOf(calls[callOf[i]]) < evs.indexOf(r), 'result follows its call'))
      const want = [/"tasks"/, /web-forms/, /example\.com\/form/, /command not found/]
      results.forEach((r, i) => assert.match(r.content, want[callOf[i]]))
      assert.deepEqual(results.map((r) => r.ok), [true, true, true, false])
    })

    contractCase('error_kinds', '5. every error kind surfaces as turn_end.ok=false with the right kind', async () => {
      const r = open()
      const got = {}
      for (const kind of ERROR_KINDS) {
        const end = (await r.turn(`error-${kind}`)).at(-1)
        got[kind] = `${end.ok}/${end.kind}`
      }
      assert.deepEqual(got, Object.fromEntries(ERROR_KINDS.map((k) => [k, `false/${k}`])))
    })

    contractCase('timeout', '6. a hung harness is killed after the timeout and reported as timeout', async () => {
      const r = open(undefined, { turnTimeoutMs: 300 })
      const t0 = Date.now()
      const end = (await r.turn('hang')).at(-1)
      assert.equal(end.ok, false)
      assert.equal(end.kind, 'timeout')
      assert.ok(Date.now() - t0 >= 300 && Date.now() - t0 < 3000)
      await until(() => !running(r.s.pid), 3000)
      await settle()
      assert.equal(r.events.filter(isEnd).length, 1)
    })

    contractCase('crash', '7. a harness crash is reported as crash and the session can be restarted', async () => {
      const r = open(undefined, {})
      const end = (await r.turn('crash')).at(-1)
      assert.equal(end.ok, false)
      assert.equal(end.kind, 'crash')
      await until(() => r.exited)
      assert.equal(r.s.alive, false)
      const again = open(undefined, {})
      assert.notEqual(again.s.pid, r.s.pid)
      assert.equal((await again.turn('turn')).at(-1).ok, true)
    })

    contractCase('credential_isolation', '8. credential isolation: a tokenFd token never reaches argv, child env or events', async () => {
      const o = opts()
      const token = `sk-ant-oat01-${randomUUID()}`
      writeFileSync(join(o.cwd, 'token'), token)
      const fd = openSync(join(o.cwd, 'token'), 'r')
      let r
      try {
        r = open({ ...o, tokenFd: fd })
        assert.equal((await r.turn('credentials')).at(-1).ok, true)
      } finally {
        closeSync(fd)
      }
      const cred = JSON.parse(readFileSync(join(o.cwd, 'cred.json'), 'utf8'))
      assert.equal(cred.tokenSha256, createHash('sha256').update(token).digest('hex'), 'the harness received the token')
      assert.ok(!cred.argv.some((a) => a.includes(token)), 'token in argv')
      const childEnv = JSON.parse(readFileSync(join(o.cwd, 'child-env.json'), 'utf8'))
      assert.ok(Object.keys(childEnv).length > 0)
      assert.deepEqual(Object.keys(childEnv).filter((k) => String(childEnv[k]).includes(token)), [], 'token in a child env')
      assert.ok(!JSON.stringify(r.events).includes(token), 'token in the event stream')
      assert.ok(!r.raw.join('\n').includes(token), 'token in the raw stream')
    })

    contractCase('narrator_redaction', '9. secrets in tool inputs are redacted in narrator output', async () => {
      const r = open()
      await r.turn('secrets')
      const posts = await narrate(r.events, r.raw)
      assert.deepEqual(posts, [
        '⚙️ Running `API_TOKEN=«redacted» curl -s https://example.com/api`',
        "⚙️ Running `curl -H 'Authorization: Bearer «redacted»' https://example.com/me`",
        '🌐 Browsing `https://example.com/cb?token=«redacted»`',
      ])
      assert.ok(!posts.join('\n').includes('s3cr3t'))
    })
  })
}

// narrator.py over a turn's normalized events (and raw lines, as the warm worker
// writes them); returns the progress lines it posted.
async function narrate(events, raw) {
  const home = mkdtempSync(join(tmpdir(), 'dmn4-narrator-'))
  const runs = join(home, 'fermi-daemon/runs')
  mkdirSync(runs, { recursive: true })
  const posts = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/admin/narrate') posts.push(JSON.parse(body).text)
      res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    writeFileSync(join(home, 'fermi-daemon/.env'), `FERMI_URL=http://127.0.0.1:${server.address().port}\nFERMI_BEARER_TOKEN=test\n`)
    writeFileSync(join(runs, 'warm-1.log'), raw.map((l) => l + '\n').join(''))
    writeFileSync(join(runs, 'warm-1.events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''))
    const py = spawn('python3', [join(ROOT, 'narrator.py'), join(realpathSync(runs), 'warm-1.log')], {
      env: { PATH: process.env.PATH, HOME: home, NARRATOR_MIN_INTERVAL: '0' },
      stdio: 'ignore',
    })
    const [code] = await once(py, 'exit')
    assert.equal(code, 0)
    return posts
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
}
