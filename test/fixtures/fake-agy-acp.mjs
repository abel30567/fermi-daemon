// Fake headless Antigravity CLI (`antigravity acp`, v1.5.14+) for box-runner tests.
// Speaks NDJSON JSON-RPC 2.0 over stdio and records spawn metadata + RPC calls to
// $FAKE_DIR/acp.log. Modes via FAKE_ACP:
//   success       full handshake, permission round-trip, tool_call, message chunk, end_turn
//   async_sub     spawns invoke_subagent, returns end_turn while waiting, then wakes via session/update with RESULT:
//   oauth_url     prints a Google OAuth URL line during authenticate and waits
//   429           returns a JSON-RPC RESOURCE_EXHAUSTED / 429 error on session/prompt
//   slow          emits tool_call, stalls until FAKE_STALL_FILE appears, then finishes
//   crash         writes to stderr and exits 3
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.FAKE_ACP ?? 'success'
const ENV_KEYS = [
  'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'AGY_CLI_DISABLE_AUTO_UPDATE',
  'SSH_CONNECTION',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
]

if (mode === 'crash') {
  process.stderr.write('boom: acp crashed\n')
  process.exit(3)
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const geminiHome = process.env.GEMINI_HOME ?? ''
const tokenPath = join(geminiHome, 'antigravity-acp', 'antigravity-oauth-token')
const settingsPath = join(geminiHome, 'antigravity-acp', 'settings.json')

const record = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(ENV_KEYS.filter((k) => k in process.env).map((k) => [k, process.env[k]])),
  tokenFile: existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8') : null,
  settingsFile: existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null,
  calls: [],
  permissionChoice: null,
}

const flushRecord = () => {
  if (process.env.FAKE_DIR) {
    appendFileSync(join(process.env.FAKE_DIR, 'acp.log'), JSON.stringify(record) + '\n')
  }
}

let pendingPerm = null
let buf = ''

async function handle(msg) {
  if (msg.id != null && !msg.method) {
    if (pendingPerm && msg.id === pendingPerm.id) {
      record.permissionChoice = msg.result?.outcome ?? null
      const resolve = pendingPerm.resolve
      pendingPerm = null
      resolve()
    }
    return
  }
  record.calls.push({ method: msg.method, params: msg.params })
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
  }
  if (msg.method === 'authenticate') {
    if (mode === 'oauth_url') {
      flushRecord()
      process.stderr.write('Please sign in at https://accounts.google.com/o/oauth2/auth?client_id=test\n')
      return
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
  if (msg.method === 'session/new') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-fake-1' } })
  }
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
  if (msg.method === 'session/prompt') {
    if (mode === '429') {
      flushRecord()
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'RESOURCE_EXHAUSTED: 429 quota exceeded' },
      })
    }
    if (mode === 'async_sub') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-fake-1',
          update: { sessionUpdate: 'tool_call', title: 'Run invoke_subagent', kind: 'other' },
        },
      })
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-fake-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Spawned subagents. Waiting for them to finish.' },
          },
        },
      })
      flushRecord()
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-fake-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '\n\nAll subagents done.\nRESULT: async swarm ok' },
            },
          },
        })
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-fake-1',
            update: { sessionUpdate: 'usage_update', used: 1000, size: 1000000 },
          },
        })
      }, 150)
      return
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-fake-1',
        update: { sessionUpdate: 'tool_call', title: 'Run invoke_subagent', kind: 'other' },
      },
    })
    await new Promise((resolve) => {
      pendingPerm = { id: 9001, resolve }
      send({
        jsonrpc: '2.0',
        id: 9001,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-fake-1',
          options: [
            { optionId: 'opt-once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'opt-always', kind: 'allow_always', name: 'Always allow' },
          ],
        },
      })
    })
    if (mode === 'slow' && process.env.FAKE_STALL_FILE) {
      while (!existsSync(process.env.FAKE_STALL_FILE)) await new Promise((r) => setTimeout(r, 20))
    }
    if (process.env.FAKE_ACP_ROTATE === '1' && existsSync(tokenPath)) {
      writeFileSync(tokenPath, JSON.stringify({ token: { refresh_token: 'rotated-local' }, auth_method: 'oauth-personal' }))
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-fake-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'All subagents completed.\nRESULT: antigravity swarm ok' },
        },
      },
    })
    flushRecord()
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } })
}

process.stdin.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    handle(JSON.parse(line)).catch((e) => {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    })
  }
})
