// Fake codex for the conformance suite (./suite.mjs). Two modes, as codex:
//   app-server  codex's JSON-RPC over stdio: initialize, thread/start, then each
//               turn/start's text names a fixture in test/fixtures/harness/codex/
//               that is replayed as the turn; turn/interrupt ends the turn as
//               codex does (turn/completed status "interrupted"). Closing stdin
//               shuts it down.
//   exec        `codex exec --json -`: the prompt (stdin) names the fixture; its
//               notifications are translated to exec's JSONL events (snake_case
//               items, turn.completed / turn.failed).
// Fixtures hold app-server notifications without ids (the fake fills in threadId,
// turnId and turn.id), plus directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an interrupt drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
//   {"$fake":"tool_env"}       credential probe: record the sha256 of the
//     credential codex would use from its environment (OPENAI_API_KEY; null if
//     unset) and this process's argv to $FAKE_DIR/cred.json, run a shell child
//     (inheriting the environment) that dumps its environment to
//     $FAKE_DIR/child-env.json, and stream that commandExecution item.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/codex')
const THREAD = '01a16680-e983-74b0-a73b-cd361b112846'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Replay fixture `name` as turn `turnId`, passing each notification to `emit`.
async function replay(name, turnId, emit, cancelled = () => false) {
  const lines = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    if (cancelled()) return
    const d = JSON.parse(line)
    if (d.$fake === 'sleep') await sleep(d.ms)
    else if (d.$fake === 'hang') await new Promise(() => {})
    else if (d.$fake === 'exit') process.exit(d.code)
    else if (d.$fake === 'tool_env') toolEnv().forEach((n) => emit(ids(n, turnId)))
    else emit(ids(d, turnId))
  }
}

function ids(n, turnId) {
  const params = { ...n.params, threadId: THREAD }
  if (n.method === 'turn/completed') params.turn = { ...params.turn, id: turnId }
  else params.turnId = turnId
  return { ...n, params }
}

function toolEnv() {
  const dir = process.env.FAKE_DIR
  const key = process.env.OPENAI_API_KEY
  const tokenSha256 = key ? createHash('sha256').update(key).digest('hex') : null
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ tokenSha256, argv: process.argv.slice(2) }))
  const env = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'child-env.json'), env)
  const item = { type: 'commandExecution', id: 'call_env', command: 'env', cwd: dir, commandActions: [], status: 'inProgress', aggregatedOutput: null, exitCode: null }
  return [
    { method: 'item/started', params: { item } },
    { method: 'item/completed', params: { item: { ...item, status: 'completed', aggregatedOutput: env, exitCode: 0 } } },
  ]
}

function appServer() {
  let run = null // the in-flight turn: { id, cancelled }
  let turns = 0
  createInterface({ input: process.stdin })
    .on('line', async (line) => {
      const msg = JSON.parse(line)
      const reply = (result) => out({ id: msg.id, result })
      if (msg.method === 'initialize') reply({ userAgent: 'fermi-daemon/0.163.0 (Mac OS 14.5.0; arm64) fake', platformFamily: 'unix', platformOs: 'macos' })
      else if (msg.method === 'thread/start') {
        const thread = { id: THREAD, sessionId: THREAD, cwd: msg.params.cwd, status: { type: 'idle' }, ephemeral: false }
        reply({ thread, model: msg.params.model ?? 'gpt-fake', modelProvider: 'openai', cwd: msg.params.cwd, approvalPolicy: msg.params.approvalPolicy })
        out({ method: 'thread/started', params: { thread } })
      } else if (msg.method === 'turn/start') {
        const t = (run = { id: `turn_${++turns}`, cancelled: false })
        reply({ turn: { id: t.id, items: [], status: 'inProgress', error: null } })
        out({ method: 'turn/started', params: { threadId: THREAD, turn: { id: t.id, items: [], status: 'inProgress', error: null } } })
        await replay(msg.params.input[0].text, t.id, out, () => t.cancelled)
        if (run === t) run = null
      } else if (msg.method === 'turn/interrupt') {
        if (run?.id === msg.params.turnId) {
          run.cancelled = true
          out({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: run.id, items: [], status: 'interrupted', error: null } } })
          run = null
        }
        reply({})
      } else if (msg.id != null) out({ id: msg.id, error: { code: -32601, message: `fake: ${msg.method}` } })
    })
    .on('close', () => process.exit(0))
}

// app-server item → exec item: snake_case keys and type, in_progress status.
const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
const execItem = (it) =>
  Object.fromEntries(Object.entries(it).map(([k, v]) => [snake(k), k === 'type' ? snake(v) : k === 'status' ? snake(v) : v]))

async function exec() {
  let prompt = ''
  for await (const c of process.stdin) prompt += c
  out({ type: 'thread.started', thread_id: THREAD })
  out({ type: 'turn.started' })
  let usage = null
  let failed = false
  await replay(prompt.trim(), 'turn_1', ({ method, params: p }) => {
    if (method === 'item/started') out({ type: 'item.started', item: execItem(p.item) })
    else if (method === 'item/completed') out({ type: 'item.completed', item: execItem(p.item) })
    else if (method === 'error') out({ type: 'error', message: p.error.message })
    else if (method === 'thread/tokenUsage/updated') usage = p.tokenUsage.total
    else if (method === 'turn/completed' && p.turn.status === 'completed')
      out({ type: 'turn.completed', usage: { input_tokens: usage?.inputTokens ?? 0, cached_input_tokens: usage?.cachedInputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 } })
    else if (method === 'turn/completed') {
      failed = true
      out({ type: 'error', message: p.turn.error.message })
      out({ type: 'turn.failed', error: { message: p.turn.error.message } })
    }
  })
  process.exit(failed ? 1 : 0)
}

if (process.argv[2] === 'app-server') appServer()
else if (process.argv[2] === 'exec') exec()
else {
  process.stderr.write(`fake codex: unsupported argv ${process.argv.slice(2).join(' ')}\n`)
  process.exit(2)
}
