// The per-attempt isolation assertion. A harness's `init` event (or the tool
// list its adapter reports in one) must show:
//   - no built-in tool beyond the scenario's `tools` (default none; names compare
//     case-insensitively, so pi's `bash` is `Bash`);
//   - MCP servers exactly { fermi }: the init's `mcpServers` when the harness
//     reports them, else the servers its mcp__<server>__* tools name.
// The config's fermi → 127.0.0.1 half is checked by checkMcpConfig before launch.
// A breach aborts the attempt with errorKind isolation_breach; it never passes.
import { isLocalUrl } from './net.mjs'

export const EVAL_SERVER = 'fermi'

// → a breach message, or null when the init is isolated.
export function isolationBreach(init, { tools = [] } = {}) {
  if (!Array.isArray(init?.tools)) return 'the harness reported no tool list'
  const declared = new Set(tools.map((t) => String(t).toLowerCase()))
  const builtins = init.tools.filter((t) => !String(t).startsWith('mcp__'))
  const extra = builtins.filter((t) => !declared.has(String(t).toLowerCase()))
  if (extra.length) return `built-in tool(s) not declared by the scenario: ${extra.join(', ')}`
  const servers = Array.isArray(init.mcpServers)
    ? init.mcpServers
    : [...new Set(init.tools.filter((t) => String(t).startsWith('mcp__')).map((t) => /^mcp__(.+?)__/.exec(t)?.[1]))]
  const others = servers.filter((s) => s !== EVAL_SERVER)
  if (others.length || (Array.isArray(init.mcpServers) && !servers.includes(EVAL_SERVER)))
    return `MCP servers must be exactly {${EVAL_SERVER}}, got {${servers.join(', ')}}`
  return null
}

// The MCP config handed to the harness: exactly { fermi: http://127.0.0.1:<port>/… }.
export function checkMcpConfig(config) {
  const entries = Object.entries(config?.mcpServers ?? {})
  const ok = entries.length === 1 && entries[0][0] === EVAL_SERVER && isLocalUrl(entries[0][1]?.url) && new URL(entries[0][1].url).hostname === '127.0.0.1'
  if (!ok) throw new Error(`isolation: the eval MCP config must be exactly {${EVAL_SERVER} → 127.0.0.1}, got ${JSON.stringify(config?.mcpServers)}`)
}
