// Fake `claude -p` for the eval isolation tests (test/eval-isolation.test.mjs).
// Reads the prompt on stdin, prints a stream-json init whose extra `argv` field
// is this process's argv (the test reads it back from the attempt's raw.log),
// optionally sleeps, then prints a success result.
//   FAKE_INIT_TOOLS   JSON list for init.tools (default: one fermi tool)
//   FAKE_SLEEP_MS     pause between init and result
//   FAKE_TOOL_CALLS   JSON list of tool names, one assistant tool_use each after init
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
process.stdin.resume()
process.stdin.on('end', async () => {
  const tools = process.env.FAKE_INIT_TOOLS ? JSON.parse(process.env.FAKE_INIT_TOOLS) : ['mcp__fermi__task_claim']
  out({ type: 'system', subtype: 'init', tools, mcp_servers: [{ name: 'fermi', status: 'connected' }], model: 'fake', claude_code_version: '0.0.0', argv: process.argv.slice(2) })
  for (const [i, name] of (process.env.FAKE_TOOL_CALLS ? JSON.parse(process.env.FAKE_TOOL_CALLS) : []).entries())
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] } })
  if (process.env.FAKE_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP_MS)))
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, duration_ms: 1 })
})
