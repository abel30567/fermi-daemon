// DMN-43: scripts/private-scan.mjs fails when a tracked file holds a real-looking number, JID or
// LID (or a line matching the local private patterns), passes on the placeholders, and never
// prints the value it found.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const SCAN = join(ROOT, 'scripts/private-scan.mjs')
// Built at runtime so this file holds no number itself: a UK drama-range (fictional) mobile.
const PLANTED = '7700' + '900' + '123'
const NO_PATTERNS = join(tmpdir(), 'dmn43-no-such-patterns-file')

// A temp git repo with `files` ({ name: text }) added to the index.
function repo(files, untracked = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dmn43-scan-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  if (Object.keys(files).length) execFileSync('git', ['add', '.'], { cwd: dir })
  for (const [name, text] of Object.entries(untracked)) writeFileSync(join(dir, name), text)
  return dir
}

const scan = (dir, patterns = NO_PATTERNS) =>
  spawnSync(process.execPath, [SCAN, dir], { encoding: 'utf8', env: { ...process.env, FERMI_PRIVATE_PATTERNS: patterns } })

test('the repo passes the scan', () => {
  const r = scan(ROOT)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /0 finding\(s\)/)
})

for (const [kind, line] of [
  ['E.164 number', `call +44${PLANTED} now`],
  ['WhatsApp JID', `"chat": "44${PLANTED}@s.whatsapp.net"`],
  ['WhatsApp JID', `"chat": "44${PLANTED}-1@g.us"`],
  ['WhatsApp LID', `"lid": "1${PLANTED}99@lid"`],
  ['phone-looking chat id', `(channel wa, chat_id 44${PLANTED} is the same person)`],
]) {
  test(`a planted ${kind} fails the scan without printing it`, () => {
    const r = scan(repo({ 'a.md': 'clean\n', 'b.json': `{\n${line}\n}\n` }))
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, new RegExp(`b\\.json:2: ${kind.replace('.', '\\.')}`))
    assert.ok(!(r.stdout + r.stderr).includes(PLANTED), 'the scanner printed the value')
  })
}

test('the placeholders pass', () => {
  const text = [
    'call +15555550100 or +15555550101',
    '"pn": "15555554567@s.whatsapp.net", "lid": "10000000000000@lid", "alt": "15555550222@lid"',
    '"chat": "120363000000000001@g.us", "dm": "15555550100@c.us"',
    '(channel wa, chat_id 15555550100 is the same person: Example)',
    'mail owner@example.com, ts 1761200000000, id 1@g.us',
  ].join('\n')
  const r = scan(repo({ 'p.md': text }))
  assert.equal(r.status, 0, r.stderr)
})

test('only tracked files are scanned', () => {
  assert.equal(scan(repo({ 'a.md': 'clean\n' }, { 'notes.md': `+44${PLANTED}\n` })).status, 0)
})

test('the local private-patterns file adds patterns, and is skipped when absent', () => {
  const dir = repo({ 'a.md': 'hello Zelda Privatename\n' })
  const patterns = join(dir, '..', `dmn43-patterns-${process.pid}`)
  writeFileSync(patterns, '# comment\n\nZelda\\s+Private\\w+\n+1(\n')
  const r = scan(dir, patterns)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /a\.md:1: private pattern #1/)
  assert.ok(!r.stderr.includes('Zelda'), 'the scanner printed the value')
  assert.match(r.stdout, /2 private pattern\(s\)/)
  assert.equal(scan(dir).status, 0)
})
