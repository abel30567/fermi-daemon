import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import type { WebClient } from '@slack/web-api'
import {
	type OutboxMessage,
	captionFor,
	ensureMediaOutDir,
	failureNotice,
	fetchRemoteMedia,
	resolveLocalMedia,
	runOutboxLoop,
} from '../../bridge-lib/outbound-media.ts'
import type { Config } from './config.ts'
import { log } from './log.ts'

// Keep uploads reasonable for a chat attachment; Slack allows up to 1 GB.
export const SL_MAX_MEDIA_BYTES = 100 * 1024 * 1024

export type SlackUpload = {
	channel_id: string
	file: Buffer | Readable
	filename: string
	initial_comment?: string
}

/** Build the files.uploadV2 arguments for an outbox attachment. */
export async function buildSlackUpload(msg: OutboxMessage, daemonHome: string): Promise<SlackUpload> {
	const media = msg.media
	if (!media) throw new Error('buildSlackUpload called without media')
	const initial_comment = captionFor(msg)
	if (media.path) {
		const local = resolveLocalMedia(media, daemonHome, SL_MAX_MEDIA_BYTES)
		return { channel_id: msg.chat_id, file: createReadStream(local.path), filename: local.fileName, initial_comment }
	}
	const remote = await fetchRemoteMedia(media, SL_MAX_MEDIA_BYTES)
	return { channel_id: msg.chat_id, file: remote.buffer, filename: remote.fileName, initial_comment }
}

async function send(web: WebClient, msg: OutboxMessage, daemonHome: string): Promise<void> {
	if (!msg.media) {
		await web.chat.postMessage({ channel: msg.chat_id, text: msg.body })
		return
	}
	const upload = await buildSlackUpload(msg, daemonHome)
	const res = await web.filesUploadV2(upload)
	if (!res.ok) throw new Error(`files.uploadV2 failed: ${res.error ?? 'unknown'}`)
}

/** Poll /sl/outbox for rows the worker could not send itself (attachments). */
export function startOutboxLoop(config: Config, web: WebClient, ready: () => boolean): void {
	ensureMediaOutDir(config.DAEMON_HOME)
	runOutboxLoop({
		fermiUrl: config.FERMI_URL,
		token: config.FERMI_BEARER_TOKEN,
		channel: 'sl',
		pollMs: config.POLL_MS,
		log,
		ready,
		send: (msg) => send(web, msg, config.DAEMON_HOME),
		notifyFailure: async (msg, err) => {
			await web.chat.postMessage({ channel: msg.chat_id, text: failureNotice(err) })
		},
	}).catch((err) => {
		log(`FATAL outbox loop: ${String(err)}`)
		process.exit(1)
	})
}
