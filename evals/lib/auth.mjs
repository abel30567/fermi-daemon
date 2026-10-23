// Inference auth for the sandboxed eval harness (evals/run.mjs --auth <mode>).
// The runner reads every credential in-process; a value is never printed, logged
// or written to the attempt dir, and each one joins the noCanaryLeak scan set.
//   none      (default) no credential is handed over (the sandbox hides the user's login)
//   fd        CI: the token on the runner's inherited CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR,
//             read once and handed to every harness on a fresh pipe (claude-code, hbar)
//   keychain  macOS: the Claude Code OAuth access token from the login keychain item
//             "Claude Code-credentials", re-read before each attempt (the user's own
//             Claude Code refreshes it), on a fresh pipe. The refresh token stays there.
//   proxy     CLIProxyAPI on 127.0.0.1:8317 with ~/.cli-proxy-api/.proxy-token
//             (claude-code and hbar: ANTHROPIC_BASE_URL; pi: a models.json provider;
//             codex: a config.toml model provider)
// createAuth(...).attempt() → the per-attempt additions to the harness options:
//   { tokenPipe?, env?, scrubSubprocessEnv?, provider? (pi, codex), localPorts?, egressAllow?, secrets }
import { execFileSync } from 'node:child_process'
import { closeSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { assertLocalUrls } from './net.mjs'

export const AUTH_MODES = ['none', 'fd', 'keychain', 'proxy']
export const PROXY_URL = 'http://127.0.0.1:8317'
export const KEYCHAIN_ITEM = 'Claude Code-credentials'
// Where each mode can deliver a credential: a pipe needs CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
// (hbar is claude-code with CLAUDE_BIN); codex has no fd handoff, only a proxy provider.
const HARNESSES = { fd: ['claude-code'], keychain: ['claude-code'], proxy: ['claude-code', 'pi', 'codex'] }
const TIERS = ['HAIKU', 'SONNET', 'OPUS']

// The current access token from the login keychain. `security` and `user` are injectable (tests).
// A Mac can hold several "Claude Code-credentials" items (one per account, some holding only
// mcpOAuth); Claude Code keeps the Claude.ai login under the macOS username, so that account is
// tried first, then every other account `dump-keychain` lists for the service, in order.
// Errors never carry an item's contents or an account name (only its length).
export function keychainToken({ security = '/usr/bin/security', user = userInfo().username } = {}) {
  const run = (args) => execFileSync(security, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 })
  const tried = []
  const read = (account) => {
    let raw
    try {
      raw = run(['find-generic-password', '-s', KEYCHAIN_ITEM, '-a', account, '-w'])
    } catch {
      return
    }
    tried.push(account.length)
    let token
    try {
      token = JSON.parse(raw)?.claudeAiOauth?.accessToken
    } catch {}
    if (typeof token === 'string' && token) return token
  }
  let token = read(user)
  if (token) return token
  for (const account of keychainAccounts(run)) if (account !== user && (token = read(account))) return token
  if (!tried.length) throw new Error(`--auth keychain: no "${KEYCHAIN_ITEM}" item in the login keychain (log in to Claude Code first)`)
  throw new Error(
    `--auth keychain: none of the ${tried.length} "${KEYCHAIN_ITEM}" item(s) tried holds a claudeAiOauth.accessToken (account name lengths: ${tried.join(', ')})`,
  )
}

// The accounts of every generic-password item for KEYCHAIN_ITEM, from `dump-keychain`'s
// attribute listing (no -d: no secrets). An account prints as "name" or, if not plain ASCII,
// as 0x<hex>  "<escaped>". [] if the dump fails.
function keychainAccounts(run) {
  let dump
  try {
    dump = run(['dump-keychain'])
  } catch {
    return []
  }
  const attr = (record, key) => {
    const m = record.match(new RegExp(`^\\s*"${key}"<blob>=(?:0x([0-9A-Fa-f]+)|"(.*)")`, 'm'))
    return m && (m[1] ? Buffer.from(m[1], 'hex').toString('utf8') : m[2])
  }
  const accounts = []
  for (const record of dump.split(/^keychain: /m)) {
    if (!/^class: "genp"$/m.test(record) || attr(record, 'svce') !== KEYCHAIN_ITEM) continue
    const account = attr(record, 'acct')
    if (account != null && !accounts.includes(account)) accounts.push(account)
  }
  return accounts
}

// The token on the inherited fd, read to the end (a CI pipe cannot be re-read), then
// the fd is closed and the variable dropped so nothing else picks up a reused number.
export function fdToken(env = process.env) {
  const v = env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  const fd = Number(v)
  if (!v || !Number.isInteger(fd) || fd < 0) throw new Error('--auth fd needs CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR (an open fd)')
  let token
  try {
    token = readFileSync(fd, 'utf8').trim()
  } catch {
    throw new Error(`--auth fd: cannot read CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR (${fd})`)
  } finally {
    try {
      closeSync(fd)
    } catch {}
    delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  }
  if (!token) throw new Error(`--auth fd: CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR (${fd}) holds no token`)
  return token
}

export function proxyToken(home = homedir()) {
  let token
  try {
    token = readFileSync(join(home, '.cli-proxy-api/.proxy-token'), 'utf8').trim()
  } catch {}
  if (!token) throw new Error('--auth proxy: no token in ~/.cli-proxy-api/.proxy-token')
  return token
}

// Throws on a bad mode, a harness the mode cannot reach or a non-localhost proxy URL.
export function createAuth({ mode = 'none', harness, model, env = process.env, readKeychain = keychainToken, readProxyToken = proxyToken, proxyUrl = PROXY_URL } = {}) {
  if (!AUTH_MODES.includes(mode)) throw new Error(`--auth must be one of ${AUTH_MODES.join(', ')}`)
  if (mode === 'none') return { mode, attempt: () => ({ secrets: [] }) }
  if (!HARNESSES[mode].includes(harness))
    throw new Error(`--auth ${mode} needs --harness ${HARNESSES[mode].join(' or ')}`)
  if (mode === 'fd') {
    const token = fdToken(env)
    return { mode, attempt: () => ({ tokenPipe: token, secrets: [token] }) }
  }
  if (mode === 'keychain')
    return {
      mode,
      attempt: () => {
        const token = readKeychain()
        return { tokenPipe: token, secrets: [token] }
      },
    }
  assertLocalUrls({ '--auth proxy': proxyUrl })
  if (!model) throw new Error('--auth proxy needs --model (every model tier is pinned to it)')
  const token = readProxyToken()
  const { host, port } = new URL(proxyUrl)
  const reach = { localPorts: [port || '80'], egressAllow: [host], secrets: [token] }
  if (harness === 'pi' || harness === 'codex') return { mode, attempt: () => ({ ...reach, provider: { baseUrl: `${proxyUrl}/v1`, apiKey: token } }) }
  const tiers = Object.fromEntries(TIERS.map((t) => [`ANTHROPIC_DEFAULT_${t}_MODEL`, model]))
  const proxyEnv = {
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ...tiers,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
  }
  return { mode, attempt: () => ({ ...reach, env: proxyEnv, scrubSubprocessEnv: true }) }
}
