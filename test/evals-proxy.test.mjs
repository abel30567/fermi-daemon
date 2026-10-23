import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

// DMN-24: the target cutting the harness's SSE `GET /mcp` mid-stream used to crash the runner
// (unhandled 'error' from Readable.fromWeb(up.body).pipe(res)). Run in a child so a crash is an exit code.
test('an SSE stream cut mid-stream by the upstream is a trace note, not a crash', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'test/fixtures/sse-cut-attempt.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const { result, sse, notes } = JSON.parse(r.stdout)
  assert.match(sse, /^data: \{"hello":1\}/) // the event before the cut reached the harness
  assert.equal(result.pass, true, JSON.stringify(result.failed)) // the proxy stayed up for the whole drain
  assert.deepEqual(result.toolCalls, ['task_claim', 'channel_send', 'task_complete'])
  assert.deepEqual(result.errorKinds, [])
  assert.equal(notes.length, 1, JSON.stringify(notes))
  assert.equal(notes[0].source, 'mcp-proxy')
  assert.match(notes[0].detail, /terminated|other side closed/)
})
