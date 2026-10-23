// OS-level sandbox for a harness process in eval mode, the same for every
// adapter (claude-code, hbar via CLAUDE_BIN, pi, codex). An adapter given
// `sandbox` spawns through sandbox.wrap(bin, args) with sandbox.env plus its own
// options' env, and nothing else from the runner's environment.
//
//   createSandbox({ root, readable?, localPorts? })
//     root        the attempt's sandbox dir: the harness's HOME; root/tmp is its TMPDIR
//     readable    extra paths the harness may read (its cwd, test fakes)
//     localPorts  the 127.0.0.1 ports it may connect to (the MCP proxy, the egress proxy)
//     egressProxy optional http://127.0.0.1:<port> CONNECT proxy for the model endpoints
//                 (evals/lib/egress-proxy.mjs); set as HTTPS_PROXY, its port is allowed too
//   → { root, tmp, env, backend, wrap(bin, args) → [cmd, argv] }
//     env         the harness's whole inherited env: PATH, LANG, LC_* and TERM from the
//                 runner (AMBIENT_ENV), HOME and TMPDIR in root, the egress proxy vars.
//                 No ambient credential or endpoint (ANTHROPIC_*, OPENAI_*, CLAUDE_*, …):
//                 the runner adds those it means to hand over (evals/lib/auth.mjs)
//
// Policy, applied by sandbox-exec (macOS, a generated Seatbelt profile) or
// bwrap (Linux):
//   - writes only under root (and /dev/null);
//   - no reads of the real $HOME (os.userInfo().homedir and $HOME), except the
//     harness binary's directory (the whole node_modules tree when the binary is in
//     one: a node package needs its package.json and dependencies), the node
//     runtime and `readable`. Metadata
//     (stat) stays allowed, listing a directory or reading a file does not;
//   - network (macOS): 127.0.0.1 on `localPorts` only; model endpoints are reached
//     through the egress proxy, which allows only MODEL_HOSTS. No unix sockets
//     (ssh-agent), no keychain daemon.
//     Linux: bwrap shares the network namespace (an unshared one has no route to
//     the runner's 127.0.0.1 servers), so only the filesystem part is enforced there.
// wrap() throws when the platform has no backend: an eval harness never runs unsandboxed.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
export const AMBIENT_ENV = /^(PATH|LANG|LC_\w+|TERM)$/

const which = (bin) => {
  if (isAbsolute(bin) || bin.includes('/')) return bin
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(d, bin)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {}
  }
  throw new Error(`sandbox: ${bin} not found on PATH`)
}
const real = (p) => (existsSync(p) ? realpathSync(p) : p)
// …/node_modules/<pkg>/dist/cli.js → …/node_modules (the outermost one); else the binary's directory.
const binRoot = (exe) => {
  const i = exe.indexOf('/node_modules/')
  return i < 0 ? dirname(exe) : exe.slice(0, i + '/node_modules'.length)
}

// 'sandbox-exec' | 'bwrap' | null for this machine.
export function sandboxBackend(platform = process.platform) {
  if (platform === 'darwin') return existsSync(SANDBOX_EXEC) ? 'sandbox-exec' : null
  if (platform === 'linux') return spawnSync('bwrap', ['--version']).status === 0 ? 'bwrap' : null
  return null
}

const sb = (p) => JSON.stringify(p) // an SBPL string literal

export function seatbeltProfile({ root, homes, readable, localPorts }) {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork signal process-info*)',
    '(allow sysctl-read ipc-posix-shm ipc-posix-sem pseudo-tty iokit-open user-preference-read mach-lookup)',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
    '(allow file-read-metadata)',
    `(allow file-read* (require-all ${homes.map((h) => `(require-not (subpath ${sb(h)}))`).join(' ')}))`,
    `(allow file-read* ${[root, ...readable].map((p) => `(subpath ${sb(p)})`).join(' ')})`,
    `(allow file-write* (subpath ${sb(root)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    ...(localPorts.length ? [`(allow network-outbound ${localPorts.map((p) => `(remote ip ${sb(`localhost:${p}`)})`).join(' ')})`] : []),
  ].join('\n')
}

export function bwrapArgs({ root, homes, readable }) {
  const a = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc']
  for (const h of homes) a.push('--tmpfs', h)
  for (const p of readable) if (existsSync(p)) a.push('--ro-bind', p, p)
  a.push('--bind', root, root)
  return a
}

export function createSandbox({ root, readable = [], localPorts = [], egressProxy, platform = process.platform } = {}) {
  if (!root) throw new Error('sandbox: root is required')
  mkdirSync(join(root, 'tmp'), { recursive: true })
  root = realpathSync(root)
  const tmp = join(root, 'tmp')
  const homes = [...new Set([userInfo().homedir, process.env.HOME].filter(Boolean).map(real))]
  const ports = [...localPorts]
  const ambient = Object.entries(process.env).filter(([k]) => AMBIENT_ENV.test(k))
  const env = { ...Object.fromEntries(ambient), HOME: root, TMPDIR: tmp, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  if (egressProxy) {
    ports.push(new URL(egressProxy).port)
    Object.assign(env, { HTTPS_PROXY: egressProxy, https_proxy: egressProxy, HTTP_PROXY: egressProxy, http_proxy: egressProxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1' })
  }
  const backend = sandboxBackend(platform)
  return {
    root,
    tmp,
    env,
    backend,
    wrap(bin, args) {
      if (!backend) throw new Error(`sandbox: no sandbox backend on ${platform} (sandbox-exec on macOS, bwrap on Linux); refusing to run the harness unsandboxed`)
      const exe = real(which(bin))
      // The harness and its runtime: the binary's directory or node_modules tree and the node install (node-based harnesses and fakes).
      const runtime = [binRoot(exe), dirname(dirname(real(process.execPath)))]
      const paths = [...new Set([...runtime, ...readable.map(real)])]
      if (backend === 'sandbox-exec') return [SANDBOX_EXEC, ['-p', seatbeltProfile({ root, homes, readable: paths, localPorts: ports }), exe, ...args]]
      return ['bwrap', [...bwrapArgs({ root, homes, readable: paths }), '--', exe, ...args]]
    },
  }
}
