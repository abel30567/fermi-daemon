import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import http from 'node:http'
import { ROOT } from './run-worker.mjs'

// Runs narrator.py over a normalized events log whose task_claim result names (channel, chat_id),
// followed by one Bash call, and returns what it POSTed to /admin/narrate.
async function narrate(channel, chatId) {
  const home = mkdtempSync(join(tmpdir(), 'dmn42-narrator-'))
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
  const claim = JSON.stringify({ tasks: [{ channel, chat_id: chatId }] })
  const events = [
    { type: 'tool_result', content: claim },
    { type: 'tool_call', name: 'Bash', input: { command: 'ls' } },
    { type: 'turn_end' },
  ]
  writeFileSync(join(runs, 'warm-1.log'), '')
  writeFileSync(join(runs, 'warm-1.events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const py = spawn('python3', [join(ROOT, 'narrator.py'), join(realpathSync(runs), 'warm-1.log')], {
    env: { PATH: process.env.PATH, HOME: home, NARRATOR_MIN_INTERVAL: '0' },
    stdio: 'ignore',
  })
  const [code] = await once(py, 'exit')
  server.close()
  assert.equal(code, 0)
  return posts
}

for (const [channel, chatId] of [
  ['wa', '120363000000000000@g.us'],
  ['tg', '-1001000000000'],
  ['sl', 'C0EVALCHAN'],
  ['sl', 'G0EVALGROUP'],
  ['dc', '100000000000000000'],
]) {
  test(`no narration in a ${channel} group chat (${chatId})`, async () => {
    assert.deepEqual(await narrate(channel, chatId), [])
  })
}

for (const [channel, chatId] of [
  ['wa', '15555550100@s.whatsapp.net'],
  ['tg', '15555550100'],
  ['sl', 'D0EVALDM'],
]) {
  test(`DMs still narrate: ${channel} ${chatId}`, async () => {
    assert.deepEqual(await narrate(channel, chatId), [{ channel, chat_id: chatId, text: '⚙️ Running `ls`' }])
  })
}
