import { digitsOf, type Member } from './mentions.ts'

const MAX_QUOTE = 300

// Text of a quoted message, or a placeholder for media without a caption.
function quotedText(q: any): string | null {
	const m = q?.ephemeralMessage?.message ?? q?.viewOnceMessage?.message ?? q?.viewOnceMessageV2?.message ?? q
	if (!m) return null
	const text =
		m.conversation ??
		m.extendedTextMessage?.text ??
		m.imageMessage?.caption ??
		m.videoMessage?.caption ??
		m.documentMessage?.caption
	if (text) return text
	if (m.imageMessage) return '[image]'
	if (m.videoMessage) return '[video]'
	if (m.audioMessage) return '[audio]'
	if (m.documentMessage) return `[document${m.documentMessage.fileName ? `: ${m.documentMessage.fileName}` : ''}]`
	if (m.stickerMessage) return '[sticker]'
	return null
}

// "[replying to Name: "…"]" for a reply, or null when the message quotes nothing.
// selfIds are the bot's own jids, so quotes of the bot's messages read "Fermi".
export function quotePrefix(contextInfo: any, members: Member[], selfIds: string[]): string | null {
	const text = quotedText(contextInfo?.quotedMessage)
	if (!text) return null
	const who = typeof contextInfo.participant === 'string' ? contextInfo.participant : ''
	const d = who ? digitsOf(who) : ''
	let name: string | undefined
	if (d && selfIds.some((id) => digitsOf(id) === d)) name = 'Fermi'
	else if (d) {
		const m = members.find((x) => (x.pn && digitsOf(x.pn) === d) || (x.lid && digitsOf(x.lid) === d))
		name = m?.names[0] ?? (who.endsWith('@s.whatsapp.net') ? d : undefined)
	}
	const flat = text.replace(/\s+/g, ' ').trim()
	const clipped = flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE)}…` : flat
	return `[replying to ${name ?? 'someone'}: "${clipped}"]`
}
