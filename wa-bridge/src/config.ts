import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Config = {
	FERMI_URL: string
	FERMI_BEARER_TOKEN: string
	WA_WEBHOOK_SECRET: string
	POLL_MS: number
	DAEMON_HOME: string
	AUTH_DIR: string
	STATE_DIR: string
	// Which jid family to use in group mentions: follow the group's addressing
	// mode ('auto', default), or force '@lid' / '@s.whatsapp.net'.
	MENTION_JID_MODE: 'auto' | 'lid' | 'pn'
	DEBUG: boolean
}

// Parse KEY=VALUE lines from ~/fermi-daemon/.env, ignoring comments and blanks.
function parseEnvFile(path: string): Record<string, string> {
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch {
		return {}
	}
	const out: Record<string, string> = {}
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#')) continue
		const eq = trimmed.indexOf('=')
		if (eq === -1) continue
		const key = trimmed.slice(0, eq).trim()
		let value = trimmed.slice(eq + 1).trim()
		// Strip a single layer of surrounding quotes if present.
		if (
			value.length >= 2 &&
			(value[0] === '"' || value[0] === "'") &&
			value[value.length - 1] === value[0]
		) {
			value = value.slice(1, -1)
		}
		if (key !== '') out[key] = value
	}
	return out
}

export function loadConfig(): Config {
	const home = homedir()
	const DAEMON_HOME = join(home, 'fermi-daemon')
	const fileEnv = parseEnvFile(join(DAEMON_HOME, '.env'))

	// Process env overrides the .env file.
	const get = (key: string): string | undefined => process.env[key] ?? fileEnv[key]

	const required = ['FERMI_URL', 'FERMI_BEARER_TOKEN', 'WA_WEBHOOK_SECRET'] as const
	const missing: string[] = []
	const values: Record<string, string> = {}
	for (const key of required) {
		const v = get(key)
		if (v === undefined || v === '') {
			missing.push(key)
		} else {
			values[key] = v
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`missing required config: ${missing.join(', ')} — set them in ${join(DAEMON_HOME, '.env')} or the environment`,
		)
	}

	const pollRaw = get('POLL_MS')
	const POLL_MS = pollRaw !== undefined && pollRaw !== '' ? Number(pollRaw) : 3000
	if (!Number.isFinite(POLL_MS) || POLL_MS <= 0) {
		throw new Error(`invalid POLL_MS: ${pollRaw}`)
	}

	const modeRaw = get('WA_MENTION_JID_MODE') ?? 'auto'
	if (modeRaw !== 'auto' && modeRaw !== 'lid' && modeRaw !== 'pn') {
		throw new Error(`invalid WA_MENTION_JID_MODE: ${modeRaw} (expected auto|lid|pn)`)
	}

	return {
		FERMI_URL: values.FERMI_URL.replace(/\/+$/, ''),
		FERMI_BEARER_TOKEN: values.FERMI_BEARER_TOKEN,
		WA_WEBHOOK_SECRET: values.WA_WEBHOOK_SECRET,
		POLL_MS,
		DAEMON_HOME,
		AUTH_DIR: join(DAEMON_HOME, 'wa-auth'),
		STATE_DIR: join(DAEMON_HOME, 'wa-bridge', 'state'),
		MENTION_JID_MODE: modeRaw,
		DEBUG: get('WA_BRIDGE_DEBUG') === '1',
	}
}
