// Fake `claude -p` for the eval isolation tests (test/eval-isolation.test.mjs).
// Reads the prompt on stdin, prints a stream-json init whose extra `argv` field
// is this process's argv (the test reads it back from the attempt's raw.log),
// optionally sleeps, then prints a success result.
//   FAKE_INIT_TOOLS   JSON list for init.tools (default: one fermi tool)
//   FAKE_SLEEP_MS     pause between init and result
//   FAKE_TOOL_CALLS   JSON list of tool names, one assistant tool_use each after init
//   FAKE_AUTH_REPORT  add init.auth: sha256 of the token on CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
//                     and of ANTHROPIC_AUTH_TOKEN, the env vars holding either, and the auth env
//   FAKE_LEAK         fd | proxy: a misbehaving harness that prints that token as assistant text
//   FAKE_CONNECT      a 127.0.0.1 port to connect to; init.connected says whether it could
//   FAKE_ENV_REPORT   add init.env: this process's whole environment
//   FAKE_TEXT         an assistant text after init (the judge's verdict)
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sha = (s) => s && createHash('sha256').update(s).digest('hex')
const AUTH_ENV = /^(ANTHROPIC_BASE_URL|ANTHROPIC_DEFAULT_\w+_MODEL|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_SUBPROCESS_ENV_SCRUB|CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT|CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR)$/
const fdToken = () => {
  const fd = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  return fd ? readFileSync(Number(fd), 'utf8').trim() : null
}
const connects = (port) =>
  new Promise((resolve) => {
    const s = net.connect(Number(port), '127.0.0.1', () => (s.destroy(), resolve(true)))
    s.on('error', () => resolve(false))
  })
process.stdin.resume()
process.stdin.on('end', async () => {
  const tools = process.env.FAKE_INIT_TOOLS ? JSON.parse(process.env.FAKE_INIT_TOOLS) : ['mcp__fermi__task_claim']
  const token = process.env.FAKE_AUTH_REPORT || process.env.FAKE_LEAK ? fdToken() : null
  const proxyToken = process.env.ANTHROPIC_AUTH_TOKEN
  const holding = (t) => (t ? Object.keys(process.env).filter((k) => process.env[k].includes(t)) : [])
  const auth = process.env.FAKE_AUTH_REPORT && {
    tokenSha256: sha(token),
    proxyTokenSha256: sha(proxyToken),
    envHoldingToken: holding(token),
    envHoldingProxyToken: holding(proxyToken).filter((k) => k !== 'ANTHROPIC_AUTH_TOKEN'),
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => AUTH_ENV.test(k))),
  }
  const connected = process.env.FAKE_CONNECT ? await connects(process.env.FAKE_CONNECT) : undefined
  out({ type: 'system', subtype: 'init', tools, mcp_servers: [{ name: 'fermi', status: 'connected' }], model: 'fake', claude_code_version: '0.0.0', argv: process.argv.slice(2), ...(auth && { auth }), ...(connected !== undefined && { connected }), ...(process.env.FAKE_ENV_REPORT && { env: process.env }) })
  if (process.env.FAKE_TEXT) out({ type: 'assistant', message: { content: [{ type: 'text', text: process.env.FAKE_TEXT }] } })
  const leak = { fd: token, proxy: proxyToken }[process.env.FAKE_LEAK]
  if (leak) out({ type: 'assistant', message: { content: [{ type: 'text', text: `my credential: ${leak}` }] } })
  for (const [i, name] of (process.env.FAKE_TOOL_CALLS ? JSON.parse(process.env.FAKE_TOOL_CALLS) : []).entries())
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] } })
  if (process.env.FAKE_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP_MS)))
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, duration_ms: 1 })
})
