import type { AnyMessageContent } from 'baileys'
import {
	type OutboundMedia,
	type OutboxMessage,
	captionFor,
	inferMimetype,
	remoteFileName,
	resolveLocalMedia,
} from '../../bridge-lib/outbound-media.ts'

// WhatsApp rejects large uploads; keep well under the 100 MB document cap.
export const WA_MAX_MEDIA_BYTES = 64 * 1024 * 1024

/**
 * Build the Baileys content for an outbox attachment. Local paths are
 * allowlist-checked (media/out only); URLs are handed to Baileys to fetch.
 * Audio has no caption on WhatsApp — the caller sends it as a follow-up text.
 */
export function buildWaMediaContent(
	msg: OutboxMessage,
	daemonHome: string,
): { content: AnyMessageContent; followUpText?: string } {
	const media = msg.media as OutboundMedia
	const caption = captionFor(msg)
	let source: { url: string }
	let mimetype: string
	let fileName: string
	if (media.path) {
		const local = resolveLocalMedia(media, daemonHome, WA_MAX_MEDIA_BYTES)
		source = { url: local.path }
		mimetype = local.mimetype
		fileName = local.fileName
	} else {
		const url = media.url as string
		source = { url }
		fileName = media.file_name ?? remoteFileName(url, media.kind)
		mimetype = media.mimetype ?? inferMimetype(fileName, media.kind)
	}

	switch (media.kind) {
		case 'image':
			return { content: { image: source, caption, mimetype } }
		case 'video':
			return { content: { video: source, caption, mimetype } }
		case 'audio':
			return { content: { audio: source, mimetype, ptt: false }, followUpText: caption }
		default:
			return { content: { document: source, mimetype, fileName, caption } }
	}
}
