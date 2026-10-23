// Child process for DMN-24: one fake-harness attempt whose harness first opens
// the long-lived SSE `GET /mcp` through the proxy, and the upstream sends one
// event then destroys its socket mid-stream (the eval worker shutting down).
// Without the proxy's error handling the unhandled stream 'error' kills this
// process; with it the attempt finishes. Prints { result, notes } as JSON.
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '../../evals/lib/net.mjs'
import { runAttempt } from '../../evals/lib/runner.mjs'
import * as fake from '../../evals/harness/fake.mjs'

const upstream = await serve((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"hello":1}\n\n')
  setTimeout(() => req.socket.destroy(), 50)
})

// The fake target has no SSE stream, so the proxy's upstream GET /mcp goes to the cutting upstream instead.
const realFetch = globalThis.fetch
globalThis.fetch = (url, init = {}) =>
  realFetch(init.method === 'GET' && new URL(url).pathname === '/mcp' ? `${upstream.url}/mcp` : url, init)

// The harness's side of the SSE stream: resolves once the proxy has ended it, with the bytes received.
const openSse = (url) =>
  new Promise((resolve) => {
    let data = ''
    const req = http.get(url, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.on('data', (c) => (data += c))
      res.on('error', () => {})
      res.on('close', () => resolve(data))
    })
    req.on('error', () => resolve(data))
  })

let sse = null
const harness = {
  name: 'sse-cut',
  runOnce(o) {
    const events = new EventEmitter()
    const done = (async () => {
      await null
      const { url } = JSON.parse(readFileSync(o.mcpConfig, 'utf8')).mcpServers.fermi
      sse = await openSse(url)
      const run = fake.runOnce(o) // the proxy must still serve the drain after the cut
      run.events.on('event', (ev) => events.emit('event', ev))
      return run.done
    })()
    return { pid: process.pid, events, done, close: () => {} }
  },
}

const scenario = {
  name: 'sse-cut',
  fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
  inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
  expect: [{ called: 'channel_send' }, { 'task.status': 'done' }],
  fake: {
    script: [
      { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } },
      { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text: 'ok' } },
      { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'r' } },
    ],
  },
}
const outDir = mkdtempSync(join(tmpdir(), 'dmn24-'))
const result = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir })
const trace = readFileSync(join(outDir, 'sse-cut/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
await upstream.close()
console.log(JSON.stringify({ result, sse, notes: trace.filter((e) => e.type === 'note') }))
