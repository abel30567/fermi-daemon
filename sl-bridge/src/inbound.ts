import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { type SlackFile, saveSlackFile } from './files.ts'
import { log } from './log.ts'

const RETRY_DELAYS_MS = [1000, 3000, 9000]

export type SlackMessageEvent = {
	type?: string
	subtype?: string
	bot_id?: string
	user?: string
	channel?: string
	channel_type?: string
	team?: string
	text?: string
	hidden?: boolean
	client_msg_id?: string
	ts?: string
	files?: SlackFile[]
}

export type Inbound = {
	author_id: string
	display_name: string
	channel_id: string
	team_id: string | null
	is_im: boolean
	text: string
	message_id?: string
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function pokeDaemon(config: Config): void {
	try {
		const pollScript = join(config.DAEMON_HOME, 'poll.sh')
		spawn(pollScript, [], { detached: true, stdio: 'ignore' }).unref()
	} catch (err) {
		log(`warn: failed to spawn poll.sh: ${String(err)}`)
	}
}

function isIm(event: SlackMessageEvent): boolean {
	if (event.channel_type === 'im') return true
	return typeof event.channel === 'string' && event.channel.startsWith('D')
}

// Plain user messages and file uploads (subtype file_share) are forwarded.
// Every other subtype (message_changed, message_deleted, bot_message,
// channel_join, ...) and anything from a bot is ignored.
export function isForwardable(event: SlackMessageEvent): boolean {
	if (event.type !== 'message' || event.bot_id || event.hidden) return false
	if (event.subtype && event.subtype !== 'file_share') return false
	return Boolean(event.text) || (event.files?.length ?? 0) > 0
}

// The caption (if any) followed by one line per uploaded file, saved under
// <DAEMON_HOME>/media like wa-bridge's inbound media.
export async function inboundText(config: Config, event: SlackMessageEvent): Promise<string> {
	const lines = event.text ? [event.text] : []
	for (const file of event.files ?? []) {
		const saved = await saveSlackFile(file, config.SLACK_BOT_TOKEN, join(config.DAEMON_HOME, 'media'))
		log(saved.path ? `saved slack file -> ${saved.path}` : `slack file not saved: ${saved.error}`)
		lines.push(saved.line)
	}
	return lines.join('\n')
}

// The Worker dedupes on message_id, so a retried POST of the same Slack message
// is enqueued once. client_msg_id is Slack's per-message id; ts is unique per
// channel and covers messages without one.
export function buildInbound(
	event: SlackMessageEvent & { user: string; channel: string; text: string },
	displayName: string,
	teamId: string | null,
): Inbound {
	return {
		author_id: event.user,
		display_name: displayName,
		channel_id: event.channel,
		team_id: teamId,
		is_im: isIm(event),
		text: event.text,
		message_id: event.client_msg_id || event.ts,
	}
}

export async function forwardToWorker(config: Config, msg: Inbound): Promise<void> {
	const url = `${config.FERMI_URL}/sl/webhook`
	const body = JSON.stringify(msg)
	for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-sl-bridge-secret': config.SLACK_BRIDGE_SECRET,
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
		`DROPPED inbound message from ${msg.author_id} (channel ${msg.channel_id}) after ${RETRY_DELAYS_MS.length + 1} attempts`,
	)
}
