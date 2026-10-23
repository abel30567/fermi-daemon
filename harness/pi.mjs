// pi adapter (see ./index.mjs for the contract). Spawns `pi --mode rpc` and maps
// its RPC records (docs/rpc.md and docs/json.md in @earendil-works/pi-coding-agent)
// to the normalized stream. A turn is {type:'prompt', message}; an interrupt is
// {type:'abort'}; a turn ends at `agent_settled` (pi will not continue on its own),
// or at the prompt's `response` when pi rejects or handles it without a run.
// runOnce uses the same RPC session: one prompt, then stdin is closed (pi's
// orderly shutdown), so the prompt never reaches argv.
//
// Options beyond the contract:
//   bin          default env PI_BIN, else `pi` on PATH
//   sandboxHome  eval mode, required with mcpConfig (pi has no --mcp-config):
//                pi runs with HOME=<sandboxHome> and PI_CODING_AGENT_DIR=
//                <sandboxHome>/.pi/agent, whose mcp.json is written from
//                mcpConfig (a path or an object; `url` servers only, every URL
//                localhost or the adapter refuses to start). The real
//                ~/.pi/agent/mcp.json is never read; only ~/.pi/agent/auth.json
//                is copied in, for inference login (the credential-isolation
//                blocker below), and that copy is deleted when pi exits.
// allowedTools is ignored and runOnce's skipPermissions/maxTurns have no pi
// equivalent. tokenFd, configDir and scrubSubprocessEnv are refused, and so is
// mcpConfig without sandboxHome (they promise an isolation pi cannot give; see
// below).
//
// Known gaps vs the Claude Code adapter:
//   - No per-turn cost or session id. pi has no turn-level result record (Claude's
//     total_cost_usd / session_id) and no init record, so turn_end carries no
//     costUsd or token counts and no `init` event is emitted. The session id is
//     only available through the get_state command.
//   - Broader built-in tools. pi enables read, bash, edit and write and never asks
//     for permission; Claude's lane allows only Bash + MCP. Built-in names are
//     lowercase (`bash`, not `Bash`) and take `path` instead of `file_path`;
//     narrator.py knows both spellings.
//   - No Google Calendar. pi has no equivalent of the claude.ai connector; MCP
//     servers come from <agent-dir>/mcp.json (fermi, playwright).
//   - Credential isolation: SWAP-GATE BLOCKER. pi reads its Anthropic credential
//     only from argv (--api-key), the environment (ANTHROPIC_API_KEY /
//     ANTHROPIC_OAUTH_TOKEN, which its bash tool's children inherit: pi's
//     getShellEnv() passes process.env through) or <agent-dir>/auth.json
//     (~/.pi/agent/auth.json after /login, a plain file with the OAuth tokens that
//     the no-prompt read/bash tools can open). There is no fd handoff like
//     CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, so tokenFd is refused and the
//     conformance credential-isolation case is expectedFail. Do not swap pi into
//     the live worker until the credential is out of reach of its tools.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyResult } from '../lib/turn-outcome.mjs'
import { bareToolName } from './index.mjs'

export const name = 'pi'

const UNSUPPORTED = ['tokenFd', 'configDir', 'scrubSubprocessEnv']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const isLocalUrl = (url) => {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

// The runner's MCP config ({ mcpServers: { name: { type, url, headers? } } },
// Claude's --mcp-config shape) → pi's mcp.json. Throws unless every server is
// a localhost URL: an eval must never reach a real Fermi.
export function piMcpConfig(mcpConfig) {
  const src = typeof mcpConfig === 'string' ? JSON.parse(readFileSync(mcpConfig, 'utf8')) : mcpConfig
  const servers = Object.entries(src?.mcpServers ?? {}).map(([k, s]) => [k, { url: s?.url, ...(s?.headers && { headers: s.headers }) }])
  const bad = servers.filter(([, s]) => !isLocalUrl(s.url))
  if (bad.length) throw new Error(`pi adapter: refusing to start: non-localhost MCP server(s) ${bad.map(([k, s]) => `${k}=${s.url}`).join(', ')}`)
  return { mcpServers: Object.fromEntries(servers) }
}

// Eval mode: a HOME holding only the generated mcp.json and a copy of the real
// auth.json. Returns the env overrides and the cleanup for when pi exits.
function sandbox({ mcpConfig, sandboxHome }) {
  const config = piMcpConfig(mcpConfig)
  const agentDir = join(sandboxHome, '.pi/agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify(config, null, 2))
  const auth = join(agentDir, 'auth.json')
  copyFileSync(join(process.env.HOME, '.pi/agent/auth.json'), auth)
  return { env: { HOME: sandboxHome, PI_CODING_AGENT_DIR: agentDir }, cleanup: () => rmSync(auth, { force: true }) }
}

export function sessionArgs({ model, systemPrompt }) {
  const a = ['--mode', 'rpc']
  if (model) a.push('--model', `anthropic/${model.replace(/\[.*\]$/, '')}`) // pi has no [1m] suffix
  if (systemPrompt != null) a.push('--append-system-prompt', systemPrompt)
  return a
}

const contentText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : ''

// A turn's last assistant message in the shape classifyResult reads (a Claude
// result event). Provider errors read "<status> <body>" (the Anthropic SDK's text).
function resultOf(m, aborted) {
  const failed = aborted || m?.stopReason === 'error' || m?.stopReason === 'aborted'
  const text = failed ? m?.errorMessage ?? '' : contentText(m?.content)
  const status = failed ? /^(\d{3})\b/.exec(text)?.[1] : null
  return { is_error: failed, result: text, subtype: m?.stopReason, ...(status && { api_error_status: Number(status) }) }
}

// pi RPC records → normalized events. Stateful: turn_end needs the turn's last
// assistant message and whether the turn was aborted. start() on each send.
export function createNormalizer() {
  let since = 0
  let last = null
  let aborted = false
  const end = (j, result) => [
    { type: 'turn_end', ...classifyResult(result), durationMs: since ? Date.now() - since : 0, raw: j },
  ]
  return {
    start() {
      since = Date.now()
      last = null
      aborted = false
    },
    abort() {
      aborted = true
    },
    normalize(j) {
      switch (j?.type) {
        case 'message_end':
          if (j.message?.role !== 'assistant') return []
          last = j.message
          return (last.content ?? []).filter((b) => b?.type === 'text' && b.text).map((b) => ({ type: 'text', text: b.text }))
        case 'tool_execution_start':
          return [{ type: 'tool_call', id: j.toolCallId, name: bareToolName(j.toolName), rawName: j.toolName, input: j.args ?? {} }]
        case 'tool_execution_end':
          return [{ type: 'tool_result', id: j.toolCallId, ok: j.isError !== true, content: contentText(j.result?.content) }]
        case 'agent_settled':
          return end(j, resultOf(last, aborted))
        case 'response':
          // A rejected or handled prompt starts no run, so no agent_settled follows.
          if (j.command !== 'prompt') return []
          if (!j.success) return end(j, { is_error: true, result: String(j.error ?? '') })
          return j.data?.disposition === 'handled' ? end(j, { is_error: false, result: '' }) : []
        default:
          return []
      }
    },
  }
}

function open(o) {
  const bad = UNSUPPORTED.filter((k) => o[k] != null)
  if (o.mcpConfig != null && o.sandboxHome == null) bad.push('mcpConfig without sandboxHome')
  if (bad.length) throw new Error(`pi adapter: unsupported option(s) ${bad.join(', ')} (see harness/pi.mjs)`)
  const box = o.sandboxHome != null ? sandbox(o) : null
  let child
  try {
    child = spawn(o.bin || process.env.PI_BIN || 'pi', sessionArgs(o), {
      cwd: o.cwd,
      env: { ...process.env, ...o.env, ...box?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    box?.cleanup()
    throw err
  }
  if (box) {
    child.on('exit', box.cleanup)
    child.on('error', box.cleanup)
  }
  const events = new EventEmitter()
  const norm = createNormalizer()
  // Split on LF only: pi's records may hold U+2028/U+2029, which readline splits on.
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      events.emit('raw', line)
      let j
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      for (const ev of norm.normalize(j)) events.emit('event', ev)
    }
  })
  child.stderr.on('data', (d) => events.emit('stderr', d.toString()))
  child.on('exit', (code) => events.emit('exit', code))
  const write = (msg) => {
    if (!child.stdin.writable) return false
    child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }
  const send = (text) => {
    norm.start()
    return write({ type: 'prompt', message: text })
  }
  return { child, events, norm, write, send }
}

export function startSession(o) {
  const { child, events, norm, write, send } = open(o)
  return {
    pid: child.pid,
    events,
    get alive() {
      return child.stdin.writable
    },
    send,
    // Abort the in-flight turn; the process (and its session) stays alive.
    interrupt() {
      norm.abort()
      return write({ type: 'abort' })
    },
    close(signal) {
      child.kill(signal)
    },
  }
}

export function runOnce(o) {
  const { child, events, send } = open(o)
  const all = []
  let outcome = null
  let stderr = ''
  events.on('event', (ev) => {
    all.push(ev)
    if (ev.type === 'turn_end' && !outcome) {
      outcome = ev
      child.stdin.end() // orderly shutdown
    }
  })
  events.on('stderr', (s) => (stderr += s))
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, outcome, events: all, stderr })))
  send(o.prompt ?? '')
  return { pid: child.pid, events, done, close: (signal) => child.kill(signal) }
}
