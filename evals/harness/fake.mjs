// Scripted fake harness for testing the eval runner itself, with no inference.
// It follows the adapter contract in ../../harness/index.mjs (runOnce only) and
// lives here, not in harness/, so production can never select it.
//
// Instead of a model it plays `script` (an adapter option): a list of steps,
//   { tool, args }  call `tool` on the `fermi` server of `mcpConfig`
//   { text }        emit assistant text
// String args may use ${task.<field>}: the first task of the latest non-empty
// task_claim result. Each step becomes the same normalized events a real
// adapter emits (tool_call / tool_result / text), then one turn_end.
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

export function startSession() {
  throw new Error('the fake harness supports runOnce only')
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
    const config = JSON.parse(typeof o.mcpConfig === 'string' && !o.mcpConfig.trim().startsWith('{') ? readFileSync(o.mcpConfig, 'utf8') : o.mcpConfig)
    const url = config.mcpServers?.[SERVER]?.url
    if (!url) throw new Error(`fake harness: mcpConfig has no "${SERVER}" server`)
    if (!Array.isArray(o.script)) throw new Error('fake harness: no script (scenario.fake.script)')
    const mcp = await mcpConnect(url, { clientName: 'fake-harness' })
    emit({ type: 'init', harness: name, version: null, model: o.model ?? null, tools: (await mcp.listTools()).map((t) => `mcp__${SERVER}__${t.name}`) })
    const ctx = {}
    let n = 0
    for (const step of o.script) {
      if (stopped) break
      if (step.text != null) {
        emit({ type: 'text', text: fill(step.text, ctx) })
        continue
      }
      const id = `fake_${++n}`
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
    return { ok: !stopped, kind: stopped ? 'unknown_error' : 'ok', detail: stopped ? 'killed' : 'script done' }
  })()
    .catch((err) => ({ ok: false, kind: 'unknown_error', detail: String(err?.message ?? err) }))
    .then((res) => {
      const outcome = { type: 'turn_end', ...res, durationMs: Date.now() - since, raw: null }
      emit(outcome)
      events.emit('exit', res.ok ? 0 : 1)
      return { code: res.ok ? 0 : 1, outcome, events: all, stderr: '' }
    })
  return { pid: process.pid, events, done, close: () => (stopped = true) }
}
