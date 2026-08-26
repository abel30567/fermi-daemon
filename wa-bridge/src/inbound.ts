import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { log } from './log.ts'

const RETRY_DELAYS_MS = [1000, 3000, 9000]
const WARM_CONTROL_PORT = Number(process.env.WARM_CONTROL_PORT ?? 8791)

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// Emergency-stop detection. True when the whole message reads as "drop what
// you're doing" — kept strict enough that "stop by the store" won't trigger it,
// but covers the user's examples ("no stop", "stop now") and the obvious verbs.
export function isStopCommand(text: string): boolean {
	const t = text
		.trim()
		.toLowerCase()
		.replace(/[!.?,]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!t) return false
	return /^(no ?stop|stop( (now|it|that|right now|please|pls|everything|the ?task|task|doing))?|halt|abort( it| that| the ?task)?|cancel( it| that| the ?task| task)?|quit|nvm|never ?mind|emergency ?stop|drop (it|the ?task|this)|stop what ?(you'?re|u r) doing|hold on stop)$/.test(
		t,
	)
}

// Tell the warm worker to interrupt the running turn immediately. Returns true
// if the worker acknowledged (so we can skip enqueueing a redundant stop task).
async function signalAbort(chatId: string): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${WARM_CONTROL_PORT}/abort`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ channel: 'wa', chat_id: chatId }),
			signal: AbortSignal.timeout(3000),
		})
		return res.ok
	} catch {
		return false
	}
}

// Kick the Fermi daemon so it drains the freshly-queued inbound message
// promptly. poll.sh holds its own lock, so a duplicate spawn is harmless.
function pokeDaemon(config: Config): void {
	try {
		const pollScript = join(config.DAEMON_HOME, 'poll.sh')
		spawn(pollScript, [], { detached: true, stdio: 'ignore' }).unref()
	} catch (err) {
		log(`warn: failed to spawn poll.sh: ${String(err)}`)
	}
}

export type InboundHandler = (sender: string, chatId: string, text: string) => Promise<void>

export function makeInboundHandler(config: Config): InboundHandler {
	const url = `${config.FERMI_URL}/wa/webhook`
	return async (sender, chatId, text) => {
		// Emergency stop: interrupt the running turn immediately rather than
		// letting the stop wait in the queue behind the task it's meant to stop.
		if (isStopCommand(text)) {
			log(`stop command from ${sender} (chat ${chatId}): "${text}" — signaling abort`)
			if (await signalAbort(chatId)) return
			log('abort signal failed (warm worker down?) — enqueueing normally')
		}
		const body = JSON.stringify({ sender, chat_id: chatId, text })
		for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
			try {
				const res = await fetch(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-wa-bridge-secret': config.WA_WEBHOOK_SECRET,
					},
					body,
				})
				if (res.ok) {
					pokeDaemon(config)
					return
				}
				log(`webhook non-2xx (attempt ${attempt + 1}): ${res.status}`)
			} catch (err) {
				log(`webhook network error (attempt ${attempt + 1}): ${String(err)}`)
			}
			const delay = RETRY_DELAYS_MS[attempt]
			if (delay !== undefined) await sleep(delay)
		}
		log(
			`DROPPED inbound message from ${sender} (chat ${chatId}) after ${RETRY_DELAYS_MS.length + 1} attempts`,
		)
	}
}
