import { AttachmentBuilder, type Client } from 'discord.js'
import {
	type OutboxMessage,
	captionFor,
	ensureMediaOutDir,
	failureNotice,
	remoteFileName,
	resolveLocalMedia,
	runOutboxLoop,
} from '../../bridge-lib/outbound-media.ts'
import type { Config } from './config.ts'
import { log } from './log.ts'

// Discord's upload limit for bots without boosts.
export const DC_MAX_MEDIA_BYTES = 10 * 1024 * 1024
const DC_MAX_CONTENT = 2000

export type DiscordSend = { content?: string; files?: AttachmentBuilder[] }

/** Build the channel.send() payload for an outbox row (text or attachment). */
export function buildDiscordSend(msg: OutboxMessage, daemonHome: string): DiscordSend {
	const media = msg.media
	if (!media) return { content: msg.body.slice(0, DC_MAX_CONTENT) }
	const caption = captionFor(msg)?.slice(0, DC_MAX_CONTENT)
	let source: string
	let name: string
	if (media.path) {
		const local = resolveLocalMedia(media, daemonHome, DC_MAX_MEDIA_BYTES)
		source = local.path
		name = local.fileName
	} else {
		source = media.url as string
		name = media.file_name ?? remoteFileName(source, media.kind)
	}
	// discord.js resolves a path or URL string into the multipart upload.
	const file = new AttachmentBuilder(source, { name })
	return { content: caption, files: [file] }
}

async function sendToChannel(client: Client, chatId: string, payload: DiscordSend): Promise<void> {
	const channel = await client.channels.fetch(chatId)
	if (!channel || !channel.isSendable()) throw new Error(`channel ${chatId} is not sendable`)
	await channel.send(payload)
}

/** Poll /dc/outbox for rows the worker could not send itself (attachments). */
export function startOutboxLoop(config: Config, client: Client): void {
	ensureMediaOutDir(config.DAEMON_HOME)
	runOutboxLoop({
		fermiUrl: config.FERMI_URL,
		token: config.FERMI_BEARER_TOKEN,
		channel: 'dc',
		pollMs: config.POLL_MS,
		log,
		ready: () => client.isReady(),
		send: (msg) => sendToChannel(client, msg.chat_id, buildDiscordSend(msg, config.DAEMON_HOME)),
		notifyFailure: (msg, err) => sendToChannel(client, msg.chat_id, { content: failureNotice(err) }),
	}).catch((err) => {
		log(`FATAL outbox loop: ${String(err)}`)
		process.exit(1)
	})
}
