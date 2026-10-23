// Fake external services for the eval target, all on 127.0.0.1 and all recording
// every request: the chat APIs (Slack, Telegram, Discord), Twilio, the Anthropic
// API, the Teams outbound webhook (tools/teams-send.sh's teams-outbound.url), and the Mac bridge (MacOSMCP's JSON-RPC, including the warm worker's
// model-switch curl that the drain prompt runs through mac_shell).
import { randomUUID } from 'node:crypto'
import { readBody, sendJson, serve } from './net.mjs'

// Canned success bodies, shaped like each real API's reply.
const CANNED = {
  slack: () => ({ ok: true, channel: 'C0EVAL', ts: `${Date.now() / 1000}` }),
  telegram: () => ({ ok: true, result: { message_id: 1 } }),
  discord: () => ({ id: '1' }),
  twilio: () => ({ sid: `CA${randomUUID().replaceAll('-', '')}`, status: 'queued' }),
  anthropic: () => ({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'eval' }], usage: {} }),
  teams: () => ({}),
}

const parse = (body, type = '') => {
  if (!body) return null
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(body))
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

// One recording HTTP fake per service. Each request is pushed to `calls`, tagged
// with the run phase it arrived in (see startFakes' setPhase).
export async function startApiFake(service, phase = () => 'drain') {
  const calls = []
  const srv = await serve(async (req, res) => {
    const body = await readBody(req)
    calls.push({ t: Date.now(), phase: phase(), method: req.method, path: req.url, body: parse(body, req.headers['content-type']) })
    sendJson(res, service === 'twilio' && req.method === 'POST' ? 201 : 200, CANNED[service]())
  })
  return { ...srv, service, calls }
}

// mac_shell commands the drain prompt sends to the warm worker's control endpoint.
const MODEL_CURL = /curl\b.*127\.0\.0\.1:8791\/model/

// Fake MacOSMCP: an MCP JSON-RPC server at /mcp. `canned` is a list of
// { tool?, match?, result } (match is a regex source tested against the
// arguments' JSON); the first hit's `result` text is returned. The model-switch
// curl is answered from a recorded "current model" without touching :8791.
export async function startFakeMac({ canned = [], model = 'sonnet' } = {}) {
  const calls = []
  const state = { model, switches: [] }
  const answer = (name, args) => {
    const hit = canned.find(
      (c) => (!c.tool || c.tool === name) && (!c.match || new RegExp(c.match).test(JSON.stringify(args))),
    )
    if (hit) return String(hit.result ?? '')
    const cmd = String(args?.command ?? '')
    if (name === 'mac_shell' && MODEL_CURL.test(cmd)) {
      const m = /"model"\s*:\s*\\?"([^"\\]+)/.exec(cmd)
      if (/-X\s*POST/.test(cmd) && m) {
        state.model = m[1]
        state.switches.push(m[1])
        return JSON.stringify({ ok: true, model: state.model })
      }
      return JSON.stringify({ model: state.model })
    }
    return ''
  }
  const srv = await serve(async (req, res) => {
    const msg = parse(await readBody(req), 'json') ?? {}
    if (msg.method === 'initialize')
      return sendJson(
        res,
        200,
        { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-mac', version: '0' } } },
        { 'mcp-session-id': 'fake-mac' },
      )
    if (msg.id == null) return res.writeHead(202).end()
    if (msg.method === 'tools/list') return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params ?? {}
      calls.push({ t: Date.now(), tool: name, args })
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: answer(name, args) }] } })
    }
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  })
  return { ...srv, calls, state }
}

const SERVICES = ['slack', 'telegram', 'discord', 'twilio', 'anthropic', 'teams']

// Start every fake. `env` is the worker env that points the eval target at them.
// `setPhase('inbound' | 'drain')` tags later requests: the target's own webhook acks
// arrive in 'inbound', what the drain caused in 'drain'.
export async function startFakes({ mac } = {}) {
  let phase = 'inbound'
  const apis = Object.fromEntries(await Promise.all(SERVICES.map(async (s) => [s, await startApiFake(s, () => phase)])))
  const macFake = await startFakeMac(mac)
  return {
    apis,
    mac: macFake,
    env: {
      SLACK_API_BASE: apis.slack.url,
      TELEGRAM_API_BASE: apis.telegram.url,
      DISCORD_API_BASE: apis.discord.url,
      TWILIO_API_BASE: apis.twilio.url,
      ANTHROPIC_API_BASE: apis.anthropic.url,
      MACOS_MCP_URL: macFake.url,
    },
    setPhase: (p) => (phase = p),
    // Everything recorded, for the state dump.
    record: () => ({
      ...Object.fromEntries(SERVICES.map((s) => [s, apis[s].calls])),
      mac: macFake.calls,
      macModel: { current: macFake.state.model, switches: macFake.state.switches },
    }),
    close: () => Promise.all([...Object.values(apis).map((a) => a.close()), macFake.close()]),
  }
}
