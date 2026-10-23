// The per-attempt isolation assertion. The default eval surface is the production
// one: a shell (claude-code's `Bash`) next to the local `fermi` MCP server, always
// inside the OS sandbox (harness/sandbox.mjs). A scenario's `tools` may narrow it
// (e.g. []), never widen it. A harness's `init` event (or the tool list its adapter
// reports in one) must show:
//   - no built-in tool beyond that surface plus the harness's irreducible built-ins
//     (HARNESS_BUILTINS: pi's read/bash/edit/write, codex's Bash/apply_patch), which
//     are allowed and recorded as builtinTools / surfaceDelta, not a breach, and
//     claude-code's internal meta tools (INTERNAL_TOOLS: ToolSearch, which only loads
//     deferred tool schemas and has no host access), which are allowed and kept out
//     of surfaceDelta. Names compare case-insensitively, so pi's `bash` is `Bash`;
//   - MCP servers exactly { fermi }: the init's `mcpServers` when the harness
//     reports them, else the servers its mcp__<server>__* tools name.
// The config's fermi → 127.0.0.1 half is checked by checkMcpConfig before launch,
// and a read of the sandbox canary (plantSandboxCanary) is a breach too.
// A breach aborts the attempt with errorKind isolation_breach; it never passes.
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { CODEX_BUILTINS } from '../../harness/codex.mjs'
import { PI_BUILTINS } from '../../harness/pi.mjs'
import { isLocalUrl } from './net.mjs'

export const EVAL_SERVER = 'fermi'
// The production lane's built-ins (claude-code `--tools Bash`); the eval default.
export const PRODUCTION_BUILTINS = ['Bash']
// claude-code's meta tools: ToolSearch loads the deferred MCP tool schemas. `--tools Bash`
// alone drops it and claude-code then sends every fermi schema up front instead of deferring
// them, so the runner passes `--tools Bash,ToolSearch`.
export const INTERNAL_TOOLS = ['ToolSearch']
// Built-ins a harness cannot drop: allowed whatever the scenario's `tools`.
export const HARNESS_BUILTINS = { 'claude-code': INTERNAL_TOOLS, pi: PI_BUILTINS, codex: CODEX_BUILTINS }

const lower = (xs) => new Set(xs.map((t) => String(t).toLowerCase()))
export const builtinsOf = (init) => (Array.isArray(init?.tools) ? init.tools.filter((t) => !String(t).startsWith('mcp__')) : null)

// The built-ins `harness` may report: the scenario's `tools` (default the production
// surface) plus the harness's irreducible ones. Throws when `tools` widens the surface.
export function allowedBuiltins(harness, tools = PRODUCTION_BUILTINS) {
  const prod = lower(PRODUCTION_BUILTINS)
  const wider = tools.filter((t) => !prod.has(String(t).toLowerCase()))
  if (wider.length) throw new Error(`isolation: scenario tools may only narrow the production surface {${PRODUCTION_BUILTINS.join(', ')}}, got ${wider.join(', ')}`)
  return [...tools, ...(HARNESS_BUILTINS[harness] ?? [])]
}

// The reported built-ins against the production surface → { added, removed }; INTERNAL_TOOLS
// are not surface.
export function surfaceDelta(builtins) {
  const have = lower(builtins)
  const same = lower([...PRODUCTION_BUILTINS, ...INTERNAL_TOOLS])
  return { added: builtins.filter((t) => !same.has(String(t).toLowerCase())), removed: PRODUCTION_BUILTINS.filter((t) => !have.has(t.toLowerCase())) }
}

// → a breach message, or null when the init is isolated. `allowed`: allowedBuiltins().
export function isolationBreach(init, { allowed = PRODUCTION_BUILTINS } = {}) {
  const builtins = builtinsOf(init)
  if (!builtins) return 'the harness reported no tool list'
  const ok = lower(allowed)
  const extra = builtins.filter((t) => !ok.has(String(t).toLowerCase()))
  if (extra.length) return `built-in tool(s) outside the allowed surface {${allowed.join(', ')}}: ${extra.join(', ')}`
  const servers = Array.isArray(init.mcpServers)
    ? init.mcpServers
    : [...new Set(init.tools.filter((t) => String(t).startsWith('mcp__')).map((t) => /^mcp__(.+?)__/.exec(t)?.[1]))]
  const others = servers.filter((s) => s !== EVAL_SERVER)
  if (others.length || (Array.isArray(init.mcpServers) && !servers.includes(EVAL_SERVER)))
    return `MCP servers must be exactly {${EVAL_SERVER}}, got {${servers.join(', ')}}`
  return null
}

// A random token in a file under the real $HOME, which the sandbox denies reading.
// Seeing the token in the harness's output means the sandbox let it read there.
// → { path, token, seen(event) → bool, remove() }
export function plantSandboxCanary(home = userInfo().homedir) {
  const token = `fermi-sandbox-canary-${randomBytes(16).toString('hex')}`
  const path = join(home, `.${token}`)
  writeFileSync(path, token + '\n', { mode: 0o600 })
  return { path, token, seen: (ev) => JSON.stringify(ev).includes(token), remove: () => rmSync(path, { force: true }) }
}

// The MCP config handed to the harness: exactly { fermi: http://127.0.0.1:<port>/… }.
export function checkMcpConfig(config) {
  const entries = Object.entries(config?.mcpServers ?? {})
  const ok = entries.length === 1 && entries[0][0] === EVAL_SERVER && isLocalUrl(entries[0][1]?.url) && new URL(entries[0][1].url).hostname === '127.0.0.1'
  if (!ok) throw new Error(`isolation: the eval MCP config must be exactly {${EVAL_SERVER} → 127.0.0.1}, got ${JSON.stringify(config?.mcpServers)}`)
}
