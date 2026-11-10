// DMN-51: lib/redact.mjs strips secrets from every persisted line; lib/logs.mjs writes logs
// 0600, chmods older logs on start and prunes runs/. Fake keys are built at runtime, so no
// committed file holds a secret-shaped string (scripts/gates.sh scans the fixtures).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REDACTED, redact, redactLine, createLineRedactor } from '../lib/redact.mjs'
import { openLog, secureLogs, pruneRuns } from '../lib/logs.mjs'
import { scanText } from '../scripts/scan-secrets.mjs'
import { ROOT, runWorker, until } from './run-worker.mjs'

const alnum = (n) => randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n)
const b64url = (s) => Buffer.from(s).toString('base64url')
// One fake key per kind scripts/scan-secrets.mjs fails a run on.
const FAKE = {
  anthropic: `sk-ant-api03-${alnum(40)}`,
  openai: `sk-proj-${alnum(40)}`,
  github: `ghp_${alnum(36)}`,
  githubPat: `github_pat_${alnum(40)}`,
  slack: `xoxb-${alnum(12)}-${alnum(24)}`,
  aws: `AKIA${alnum(16).toUpperCase()}`,
  google: `AIza${alnum(35)}`,
  jwt: `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(`{"sub":"${alnum(12)}"}`)}.${alnum(43)}`,
  bearer: `Bearer ${alnum(40)}`,
}
const PEM_KIND = 'RSA PRIV' + 'ATE KEY'
const pem = (cols = 64) => {
  const body = randomBytes(600).toString('base64')
  return [`-----BEGIN ${PEM_KIND}-----`, ...body.match(new RegExp(`.{1,${cols}}`, 'g')), `-----END ${PEM_KIND}-----`]
}
const mode = (p) => statSync(p).mode & 0o777
const tmp = () => mkdtempSync(join(tmpdir(), 'dmn51-'))
const leaks = (text, secrets) => secrets.filter((s) => text.includes(s))

describe('redact()', () => {
  test('a fake key of every scan-secrets kind becomes [REDACTED] and the result scans clean', () => {
    for (const [kind, key] of Object.entries(FAKE)) {
      const out = redact(`debug: ${key} end`)
      assert.ok(out.includes(REDACTED), kind)
      assert.deepEqual(leaks(out, [key.replace(/^Bearer /, '')]), [], kind)
      assert.deepEqual(scanText(out), [], kind)
      assert.match(out, /^debug: .*end$/, kind)
    }
    assert.equal(redact(`-H 'x-api-key: ${alnum(32)}'`), `-H 'x-api-key: ${REDACTED}'`)
    assert.equal(redact(FAKE.bearer), `Bearer ${REDACTED}`)
  })

  test("narrator.py's secrets fixture: env assignment, auth header and URL token are redacted", () => {
    const text = readFileSync(join(ROOT, 'test/fixtures/harness/claude-code/secrets.jsonl'), 'utf8')
    const out = text.split('\n').map(redactLine).join('\n')
    assert.deepEqual(leaks(out, ['s3cr3t-env-0001', 's3cr3t-hdr-0002', 's3cr3t-url-0003']), [])
    assert.match(out, /API_TOKEN=\[REDACTED\]/)
    assert.match(out, /Bearer \[REDACTED\]/)
    assert.match(out, /\?token=\[REDACTED\]/)
  })

  test('ordinary log text is left alone', () => {
    const text = [
      'drain: 3 pending — firing warm turn',
      'task-0123456789abcdefghijklmnop claimed',
      '{"usage":{"input_tokens":1200,"output_tokens":34}}',
      'if (a === b) return key == c',
      'Basic configuration of the bridge',
      `commit ${randomBytes(20).toString('hex')} at /tmp/fermi-daemon/runs/warm-1.log`,
    ].join('\n')
    assert.equal(redact(text), text)
  })
})

describe('edge case: multiline keys', () => {
  test('a PEM key inside one string, with the text after it kept', () => {
    const lines = pem()
    const out = redact(`key:\n${lines.join('\n')}\nafter the key`)
    assert.equal(out, `key:\n${REDACTED}\nafter the key`)
  })

  test('a PEM key inside a JSON transcript line (escaped newlines)', () => {
    const lines = pem()
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: lines.join('\n') }] } })
    const out = redactLine(line)
    assert.equal(JSON.parse(out).message.content[0].content, REDACTED)
    assert.deepEqual(leaks(out, lines.slice(1, -1)), [])
  })

  test('a PEM key written to a stream line by line and split mid-line, then a normal line', () => {
    const lines = pem()
    const r = createLineRedactor()
    const text = `cat id_rsa\n${lines.join('\n')}\nrun-once: exit 0\n`
    let out = ''
    for (let i = 0; i < text.length; i += 7) out += r.write(text.slice(i, i + 7))
    out += r.end()
    assert.deepEqual(leaks(out, lines.slice(1, -1)), [])
    assert.match(out, /^cat id_rsa\n/)
    assert.match(out, /\nrun-once: exit 0\n$/)
  })

  test('a PEM key cut off before its END line stops redacting at the first non-key line', () => {
    const lines = pem().slice(0, -3)
    const r = createLineRedactor()
    const out = r.write(`${lines.join('\n')}\n{"type":"result","result":"done"}\nrun-once: exit 1\n`) + r.end()
    assert.deepEqual(leaks(out, lines.slice(1)), [])
    assert.match(out, /\n\{"type":"result","result":"done"\}\nrun-once: exit 1\n$/)
  })
})

describe('edge case: base64-wrapped', () => {
  test('a base64 (std and url-safe) blob that decodes to a key is redacted', () => {
    const env = `FERMI_URL=https://fermi.example.workers.dev\nOPENAI_API_KEY=${FAKE.openai}\n`
    for (const enc of ['base64', 'base64url']) {
      const blob = Buffer.from(env).toString(enc)
      assert.equal(redact(`echo ${blob} | base64 -d`), `echo ${REDACTED} | base64 -d`, enc)
    }
  })

  test('a line-wrapped (76-column) base64 blob whose key spans the wrap', () => {
    const blob = Buffer.from(`${'x'.repeat(50)} token ${FAKE.github} ${'y'.repeat(50)}`).toString('base64')
    const wrapped = blob.match(/.{1,76}/g).join('\n')
    const out = redact(`attachment:\n${wrapped}\nend`)
    assert.equal(out, `attachment:\n${REDACTED}\nend`)
  })

  test('Basic auth (base64 user:password) is redacted', () => {
    const basic = Buffer.from(`owner:${alnum(20)}`).toString('base64')
    assert.equal(redact(`Authorization: Basic ${basic}`), `Authorization: Basic ${REDACTED}`)
  })

  test('base64 that decodes to nothing secret (an image) is kept', () => {
    const img = randomBytes(30_000).toString('base64')
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', data: img } }] } })
    assert.equal(redactLine(line), line)
  })
})

describe('edge case: redaction keeps JSON transcripts valid', () => {
  test('every committed stream fixture line is unchanged or still valid JSON', () => {
    const dir = join(ROOT, 'test/fixtures')
    const files = [join(dir, 'claude-stream.jsonl'), ...['claude-code', 'codex', 'pi'].flatMap((h) => readdirSync(join(dir, 'harness', h)).map((f) => join(dir, 'harness', h, f)))]
    let checked = 0
    for (const f of files)
      for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        const out = redactLine(line)
        try {
          JSON.parse(line)
        } catch {
          continue
        }
        assert.doesNotThrow(() => JSON.parse(out), `${f}: ${out}`)
        checked++
      }
    assert.ok(checked > 100, `only ${checked} JSON lines checked`)
    // Only the line holding the fixture's one secret changes; the rest are byte-identical.
    const lines = readFileSync(join(dir, 'claude-stream.jsonl'), 'utf8').split('\n')
    const changed = lines.filter((l) => redactLine(l) !== l)
    assert.equal(changed.length, 1)
    assert.match(changed[0], /API_TOKEN=abc123secret/)
  })

  test('secrets next to escapes, quotes, backslashes and unicode: valid JSON, only the secret changes', () => {
    const texts = [
      `TOKEN="${FAKE.openai}" && echo "done"`,
      `password: '${alnum(16)}'\\`,
      `{"api_key": "${alnum(24)}", "n": 1}`,
      `C:\\keys\\${FAKE.github}\\n — ✓ “${FAKE.google}”`,
      `${FAKE.bearer}\n\t${FAKE.jwt}\u0000end`,
    ]
    for (const text of texts) {
      const ev = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: text } }], n: 3, ok: true, x: null } }
      const out = redactLine(JSON.stringify(ev))
      const back = JSON.parse(out)
      assert.equal(back.message.content[0].input.command, redact(text))
      assert.notEqual(back.message.content[0].input.command, text, text)
      back.message.content[0].input.command = text
      assert.deepEqual(back, ev)
      assert.deepEqual(scanText(out), [])
    }
  })

  test('the events log stays one JSON value per line through openLog', async () => {
    const dir = tmp()
    const path = join(dir, 'e.jsonl')
    const w = openLog(path, 'w')
    const evs = [{ type: 'text', text: `key ${FAKE.anthropic}` }, { type: 'tool', input: { k: pem().join('\n') } }, { type: 'turn_end' }]
    for (const e of evs) w.write(JSON.stringify(e) + '\n')
    await new Promise((r) => w.end(r))
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    assert.deepEqual(lines.map((l) => JSON.parse(l).type), ['text', 'tool', 'turn_end'])
    assert.ok(!lines.join('\n').includes(FAKE.anthropic))
  })
})

describe('edge case: performance on large logs', () => {
  test('50 MB of stream-json (with images and keys) redacts in well under real time', () => {
    const img = randomBytes(1_500_000).toString('base64')
    const lines = []
    let size = 0
    for (let i = 0; size < 50e6; i++) {
      const l =
        i % 500 === 0
          ? JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', data: img } }] } })
          : i % 50 === 0
            ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: `curl -H "x-api-key: ${alnum(30)}" ${FAKE.openai}` } }] } })
            : JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `line ${i}: ${'lorem ipsum dolor sit amet '.repeat(20)} /tmp/a/b/c.log ${randomBytes(20).toString('hex')}` }] } })
      lines.push(l)
      size += l.length + 1
    }
    const r = createLineRedactor()
    const t0 = performance.now()
    let out = 0
    for (let i = 0; i < lines.length; i += 100) out += r.write(lines.slice(i, i + 100).join('\n') + '\n').length
    const ms = performance.now() - t0
    assert.ok(out > 49e6)
    assert.ok(ms < 15_000, `50 MB took ${Math.round(ms)} ms`)
  })

  test('pathological 2 MB lines (one alnum run, endless assignments, an unclosed PEM) stay linear', () => {
    const inputs = [
      'a'.repeat(2e6),
      'KEY'.repeat(7e5) + '=',
      'x=1 '.repeat(5e5),
      `-----BEGIN ${PEM_KIND}-----` + 'A'.repeat(2e6),
      'Bearer '.repeat(3e5),
      '-----BEGIN '.repeat(2e5),
    ]
    for (const s of inputs) {
      const t0 = performance.now()
      redactLine(s)
      const ms = performance.now() - t0
      assert.ok(ms < 2000, `${s.slice(0, 20)}… took ${Math.round(ms)} ms`)
    }
  })
})

describe('log files: 0600, chmod on start, runs/ rotation', () => {
  test('openLog creates new files 0600 and tightens an existing 0644 file', async () => {
    const dir = tmp()
    const fresh = join(dir, 'new.log')
    const old = join(dir, 'old.log')
    writeFileSync(old, 'before\n')
    chmodSync(old, 0o644)
    for (const p of [fresh, old]) {
      const w = openLog(p)
      w.write(`x ${FAKE.slack}\n`)
      await new Promise((r) => w.end(r))
      assert.equal(mode(p), 0o600, p)
      assert.ok(readFileSync(p, 'utf8').endsWith(`x ${REDACTED}\n`))
    }
    assert.match(readFileSync(old, 'utf8'), /^before\n/, 'append keeps what was there')
  })

  test('secureLogs chmods group/world-readable files to 0600 and leaves dirs, symlinks and missing dirs alone', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.log'), '')
    chmodSync(join(dir, 'a.log'), 0o644)
    writeFileSync(join(dir, 'b.log'), '')
    chmodSync(join(dir, 'b.log'), 0o640)
    mkdirSync(join(dir, 'sub'), { mode: 0o755 })
    secureLogs([dir, join(dir, 'missing')])
    assert.equal(mode(join(dir, 'a.log')), 0o600)
    assert.equal(mode(join(dir, 'b.log')), 0o600)
    assert.equal(mode(join(dir, 'sub')), 0o755)
  })

  test('pruneRuns removes files older than N days; 0 keeps everything', () => {
    const dir = tmp()
    const now = Date.now()
    for (const [name, days] of [['old.log', 20], ['edge.log', 13.9], ['new.log', 0]]) {
      writeFileSync(join(dir, name), '')
      const t = (now - days * 86_400_000) / 1000
      utimesSync(join(dir, name), t, t)
    }
    assert.equal(pruneRuns(dir, 0, now), 0)
    assert.equal(readdirSync(dir).length, 3)
    assert.equal(pruneRuns(dir, 14, now), 1)
    assert.deepEqual(readdirSync(dir).sort(), ['edge.log', 'new.log'])
    assert.equal(pruneRuns(join(dir, 'missing'), 14, now), 0)
  })
})

describe('warm worker', () => {
  test('a stream with fake keys: runs/ log and events show [REDACTED], files are 0600; old logs chmodded and expired on start', async () => {
    const dir = tmp()
    const key = pem()
    const stream = join(dir, 'stream.jsonl')
    const out = (o) => JSON.stringify(o) + '\n'
    writeFileSync(
      stream,
      out({ type: 'system', subtype: 'init', session_id: 'fake', model: 'fake', tools: ['Bash'] }) +
        out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `OPENAI_API_KEY=${FAKE.openai} curl -H "Authorization: ${FAKE.bearer}" x` } }] } }) +
        out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: key.join('\n') }] } }) +
        out({ type: 'assistant', message: { content: [{ type: 'text', text: `found ${FAKE.github}` }] } }) +
        out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }),
    )
    const secrets = [FAKE.openai, FAKE.bearer.slice(7), FAKE.github, ...key.slice(1, -1)]
    let modes
    const { runs, log } = await runWorker({
      result: { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' },
      durationMs: 0,
      env: { FAKE_STREAM: stream, RUNS_RETENTION_DAYS: '7' },
      setup: (daemon) => {
        mkdirSync(join(daemon, 'logs'))
        for (const f of ['runs/old-but-kept.log', 'runs/expired.log', 'logs/warm-worker.log']) {
          writeFileSync(join(daemon, f), 'x\n')
          chmodSync(join(daemon, f), 0o644)
        }
        const t = (Date.now() - 8 * 86_400_000) / 1000
        utimesSync(join(daemon, 'runs/expired.log'), t, t)
        const kept = (Date.now() - 6 * 86_400_000) / 1000
        utimesSync(join(daemon, 'runs/old-but-kept.log'), kept, kept)
      },
      act: async ({ home }) => {
        const d = join(home, 'fermi-daemon')
        const read = (f) => readFileSync(join(d, 'runs', f), 'utf8')
        await until(() => {
          const l = readdirSync(join(d, 'runs')).find((f) => /^warm-\d+\.log$/.test(f))
          return l && /"result"/.test(read(l)) && /turn_end|result/.test(read(l.replace(/\.log$/, '.events.jsonl')))
        })
        modes = Object.fromEntries([...readdirSync(join(d, 'runs')).map((f) => `runs/${f}`), 'logs/warm-worker.log'].map((f) => [f, mode(join(d, f))]))
      },
    })
    const turn = Object.keys(runs).find((f) => /^warm-\d+\.log$/.test(f))
    assert.ok(turn, log)
    const events = runs[turn.replace(/\.log$/, '.events.jsonl')]
    for (const text of [runs[turn], events]) {
      assert.deepEqual(leaks(text, secrets), [])
      assert.match(text, /\[REDACTED\]/)
      for (const l of text.trim().split('\n')) JSON.parse(l)
    }
    assert.match(runs[turn], /OPENAI_API_KEY=\[REDACTED\]/)
    assert.ok(!('expired.log' in runs), 'runs/ file older than RUNS_RETENTION_DAYS removed')
    assert.ok('old-but-kept.log' in runs)
    assert.match(log, /runs\/: removed 1 file\(s\) older than 7 days/)
    for (const [f, m] of Object.entries(modes)) assert.equal(m, 0o600, f)
    assert.ok(existsSync(stream))
  })
})
