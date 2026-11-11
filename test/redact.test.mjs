// DMN-51: lib/redact.mjs strips secrets from every persisted line; lib/logs.mjs writes logs
// 0600, chmods older logs on start and prunes runs/. Fake keys are built at runtime, so no
// committed file holds a secret-shaped string (scripts/gates.sh scans the fixtures).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
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

describe('JSON lines: a value under a secret-named key', () => {
  test('nested keys, {name, value} pairs and auth headers are redacted; the rest of the line is kept', () => {
    const v = alnum(32)
    const cases = [
      [{ input: { headers: { 'x-api-key': v } } }, { input: { headers: { 'x-api-key': REDACTED } } }],
      [{ env: { API_TOKEN: v, PATH: '/usr/bin' } }, { env: { API_TOKEN: REDACTED, PATH: '/usr/bin' } }],
      [{ input: { password: 'hunter2hunter2' } }, { input: { password: REDACTED } }],
      [{ input: { api_key: v, client_secret: v, refresh_token: v } }, { input: { api_key: REDACTED, client_secret: REDACTED, refresh_token: REDACTED } }],
      [{ headers: { Authorization: v, 'Proxy-Authorization': v } }, { headers: { Authorization: REDACTED, 'Proxy-Authorization': REDACTED } }],
      [{ headers: [{ name: 'x-api-key', value: v }, { name: 'accept', value: 'json' }] }, { headers: [{ name: 'x-api-key', value: REDACTED }, { name: 'accept', value: 'json' }] }],
      [[{ type: 'tool_use', input: { secret: v } }], [{ type: 'tool_use', input: { secret: REDACTED } }]],
    ]
    for (const [ev, want] of cases) {
      const out = redactLine(JSON.stringify(ev))
      assert.deepEqual(JSON.parse(out), want, out)
      assert.ok(!out.includes(v) && !out.includes('hunter2'), out)
    }
    const ws = createLineRedactor().write(JSON.stringify({ input: { 'x-api-key': v } }) + '\n')
    assert.ok(!ws.includes(v), 'the stream redactor too')
  })

  test('non-secret keys, empty and non-string values are left alone', () => {
    const lines = [
      { usage: { input_tokens: 1200, output_tokens: 34, max_tokens: 'auto' } },
      { name: 'Bash', input: { command: 'ls', description: 'list' } },
      { name: 'accept', value: 'application/json' },
      { password: '', token: null, api_key: 3 },
    ].map((o) => JSON.stringify(o))
    for (const l of lines) assert.equal(redactLine(l), l)
  })

  test('camelCase and compound credential names are redacted', () => {
    const v = alnum(28)
    const names = ['accessToken', 'refreshToken', 'clientSecret', 'authToken', 'idToken', 'sessionToken', 'bearerToken', 'passphrase', 'secretKey', 'secret_key', 'Set-Cookie', 'cookie']
    for (const k of names) {
      const out = redactLine(JSON.stringify({ [k]: v, n: 1 }))
      assert.deepEqual(JSON.parse(out), { [k]: REDACTED, n: 1 }, k)
    }
    assert.equal(redact(`clientSecret: ${v}`), `clientSecret: ${REDACTED}`)
  })

  test('no false positives: token counters and tool names stay byte-identical, known secret names stay redacted', () => {
    const v = alnum(28)
    const safe = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'max_tokens', 'token_count', 'tokenizer', 'tokens', 'tool_use_id', 'monkey']
    for (const k of safe) {
      const l = JSON.stringify({ [k]: v })
      assert.equal(redactLine(l), l, k)
      assert.equal(redact(`${k}: ${v}`), `${k}: ${v}`, k)
    }
    for (const l of [JSON.stringify({ name: 'mcp__fermi__task_claim', input: { id: v } }), JSON.stringify({ type: 'tool_use', name: 'mcp__fermi__task_claim' })]) assert.equal(redactLine(l), l)
    const secret = ['api_key', 'apiKey', 'api-key', 'access_token', 'privateKey', 'X-Auth-Token', 'OPENAI_API_KEY', 'credentials', 'password', 'client_secret', 'x-api-key', 'authorization']
    for (const k of secret) assert.deepEqual(JSON.parse(redactLine(JSON.stringify({ [k]: v }))), { [k]: REDACTED }, k)
  })
})

describe('process stdout/stderr (redactStdio)', () => {
  test('console output, partial writes, warnings and uncaught exception traces are redacted', () => {
    for (const fail of ['throw new Error(`boom ${k}`)', 'Promise.reject(new Error(`rej ${k}`))']) {
      const key = FAKE.openai
      const script = `import { redactStdio } from ${JSON.stringify(join(ROOT, 'lib/logs.mjs'))}
redactStdio()
const k = ${JSON.stringify(key)}
console.log('out', k)
console.error('err', k)
process.emitWarning('warn ' + k)
process.stdout.write('partial ' + k)
setTimeout(() => { ${fail} }, 10)`
      // npm test runs under NODE_NO_WARNINGS=1 (scripts/sentinel-home.mjs); this child needs its warning.
      const env = { ...process.env, NODE_NO_WARNINGS: '' }
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env })
      const all = r.stdout + r.stderr
      assert.equal(r.status, 1, all)
      assert.deepEqual(leaks(all, [key]), [], all)
      for (const re of [/out \[REDACTED\]/, /err \[REDACTED\]/, /Warning: warn \[REDACTED\]/, /partial \[REDACTED\]/, /(boom|rej) \[REDACTED\]\n\s+at /]) assert.match(all, re)
    }
  })

  test("run-once's own crash output (poll.sh appends it to the run log) is redacted", () => {
    // An unknown option makes parseArgs throw before anything else runs: an uncaught exception.
    const r = spawnSync(process.execPath, [join(ROOT, 'bin/run-once.mjs'), `--${FAKE.openai}`], { cwd: tmp(), encoding: 'utf8' })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /Unknown option '--\[REDACTED\]'/)
    assert.deepEqual(leaks(r.stdout + r.stderr, [FAKE.openai]), [])
  })
})

describe('gates.sh fixture secret scan', () => {
  const line = /^list=\$\(mktemp\)\n[\s\S]*?^node scripts\/scan-secrets\.mjs .*$/m.exec(readFileSync(join(ROOT, 'scripts/gates.sh'), 'utf8'))?.[0]
  const run = (cwd, env = process.env) => spawnSync('bash', ['-euo', 'pipefail', '-c', line], { cwd, encoding: 'utf8', env })
  // A temp repo with the scanner and the given files, all tracked.
  const repo = (files) => {
    const dir = tmp()
    mkdirSync(join(dir, 'scripts'))
    copyFileSync(join(ROOT, 'scripts/scan-secrets.mjs'), join(dir, 'scripts/scan-secrets.mjs'))
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), text)
    }
    for (const args of [['init', '-q'], ['add', '.']]) assert.equal(spawnSync('git', args, { cwd: dir }).status, 0)
    return dir
  }
  const clean = { 'test/fixtures/a.json': '{}\n', 'evals/fixtures/b.json': '{}\n' }

  test('passes on the committed fixtures', () => {
    assert.ok(line, 'gates.sh runs scan-secrets over the fixtures')
    const r = run(ROOT)
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

  test('fails on a tracked fixture holding a fake key, naming the file but not the value', () => {
    const dir = repo({ ...clean, 'evals/fixtures/run.jsonl': JSON.stringify({ text: `key ${FAKE.openai}` }) + '\n' })
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /evals\/fixtures\/run\.jsonl/)
    assert.ok(!(r.stdout + r.stderr).includes(FAKE.openai))
  })

  test('fails, and does not skip the scan, when git ls-files fails', () => {
    const dir = repo({ ...clean, 'test/fixtures/leak.txt': `key ${FAKE.openai}\n` })
    const shim = tmp()
    const git = spawnSync('command', ['-v', 'git'], { shell: '/bin/sh', encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase "$*" in *fixtures*) echo 'fatal: simulated' >&2; exit 128;; esac\nexec ${JSON.stringify(git)} "$@"\n`)
    chmodSync(join(shim, 'git'), 0o755)
    const r = run(dir, { ...process.env, PATH: `${shim}:${process.env.PATH}` })
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /scan-secrets: git ls-files test\/fixtures failed/)
  })

  test('fails loudly when a fixture dir has no tracked files (renamed or untracked)', () => {
    for (const [files, gone] of [[{}, 'test/fixtures'], [{ 'evals/fixtures/b.json': '{}\n', 'test/fixtures-old/a.json': '{}\n' }, 'test/fixtures'], [{ 'test/fixtures/a.json': '{}\n' }, 'evals/fixtures']]) {
      const r = run(repo(files))
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stderr, new RegExp(`scan-secrets: no tracked files under ${gone}`))
    }
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
  test("its own output is redacted: keys in harness stderr and a Teams message, cut by the log slices, show [REDACTED]", async () => {
    // Each key starts just before its slice limit (200 for stderr, 80 for Teams text), so slicing
    // before redacting would leave a 12-char stub that no pattern matches. The Teams sender is
    // not redacted at its call site: only the stdout redactor (redactStdio) covers it.
    const [key, sender, text] = [FAKE.openai, FAKE.github, FAKE.anthropic]
    const secret = 'test-teams-secret'
    const { log } = await runWorker({
      result: { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' },
      pending: 0,
      durationMs: 0,
      dotenv: `TEAMS_WEBHOOK_SECRET=${secret}\n`,
      env: { FAKE_STDERR: `error: ${'x'.repeat(180)} ${key} denied\n` },
      act: async ({ log }) => {
        await until(() => /teams webhook on 127\.0\.0\.1:\d+/.test(log()))
        const port = /teams webhook on 127\.0\.0\.1:(\d+)/.exec(log())[1]
        const res = await fetch(`http://127.0.0.1:${port}/teams/webhook`, {
          method: 'POST',
          headers: { 'x-teams-bridge-secret': secret },
          body: JSON.stringify({ senderDisplayName: `bot ${sender}`, messageBody: `<p>${'y'.repeat(67)} ${text} end</p>` }),
        })
        assert.equal(res.status, 200)
        await until(() => /claude stderr:/.test(log()) && /teams inbound/.test(log()))
      },
    })
    assert.match(log, /claude stderr: error: x+ \[REDACTED\]/)
    assert.match(log, /teams inbound from bot \[REDACTED\]: y+ \[REDACTED\]/)
    assert.deepEqual(leaks(log, [key, sender, text].map((k) => k.slice(0, 12))), [], log)
  })

  test('a file in logs/ it cannot chmod is a warning, not a startup failure', async () => {
    const locked = []
    const { log } = await runWorker({
      result: { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' },
      durationMs: 0,
      // An unreadable logs/ makes secureLogs throw EACCES, like a root-owned file would EPERM.
      setup: (daemon) => {
        mkdirSync(join(daemon, 'logs'), { mode: 0o000 })
        locked.push(join(daemon, 'logs'))
      },
      act: async ({ log }) => {
        try {
          await until(() => /starting warm claude/.test(log()))
        } finally {
          for (const d of locked) chmodSync(d, 0o700)
        }
      },
    })
    assert.match(log, /warning: could not make runs\/ and logs\/ owner-only: EACCES/)
    assert.match(log, /starting warm claude/)
  })

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
