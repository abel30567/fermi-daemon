// Fake Claude Code for the conformance suite (./suite.mjs). Speaks claude's
// native stream-json. In session mode (--input-format stream-json) each user
// message's text names a fixture in test/fixtures/harness/claude-code/ that is
// replayed as the turn; in one-shot mode the prompt on stdin names it. Fixture
// lines are written verbatim, except directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an interrupt drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
//   {"$fake":"tool_env"}       credential probe: read the token from the fd in
//     CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, record its sha256 and this
//     process's argv to $FAKE_DIR/cred.json, run a Bash-tool child (inheriting
//     the environment, as claude's Bash tool does) that dumps its environment to
//     $FAKE_DIR/child-env.json, and stream that tool call and its output.
// An interrupt control_request ends the in-flight turn with claude's aborted result.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/claude-code')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')

let turn = null // the in-flight turn: { cancelled }

async function replay(name) {
  const t = (turn = { cancelled: false })
  const lines = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    if (t.cancelled) return
    const d = JSON.parse(line)
    if (!d.$fake) out(line)
    else if (d.$fake === 'sleep') await new Promise((r) => setTimeout(r, d.ms))
    else if (d.$fake === 'hang') await new Promise(() => {})
    else if (d.$fake === 'exit') process.exit(d.code)
    else if (d.$fake === 'tool_env') toolEnv()
  }
  if (turn === t) turn = null
}

function toolEnv() {
  const dir = process.env.FAKE_DIR
  const token = readFileSync(Number(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), 'utf8').trim()
  const tokenSha256 = createHash('sha256').update(token).digest('hex')
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ tokenSha256, argv: process.argv.slice(2) }))
  const env = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'child-env.json'), env)
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_env', name: 'Bash', input: { command: 'env' } }] } })
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_env', content: env }] } })
}

if (process.argv.includes('--input-format')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } })
      if (msg.request?.subtype === 'interrupt' && turn) {
        turn.cancelled = true
        turn = null
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, result: '', terminal_reason: 'aborted' })
      }
    } else if (msg.type === 'user') replay(msg.message.content[0].text)
  })
} else {
  let prompt = ''
  process.stdin.on('data', (d) => (prompt += d)).on('end', () => replay(prompt.trim()))
}
