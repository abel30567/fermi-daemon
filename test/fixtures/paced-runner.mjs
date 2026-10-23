// One eval runner process for the DMN-34 lock test: `n` attempts through runAttempt,
// paced like evals/run.mjs (createPacer on `backend`, the lock under `home`). Its stub
// harness appends {pid, start, end} per attempt to `log`, holding the attempt `holdMs`.
//   node paced-runner.mjs <home> <log> <out> <backend> <n> <holdMs> [minGapMs]
import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { createPacer } from '../../evals/lib/pacing.mjs'
import { runAttempt } from '../../evals/lib/runner.mjs'

const [home, log, out, backend, n, holdMs, minGapMs = '0'] = process.argv.slice(2)
const inbound = { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' }

const harness = {
  name: 'fake',
  runOnce() {
    const events = new EventEmitter()
    const done = (async () => {
      const start = Date.now()
      await sleep(Number(holdMs))
      appendFileSync(log, JSON.stringify({ pid: process.pid, start, end: Date.now() }) + '\n')
      events.emit('event', { type: 'turn_end', ok: true, kind: 'ok', detail: 'stub', durationMs: 0, raw: null })
      return { code: 0 }
    })()
    return { pid: process.pid, events, done, close() {} }
  },
}

const pacer = createPacer({ backend, minGapMs: Number(minGapMs), home, pollMs: 10 })
for (let attempt = 1; attempt <= Number(n); attempt++) {
  const r = await runAttempt({ scenario: { name: `p${process.pid}`, inbound, expect: [] }, attempt, harness, timeoutMs: 10_000, outDir: out, pace: pacer.run })
  if (!r.pass) throw new Error(JSON.stringify(r.failed))
}
