// Scripted fake harness for testing the eval runner itself, with no inference.
// It follows the adapter contract in ../../harness/index.mjs (runOnce and
// startSession) and lives here, not in harness/, so production can never select it.
//
// Instead of a model it plays `script` (an adapter option): a list of steps,
//   { tool, args }     call `tool` on the `fermi` server of `mcpConfig`
//   { text }           emit assistant text
//   { sleepMs }        think for that long (a number, or a string such as "${turn}")
//   { apiError: { status?, text } }
//                      the model API fails mid-turn: the turn ends here with
//                      lib/turn-outcome.mjs's classification of that error
// A step with `onTurn: n` is played only in the session's n-th turn (runOnce is
// turn 1); every other step is played in every turn. A session keeps its context
// between turns, like a warm session remembers what it claimed.
// String args may use ${task.<field>} (the first task of the latest non-empty
// task_claim result), ${turn} and ${canary} (the runner's FERMI_EVAL_CANARY from
// `env`, there only so a negative control can leak it). Each step becomes the same normalized
// events a real adapter emits (tool_call / tool_result / text), then one
// turn_end. A tool call that fails at the transport (an HTTP 500) is a failed
// tool_result, the way a real harness hands it to the model.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { classifyResult } from '../../lib/turn-outcome.mjs'
import { mcpConnect, resultText } from '../lib/mcp-client.mjs'

export const name = 'fake'

const SERVER = 'fermi'

const fill = (v, ctx) =>
  typeof v === 'string'
    ? v
        .replace(/\$\{task\.(\w+)\}/g, (_, k) => String(ctx.task?.[k] ?? ''))
        .replace(/\$\{turn\}/g, String(ctx.turn))
        .replace(/\$\{canary\}/g, ctx.canary ?? '')
    : Array.isArray(v)
      ? v.map((x) => fill(x, ctx))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ctx)]))
        : v

// The shared player behind runOnce and startSession. `turn()` plays one turn of
// the script and resolves its turn_end payload ({ ok, kind, detail }).
function player(o, emit, isStopped) {
  const ctx = { turn: 0, canary: o.env?.FERMI_EVAL_CANARY }
  let mcp = null
  let n = 0
  const connect = async () => {
    const config = JSON.parse(typeof o.mcpConfig === 'string' && !o.mcpConfig.trim().startsWith('{') ? readFileSync(o.mcpConfig, 'utf8') : o.mcpConfig)
    const url = config.mcpServers?.[SERVER]?.url
    if (!url) throw new Error(`fake harness: mcpConfig has no "${SERVER}" server`)
    if (!Array.isArray(o.script)) throw new Error('fake harness: no script (scenario.fake.script)')
    mcp = await mcpConnect(url, { clientName: 'fake-harness' })
    emit({ type: 'init', harness: name, version: null, model: o.model ?? null, tools: (await mcp.listTools()).map((t) => `mcp__${SERVER}__${t.name}`) })
  }
  const turn = async () => {
    if (!mcp) await connect()
    ctx.turn++
    for (const step of o.script) {
      if (isStopped()) return { ok: false, kind: 'unknown_error', detail: 'killed' }
      if (step.onTurn != null && step.onTurn !== ctx.turn) continue
      if (step.apiError) return classifyResult({ is_error: true, api_error_status: step.apiError.status ?? null, result: String(step.apiError.text ?? 'API Error') })
      if (step.sleepMs != null) {
        await sleep(Number(fill(String(step.sleepMs), ctx)))
        continue
      }
      if (step.text != null) {
        emit({ type: 'text', text: fill(step.text, ctx) })
        continue
      }
      const id = `fake_${++n}`
      const input = fill(step.args ?? {}, ctx)
      emit({ type: 'tool_call', id, name: step.tool, rawName: `mcp__${SERVER}__${step.tool}`, input })
      let r
      try {
        r = await mcp.callTool(step.tool, input)
      } catch (err) {
        emit({ type: 'tool_result', id, ok: false, content: String(err?.message ?? err) })
        continue
      }
      const content = resultText(r)
      emit({ type: 'tool_result', id, ok: r.isError !== true, content })
      if (step.tool === 'task_claim') {
        try {
          const t = JSON.parse(content).tasks?.[0]
          if (t) ctx.task = t
        } catch {}
      }
    }
    return { ok: true, kind: 'ok', detail: 'script done' }
  }
  return {
    turn: () => turn().catch((err) => ({ ok: false, kind: 'unknown_error', detail: String(err?.message ?? err) })),
  }
}

export function startSession(o) {
  const events = new EventEmitter()
  const emit = (ev) => events.emit('event', ev)
  let alive = true
  let stopped = false
  const p = player(o, emit, () => stopped)
  let queue = Promise.resolve()
  return {
    pid: process.pid,
    events,
    get alive() {
      return alive
    },
    send() {
      queue = queue.then(async () => {
        if (!alive) return
        const since = Date.now()
        stopped = false
        const res = await p.turn()
        emit({ type: 'turn_end', ...res, durationMs: Date.now() - since, raw: null })
      })
    },
    interrupt: () => (stopped = true),
    close() {
      stopped = true
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
  const p = player(o, emit, () => stopped)
  const done = (async () => {
    await null // let the caller attach listeners first
    return p.turn()
  })().then((res) => {
    const outcome = { type: 'turn_end', ...res, durationMs: Date.now() - since, raw: null }
    emit(outcome)
    events.emit('exit', res.ok ? 0 : 1)
    return { code: res.ok ? 0 : 1, outcome, events: all, stderr: '' }
  })
  return { pid: process.pid, events, done, close: () => (stopped = true) }
}
