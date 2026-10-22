// Fake `claude -p --input-format stream-json --output-format stream-json`:
// answers every user message with a result event. Drain turns (the "pending
// tasks" prompt) get FAKE_RESULT (a result-event JSON file) until FAKE_ERRORS
// drain turns have errored, then a success result. Every spawn and turn is
// appended to $FAKE_DIR/turns.log as JSON lines.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.env.FAKE_DIR
const logFile = join(dir, 'turns.log')
const errorResult = JSON.parse(readFileSync(process.env.FAKE_RESULT, 'utf8'))
const maxErrors = Number(process.env.FAKE_ERRORS ?? Infinity)
const delay = Number(process.env.FAKE_DELAY_MS || 0)
const record = (o) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + '\n')
const drainsSoFar = () =>
  readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('"drain":true')).length
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

record({ kind: 'spawn' })
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type !== 'user') return
  const text = msg.message?.content?.[0]?.text || ''
  const drain = text.includes('pending tasks')
  const errored = drain ? drainsSoFar() < maxErrors : true
  record({ kind: 'turn', drain })
  setTimeout(() => {
    out({ type: 'system', subtype: 'init', session_id: 'fake' })
    if (drain && process.env.FAKE_CLAIM) {
      const tasks = [{ id: 't1', channel: 'wa', chat_id: '+15555550100' }]
      out({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ tasks }) }] }] },
      })
    }
    out(
      errored
        ? errorResult
        : { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' },
    )
  }, delay)
})
