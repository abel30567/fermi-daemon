// Small localhost HTTP helpers shared by the fakes, the fake target and the proxy.
import http from 'node:http'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLocalUrl(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

// Throws if any { name: url } entry is not a localhost URL. The evals must never
// reach a real Fermi, chat API or Mac.
export function assertLocalUrls(urls) {
  const bad = Object.entries(urls).filter(([, url]) => url != null && !isLocalUrl(url))
  if (bad.length) {
    throw new Error(`refusing to start: non-localhost URL(s) configured: ${bad.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
}

export async function readBody(req) {
  let s = ''
  for await (const chunk of req) s += chunk
  return s
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

// Start `handler` on 127.0.0.1 (port 0 = a free one). Resolves { url, port, close }.
export async function serve(handler, port = 0) {
  const server = http.createServer((req, res) =>
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) })
      else res.end()
    }),
  )
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const actual = server.address().port
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

export async function freePort() {
  const s = await serve(() => {})
  await s.close()
  return s.port
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
