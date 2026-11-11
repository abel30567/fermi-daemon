// The permission and tool surface every daemon run gets, warm (warm-worker.mjs)
// and cold (bin/run-once.mjs) alike, so both see the same tools and settings.
import { existsSync, realpathSync } from 'node:fs'

// Server-level grants: Bash, all Fermi tools via the claude.ai connector, all
// Playwright tools (user-scope MCP, local browser) and Google Calendar.
export const ALLOWED_TOOLS = 'Bash,mcp__claude_ai_Fermi,mcp__playwright,mcp__claude_ai_Google_Calendar'

// Skip global user settings and hooks (they block/add latency, and can grant
// bypassPermissions). Matches the warm session's --setting-sources.
export const SETTING_SOURCES = 'project,local'

// ---- OS sandbox for an agent run (DMN-50) -----------------------------------
// macOS: sandbox-exec with a deny-by-default Seatbelt profile. Writes only under
// `workdir` (and /dev/null, /dev/tty); network only to 127.0.0.1 on `allowPorts`:
// Seatbelt matches addresses, not host names, so allowlisted remote endpoints are
// reached through a local proxy listening on one of those ports. Reads stay open.
// No sandbox-exec (Linux, a future macOS): refuse, unless FERMI_ALLOW_UNSANDBOXED=1.

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
export const UNSANDBOXED_BANNER =
  'WARNING: RUNNING THE AGENT UNSANDBOXED (FERMI_ALLOW_UNSANDBOXED=1): it can write anywhere and reach any host'

const sbpl = (s) => JSON.stringify(s)

export function sandboxProfile({ workdir, allowPorts = [] }) {
  const dir = realpathSync(workdir)
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork signal process-info*)',
    '(allow sysctl-read ipc-posix-shm ipc-posix-sem pseudo-tty iokit-open user-preference-read mach-lookup)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${sbpl(dir)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    ...(allowPorts.length ? [`(allow network-outbound ${allowPorts.map((p) => `(remote ip ${sbpl(`localhost:${p}`)})`).join(' ')})`] : []),
  ].join('\n')
}

// → { sandboxed, banner?, wrap(bin, args) → [cmd, argv] }; throws when it must refuse.
export function runPolicy({ workdir, allowPorts = [], env = process.env, platform = process.platform, sandboxExec = SANDBOX_EXEC }) {
  if (platform === 'darwin' && existsSync(sandboxExec)) {
    const profile = sandboxProfile({ workdir, allowPorts })
    return { sandboxed: true, wrap: (bin, args) => [sandboxExec, ['-p', profile, bin, ...args]] }
  }
  if (env.FERMI_ALLOW_UNSANDBOXED !== '1')
    throw new Error(`no OS sandbox on ${platform} (${sandboxExec} not found); refusing to run the agent unsandboxed (FERMI_ALLOW_UNSANDBOXED=1 overrides, for dev only)`)
  return { sandboxed: false, banner: UNSANDBOXED_BANNER, wrap: (bin, args) => [bin, args] }
}
