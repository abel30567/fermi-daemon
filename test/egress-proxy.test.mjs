// The egress proxy's close() lets the process exit even when a tunnel's upstream never sends its FIN
// (abel30567/hbar#272: run.mjs hung after summary.json on two FIN_WAIT_2 upstream sockets). Offline and unsandboxed:
// node --test test/egress-proxy.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROXY = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../evals/lib/egress-proxy.mjs')).href
const EXIT_WITHIN_MS = 5000

// Opens a CONNECT tunnel to 127.0.0.1:<port>, ends its side of it, closes the proxy and returns.
// Nothing else holds the event loop, so the process exits once close() has released every socket.
const CHILD = `
import net from 'node:net'
import { startEgressProxy } from ${JSON.stringify(PROXY)}
const target = '127.0.0.1:' + process.argv[1]
const egress = await startEgressProxy({ hosts: [], local: [target] })
const client = net.connect(egress.port, '127.0.0.1')
client.on('error', () => {})
client.write('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n')
const reply = await new Promise(resolve => client.once('data', d => resolve(String(d))))
if (!reply.startsWith('HTTP/1.1 200')) throw new Error('tunnel refused: ' + reply)
client.end()
await new Promise(resolve => setTimeout(resolve, 300))
await egress.close()
console.log('closed')
`

test('close() releases an upstream whose remote half-closes and never ends', async () => {
  // Half-open upstream: reads the proxy's FIN and never sends its own.
  const held = []
  let upstreamEnded = false
  const server = net.createServer({ allowHalfOpen: true }, s => {
    held.push(s)
    s.on('error', () => {})
    s.on('end', () => (upstreamEnded = true))
    s.resume()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, String(server.address().port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_WITHIN_MS)
    const [code, signal] = await new Promise(resolve => child.on('exit', (c, s) => resolve([c, s])))
    clearTimeout(timer)
    assert.match(out, /closed/, out)
    assert.ok(upstreamEnded, 'the proxy half-closed the upstream before close()')
    assert.equal(signal, null, `child still running ${EXIT_WITHIN_MS} ms after close():\n${out}`)
    assert.equal(code, 0, out)
  } finally {
    for (const s of held) s.destroy()
    server.close()
  }
})
