// Fake pi for the conformance suite (./suite.mjs). Speaks pi's RPC protocol
// (`pi --mode rpc`): each `prompt` command is answered with pi's prompt response,
// and its message names a fixture in test/fixtures/harness/pi/ that is replayed
// as the run. Closing stdin shuts it down, as pi does. Fixture lines are written
// verbatim, except directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an abort drops the rest)
//   {"$fake":"hang"}           never finish the run
//   {"$fake":"exit","code":N}  exit mid-run (a crash)
//   {"$fake":"tool_env"}       credential probe: record the sha256 of the
//     credential pi would use (ANTHROPIC_OAUTH_TOKEN, pi's only non-argv,
//     non-file channel; null if unset) and this process's argv to
//     $FAKE_DIR/cred.json, run a bash-tool child (inheriting the environment, as
//     pi's bash tool does) that dumps its environment to $FAKE_DIR/child-env.json,
//     and stream that tool execution.
//   {"$fake":"mcp_probe"}      MCP probe: resolve the agent dir as pi does
//     (PI_CODING_AGENT_DIR, else $HOME/.pi/agent) and record HOME, that dir and
//     the mcp.json, auth.json and models.json pi would load (and its argv) from it to $FAKE_DIR/mcp-seen.json.
// An abort ends the in-flight run the way pi does: an aborted assistant message,
// then agent_end and agent_settled, then the abort response.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/pi')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')

let run = null // the in-flight run: { cancelled }

async function replay(name) {
  const t = (run = { cancelled: false })
  const lines = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    if (t.cancelled) return
    const d = JSON.parse(line)
    if (!d.$fake) out(line)
    else if (d.$fake === 'sleep') await new Promise((r) => setTimeout(r, d.ms))
    else if (d.$fake === 'hang') await new Promise(() => {})
    else if (d.$fake === 'exit') process.exit(d.code)
    else if (d.$fake === 'tool_env') toolEnv()
    else if (d.$fake === 'mcp_probe') mcpProbe()
  }
  if (run === t) run = null
}

function toolEnv() {
  const dir = process.env.FAKE_DIR
  const token = process.env.ANTHROPIC_OAUTH_TOKEN
  const tokenSha256 = token ? createHash('sha256').update(token).digest('hex') : null
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ tokenSha256, argv: process.argv.slice(2) }))
  const env = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'child-env.json'), env)
  out({ type: 'tool_execution_start', toolCallId: 'toolu_env', toolName: 'bash', args: { command: 'env' } })
  out({ type: 'tool_execution_end', toolCallId: 'toolu_env', toolName: 'bash', result: { content: [{ type: 'text', text: env }], details: {} }, isError: false })
}

function mcpProbe() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, '.pi/agent')
  const read = (f) => {
    try {
      return readFileSync(join(agentDir, f), 'utf8')
    } catch {
      return null
    }
  }
  const seen = { home: process.env.HOME, agentDir, mcp: read('mcp.json'), auth: read('auth.json'), models: read('models.json'), argv: process.argv.slice(2) }
  writeFileSync(join(process.env.FAKE_DIR, 'mcp-seen.json'), JSON.stringify(seen))
}

const aborted = {
  role: 'assistant',
  content: [],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'aborted',
  errorMessage: 'Request was aborted',
  timestamp: 0,
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return out({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' })
    }
    if (msg.type === 'prompt') {
      out({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
      replay(msg.message)
    } else if (msg.type === 'abort') {
      if (run) {
        run.cancelled = true
        run = null
        out({ type: 'message_end', message: aborted })
        out({ type: 'turn_end', message: aborted, toolResults: [] })
        out({ type: 'agent_end', messages: [aborted], willRetry: false })
        out({ type: 'agent_settled' })
      }
      out({ type: 'response', command: 'abort', success: true })
    }
  })
  .on('close', () => process.exit(0))
