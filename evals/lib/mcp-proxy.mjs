// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, status?: number, result?: string, latencyMs?: number, times?: number }:
// latency delays the call; error answers it with an isError result, status with
// that bare HTTP status (a tool 500) and result with that text as a normal result
// (a malformed payload), all without reaching the target. `times` limits the
// fault to the tool's first n calls. `canned` (the scenario's fixtures.tools, given
// only in front of the real eval worker) answers a call it matches the way the fake
// target does, so canned breadth results hold under either target. A response
// stream cut on either side (the target stopping mid-SSE, the client disconnecting)
// tears down both sides and is reported to `onError`, never thrown.
import { Readable, pipeline } from 'node:stream'
import { cannedResult } from './fake-tools.mjs'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, canned = [], onError = () => {} }) {
  const seen = {}
  return serve(async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : undefined
    let msg = null
    try {
      msg = body ? JSON.parse(body) : null
    } catch {}
    const tool = msg?.method === 'tools/call' ? msg.params?.name : null
    const n = tool ? (seen[tool] = (seen[tool] ?? 0) + 1) : 0
    const fault = tool && faults[tool] && !(faults[tool].times != null && n > faults[tool].times) ? faults[tool] : null
    if (fault?.latencyMs) await sleep(fault.latencyMs)
    if (fault?.status != null) return res.writeHead(fault.status, { 'content-type': 'text/plain' }).end(`HTTP ${fault.status} (eval fault)`)
    const reply = (text, isError) => sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(text) }], ...(isError && { isError }) } })
    if (fault?.error != null) return reply(fault.error, true)
    if (fault?.result != null) return reply(fault.result, false)
    const hit = tool && cannedResult(canned, tool, msg.params?.arguments ?? {})
    if (hit) return reply(hit.text, hit.isError)

    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)))
    const up = await fetch(new URL(req.url, target), { method: req.method, headers, body })
    const out = {}
    up.headers.forEach((v, k) => !HOP.has(k) && k !== 'content-encoding' && (out[k] = v))
    res.writeHead(up.status, out)
    if (up.body) pipeline(Readable.fromWeb(up.body), res, (err) => err && onError(err))
    else res.end()
  })
}
