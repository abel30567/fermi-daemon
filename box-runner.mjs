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
			// Pass the SAME HOME the harness uses (harnessEnv), or the --global
			// config lands in a different .gitconfig than the harness's git reads
			// and commits fall back to root@hostname. Identity is also enforced via
			// GIT_* env vars in harnessEnv() as the authoritative override.
			execSync('git config --global credential.helper store && git config --global user.email "326217896+fermi-neutrino@users.noreply.github.com" && git config --global user.name "fermi-neutrino"', {
				env: { ...process.env, HOME: home },
			})
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
	// Headless box: kill telemetry, auto-update, and the session-title sidecar
	// call (the last one hard-fails on proxy models like gpt-5.6-sol/gpt-6-astra
	// with unrecognized_model and exits the whole harness 1).
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
	env.DISABLE_TELEMETRY = '1'
	env.DISABLE_AUTOUPDATER = '1'
	env.DISABLE_ERROR_REPORTING = '1'
	if (inference.githubToken) {
		env.GITHUB_TOKEN = inference.githubToken
		env.GH_TOKEN = inference.githubToken
		// Authoritative commit identity: GIT_* env vars override any gitconfig, so
		// commits are attributed to the fleet bot regardless of HOME/.gitconfig
		// state (otherwise git falls back to root@<ec2-hostname>).
		env.GIT_AUTHOR_NAME = 'fermi-neutrino'
		env.GIT_AUTHOR_EMAIL = '326217896+fermi-neutrino@users.noreply.github.com'
		env.GIT_COMMITTER_NAME = 'fermi-neutrino'
		env.GIT_COMMITTER_EMAIL = '326217896+fermi-neutrino@users.noreply.github.com'
	}
	if (ROUTE === 'claude') {
		if (inference.claudeToken) env.CLAUDE_CODE_OAUTH_TOKEN = inference.claudeToken
		// Model selection: per-mission `model` override > box CLAUDE_MODEL default >
		// Claude Code's own subscription default. Opus by default (workers get the
		// strong model); a mission can opt DOWN to sonnet for cheap high-fan-out.
		const claudeModel = missionModel ?? cfg.CLAUDE_MODEL
		if (claudeModel) {
			env.ANTHROPIC_MODEL = claudeModel
			env.ANTHROPIC_DEFAULT_OPUS_MODEL = claudeModel
			env.ANTHROPIC_DEFAULT_SONNET_MODEL = claudeModel
			env.CLAUDE_CODE_SUBAGENT_MODEL = claudeModel
		}
		return env
	}
	const model = missionModel ?? (ROUTE === 'codex' ? (cfg.CODEX_MODEL ?? 'gpt-5.6-sol') : (cfg.GROK_MODEL ?? 'grok-4.6'))
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
let missionModel = null // per-mission model override from the task payload

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

const PROGRESS_MS = Number(cfg.PROGRESS_MS ?? 30_000) // cadence of progress notes
const STUCK_MS = Number(cfg.STUCK_MS ?? 180_000) // no harness output this long → flag stuck

// Runs the harness in stream-json mode, tails each event to (a) post periodic
// progress notes via /box/report so an orchestrator can watch a run, and
// (b) emit an explicit "possibly stuck" note when output stalls, so a hung
// agent is visible long before its TTL instead of a 60-min black box.
function runHarness(prompt) {
	return new Promise((resolvePromise) => {
		const args = [
			'-p',
			'--dangerously-skip-permissions',
			'--output-format',
			'stream-json',
			'--verbose',
			'--mcp-config',
			join(WORKDIR, '.mcp.json'),
			'--strict-mcp-config',
		]
		child = spawn(cfg.CLAUDE_BIN ?? 'claude', args, {
			cwd: WORKDIR,
			env: harnessEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let err = ''
		let buf = ''
		let resultEvent = null
		let turns = 0
		let lastTool = 'starting'
		let lastActivity = Date.now()
		let stuckNoted = false

		child.stdout.on('data', (d) => {
			buf += d
			let nl
			// biome-ignore lint/suspicious/noAssignInExpressions: line splitter
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim()
				buf = buf.slice(nl + 1)
				if (!line) continue
				lastActivity = Date.now()
				stuckNoted = false
				try {
					const ev = JSON.parse(line)
					if (ev.type === 'assistant' || ev.type === 'user') turns++
					const tool = ev.message?.content?.find?.((c) => c.type === 'tool_use')?.name
					if (tool) lastTool = tool
					if (ev.type === 'result') resultEvent = ev
				} catch {}
			}
		})
		child.stderr.on('data', (d) => {
			err += d
			process.stderr.write(d)
		})

		// Progress / stuck reporter — best-effort, never blocks the run.
		const reporter = setInterval(() => {
			const idle = Math.round((Date.now() - lastActivity) / 1000)
			if (idle * 1000 >= STUCK_MS) {
				if (stuckNoted) return // one stuck note per stall, not every tick
				stuckNoted = true
				api('/box/report', {
					note: `⚠️ possibly stuck: no harness output for ${idle}s (turns=${turns}, last tool=${lastTool})`,
				}).catch(() => {})
			} else {
				api('/box/report', { note: `working: turns=${turns}, last tool=${lastTool}` }).catch(() => {})
			}
		}, PROGRESS_MS)

		const finish = (payload) => {
			clearInterval(reporter)
			child = null
			resolvePromise(payload)
		}
		child.on('error', (e) => finish({ code: 127, resultEvent: null, err: String(e) }))
		child.on('close', (code) => finish({ code, resultEvent, err }))
		child.stdin.write(prompt)
		child.stdin.end()
	})
}

// Lease any web sessions the mission named; write each storageState to a file
// the harness can pass to Playwright's browser.newContext({ storageState }).
async function leaseSessions(payload) {
	const leased = []
	for (const name of payload.sessions ?? []) {
		try {
			const res = await api('/box/session-lease', { name, lease_seconds: 7200 })
			if (!res.ok) {
				log(`session lease ${name} failed: ${res.error}`)
				continue
			}
			// Broker mode (#32): the box receives a handle, not cookies. Cookies
			// stay in the control plane; the box drives the session by RPC through
			// the ./fermi-browser helper written below.
			leased.push({ name, site: res.site, lease_id: res.lease_id, mode: res.mode ?? 'broker' })
		} catch (e) {
			log(`session lease ${name} error:`, String(e))
		}
	}
	if (leased.length) writeBrowserHelper()
	return leased
}

// A tiny CLI the agent shells out to for leased-session browsing. It never sees
// cookies: it POSTs an op to /box/browser-rpc and polls /box/browser-rpc/wait;
// the Mac executor runs the actual Playwright against the real session.
function writeBrowserHelper() {
	const helper = `#!/usr/bin/env node
// Usage: fermi-browser <session> <goto|click|fill|extract|screenshot> [--url U] [--selector S] [--value V]
const [session, op, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]
const URL = ${JSON.stringify(FERMI_URL)}, TOKEN = ${JSON.stringify(TOKEN)}
const post = (p, b) => fetch(URL + p, { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json())
const sub = await post('/box/browser-rpc', { session, op, args: flags })
if (!sub.ok) { console.error(JSON.stringify(sub)); process.exit(1) }
const res = await post('/box/browser-rpc/wait', { op_id: sub.op_id, timeout_seconds: 90 })
console.log(JSON.stringify(res))
process.exit(res.ok ? 0 : 1)
`
	const file = join(WORKDIR, 'fermi-browser')
	writeFileSync(file, helper, { mode: 0o755 })
}

function buildPrompt(payload, followups, sessions = []) {
	const parts = [payload.prompt]
	if (sessions.length) {
		parts.push(
			`\nLeased logged-in web sessions. You do NOT have the cookies and cannot log in yourself — drive each session through the ./fermi-browser helper, which runs the browser on the trusted control plane:\n` +
				sessions.map((s) => `- ${s.name} → ${s.site}`).join('\n') +
				`\nExamples: ./fermi-browser <session> goto --url <url-on-that-site> ; ./fermi-browser <session> extract --url <url> --selector <css> ; ./fermi-browser <session> click --selector <css>. Each prints JSON {ok,status,result}. Navigation is restricted to the session's own site.`,
		)
	}
	if (payload.repo) parts.push(`\nRepository: ${payload.repo} (base branch: ${payload.branch ?? 'default'}). Clone it into the working directory, work on your own branch, and push a PR when done.`)
	if (payload.skills?.length) parts.push(`\nLoad these Fermi skills before starting: ${payload.skills.join(', ')}.`)
	parts.push(`\nPROOF CONTRACT (JSON, checked MECHANICALLY — completion is refused if it fails; text claims count for nothing): ${payload.proof_contract}`)
	parts.push('\nSave any proof files (screenshots, logs, diffs) into the ./artifacts/ directory — they are uploaded automatically when you finish.')
	parts.push('\nEnd your final message with a line "RESULT: <one-sentence outcome>".')
	for (const f of followups) parts.push(`\nFOLLOW-UP FROM ORCHESTRATOR: ${f}`)
	return parts.join('\n')
}

/**
 * Pre-submit self-check of the structured proof contract (#36): same semantics
 * as the worker's checker at /box/complete, evaluated locally so an honest
 * agent gets one corrective rerun instead of a server-side refusal. Returns
 * null when the contract passes or is not checkable here.
 */
/**
 * Repo missions: generate artifacts/out.diff mechanically instead of trusting
 * the agent to remember. In the 100-agent run (2026-09-07) 4 of 6 failures
 * were green code that skipped this one step — the runner can just do it.
 * No-op if the agent already produced a non-empty out.diff.
 */
function ensureRepoDiffArtifact(payload) {
	if (!payload.repo) return
	const artifact = join(WORKDIR, 'artifacts', 'out.diff')
	try {
		if (existsSync(artifact) && statSync(artifact).size > 0) return
	} catch {}
	// The agent clones wherever it likes: WORKDIR itself or a child directory.
	let repoDir = existsSync(join(WORKDIR, '.git')) ? WORKDIR : null
	if (!repoDir) {
		for (const d of readdirSync(WORKDIR)) {
			try {
				const p = join(WORKDIR, d)
				if (statSync(p).isDirectory() && existsSync(join(p, '.git'))) { repoDir = p; break }
			} catch {}
		}
	}
	if (!repoDir) return
	const base = payload.branch ?? 'main'
	try {
		const diff = execSync(`git diff origin/${base}...HEAD`, {
			cwd: repoDir,
			maxBuffer: 32 * 1024 * 1024,
			env: harnessEnv(),
		})
		if (diff.length > 0) {
			mkdirSync(join(WORKDIR, 'artifacts'), { recursive: true })
			writeFileSync(artifact, diff)
			log(`auto-generated out.diff (${diff.length} bytes)`)
		}
	} catch (e) {
		log('auto out.diff failed:', String(e.message ?? e).slice(0, 120))
	}
}

function localProofFailure(payload) {
	let contract
	try {
		contract = JSON.parse(payload.proof_contract)
	} catch {
		return null // legacy free-text contract — server grandfathers it
	}
	if (contract?.kind === 'artifact') {
		const file = join(WORKDIR, 'artifacts', contract.name)
		if (!existsSync(file)) return `required artifact ./artifacts/${contract.name} is missing`
		const size = statSync(file).size
		if (size === 0) return `required artifact ./artifacts/${contract.name} is empty`
		if (contract.min_bytes && size < contract.min_bytes)
			return `artifact ./artifacts/${contract.name} is ${size} bytes; contract requires >= ${contract.min_bytes}`
	}
	if (contract?.kind === 'test') {
		try {
			execSync(contract.cmd, { cwd: WORKDIR, timeout: 10 * 60_000, stdio: 'pipe' })
			if ((contract.expect_exit ?? 0) !== 0) return `'${contract.cmd}' exited 0, contract expects ${contract.expect_exit}`
		} catch (e) {
			if ((contract.expect_exit ?? 0) === 0)
				return `proof command '${contract.cmd}' failed: ${String(e.message ?? e).slice(0, 300)}`
		}
	}
	return null // http checked by the worker; dom replays via fleetctl
}

function extractResult(resultEvent) {
	const text = resultEvent?.result ?? ''
	const line = String(text).match(/RESULT:\s*(.+)/)
	return (line ? line[1] : String(text)).slice(0, 2000)
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
			missionModel = payload.model || null
			const followups = pendingFollowups.splice(0)
			const sessions = await leaseSessions(payload)
			log(`running task ${poll.task.id}${sessions.length ? ` (${sessions.length} session(s) leased)` : ''}`)
			let { code, resultEvent, err } = await runHarness(buildPrompt(payload, followups, sessions))
			// One corrective rerun when the harness claims success but the proof
			// contract mechanically fails locally — honest agents self-correct
			// here instead of being refused at /box/complete.
			if (code === 0) {
				ensureRepoDiffArtifact(payload)
				const proofFail = localProofFailure(payload)
				if (proofFail) {
					log(`proof self-check failed (${proofFail}); corrective rerun`)
					const rerun = await runHarness(
						buildPrompt(payload, [...followups, `Your previous attempt did not satisfy the proof contract: ${proofFail}. Fix the work so the contract passes, then finish.`], sessions),
					)
					code = rerun.code
					resultEvent = rerun.resultEvent
					err = rerun.err
					if (code === 0) ensureRepoDiffArtifact(payload)
					const stillFailing = code === 0 ? localProofFailure(payload) : null
					if (stillFailing) {
						code = 1
						err = `proof contract unsatisfied after corrective rerun: ${stillFailing}`
					}
				}
			}
			if (pendingFollowups.length > 0 && !stopping) {
				// Interrupted mid-run: keep the lease, rerun with the follow-up folded in.
				log('interrupted; rerunning with follow-up')
				continue
			}
			if (code !== 0 && (err || resultEvent)) {
				// Failure diagnostics: full stderr + final result event as artifacts,
				// since the completion result only carries 500 chars.
				try {
					mkdirSync(join(WORKDIR, 'artifacts'), { recursive: true })
					writeFileSync(join(WORKDIR, 'artifacts', 'harness-stderr.txt'), err.slice(-500000))
					writeFileSync(
						join(WORKDIR, 'artifacts', 'harness-result.json'),
						JSON.stringify(resultEvent ?? {}, null, 2),
					)
				} catch {}
			}
			await uploadArtifacts()
			// Inference cost from the stream-json result event (total_cost_usd).
			const inferenceCost = Number(resultEvent?.total_cost_usd) || 0
			const status = code === 0 ? 'done' : 'failed'
			// On failure, surface the stderr tail so orchestrators can debug remotely.
			const failDetail = `harness exited ${code}${err ? `: ${err.slice(-500)}` : ''}`
			const completion = await api('/box/complete', {
				task_id: poll.task.id,
				status,
				result: code === 0 ? extractResult(resultEvent) || failDetail : failDetail,
				inference_cost_usd: inferenceCost,
			}).catch((e) => (log('complete failed:', String(e)), null))
			if (completion?.error === 'proof_unverified') {
				// The worker's mechanical check refused our `done` (e.g. an http
				// contract target is down). We already had our corrective rerun —
				// fail honestly rather than looping until TTL.
				log(`server refused done: ${completion.detail ?? 'proof_unverified'}`)
				await api('/box/complete', {
					task_id: poll.task.id,
					status: 'failed',
					result: `proof_unverified: ${completion.detail ?? ''}`.slice(0, 500),
					inference_cost_usd: 0,
				}).catch((e) => log('failed-complete failed:', String(e)))
			}
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
