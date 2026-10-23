// codex adapter (see ./index.mjs for the contract). One process per mode:
//   startSession  `codex app-server`: codex's persistent JSON-RPC session over
//                 stdio (initialize, thread/start, then turn/start per send;
//                 turn/interrupt aborts the in-flight turn and the thread stays).
//   runOnce       `codex exec --json -`: one prompt on stdin, JSONL events out.
// Both report the same thread items (app-server in camelCase, exec in snake_case),
// mapped to the normalized stream by toolCall/toolResult below.
//
// Options beyond the contract:
//   bin        default env CODEX_BIN, else `codex` on PATH
//   mcpConfig  a Claude-style mcp.json (path, JSON string or object) of http servers. codex
//              has no --mcp-config flag, so each session/run gets its own CODEX_HOME:
//              a temp dir holding config.toml with those servers (and no user config,
//              connectors, plugins or browser/computer use) plus a copy of auth.json
//              from the real CODEX_HOME (~/.codex); it is removed when the process
//              closes or fails to spawn (not if this process is SIGKILLed). Every
//              server URL must be localhost, else the adapter throws. Without
//              mcpConfig codex runs with the real CODEX_HOME (user config, MCP
//              servers, connectors); the eval runner and judge always pass one.
//   runOnce only: skipPermissions (--dangerously-bypass-approvals-and-sandbox)
// allowedTools and runOnce's maxTurns/settingSources/resume have no codex
// equivalent and are ignored. tokenFd, configDir and scrubSubprocessEnv are
// refused (they promise an isolation codex cannot give; see below).
//
// Known gaps vs the Claude Code adapter:
//   - Tool names. codex items carry no tool name: an MCP call is reported as
//     mcp__<server>__<tool> and a shell command (commandExecution) as `Bash` with
//     input { command } as codex reports it, so narrator.py needs no codex names.
//   - No cost. Turns carry token counts (exec: turn.completed usage; session: the
//     delta of thread/tokenUsage/updated totals) but no costUsd. runOnce emits no init.
//   - Error kinds. app-server errors carry codexErrorInfo (mapped by INFO_KIND);
//     exec's turn.failed carries only a message, so a failure whose text names no
//     status or known phrase (e.g. "high demand" overload) is unknown_error there.
//   - Credential isolation: SWAP-GATE BLOCKER. codex reads its credential from
//     CODEX_HOME/auth.json (a plain file its shell tool can read) or OPENAI_API_KEY
//     in the environment; there is no fd handoff, so tokenFd is refused and the
//     conformance credential-isolation case is expectedFail.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLocalUrl } from '../evals/lib/net.mjs'
import { classifyResult } from '../lib/turn-outcome.mjs'
import { bareToolName } from './index.mjs'

export const name = 'codex'

const UNSUPPORTED = ['tokenFd', 'configDir', 'scrubSubprocessEnv']
// Features that reach past the eval's MCP servers: ChatGPT connectors, plugins, the user's browser and desktop.
const DISABLED_FEATURES = ['apps', 'plugins', 'browser_use', 'computer_use']

export const sessionArgs = () => ['app-server']

export function oneShotArgs({ model, systemPrompt, skipPermissions }) {
  const a = ['exec', '--json', '--skip-git-repo-check']
  if (skipPermissions) a.push('--dangerously-bypass-approvals-and-sandbox')
  if (model) a.push('--model', model)
  if (systemPrompt != null) a.push('-c', `developer_instructions=${JSON.stringify(systemPrompt)}`)
  a.push('-') // prompt on stdin
  return a
}

// mcp.json → codex config.toml. Throws on a non-http or non-localhost server.
export function codexConfig(mcpConfig) {
  if (typeof mcpConfig !== 'string' && (typeof mcpConfig !== 'object' || mcpConfig === null))
    throw new Error('codex adapter: mcpConfig must be a path, a JSON string or an object')
  const parsed = typeof mcpConfig === 'object' ? mcpConfig : JSON.parse(mcpConfig.trim().startsWith('{') ? mcpConfig : readFileSync(mcpConfig, 'utf8'))
  const servers = parsed.mcpServers ?? {}
  const s = JSON.stringify // a JSON string is a TOML basic string
  const out = [`[features]`, ...DISABLED_FEATURES.map((f) => `${f} = false`)]
  for (const [key, srv] of Object.entries(servers)) {
    if (!srv?.url) throw new Error(`codex adapter: MCP server "${key}" has no url (only http servers are supported)`)
    if (!isLocalUrl(srv.url)) throw new Error(`codex adapter: refusing non-localhost MCP URL ${key}=${srv.url}`)
    out.push('', `[mcp_servers.${s(key)}]`, `url = ${s(srv.url)}`)
    const headers = Object.entries(srv.headers ?? {})
    if (headers.length) out.push(`http_headers = { ${headers.map(([k, v]) => `${s(k)} = ${s(String(v))}`).join(', ')} }`)
  }
  return out.join('\n') + '\n'
}

function spawnCodex(args, o) {
  const bad = UNSUPPORTED.filter((k) => o[k] != null)
  if (bad.length) throw new Error(`codex adapter: unsupported option(s) ${bad.join(', ')} (see harness/codex.mjs)`)
  const env = { ...process.env, ...o.env }
  let home = null
  if (o.mcpConfig) {
    const config = codexConfig(o.mcpConfig)
    const auth = join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
    home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    writeFileSync(join(home, 'config.toml'), config)
    if (existsSync(auth)) copyFileSync(auth, join(home, 'auth.json'))
    env.CODEX_HOME = home
  }
  const cleanup = () => home && rmSync(home, { recursive: true, force: true })
  let child
  try {
    child = spawn(o.bin || process.env.CODEX_BIN || 'codex', args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    cleanup()
    throw err
  }
  child.on('error', cleanup) // a spawn failure (missing bin, bad cwd)
  child.on('close', cleanup)
  return child
}

// Emit each stdout line as 'raw' and its JSON to onJson; stderr and exit as-is.
// Split on LF only: records may hold U+2028/U+2029, which readline splits on.
function pipe(child, events, onJson) {
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
      onJson(j)
    }
  })
  child.stderr.on('data', (d) => events.emit('stderr', d.toString()))
  child.on('exit', (code) => events.emit('exit', code))
  child.on('error', (err) => {
    events.emit('stderr', `codex adapter: ${err.message}\n`)
    if (child.pid == null) events.emit('exit', null) // never spawned, so no 'exit' follows
  })
}

const contentText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : ''

// A thread item (app-server camelCase or exec snake_case) → its tool_call, or null.
function toolCall(it) {
  if (it?.type === 'mcpToolCall' || it?.type === 'mcp_tool_call') {
    const rawName = `mcp__${it.server}__${it.tool}`
    return { type: 'tool_call', id: it.id, name: bareToolName(rawName), rawName, input: it.arguments ?? {} }
  }
  if (it?.type === 'commandExecution' || it?.type === 'command_execution')
    return { type: 'tool_call', id: it.id, name: 'Bash', rawName: 'Bash', input: { command: it.command } }
  return null
}

function toolResult(it) {
  if (it.type === 'mcpToolCall' || it.type === 'mcp_tool_call') {
    const ok = !it.error && it.status !== 'failed'
    return { type: 'tool_result', id: it.id, ok, content: it.error ? String(it.error.message ?? '') : contentText(it.result?.content) }
  }
  const exit = it.exitCode ?? it.exit_code
  const ok = it.status === 'completed' && (exit == null || exit === 0)
  return { type: 'tool_result', id: it.id, ok, content: String(it.aggregatedOutput ?? it.aggregated_output ?? '') }
}

// Item lifecycle → normalized events. A tool item seen only at completion still gets its tool_call.
function itemTracker() {
  const called = new Set()
  return {
    started(it) {
      const call = toolCall(it)
      if (!call) return []
      called.add(it.id)
      return [call]
    },
    completed(it) {
      if (it?.type === 'agentMessage' || it?.type === 'agent_message') return it.text ? [{ type: 'text', text: it.text }] : []
      const call = toolCall(it)
      if (!call) return []
      return [...(called.delete(it.id) ? [] : [call]), toolResult(it)]
    },
  }
}

// codexErrorInfo values whose kind the message text may not show.
const INFO_KIND = {
  unauthorized: 'auth',
  sessionBudgetExceeded: 'spend_limit',
  rateLimitExceeded: 'rate_limit',
  contextWindowExceeded: 'context_overflow',
  internalServerError: 'api_error',
  serverOverloaded: 'api_error',
}

// A turn error ({ message, codexErrorInfo? }) → classifyResult's outcome.
export function classifyError(error) {
  const text = String(error?.message ?? '')
  const info = error?.codexErrorInfo
  const status = (info && typeof info === 'object' && Object.values(info)[0]?.httpStatusCode) || Number(/\bstatus:? (\d{3})\b/.exec(text)?.[1]) || null
  const out = classifyResult({ is_error: true, result: text, ...(status && { api_error_status: status }) })
  return INFO_KIND[info] ? { ...out, kind: INFO_KIND[info] } : out
}

const okOutcome = (text) => classifyResult({ is_error: false, result: text ?? '' })

// `codex exec --json` events → normalized events. start() before the run.
export function createExecNormalizer() {
  const items = itemTracker()
  let since = 0
  let last = ''
  return {
    start() {
      since = Date.now()
    },
    normalize(j) {
      switch (j?.type) {
        case 'item.started':
          return items.started(j.item)
        case 'item.completed':
          if (j.item?.type === 'agent_message') last = j.item.text
          return items.completed(j.item)
        case 'turn.completed':
        case 'turn.failed': {
          const outcome = j.type === 'turn.completed' ? okOutcome(last) : classifyError(j.error)
          const u = j.usage
          return [
            {
              type: 'turn_end',
              ...outcome,
              ...(u?.input_tokens != null && { inputTokens: u.input_tokens }),
              ...(u?.output_tokens != null && { outputTokens: u.output_tokens }),
              durationMs: Date.now() - since,
              raw: j,
            },
          ]
        }
        default:
          return []
      }
    },
  }
}

export function startSession(o) {
  const child = spawnCodex(sessionArgs(), o)
  const events = new EventEmitter()
  const emit = (ev) => events.emit('event', ev)
  const items = itemTracker()
  const write = (msg) => {
    if (!child.stdin.writable) return false
    child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }
  let nextId = 1
  const pending = new Map()
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      write({ id, method, params })
    })

  let threadId = null
  let turn = null // the in-flight turn: { id, since, last, interrupt }
  let usage = null // the thread's running token totals
  let usageAtStart = null

  const ready = request('initialize', { clientInfo: { name: 'fermi-daemon', version: '1' } })
    .then((init) => {
      write({ method: 'initialized' })
      const version = /\/(\d+\.\d+\.\d+)/.exec(init?.userAgent ?? '')?.[1] ?? null
      return request('thread/start', {
        model: o.model ?? null,
        cwd: o.cwd ?? null,
        developerInstructions: o.systemPrompt ?? null,
        approvalPolicy: 'never',
      }).then((r) => {
        threadId = r.thread.id
        emit({ type: 'init', harness: name, version, model: r.model ?? null, tools: [] })
        return threadId
      })
    })
  ready.catch(() => {}) // surfaced per send

  const endTurn = (outcome, raw, durationMs) => {
    const t = turn
    turn = null
    const tokens = (k) => (usage?.[k] != null ? usage[k] - (usageAtStart?.[k] ?? 0) : null)
    emit({
      type: 'turn_end',
      ...outcome,
      ...(tokens('inputTokens') != null && { inputTokens: tokens('inputTokens') }),
      ...(tokens('outputTokens') != null && { outputTokens: tokens('outputTokens') }),
      durationMs: durationMs ?? Date.now() - t.since,
      raw,
    })
  }
  const interruptTurn = () => request('turn/interrupt', { threadId, turnId: turn.id }).catch(() => {})

  // The process is gone: fail whatever still waits on an answer (initialize, turn/start).
  child.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('codex app-server exited'))
    pending.clear()
  })

  pipe(child, events, (j) => {
    if (j.id != null && j.method) {
      // A server request (approval, user input): never answered by a person here.
      write({ id: j.id, error: { code: -32601, message: `fermi-daemon: ${j.method} is not supported` } })
      return
    }
    if (j.id != null) {
      const p = pending.get(j.id)
      pending.delete(j.id)
      if (j.error) p?.reject(new Error(j.error.message ?? JSON.stringify(j.error)))
      else p?.resolve(j.result)
      return
    }
    const p = j.params ?? {}
    if (threadId && p.threadId && p.threadId !== threadId) return
    switch (j.method) {
      case 'item/started':
        return items.started(p.item).forEach(emit)
      case 'item/completed':
        if (turn && p.item?.type === 'agentMessage') turn.last = p.item.text
        return items.completed(p.item).forEach(emit)
      case 'thread/tokenUsage/updated':
        usage = p.tokenUsage?.total ?? usage
        return
      case 'turn/completed': {
        if (!turn) return
        const st = p.turn?.status
        const outcome = st === 'completed' ? okOutcome(turn.last) : classifyError(p.turn?.error ?? { message: `turn ${st}` })
        return endTurn(outcome, j, p.turn?.durationMs ?? undefined)
      }
    }
  })

  return {
    pid: child.pid,
    events,
    get alive() {
      return child.stdin.writable
    },
    send(text) {
      if (!child.stdin.writable) return false
      const t = (turn = { id: null, since: Date.now(), last: '', interrupt: false })
      usageAtStart = usage
      ready
        .then((tid) => request('turn/start', { threadId: tid, input: [{ type: 'text', text, text_elements: [] }] }))
        .then((r) => {
          t.id = r.turn.id
          if (t.interrupt && turn === t) interruptTurn()
        })
        .catch((err) => turn === t && endTurn(classifyError({ message: err.message }), null))
      return true
    },
    // Abort the in-flight turn; the process (and its thread) stays alive.
    interrupt() {
      if (!turn) return false
      if (turn.id) interruptTurn()
      else turn.interrupt = true // turn/start has not answered yet
      return true
    },
    close(signal) {
      child.kill(signal)
    },
  }
}

export function runOnce(o) {
  const child = spawnCodex(oneShotArgs(o), o)
  const events = new EventEmitter()
  const norm = createExecNormalizer()
  const all = []
  let outcome = null
  let stderr = ''
  events.on('event', (ev) => {
    all.push(ev)
    if (ev.type === 'turn_end') outcome = ev
  })
  events.on('stderr', (s) => (stderr += s))
  norm.start()
  pipe(child, events, (j) => norm.normalize(j).forEach((ev) => events.emit('event', ev)))
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, outcome, events: all, stderr })))
  child.stdin.end(o.prompt ?? '')
  return { pid: child.pid, events, done, close: (signal) => child.kill(signal) }
}
