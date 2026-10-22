// Claude Code adapter (see ./index.mjs for the contract). Spawns `claude -p`
// with stream-json output and maps its events to the normalized stream.
//
// Options beyond the contract:
//   bin                 default env CLAUDE_BIN, else ~/.local/bin/claude (CLAUDE_BIN covers hbar)
//   configDir           → CLAUDE_CONFIG_DIR
//   tokenFd             → CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR; the fd is passed to the child as-is
//   scrubSubprocessEnv  → CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
//   runOnce only: skipPermissions (--dangerously-skip-permissions), maxTurns (--max-turns),
//                 settingSources (--setting-sources), resume (--resume <session id>)

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { classifyResult } from '../lib/turn-outcome.mjs'
import { bareToolName } from './index.mjs'

export const name = 'claude-code'

const toolList = (t) => (Array.isArray(t) ? t.join(',') : t)

// The warm worker's duplex session flags.
export function sessionArgs({ model, systemPrompt, allowedTools, mcpConfig }) {
  const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  if (model) a.push('--model', model)
  a.push('--setting-sources', 'project,local') // skip global user hooks (they block/latency)
  if (systemPrompt != null) a.push('--append-system-prompt', systemPrompt)
  if (allowedTools) a.push('--allowedTools', toolList(allowedTools))
  if (mcpConfig) a.push('--mcp-config', mcpConfig)
  return a
}

// One-shot flags, prompt on stdin (box-runner's shape).
export function oneShotArgs({ model, systemPrompt, allowedTools, mcpConfig, skipPermissions, maxTurns, settingSources, resume }) {
  const a = ['-p']
  if (skipPermissions) a.push('--dangerously-skip-permissions')
  a.push('--output-format', 'stream-json', '--verbose')
  if (mcpConfig) a.push('--mcp-config', mcpConfig, '--strict-mcp-config')
  if (model) a.push('--model', model)
  if (maxTurns != null) a.push('--max-turns', String(maxTurns))
  if (settingSources) a.push('--setting-sources', settingSources)
  if (resume) a.push('--resume', resume)
  if (allowedTools) a.push('--allowedTools', toolList(allowedTools))
  if (systemPrompt != null) a.push('--append-system-prompt', systemPrompt)
  return a
}

function spawnHarness(args, o) {
  const env = { ...process.env, ...o.env }
  if (o.configDir) env.CLAUDE_CONFIG_DIR = o.configDir
  if (o.tokenFd != null) env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = String(o.tokenFd)
  if (o.scrubSubprocessEnv) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
  const stdio = ['pipe', 'pipe', 'pipe']
  if (o.tokenFd != null) {
    // the child reads the token at the same fd number (spawn skips holes, so fill them)
    for (let i = 3; i < o.tokenFd; i++) stdio[i] = 'ignore'
    stdio[o.tokenFd] = o.tokenFd
  }
  const bin = o.bin || process.env.CLAUDE_BIN || join(process.env.HOME, '.local/bin/claude')
  return spawn(bin, args, { cwd: o.cwd, env, stdio })
}

const contentText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : ''

// One stream-json event → zero or more normalized events. `since` is when the
// turn started, used for durationMs when the result carries no duration_ms.
export function normalizeEvent(j, { since } = {}) {
  if (j?.type === 'system' && j.subtype === 'init')
    return [{ type: 'init', harness: name, version: j.claude_code_version ?? null, model: j.model ?? null, tools: j.tools ?? [] }]
  // turn completion: the result event (type:result, or has num_turns+is_error)
  if (j?.type === 'result' || (j?.num_turns !== undefined && j?.is_error !== undefined)) {
    return [
      {
        type: 'turn_end',
        ...classifyResult(j),
        ...(j.total_cost_usd != null && { costUsd: j.total_cost_usd }),
        ...(j.usage?.input_tokens != null && { inputTokens: j.usage.input_tokens }),
        ...(j.usage?.output_tokens != null && { outputTokens: j.usage.output_tokens }),
        durationMs: j.duration_ms ?? (since ? Date.now() - since : 0),
        raw: j,
      },
    ]
  }
  const blocks = Array.isArray(j?.message?.content) ? j.message.content : []
  const out = []
  for (const b of blocks) {
    if (j.type === 'assistant' && b?.type === 'text') out.push({ type: 'text', text: b.text })
    else if (j.type === 'assistant' && b?.type === 'tool_use')
      out.push({ type: 'tool_call', id: b.id, name: bareToolName(b.name), rawName: b.name, input: b.input ?? {} })
    else if (j.type === 'user' && b?.type === 'tool_result')
      out.push({ type: 'tool_result', id: b.tool_use_id, ok: b.is_error !== true, content: contentText(b.content) })
  }
  return out
}

// Split the child's stdout into lines; emit each raw line, then its normalized events.
function pipeEvents(child, events, since) {
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      events.emit('raw', line)
      let j
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      for (const ev of normalizeEvent(j, { since: since() })) events.emit('event', ev)
    }
  })
  child.stderr.on('data', (d) => events.emit('stderr', d.toString()))
  child.on('exit', (code) => events.emit('exit', code))
  child.on('error', (e) => events.emit('error', e))
}

export function startSession(o) {
  const child = spawnHarness(sessionArgs(o), o)
  const events = new EventEmitter()
  let since = 0
  pipeEvents(child, events, () => since)
  const write = (msg) => {
    if (!child.stdin.writable) return false
    child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }
  return {
    pid: child.pid,
    events,
    get alive() {
      return child.stdin.writable
    },
    send(text) {
      since = Date.now()
      return write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    },
    // Abort the in-flight turn; the process (and its session) stays alive.
    interrupt() {
      return write({ type: 'control_request', request_id: 'stop_' + Date.now(), request: { subtype: 'interrupt' } })
    },
    close(signal) {
      child.kill(signal)
    },
  }
}

export function runOnce(o) {
  const child = spawnHarness(oneShotArgs(o), o)
  const events = new EventEmitter()
  const since = Date.now()
  const all = []
  let outcome = null
  let stderr = ''
  events.on('event', (ev) => {
    all.push(ev)
    if (ev.type === 'turn_end') outcome = ev
  })
  events.on('stderr', (s) => (stderr += s))
  pipeEvents(child, events, () => since)
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, outcome, events: all, stderr })))
  child.stdin.end(o.prompt ?? '')
  return { pid: child.pid, events, done, close: (signal) => child.kill(signal) }
}
