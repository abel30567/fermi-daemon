// The sandboxed harness's only way off the box: an HTTP CONNECT proxy on
// 127.0.0.1 (the sandbox hands it out as HTTPS_PROXY) that tunnels to the model
// endpoints on :443 and refuses everything else with a 403, reported to `onDeny`.
// The harness itself may connect only to 127.0.0.1 (harness/sandbox.mjs).
import http from 'node:http'
import net from 'node:net'

// Anthropic (claude-code, pi), ChatGPT/OpenAI (codex) and xAI (hbar's grok route).
export const MODEL_HOSTS = ['api.anthropic.com', 'chatgpt.com', 'api.openai.com', 'auth.openai.com', 'api.x.ai']

// `local`: exact 127.0.0.1 authorities also tunnelled (--auth proxy: CLIProxyAPI's 127.0.0.1:8317).
export const allowedTarget = (authority, hosts = MODEL_HOSTS, local = []) => {
  if (local.includes(String(authority ?? '').toLowerCase())) return true
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(String(authority ?? ''))
  return !!m && m[2] === '443' && hosts.includes(m[1].toLowerCase())
}

export async function startEgressProxy({ hosts = MODEL_HOSTS, local = [], onDeny = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    onDeny(`${req.method} ${req.url}`) // plain HTTP is never forwarded
    res.writeHead(403).end('egress denied (eval sandbox)\n')
  })
  const tunnels = new Set() // CONNECT sockets leave the server's connection tracking
  server.on('connect', (req, client, head) => {
    tunnels.add(client)
    client.on('close', () => tunnels.delete(client))
    if (!allowedTarget(req.url, hosts, local)) {
      onDeny(`CONNECT ${req.url}`)
      return client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    }
    const [host, port] = req.url.split(':')
    const fail = () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    let up
    try {
      up = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        up.write(head)
        up.pipe(client)
        client.pipe(up)
      })
    } catch {
      return fail()
    }
    up.on('error', fail)
    client.on('error', () => up.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        for (const s of tunnels) s.destroy()
        server.close(() => resolve())
      }),
  }
}
