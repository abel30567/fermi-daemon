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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertLocalUrls } from './net.mjs'

export const AUTH_MODES = ['none', 'fd', 'keychain', 'proxy']
export const PROXY_URL = 'http://127.0.0.1:8317'
export const KEYCHAIN_ITEM = 'Claude Code-credentials'
// Where each mode can deliver a credential: a pipe needs CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
// (hbar is claude-code with CLAUDE_BIN); codex has no fd handoff, only a proxy provider.
const HARNESSES = { fd: ['claude-code'], keychain: ['claude-code'], proxy: ['claude-code', 'pi', 'codex'] }
const TIERS = ['HAIKU', 'SONNET', 'OPUS']

// The current access token from the login keychain. `security` is injectable (tests).
// Errors never carry the item's contents.
export function keychainToken({ security = '/usr/bin/security' } = {}) {
  let raw
  try {
    raw = execFileSync(security, ['find-generic-password', '-s', KEYCHAIN_ITEM, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    throw new Error(`--auth keychain: no "${KEYCHAIN_ITEM}" item in the login keychain (log in to Claude Code first)`)
  }
  let token
  try {
    token = JSON.parse(raw)?.claudeAiOauth?.accessToken
  } catch {}
  if (typeof token !== 'string' || !token) throw new Error(`--auth keychain: "${KEYCHAIN_ITEM}" holds no claudeAiOauth.accessToken`)
  return token
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
