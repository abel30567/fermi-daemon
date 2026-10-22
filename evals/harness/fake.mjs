// Scripted fake harness for testing the eval runner itself, with no inference.
// It follows the adapter contract in ../../harness/index.mjs and lives here, not
// in harness/, so production can never select it.
//
// Instead of a model it plays `script` (an adapter option): a list of steps,
//   { tool, args }      call `tool` on the `fermi` server of `mcpConfig`
//   { text }            emit assistant text
//   { shell, result? }  a call to the harness's own shell tool (`Bash`); nothing
//                       runs, the tool result is `result` (default "")
// String args may use ${task.<field>}: the first task of the latest non-empty
// task_claim result. Each step becomes the same normalized events a real
// adapter emits (tool_call / tool_result / text), then one turn_end.
// For startSession, `script` is a list of such lists, one per send(); the
// ${task.*} context carries across turns, and interrupt() ends the turn after
// the step in flight.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mcpConnect, resultText } from '../lib/mcp-client.mjs'

export const name = 'fake'

const SERVER = 'fermi'

const fill = (v, ctx) =>
  typeof v === 'string'
    ? v.replace(/\$\{task\.(\w+)\}/g, (_, k) => String(ctx.task?.[k] ?? ''))
    : Array.isArray(v)
      ? v.map((x) => fill(x, ctx))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ctx)]))
        : v

async function connect(o, emit) {
  const config = JSON.parse(typeof o.mcpConfig === 'string' && !o.mcpConfig.trim().startsWith('{') ? readFileSync(o.mcpConfig, 'utf8') : o.mcpConfig)
  const url = config.mcpServers?.[SERVER]?.url
  if (!url) throw new Error(`fake harness: mcpConfig has no "${SERVER}" server`)
  const mcp = await mcpConnect(url, { clientName: 'fake-harness' })
  emit({ type: 'init', harness: name, version: null, model: o.model ?? null, tools: (await mcp.listTools()).map((t) => `mcp__${SERVER}__${t.name}`) })
  return mcp
}

// Play `steps`; returns false if `stopped()` cut it short.
async function play(steps, { mcp, ctx, emit, stopped }) {
  for (const step of steps) {
    if (stopped()) return false
    if (step.text != null) {
      emit({ type: 'text', text: fill(step.text, ctx) })
      continue
    }
    const id = `fake_${++ctx.n}`
    if (step.shell != null) {
      emit({ type: 'tool_call', id, name: 'Bash', rawName: 'Bash', input: { command: fill(step.shell, ctx) } })
      emit({ type: 'tool_result', id, ok: true, content: String(step.result ?? '') })
      continue
    }
    const input = fill(step.args ?? {}, ctx)
    emit({ type: 'tool_call', id, name: step.tool, rawName: `mcp__${SERVER}__${step.tool}`, input })
    const r = await mcp.callTool(step.tool, input)
    const content = resultText(r)
    emit({ type: 'tool_result', id, ok: r.isError !== true, content })
    if (step.tool === 'task_claim') {
      try {
        const t = JSON.parse(content).tasks?.[0]
        if (t) ctx.task = t
      } catch {}
    }
  }
  return !stopped()
}

const turnEnd = (res, since) => ({ type: 'turn_end', ...res, durationMs: Date.now() - since, raw: null })
const failed = (err) => ({ ok: false, kind: 'unknown_error', detail: String(err?.message ?? err) })

export function startSession(o) {
  const events = new EventEmitter()
  const emit = (ev) => events.emit('event', ev)
  const ctx = { n: 0 }
  let mcp = null
  let turn = 0
  let alive = true
  let interrupted = false
  return {
    pid: process.pid,
    events,
    get alive() {
      return alive
    },
    send(text) {
      if (!alive) return false
      const steps = o.script?.[turn++]
      const since = Date.now()
      interrupted = false
      ;(async () => {
        await null // let the caller attach listeners first
        if (!Array.isArray(steps)) throw new Error(`fake harness: no script for turn ${turn} (scenario.fake.turns)`)
        mcp ??= await connect(o, emit)
        const finished = await play(steps, { mcp, ctx, emit, stopped: () => interrupted || !alive })
        // A real interrupted turn ends with an error result, which classifies as unknown_error.
        return finished ? { ok: true, kind: 'ok', detail: 'script done' } : { ok: false, kind: 'unknown_error', detail: 'interrupted' }
      })()
        .catch(failed)
        .then((res) => emit(turnEnd(res, since)))
      return true
    },
    interrupt() {
      interrupted = true
      return alive
    },
    close() {
      if (!alive) return
      alive = false
      events.emit('exit', 0)
    },
  }
}

export function runOnce(o) {
  const events = new EventEmitter()
  const all = []
  const emit = (ev) => {
    all.push(ev)
    events.emit('event', ev)
  }
  const since = Date.now()
  let stopped = false
  const done = (async () => {
    await null // let the caller attach listeners first
    if (!Array.isArray(o.script)) throw new Error('fake harness: no script (scenario.fake.script)')
    const mcp = await connect(o, emit)
    await play(o.script, { mcp, ctx: { n: 0 }, emit, stopped: () => stopped })
    return { ok: !stopped, kind: stopped ? 'unknown_error' : 'ok', detail: stopped ? 'killed' : 'script done' }
  })()
    .catch(failed)
    .then((res) => {
      const outcome = turnEnd(res, since)
      emit(outcome)
      events.emit('exit', res.ok ? 0 : 1)
      return { code: res.ok ? 0 : 1, outcome, events: all, stderr: '' }
    })
  return { pid: process.pid, events, done, close: () => (stopped = true) }
}
