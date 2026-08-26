import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DisconnectReason, downloadMediaMessage, makeWASocket, useMultiFileAuthState } from 'baileys'
import pino from 'pino'
import qrcodeTerminal from 'qrcode-terminal'
import type { Config } from './config.ts'
import { log } from './log.ts'

type WASocket = ReturnType<typeof makeWASocket>

// --- media attachment handling ----------------------------------------------
const MIME_EXT: Record<string, string> = {
	'audio/ogg': 'ogg',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/aac': 'aac',
	'audio/amr': 'amr',
	'audio/wav': 'wav',
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'video/mp4': 'mp4',
	'application/pdf': 'pdf',
}

type MediaInfo = {
	kind: 'audio' | 'image' | 'video' | 'document'
	label: string
	mimetype?: string | null
	fileName?: string | null
	caption?: string | null
}

// Unwrap the common envelopes so a media message nested in ephemeral/view-once
// is still detected.
function innerMessage(msg: any): any {
	return (
		msg?.ephemeralMessage?.message ??
		msg?.viewOnceMessage?.message ??
		msg?.viewOnceMessageV2?.message ??
		msg?.documentWithCaptionMessage?.message ??
		msg
	)
}

function extractMedia(msg: any): MediaInfo | null {
	const m = innerMessage(msg)
	if (m?.audioMessage) {
		return {
			kind: 'audio',
			label: m.audioMessage.ptt ? 'voice note' : 'audio',
			mimetype: m.audioMessage.mimetype,
		}
	}
	if (m?.imageMessage) {
		return { kind: 'image', label: 'image', mimetype: m.imageMessage.mimetype, caption: m.imageMessage.caption }
	}
	if (m?.videoMessage) {
		return { kind: 'video', label: 'video', mimetype: m.videoMessage.mimetype, caption: m.videoMessage.caption }
	}
	if (m?.documentMessage) {
		return {
			kind: 'document',
			label: 'document',
			mimetype: m.documentMessage.mimetype,
			fileName: m.documentMessage.fileName,
			caption: m.documentMessage.caption,
		}
	}
	return null
}

function mimeToExt(mime: string | null | undefined, kind: string): string {
	if (mime) {
		const base = mime.split(';')[0].trim()
		if (MIME_EXT[base]) return MIME_EXT[base]
		const sub = base.split('/')[1]
		if (sub) return sub.replace(/[^a-z0-9]/gi, '')
	}
	return kind === 'audio' ? 'ogg' : kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'bin'
}

function sanitizeName(name: string): string {
	return name.replace(/[^\w.\-]+/g, '_').slice(0, 120)
}

function describeMedia(media: MediaInfo, path: string): string {
	let s = `[${media.label} attachment saved to ${path}`
	if (media.fileName) s += `; original name: ${media.fileName}`
	if (media.mimetype) s += `; type: ${media.mimetype}`
	s += ']'
	if (media.caption) s += ` Caption: ${media.caption}`
	return s
}

// Resolve the phone-number sender and the reply chatId (group jid or DM number)
// for an inbound message, or null if the sender can't be resolved.
function resolveSender(m: any, jid: string): { sender: string; chatId: string } | null {
	if (jid.endsWith('@g.us')) {
		const key = m.key as { participant?: string; participantAlt?: string }
		const { participant, participantAlt } = key
		let sender: string | null = null
		if (participant?.endsWith('@s.whatsapp.net')) sender = participant.split('@')[0]
		else if (participant?.endsWith('@lid') && participantAlt?.endsWith('@s.whatsapp.net'))
			sender = participantAlt.split('@')[0]
		if (!sender) return null
		return { sender, chatId: jid }
	}
	let phoneJid: string | null = null
	if (jid.endsWith('@s.whatsapp.net')) phoneJid = jid
	else if (jid.endsWith('@lid')) {
		const key = m.key as { senderPn?: string; remoteJidAlt?: string }
		const alt = key.senderPn ?? key.remoteJidAlt
		if (alt?.endsWith('@s.whatsapp.net')) phoneJid = alt
	}
	if (!phoneJid) return null
	const sender = phoneJid.split('@')[0]
	return { sender, chatId: sender }
}

export type Handlers = {
	onTextMessage(sender: string, chatId: string, text: string): Promise<void>
}

// Read by the outbox loop so it only sends while the socket is live.
export type SocketState = {
	currentSocket(): WASocket | null
	isOpen(): boolean
}

const MAX_BACKOFF_MS = 60000
const INITIAL_BACKOFF_MS = 2000
const LOGGED_OUT_HELP = [
	'This device was logged out of WhatsApp (removed from Linked Devices, or logged out remotely).',
	'To recover:',
	'  1. Stop the LaunchAgent:  launchctl bootout gui/$UID/com.fermi.wa-bridge',
	'  2. Delete the auth dir:   rm -rf ~/fermi-daemon/wa-auth',
	'  3. Re-pair:               cd ~/fermi-daemon/wa-bridge && npm run pair -- <E164-digits>',
	'  4. Start the agent again: launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.fermi.wa-bridge.plist',
].join('\n')

function markerPath(config: Config): string {
	return join(config.AUTH_DIR, 'LOGGED_OUT')
}

function printPairingCode(code: string): void {
	const line = '='.repeat(48)
	console.log(`\n${line}`)
	console.log('  WHATSAPP PAIRING CODE (enter on your phone):')
	console.log('  WhatsApp > Settings > Linked Devices > Link a device')
	console.log('  > Link with phone number instead')
	console.log(`\n      ${code}\n`)
	console.log(`${line}\n`)
}

export async function createSocket(
	config: Config,
	handlers: Handlers,
	pairNumber?: string,
): Promise<SocketState> {
	if (existsSync(markerPath(config))) {
		log('refusing to start: LOGGED_OUT marker present.')
		log(LOGGED_OUT_HELP)
		process.exit(1)
	}

	mkdirSync(config.AUTH_DIR, { recursive: true, mode: 0o700 })
	const logger = pino({ level: 'silent' })

	let sock: WASocket | null = null
	let open = false
	let backoff = INITIAL_BACKOFF_MS
	let pairingRequested = false
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	async function start(): Promise<void> {
		if (reconnectTimer !== null) {
			clearTimeout(reconnectTimer)
			reconnectTimer = null
		}
		const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR)
		sock = makeWASocket({ auth: state, logger })
		open = false

		sock.ev.on('creds.update', saveCreds)

		const MEDIA_DIR = join(config.DAEMON_HOME, 'media')

		// Download an attachment to ~/fermi-daemon/media and return its local path.
		async function saveMedia(m: any, media: MediaInfo): Promise<string> {
			const buf = (await downloadMediaMessage(m, 'buffer', {}, {
				logger,
				reuploadRequest: sock!.updateMediaMessage,
			})) as Buffer
			mkdirSync(MEDIA_DIR, { recursive: true })
			const ext =
				media.fileName && media.fileName.includes('.')
					? media.fileName.split('.').pop()
					: mimeToExt(media.mimetype, media.kind)
			const base = media.fileName ? sanitizeName(media.fileName) : `${media.kind}-${Date.now()}.${ext}`
			const fpath = join(MEDIA_DIR, `${Date.now()}-${base}`)
			writeFileSync(fpath, buf)
			return fpath
		}

		async function handleInbound(m: any): Promise<void> {
			if (!m.message || m.key.fromMe) return
			const jid = m.key.remoteJid
			if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return
			const resolved = resolveSender(m, jid)
			if (!resolved) {
				log(`inbound skipped: jid=${jid} sender unresolved`)
				return
			}
			const { sender, chatId } = resolved
			const msg = m.message
			// A caption-bearing media message is still media (caption travels with it).
			const media = extractMedia(msg)
			if (media) {
				let forwardText: string
				try {
					const path = await saveMedia(m, media)
					log(`saved ${media.label} from ${sender} -> ${path}`)
					forwardText = describeMedia(media, path)
				} catch (err) {
					log(`media download failed (${media.label} from ${sender}): ${String(err)}`)
					forwardText = `[${media.label} attachment received but could not be downloaded: ${String(err)}]`
				}
				await handlers.onTextMessage(sender, chatId, forwardText)
				return
			}
			const text = msg.conversation ?? msg.extendedTextMessage?.text
			if (text) {
				await handlers.onTextMessage(sender, chatId, text)
				return
			}
			log(
				`inbound skipped: jid=${jid} resolved=${sender} hasText=false noMedia msgKeys=${Object.keys(msg).join(',')}`,
			)
		}

		sock.ev.on('messages.upsert', ({ messages, type }) => {
			if (type !== 'notify') return
			for (const m of messages) {
				handleInbound(m).catch((err) => log(`handleInbound error: ${String(err)}`))
			}
		})

		sock.ev.on('connection.update', (update) => {
			const { connection, lastDisconnect, qr } = update

			if (qr) {
				if (pairNumber && !pairingRequested) {
					pairingRequested = true
					sock
						?.requestPairingCode(pairNumber)
						.then((code) => printPairingCode(code))
						.catch((err) => log(`requestPairingCode failed: ${String(err)}`))
				} else if (pairNumber) {
					// Fallback: show the QR too in case pairing-code entry is unavailable.
					qrcodeTerminal.generate(qr, { small: true })
				} else {
					log(
						'received a QR/pairing request but no saved credentials — re-pair with `npm run pair -- <number>`.',
					)
				}
			}

			if (connection === 'open') {
				open = true
				backoff = INITIAL_BACKOFF_MS
				log(`connected as ${sock?.user?.id ?? 'unknown'} lid=${sock?.user?.lid ?? 'none'}`)
			} else if (connection === 'close') {
				open = false
				const statusCode = (
					lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
				)?.output?.statusCode

				if (statusCode === DisconnectReason.loggedOut) {
					log('logged out by WhatsApp — writing LOGGED_OUT marker and exiting.')
					try {
						writeFileSync(markerPath(config), `${LOGGED_OUT_HELP}\n`)
					} catch (err) {
						log(`failed to write LOGGED_OUT marker: ${String(err)}`)
					}
					process.exit(1)
				} else if (statusCode === DisconnectReason.restartRequired) {
					log('restart required (normal after pairing) — recreating socket.')
					start().catch((err) => log(`restart failed: ${String(err)}`))
				} else {
					log(
						`connection closed (status ${statusCode ?? 'unknown'}) — reconnecting in ${backoff}ms.`,
					)
					reconnectTimer = setTimeout(() => {
						start().catch((err) => log(`reconnect failed: ${String(err)}`))
					}, backoff)
					backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
				}
			}
		})
	}

	await start()
	return {
		currentSocket: () => sock,
		isOpen: () => open,
	}
}
