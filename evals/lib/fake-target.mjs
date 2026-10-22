// In-process stand-in for the MCP-11 eval worker, used when no `--worker` checkout
// is given (CI, runner tests). It speaks the same surface the daemon touches —
// /health, the Slack bridge webhook, and the core tools over MCP at /mcp — keeps
// state in memory, sends outbound traffic to the same fakes as the real target,
// and dumps state in eval-dump.mjs's shape. It is not a model of Fermi: grading
// semantics only hold against the real target.
import { randomUUID } from 'node:crypto'
import { coreTools } from './fake-target-tools.mjs'
import { mcpConnect, resultText } from './mcp-client.mjs'
import { readBody, sendJson, serve } from './net.mjs'

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text())

export async function startFakeTarget({ env }) {
  const db = { profile: {}, memories: [], allowlist: [], tasks: [], outbox: [], schedules: [], skills: [], audit: [], messages: [] }
  const skillBodies = new Map()
  let mac = null

  const allowed = (channel, id) => db.allowlist.some((a) => a.channel === channel && a.sender_id === id)
  const enqueue = (t) =>
    db.tasks.push({ status: 'pending', result: null, claimed_at: null, completed_at: null, ...t, id: t.id ?? randomUUID(), created_at: t.created_at ?? Date.now(), queue: t.queue ?? 'main' })

  const send = async (channel, chat_id, text) => {
    if (channel === 'sl') await post(`${env.SLACK_API_BASE}/api/chat.postMessage`, { channel: chat_id, text })
    else if (channel === 'tg') await post(`${env.TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id, text })
    else if (channel === 'dc') await post(`${env.DISCORD_API_BASE}/api/v10/channels/${chat_id}/messages`, { content: text })
    else db.outbox.push({ id: randomUUID(), channel, chat_id, body: JSON.stringify({ text }), status: 'pending', created_at: Date.now(), sent_at: null })
    db.messages.push({ channel, chat_id, role: 'assistant', text })
  }

  const TOOLS = {
    task_claim: ({ limit = 3, queue = 'main' }) => {
      const tasks = db.tasks.filter((t) => t.status === 'pending' && t.queue === queue).slice(0, limit)
      for (const t of tasks) Object.assign(t, { status: 'claimed', claimed_at: Date.now() })
      return { tasks, total: tasks.length }
    },
    task_complete: ({ id, status = 'done', result }) => {
      const t = db.tasks.find((x) => x.id === id)
      if (!t || t.status !== 'claimed') return { ok: false, error: 'not_claimed' }
      Object.assign(t, { status, result: result ?? null, completed_at: Date.now() })
      return { ok: true, id, status }
    },
    context_bootstrap: ({ channel, chat_id }) => ({
      profile: db.profile,
      pinned_memories: db.memories.filter((m) => m.pinned),
      recent: db.messages.filter((m) => m.channel === channel && m.chat_id === chat_id).slice(-20),
    }),
    conversation_history: ({ channel, chat_id }) => ({ messages: db.messages.filter((m) => m.channel === channel && m.chat_id === chat_id) }),
    memory_recall: ({ query = '' }) => {
      const words = String(query).toLowerCase().split(/\W+/).filter(Boolean)
      return { memories: db.memories.filter((m) => words.some((w) => m.body.toLowerCase().includes(w))) }
    },
    channel_send: async ({ channel, chat_id, text }) => {
      await send(channel, chat_id, text)
      return { ok: true, channel }
    },
    schedule_list: () => ({ schedules: db.schedules }),
    phone_call_start: async ({ to }) => {
      const body = await post(`${env.TWILIO_API_BASE}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, { To: to, From: env.TWILIO_FROM_NUMBER })
      return { ok: true, call_id: JSON.parse(body).sid }
    },
    mac_shell: async (args) => {
      mac ??= await mcpConnect(`${env.MACOS_MCP_URL}/mcp`, { clientName: 'fermi-worker', headers: { authorization: `Bearer ${env.MACOS_MCP_TOKEN}` } })
      return resultText(await mac.callTool('mac_shell', args))
    },
    ...coreTools(db, skillBodies),
  }

  const rpc = async (msg) => {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result })
    if (msg.method === 'initialize')
      return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fermi-fake-target', version: '0' } })
    if (msg.method === 'tools/list')
      return reply({ tools: Object.keys(TOOLS).map((name) => ({ name, inputSchema: { type: 'object' } })) })
    if (msg.method === 'tools/call') {
      const { name, arguments: args = {} } = msg.params ?? {}
      const fn = TOOLS[name]
      if (!fn) return reply({ content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true })
      try {
        const out = await fn(args)
        db.audit.push({ id: db.audit.length + 1, tool: name, created_at: Date.now() })
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] })
      } catch (err) {
        return reply({ content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true })
      }
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } }
  }

  // Mirrors handleSlackBridgeWebhook: DMs need an allowlisted author, channels an allowlisted team.
  const slackWebhook = (body) => {
    const { author_id, channel_id, text, is_im, team_id, display_name } = body
    if (!author_id || !channel_id || !text) return
    if (is_im ? !allowed('sl', author_id) : !team_id || !allowed('sl', team_id)) return
    const payload = is_im ? text : `[${display_name ?? author_id}] ${text}`
    db.messages.push({ channel: 'sl', chat_id: channel_id, role: 'user', text: payload })
    enqueue({ channel: 'sl', sender: author_id, chat_id: channel_id, payload })
    if (is_im) return send('sl', channel_id, 'Got it — working on it.')
  }

  const srv = await serve(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path === '/health') return sendJson(res, 200, { ok: true })
    if (path === '/sl/webhook' && req.method === 'POST') {
      if (req.headers['x-sl-bridge-secret'] !== env.SLACK_BRIDGE_SECRET) return res.writeHead(401).end('Unauthorized')
      await slackWebhook(JSON.parse(await readBody(req)))
      return res.writeHead(200).end('ok')
    }
    if (path === '/mcp' && req.method === 'POST') {
      const msg = JSON.parse(await readBody(req))
      if (msg.id == null) return res.writeHead(202).end()
      return sendJson(res, 200, await rpc(msg), msg.method === 'initialize' ? { 'mcp-session-id': randomUUID() } : {})
    }
    res.writeHead(404).end('Not Found')
  })

  return {
    url: srv.url,
    // Same semantics as eval-seed.mjs: every section the fixture names is replaced.
    async seed(f) {
      if (f.profile) db.profile = { ...f.profile }
      if (f.memories) db.memories = f.memories.map((m, i) => ({ id: i + 1, kind: m.kind, body: m.body, pinned: !!m.pinned, created_at: m.created_at ?? Date.now(), decayed_at: null }))
      if (f.allowlist) db.allowlist = f.allowlist.map(({ channel, sender_id, note }) => ({ channel, sender_id, note: note ?? null }))
      if (f.tasks) {
        db.tasks = []
        for (const [i, t] of f.tasks.entries()) enqueue({ ...t, created_at: t.created_at ?? Date.now() - f.tasks.length + i })
      }
      if (f.skills) for (const s of f.skills) skillBodies.set(s.slug, s.body ?? '')
      if (f.skills) db.skills = f.skills.map((s) => ({ slug: s.slug, name: s.slug, description: null, keywords: null, allowed_tools: null, version: 1, source: 'eval-seed', decayed_at: null }))
    },
    async dump() {
      const { messages, ...rest } = db
      return structuredClone(rest)
    },
    close: srv.close,
  }
}
