// Harness adapter seam. Every agent harness (Claude Code today; pi, codex, …
// later) is driven through one contract and reports one normalized event
// stream, so callers never parse a harness's native output.
//
// An adapter module exports:
//   name
//   startSession({ model, systemPrompt, cwd, env, mcpConfig?, allowedTools?, ...adapterOpts })
//     → { send(text), interrupt(), close(signal?), alive, pid, events }
//     A long-lived duplex session: send() starts a turn, interrupt() aborts the
//     in-flight turn while the session stays alive.
//   runOnce({ prompt, ...same })
//     → { events, done: Promise<{ code, outcome, events[], stderr }> }
//     One prompt, one process; `outcome` is the run's turn_end (null if none).
//
// `events` is an EventEmitter:
//   'event'  a normalized event (below)
//   'raw'    one raw output line, for logs in the harness's native format
//   'stderr' a stderr chunk (string)
//   'exit'   the exit code
//
// Normalized events ({ type, ... }):
//   init        { harness, version, model, tools[] }
//   text        { text }
//   tool_call   { id, name, rawName, input }   name is bare (see bareToolName)
//   tool_result { id, ok, content }            content is a string
//   turn_end    { ok, kind, detail, retryAfterMs?, costUsd?, inputTokens?,
//                 outputTokens?, durationMs, raw }
//               ok/kind/detail/retryAfterMs are lib/turn-outcome.mjs classifyResult.

const ADAPTERS = { 'claude-code': './claude-code.mjs' }

// The adapter named by `name` (default: env HARNESS, else claude-code).
export async function loadHarness(name = process.env.HARNESS || 'claude-code') {
  const path = ADAPTERS[name]
  if (!path) throw new Error(`unknown HARNESS "${name}" (known: ${Object.keys(ADAPTERS).join(', ')})`)
  return import(path)
}

// mcp__claude_ai_Fermi__skill_load / mcp__fermi__skill_load → skill_load.
export function bareToolName(name) {
  return String(name ?? '').replace(/^mcp__.+?__/, '')
}
