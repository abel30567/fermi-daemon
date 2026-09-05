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
import { existsSync, readFileSync, mkdirSync } from 'node:fs'

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

/** Model routing, mirroring the cpa-env pattern: proxy routes pin every
 *  model tier so subagents cannot silently fall back to a billed account. */
function harnessEnv() {
	const env = { ...process.env, HOME: cfg.HOME ?? process.env.HOME ?? '/root' }
	if (ROUTE === 'codex' || ROUTE === 'grok') {
		const model = ROUTE === 'codex' ? (cfg.CODEX_MODEL ?? 'gpt-5.6-sol') : (cfg.GROK_MODEL ?? 'grok-4.6')
		env.ANTHROPIC_BASE_URL = cfg.CPA_URL
		env.ANTHROPIC_AUTH_TOKEN = cfg.CPA_TOKEN
		env.ANTHROPIC_MODEL = model
		env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
		env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
		env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
		env.CLAUDE_CODE_SUBAGENT_MODEL = model
		env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'
		delete env.CLAUDE_CODE_OAUTH_TOKEN
		delete env.ANTHROPIC_API_KEY
	}
	return env
}

let child = null
let stopping = false

function runHarness(prompt) {
	return new Promise((resolvePromise) => {
		const args = ['-p', '--dangerously-skip-permissions', '--output-format', 'json']
		child = spawn(cfg.CLAUDE_BIN ?? 'claude', args, {
			cwd: WORKDIR,
			env: harnessEnv(),
			stdio: ['pipe', 'pipe', 'inherit'],
		})
		let out = ''
		child.stdout.on('data', (d) => {
			out += d
		})
		child.on('close', (code) => {
			child = null
			resolvePromise({ code, out })
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
	log(`box-runner up route=${ROUTE} fermi=${FERMI_URL}`)

	setInterval(() => {
		api('/box/heartbeat').catch((e) => log('heartbeat failed:', String(e)))
	}, HEARTBEAT_MS)
	await api('/box/heartbeat')

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
			const { code, out } = await runHarness(buildPrompt(payload, followups))
			if (pendingFollowups.length > 0 && !stopping) {
				// Interrupted mid-run: keep the lease, rerun with the follow-up folded in.
				log('interrupted; rerunning with follow-up')
				continue
			}
			const status = code === 0 ? 'done' : 'failed'
			await api('/box/complete', {
				task_id: poll.task.id,
				status,
				result: extractResult(out) || `harness exited ${code}`,
			}).catch((e) => log('complete failed:', String(e)))
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
