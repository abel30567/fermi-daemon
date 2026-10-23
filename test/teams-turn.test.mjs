// DMN-43: the Teams turn names the owner from the prompt overlay (OWNER_SENDER, OWNER_CHANNEL,
// OWNER_NAME), never from a literal in the code, and leaves the note out when the overlay is missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerNote } from '../lib/prompt.mjs'
import { ROOT, runWorker, until } from './run-worker.mjs'

const EXAMPLE = JSON.parse(readFileSync(join(ROOT, 'prompts/local.example.json'), 'utf8'))
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }
const SECRET = 'test-teams-secret'

const records = (home) =>
  existsSync(join(home, 'turns.log')) ? readFileSync(join(home, 'turns.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

// Posts one Teams message to the worker's webhook and returns the Teams turn's text.
async function teamsTurn(overlay) {
  let text
  const { log } = await runWorker({
    result: SUCCESS,
    pending: 0,
    durationMs: 0,
    overlay,
    dotenv: `TEAMS_WEBHOOK_SECRET=${SECRET}\n`,
    act: async ({ log, home }) => {
      await until(() => /control endpoint on 127\.0\.0\.1:\d+/.test(log()))
      const port = /control endpoint on 127\.0\.0\.1:(\d+)/.exec(log())[1]
      const res = await fetch(`http://127.0.0.1:${port}/teams/webhook`, {
        method: 'POST',
        headers: { 'x-teams-bridge-secret': SECRET },
        body: JSON.stringify({ senderDisplayName: 'Tester', messageBody: '<p>hi there</p>' }),
      })
      assert.equal(res.status, 200)
      await until(() => (text = records(home).find((r) => r.kind === 'turn' && r.text?.includes('Microsoft Teams'))?.text))
      await until(() => /teams turn done/.test(log()))
    },
  })
  assert.doesNotMatch(log, /teams turn error/)
  return text
}

test('the Teams turn names the owner from the overlay values', async () => {
  const text = await teamsTurn(EXAMPLE)
  assert.match(text, /- From Tester: hi there/)
  assert.ok(text.includes(`user context (sender ${EXAMPLE.OWNER_SENDER} on channel ${EXAMPLE.OWNER_CHANNEL} is the same person: ${EXAMPLE.OWNER_NAME}).`), text)
  assert.doesNotMatch(text, /\d{7,}/, 'a literal number in the Teams turn')
})

test('without an overlay the Teams turn still runs and omits the owner note', async () => {
  const text = await teamsTurn()
  assert.ok(text.includes('only if you need user context.'), text)
  assert.doesNotMatch(text, /same person|\d{7,}/)
})

test('ownerNote: empty unless the overlay has OWNER_CHANNEL and OWNER_SENDER; OWNER_NAME defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn43-'))
  const at = (o) => (writeFileSync(join(dir, 'o.json'), typeof o === 'string' ? o : JSON.stringify(o)), ownerNote(join(dir, 'o.json')))
  assert.equal(ownerNote(join(dir, 'missing.json')), '')
  assert.equal(at('not json'), '')
  assert.equal(at({ OWNER_CHANNEL: 'sl' }), '')
  assert.equal(at({ OWNER_SENDER: 'U0EXAMPLEOWNER', OWNER_CHANNEL: '' }), '')
  assert.equal(at({ OWNER_SENDER: 'U0EXAMPLEOWNER', OWNER_CHANNEL: 'sl' }), ' (sender U0EXAMPLEOWNER on channel sl is the same person: the owner)')
})
