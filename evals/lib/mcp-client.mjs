// Minimal streamable-HTTP MCP client (JSON or SSE replies). Used by the fake
// harness and the fake Mac bridge tests; the real harnesses bring their own.

async function rpcReply(res) {
  const text = await res.text()
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`)
  const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())[0]
    : text
  const reply = JSON.parse(data)
  if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`)
  return reply.result
}

export async function mcpConnect(url, { clientName = 'fermi-eval', headers: extra = {} } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }
  let id = 0
  const post = (message) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...message }) })
  const init = await post({
    id: ++id,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: clientName, version: '0.0.0' } },
  })
  await rpcReply(init)
  const sid = init.headers.get('mcp-session-id')
  if (sid) headers['mcp-session-id'] = sid
  await (await post({ method: 'notifications/initialized' })).body?.cancel()
  return {
    listTools: async () => (await rpcReply(await post({ id: ++id, method: 'tools/list', params: {} }))).tools,
    callTool: async (name, args = {}) =>
      rpcReply(await post({ id: ++id, method: 'tools/call', params: { name, arguments: args } })),
  }
}

// The text of a tools/call result.
export const resultText = (r) => (r?.content ?? []).map((c) => c?.text ?? '').join('')
