// Fake one-shot `claude -p --output-format stream-json` for box-runner tests:
// reads the prompt from stdin, records argv, cwd, the prompt and a few env keys
// to $FAKE_DIR/once.log (one JSON line per spawn), then plays FAKE_ONCE:
//   success  init, a Bash tool call and its result, then a result with RESULT: and cost
//   429      an API-error result (api_error_status 429), exit 1
//   spend    a spend-limit result with no status, exit 1
//   result   the result event in FAKE_ONCE_RESULT (JSON), exit 1
//   crash    stderr only, no result, exit 3
//   slow     like success, but stalls FAKE_STALL_MS before the result (with
//            FAKE_STALL_FILE: until that file exists)
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ENV_KEYS = ['IS_SANDBOX', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']
const mode = process.env.FAKE_ONCE ?? 'success'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

let prompt = ''
process.stdin.on('data', (d) => (prompt += d))
process.stdin.on('end', async () => {
  appendFileSync(
    join(process.env.FAKE_DIR, 'once.log'),
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      prompt,
      env: Object.fromEntries(ENV_KEYS.filter((k) => k in process.env).map((k) => [k, process.env[k]])),
    }) + '\n',
  )
  if (mode === 'crash') {
    process.stderr.write('boom: harness crashed\n')
    process.exit(3)
  }
  out({ type: 'system', subtype: 'init', session_id: 'fake', model: 'fake', tools: ['Bash'] })
  if (mode === '429') {
    out({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, api_error_status: 429, result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}' })
    process.exit(1)
  }
  if (mode === 'result') {
    out(JSON.parse(process.env.FAKE_ONCE_RESULT))
    process.exit(1)
  }
  if (mode === 'spend') {
    out({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, api_error_status: null, result: "You've hit your monthly spend limit" })
    process.exit(1)
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } })
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a b' }] } })
  if (mode === 'slow' && process.env.FAKE_STALL_FILE)
    while (!existsSync(process.env.FAKE_STALL_FILE)) await new Promise((r) => setTimeout(r, 20))
  else if (mode === 'slow') await new Promise((r) => setTimeout(r, Number(process.env.FAKE_STALL_MS ?? 1000)))
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nRESULT: shipped the fix' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'Done.\nRESULT: shipped the fix', total_cost_usd: 0.4321 })
})
