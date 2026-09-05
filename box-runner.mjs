#!/usr/bin/env node
// Cloud-box runner: claims work from its Fermi /box gateway queue, runs a
// headless Claude Code harness on it, streams control messages, reports
// completion, then powers the machine off.
//
// Configuration comes from /etc/fermi/box.env (written by the provisioner's
// user-data) or the process environment. Required: FERMI_URL, FERMI_BOX_TOKEN.
// Optional: ROUTE (claude|codex|grok), CPA_URL + CPA_TOKEN for proxy routes,
// CODEX_MODEL / GROK_MODEL overrides, WORKDIR, RUNNER_SELF_SHUTDOWN=1.

import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function loadEnvFile(path) {
	if (!existsSync(path)) return {}
	const out = {}
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
		if (m) out[m[1]] = m[2]
	}
	return out
}

const cfg = { ...loadEnvFile('/etc/fermi/box.env'), ...process.env }
const FERMI_URL = (cfg.FERMI_URL ?? '').replace(/\/$/, '')
const TOKEN = cfg.FERMI_BOX_TOKEN
const ROUTE = cfg.ROUTE ?? 'claude'
const WORKDIR = cfg.WORKDIR ?? '/var/fermi/work'
const POLL_MS = Number(cfg.POLL_MS ?? 5000)
const HEARTBEAT_MS = Number(cfg.HEARTBEAT_MS ?? 60_000)

if (!FERMI_URL || !TOKEN) {
	console.error('box-runner: FERMI_URL and FERMI_BOX_TOKEN are required')
	process.exit(1)
}

const log = (...args) => console.log(new Date().toISOString(), ...args)

async function api(path, body = {}) {
	const res = await fetch(`${FERMI_URL}${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (res.status === 401) throw new Error('revoked')
	return res.json()
}

// Inference bootstrap: credentials come from Fermi secrets via the box
// gateway. claude → a dedicated long-lived OAuth token (claude setup-token).
// codex/grok → a CLIProxyAPI OAuth bundle; the proxy runs ON THIS BOX,
// bound to localhost, talking directly to the provider. No shared proxy host.
const CPA_DIR = cfg.CPA_DIR ?? '/etc/fermi/cli-proxy-api'
const CPA_AUTH_FILES = { CPA_AUTH_CODEX: 'codex.json', CPA_AUTH_XAI: 'xai.json' }
const inference = { claudeToken: null, cpaKey: null, cpaProc: null, seeded: {}, githubToken: null }

async function bootstrapInference() {
	const res = await api('/box/inference-auth')
	if (!res.ok) throw new Error(`inference auth: ${res.error} missing=${res.missing ?? ''}`)
	// Repo missions receive GITHUB_TOKEN; wire git so clone/push just work.
	if (res.secrets.GITHUB_TOKEN) {
		inference.githubToken = res.secrets.GITHUB_TOKEN
		const home = cfg.HOME ?? process.env.HOME ?? '/root'
		writeFileSync(join(home, '.git-credentials'), `https://x-access-token:${inference.githubToken}@github.com\n`, { mode: 0o600 })
		try {
			execSync('git config --global credential.helper store && git config --global user.email "fermi-box@users.noreply.github.com" && git config --global user.name "Fermi Cloud Agent"')
		} catch (e) {
			log('git config failed:', String(e))
		}
	}
	if (ROUTE === 'claude') {
		inference.claudeToken = res.secrets.CLAUDE_CODE_OAUTH_TOKEN
		return
	}
	mkdirSync(CPA_DIR, { recursive: true, mode: 0o700 })
	inference.cpaKey = res.secrets.CPA_API_KEY
	for (const [secretName, file] of Object.entries(CPA_AUTH_FILES)) {
		if (res.secrets[secretName]) {
			writeFileSync(join(CPA_DIR, file), res.secrets[secretName], { mode: 0o600 })
			inference.seeded[secretName] = res.secrets[secretName]
		}
	}
	writeFileSync(
		join(CPA_DIR, 'config.yaml'),
		[
			'host: "127.0.0.1"',
			'port: 8317',
			`auth-dir: "${CPA_DIR}"`,
			'api-keys:',
			`  - "${inference.cpaKey}"`,
		].join('\n'),
	)
	inference.cpaProc = spawn(cfg.CPA_BIN ?? '/opt/fermi/cliproxyapi', ['-config', join(CPA_DIR, 'config.yaml')], {
		stdio: ['ignore', 'ignore', 'inherit'],
	})
	await new Promise((r) => setTimeout(r, 3000))
}

/** CLIProxyAPI rewrites its auth files on token refresh; push rotated
 *  bundles back to Fermi secrets so the next box gets working credentials. */
async function writebackInferenceAuth() {
	if (ROUTE === 'claude') return
	const secrets = {}
	for (const [secretName, file] of Object.entries(CPA_AUTH_FILES)) {
		const path = join(CPA_DIR, file)
		if (!existsSync(path)) continue
		const current = readFileSync(path, 'utf8')
		if (current !== inference.seeded[secretName]) {
			secrets[secretName] = current
			inference.seeded[secretName] = current
		}
	}
	if (Object.keys(secrets).length > 0) {
		await api('/box/inference-auth/update', { secrets }).catch((e) =>
			log('auth writeback failed:', String(e)),
		)
	}
}

/** Model routing, mirroring the cpa-env pattern: proxy routes pin every
 *  model tier so subagents cannot silently fall back to a billed account. */
function harnessEnv() {
	const env = { ...process.env, HOME: cfg.HOME ?? process.env.HOME ?? '/root' }
	// The box is a disposable sandbox; this lets the harness accept
	// --dangerously-skip-permissions under the root systemd unit.
	env.IS_SANDBOX = '1'
	if (inference.githubToken) {
		env.GITHUB_TOKEN = inference.githubToken
		env.GH_TOKEN = inference.githubToken
	}
	if (ROUTE === 'claude') {
		if (inference.claudeToken) env.CLAUDE_CODE_OAUTH_TOKEN = inference.claudeToken
		return env
	}
	const model = ROUTE === 'codex' ? (cfg.CODEX_MODEL ?? 'gpt-5.6-sol') : (cfg.GROK_MODEL ?? 'grok-4.6')
	env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8317'
	env.ANTHROPIC_AUTH_TOKEN = inference.cpaKey
	env.ANTHROPIC_MODEL = model
	env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
	env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
	env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
	env.CLAUDE_CODE_SUBAGENT_MODEL = model
	env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'
	delete env.CLAUDE_CODE_OAUTH_TOKEN
	delete env.ANTHROPIC_API_KEY
	return env
}

let child = null
let stopping = false

// The harness reaches Fermi MCP tools through the box-token-authenticated
// /box/mcp endpoint — no interactive OAuth, which a headless box cannot do.
function writeMcpConfig() {
	const path = join(WORKDIR, '.mcp.json')
	writeFileSync(
		path,
		JSON.stringify({
			mcpServers: {
				fermi: {
					type: 'http',
					url: `${FERMI_URL}/box/mcp`,
					headers: { Authorization: `Bearer ${TOKEN}` },
				},
			},
		}),
	)
	return path
}

function runHarness(prompt) {
	return new Promise((resolvePromise) => {
		const args = [
			'-p',
			'--dangerously-skip-permissions',
			'--output-format',
			'json',
			'--mcp-config',
			join(WORKDIR, '.mcp.json'),
			'--strict-mcp-config',
		]
		child = spawn(cfg.CLAUDE_BIN ?? 'claude', args, {
			cwd: WORKDIR,
			env: harnessEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let out = ''
		let err = ''
		child.stdout.on('data', (d) => {
			out += d
		})
		child.stderr.on('data', (d) => {
			err += d
			process.stderr.write(d)
		})
		child.on('error', (e) => {
			child = null
			resolvePromise({ code: 127, out: '', err: String(e) })
		})
		child.on('close', (code) => {
			child = null
			resolvePromise({ code, out, err })
		})
		child.stdin.write(prompt)
		child.stdin.end()
	})
}

function buildPrompt(payload, followups) {
	const parts = [payload.prompt]
	if (payload.repo) parts.push(`\nRepository: ${payload.repo} (base branch: ${payload.branch ?? 'default'}). Clone it into the working directory, work on your own branch, and push a PR when done.`)
	if (payload.skills?.length) parts.push(`\nLoad these Fermi skills before starting: ${payload.skills.join(', ')}.`)
	parts.push(`\nPROOF CONTRACT (the work does not count as done without this evidence): ${payload.proof_contract}`)
	parts.push('\nSave any proof files (screenshots, logs, diffs) into the ./artifacts/ directory — they are uploaded automatically when you finish.')
	parts.push('\nEnd your final message with a line "RESULT: <one-sentence outcome>".')
	for (const f of followups) parts.push(`\nFOLLOW-UP FROM ORCHESTRATOR: ${f}`)
	return parts.join('\n')
}

function extractResult(out) {
	try {
		const parsed = JSON.parse(out)
		const text = parsed.result ?? parsed.content ?? out
		const line = String(text).match(/RESULT:\s*(.+)/)
		return (line ? line[1] : String(text)).slice(0, 2000)
	} catch {
		const line = out.match(/RESULT:\s*(.+)/)
		return (line ? line[1] : out).slice(0, 2000)
	}
}

/** Ship everything the agent left in WORKDIR/artifacts/ up to R2 (10MB cap each). */
async function uploadArtifacts() {
	const dir = join(WORKDIR, 'artifacts')
	if (!existsSync(dir)) return
	for (const name of readdirSync(dir).slice(0, 50)) {
		const path = join(dir, name)
		try {
			const st = statSync(path)
			if (!st.isFile() || st.size === 0 || st.size > 10 * 1024 * 1024) continue
			const res = await fetch(`${FERMI_URL}/box/artifact`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${TOKEN}`,
					'x-artifact-name': name,
					'content-length': String(st.size),
				},
				body: readFileSync(path),
			})
			log(`artifact ${name}: ${res.status}`)
		} catch (e) {
			log(`artifact ${name} failed:`, String(e))
		}
	}
}

function powerOff() {
	if (cfg.RUNNER_SELF_SHUTDOWN === '1') {
		log('powering off')
		try {
			execSync('shutdown -h now')
		} catch (e) {
			log('shutdown failed:', String(e))
		}
	}
	process.exit(0)
}

async function main() {
	mkdirSync(WORKDIR, { recursive: true })
	writeMcpConfig()
	log(`box-runner up route=${ROUTE} fermi=${FERMI_URL}`)

	setInterval(() => {
		api('/box/heartbeat').catch((e) => log('heartbeat failed:', String(e)))
		writebackInferenceAuth()
	}, HEARTBEAT_MS)
	await api('/box/heartbeat')
	await bootstrapInference()
	await api('/box/report', { note: `runner up, route=${ROUTE}` }).catch(() => {})

	const pendingFollowups = []
	let idlePolls = 0

	for (;;) {
		let poll
		try {
			poll = await api('/box/poll', { lease_minutes: 60 })
		} catch (e) {
			if (String(e.message) === 'revoked') powerOff()
			log('poll failed:', String(e))
			await new Promise((r) => setTimeout(r, POLL_MS))
			continue
		}

		for (const c of poll.control ?? []) {
			if (c.type === 'stop') {
				stopping = true
				if (child) child.kill('SIGTERM')
			} else if (c.type === 'interrupt') {
				if (child) child.kill('SIGTERM')
				pendingFollowups.push(c.message)
			} else if (c.type === 'followup') {
				pendingFollowups.push(c.message)
			}
		}
		if (stopping) {
			log('stop requested')
			powerOff()
		}

		if (poll.task) {
			idlePolls = 0
			const payload = JSON.parse(poll.task.payload)
			const followups = pendingFollowups.splice(0)
			log(`running task ${poll.task.id}`)
			const { code, out, err } = await runHarness(buildPrompt(payload, followups))
			if (pendingFollowups.length > 0 && !stopping) {
				// Interrupted mid-run: keep the lease, rerun with the follow-up folded in.
				log('interrupted; rerunning with follow-up')
				continue
			}
			await uploadArtifacts()
			const status = code === 0 ? 'done' : 'failed'
			// On failure, surface the stderr tail so orchestrators can debug remotely.
			const failDetail = `harness exited ${code}${err ? `: ${err.slice(-500)}` : ''}`
			await api('/box/complete', {
				task_id: poll.task.id,
				status,
				result: code === 0 ? extractResult(out) || failDetail : failDetail,
			}).catch((e) => log('complete failed:', String(e)))
			await writebackInferenceAuth()
			log(`task ${poll.task.id} ${status}`)
			// One agent, one box: after the main task resolves, we are done.
			powerOff()
		} else {
			idlePolls++
			// Nothing to do for 10 minutes → the queue is empty and nobody is
			// coming; do not sit there billing.
			if (idlePolls * POLL_MS > 10 * 60_000) powerOff()
			await new Promise((r) => setTimeout(r, POLL_MS))
		}
	}
}

main().catch((e) => {
	log('fatal:', String(e))
	process.exit(1)
})
