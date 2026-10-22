# evals

Live behavioural evals. The daemon's output is tool calls
(`task_claim → context_bootstrap → channel_send → task_complete`), so a run is
graded on the normalized harness trace and the resulting Fermi state, not on the
final text.

```bash
node evals/run.mjs --harness <adapter|fake> [--model <id>] --scenarios '<glob>'... \
  [-k <n>] [--out <dir>] [--worker <fermi-mcp checkout>] [--timeout-ms <ms>]

# the runner's own check: fake harness, fake target, no inference, localhost only
node evals/run.mjs --harness fake --scenarios 'evals/scenarios/examples/*' --out /tmp/e && cat /tmp/e/summary.json
```

Exit code: 0 when every attempt ended as expected, 1 otherwise, 2 on a usage
error or a non-localhost URL. `--out` defaults to `runs/evals-<timestamp>`.

## What one attempt does

1. Starts fresh fakes on `127.0.0.1`. Each one records every request:
   - Slack, Telegram, Discord, Twilio and Anthropic APIs;
   - the Mac bridge, a MacOSMCP-shaped JSON-RPC server. It answers the drain
     prompt's model-switch curl (`127.0.0.1:8791/model`) itself and never
     reaches the real port. It also answers `fixtures.mac` canned results.
2. Starts the eval target with the fakes as its `*_API_BASE` / `MACOS_MCP_URL`:
   - with `--worker <path>`: fermi-mcp's `packages/worker/wrangler.eval.jsonc`
     (MCP-11) under `wrangler dev --local`. It gets a free port and its own
     `--persist-to` dir, so state is fresh on every attempt. It is seeded with
     `scripts/eval-seed.mjs` and dumped with `scripts/eval-dump.mjs`.
   - without it: `lib/fake-target.mjs`, an in-memory stand-in with the same
     webhook, core tools and dump shape. It exists to test the runner, so only
     `--harness fake` may use it; any other harness without `--worker` exits 2.
3. Starts a fault-injecting MCP proxy in front of the target's `/mcp`. The
   harness gets an MCP config with that proxy as the only server, `fermi`, so
   its tools are `mcp__fermi__*`, plus `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
4. Enqueues `inbound` through the channel webhook, the same way the bridge does.
5. Runs one drain through the adapter (`runOnce`, `prompts/drain.md` as the
   prompt) until it ends or `--timeout-ms` passes.
6. Dumps state, adds what the fakes recorded (`state.fakes`), and evaluates `expect`.
   A timeout or a `turn_end` with `ok: false` adds a failed assertion, so such an
   attempt never passes.

Per attempt, `<out>/<scenario>/<n>/` holds `trace.jsonl` (normalized events),
`raw.log` (native harness output), `state.json`, `mcp.json` and, with
`--worker`, `wrangler.log`. These hold transcripts, so never publish them.
`<out>/results.json` (schema: `schema/results.schema.json`) has one entry per
attempt. `<out>/summary.json` has the totals and the pass rate per scenario.

**Localhost only.** The runner refuses to start (exit 2) if `FERMI_URL`,
`MACOS_MCP_URL` or any `*_API_BASE` in its environment is not a localhost URL.
It also checks every URL it hands out (worker env, target, MCP config).

## Scenario format (JSON)

```jsonc
{
  "name": "reply-contract",               // default: file name
  "fixtures": {                           // seeded with MCP-11 eval-seed semantics
    "profile": { "agent": "…", "user": "…" },
    "memories": [{ "kind": "fact", "body": "…", "pinned": true }],
    "skills": [{ "slug": "…", "body": "---\nname: …\n---\n…" }],
    "bindings": [{ "channel": "sl", "sender_id": "U0EVALOWNER", "note": "owner" }], // → allowlist
    "tasks": [{ "id": "…", "channel": "sl", "sender": "…", "chat_id": "…", "payload": "…", "queue": "grok-bot" }],
    "mac": [{ "tool": "mac_shell", "match": "uptime", "result": "up 3 days" }]      // fake Mac canned results
  },
  "inbound": { "channel": "sl", "sender": "U0EVALOWNER", "chat": "D0EVAL", "text": "…",
               "attachment": { "kind": "image", "file": "x.jpg" } },               // optional
  "faults": { "channel_send": { "error": "slack is down" }, "context_bootstrap": { "latencyMs": 2000 } },
  "expect": [ { "called": "channel_send" } ],
  "expectOutcome": "fail",                // optional: a negative control that must fail
  "fake": { "script": [ … ] }             // only read by --harness fake
}
```

Inbound channels: `sl` (Slack bridge webhook; a chat id starting with `D` is a
DM). Other channels fail the attempt with a clear error until they are added.

`expect` entries each have exactly one key (see `lib/assertions.mjs`):

| assertion | example |
|---|---|
| `called` / `notCalled` / `exactlyOnce` | `{ "notCalled": "phone_call_start" }` |
| `order` (a subsequence of the calls) | `{ "order": ["task_claim", "channel_send", "task_complete"] }` |
| `argsMatch` (some call, or `every`) | `{ "argsMatch": { "tool": "task_claim", "every": true, "args": { "queue": null } } }`: a `"/re/i"` string is a regex, `null` means absent |
| `outbox.count` | `{ "outbox.count": { "eq": 1, "chat_id": "D0EVAL" } }`: messages sent during the drain (chat API fakes + D1 outbox); the webhook's own "Got it" ack is not counted |
| `task.status` | `"done"` for the inbound message's task, or `{ "queue": "grok-bot", "is": "pending" }` |
| `noSecretIn` | `["sk-…"]`: not in tool args, assistant text or outbound messages |
| `maxToolCalls` / `maxLatencyMs` | `{ "maxLatencyMs": 60000 }`: from enqueue to the end of the drain |

## The fake harness

`--harness fake` (`harness/fake.mjs`) runs no model. It plays the scenario's
`fake.script` against the `fermi` server in its MCP config and emits the same
normalized events a real adapter does. A step is `{ "tool", "args" }` or
`{ "text" }`. `${task.<field>}` in an arg means the first task of the latest
non-empty `task_claim`. The runner tests in `test/evals.test.mjs` use only this
harness and the fake target. They run under a preload that blocks every
non-loopback connection.
