// Scripted fake harness for testing the eval runner itself, with no inference.
// It follows the adapter contract in ../../harness/index.mjs (runOnce and
// startSession) and lives here, not in harness/, so production can never select it.
//
// Instead of a model it plays `script` (an adapter option): a list of steps,
//   { tool, args }      call `tool` on the `fermi` server of `mcpConfig`
//   { text }            emit assistant text
//   { shell, result? }  a call to the harness's own shell tool (`Bash`); nothing
//                       runs, the tool result is `result` (default "")
//   { shell, exec: true }
//                       the same call, but `/bin/sh -c <shell>` really runs, under
//                       the attempt's `sandbox` (harness/sandbox.mjs; refused without
//                       one); the result is its output, ok when it exits 0
//   { internal, args?, result? }
//                       a call to another of the harness's own tools, e.g.
//                       "ToolSearch" loading deferred tools; nothing runs
//   { sleepMs }         think for that long (a number, or a string such as "${turn}")
//   { apiError: { status?, text } }
//                       the model API fails mid-turn: the turn ends here with
//                       lib/turn-outcome.mjs's classification of that error
// `builtins` (an adapter option, the scenario's fake.builtins) are the built-in
// tools its init reports next to the fermi tools, e.g. ["Bash"].
// String args may use ${task.<field>} (the first task of the latest non-empty
// task_claim result), ${turn} and ${canary} (the runner's FERMI_EVAL_CANARY from
// `env`, there only so a negative control can leak it). Each step becomes the same normalized
// events a real adapter emits (tool_call / tool_result / text), then one
// turn_end. A tool call that fails at the transport (an HTTP 500) is a failed
// tool_result, the way a real harness hands it to the model.
// For startSession, `script` is either a list of such lists, one per send(), or
// one flat list played in every turn, where a step with `onTurn: n` is played
// only in the n-th turn (runOnce is turn 1). Either way the context carries
// across turns, like a warm session remembers what it claimed, and interrupt()
// ends the turn after the step in flight.
import { execFile } from 'node:child_process'
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

async function connect(o, emit) {
  const config = JSON.parse(typeof o.mcpConfig === 'string' && !o.mcpConfig.trim().startsWith('{') ? readFileSync(o.mcpConfig, 'utf8') : o.mcpConfig)
  const url = config.mcpServers?.[SERVER]?.url
  if (!url) throw new Error(`fake harness: mcpConfig has no "${SERVER}" server`)
  const mcp = await mcpConnect(url, { clientName: 'fake-harness' })
  emit({ type: 'init', harness: name, version: null, model: o.model ?? null, tools: [...(o.builtins ?? []), ...(await mcp.listTools()).map((t) => `mcp__${SERVER}__${t.name}`)] })
  return mcp
}

// Play `steps` as turn `ctx.turn`; returns the turn_end payload, or null if `stopped()` cut it short.
// A shell step with exec: true, run under the sandbox with the env a sandboxed adapter
// gives its harness (the options' env and sandbox.env, nothing ambient) → its tool_result.
// Asynchronously: the command may call the runner's in-process fakes (tools/teams-send.sh).
async function execShell(command, { sandbox, cwd, env }) {
  if (!sandbox) return { ok: false, content: 'fake harness: exec needs a sandbox' }
  try {
    const [cmd, argv] = sandbox.wrap('/bin/sh', ['-c', command])
    return await new Promise((resolve) =>
      execFile(cmd, argv, { cwd, env: { ...env, ...sandbox.env }, encoding: 'utf8', timeout: 10_000 }, (err, stdout, stderr) =>
        resolve({ ok: !err, content: `${stdout ?? ''}${stderr ?? ''}${err && err.code == null ? err.message : ''}` }),
      ),
    )
  } catch (err) {
    return { ok: false, content: String(err?.message ?? err) }
  }
}

async function play(steps, { mcp, ctx, emit, stopped, o }) {
  for (const step of steps) {
    if (stopped()) return null
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
    const id = `fake_${++ctx.n}`
    if (step.shell != null) {
      const command = fill(step.shell, ctx)
      emit({ type: 'tool_call', id, name: 'Bash', rawName: 'Bash', input: { command } })
      emit({ type: 'tool_result', id, ...(step.exec ? await execShell(command, o) : { ok: true, content: String(step.result ?? '') }) })
      continue
    }
    if (step.internal != null) {
      emit({ type: 'tool_call', id, name: step.internal, rawName: step.internal, input: fill(step.args ?? {}, ctx) })
      emit({ type: 'tool_result', id, ok: true, content: String(step.result ?? '') })
      continue
    }
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
  return stopped() ? null : { ok: true, kind: 'ok', detail: 'script done' }
}

const turnEnd = (res, since) => ({ type: 'turn_end', ...res, durationMs: Date.now() - since, raw: null })
const failed = (err) => ({ ok: false, kind: 'unknown_error', detail: String(err?.message ?? err) })

export function startSession(o) {
  const events = new EventEmitter()
  const emit = (ev) => events.emit('event', ev)
  const ctx = { n: 0, turn: 0, canary: o.env?.FERMI_EVAL_CANARY }
  const perTurn = Array.isArray(o.script?.[0])
  let mcp = null
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
      const turn = ++ctx.turn
      const steps = perTurn ? o.script[turn - 1] : o.script
      const since = Date.now()
      interrupted = false
      ;(async () => {
        await null // let the caller attach listeners first
        if (!Array.isArray(steps)) throw new Error(`fake harness: no script for turn ${turn} (scenario.fake.script or scenario.fake.turns)`)
        mcp ??= await connect(o, emit)
        // A real interrupted turn ends with an error result, which classifies as unknown_error.
        return (await play(steps, { mcp, ctx, emit, stopped: () => interrupted || !alive, o })) ?? { ok: false, kind: 'unknown_error', detail: 'interrupted' }
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
    const ctx = { n: 0, turn: 1, canary: o.env?.FERMI_EVAL_CANARY }
    return (await play(o.script, { mcp, ctx, emit, stopped: () => stopped, o })) ?? { ok: false, kind: 'unknown_error', detail: 'killed' }
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
