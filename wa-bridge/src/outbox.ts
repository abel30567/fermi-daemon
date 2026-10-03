import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { log, logDebug } from './log.ts'
import { chunkText, type JidMode, type MentionDirectory, mentionsIn } from './mentions.ts'
import type { SocketState } from './socket.ts'

type OutboxMessage = {
	id: string
	chat_id: string
	body: string
	created_at: number
}

type WASocket = NonNullable<ReturnType<SocketState['currentSocket']>>

const MAX_CHUNK = 4000
const METADATA_TTL_MS = 10 * 60 * 1000
// Local spool written by `npm run mention-test`; drained by the running bridge.
export const TEST_QUEUE_FILE = 'mention-test-queue.jsonl'

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ack(config: Config, ids: string[]): Promise<void> {
	try {
		const res = await fetch(`${config.FERMI_URL}/wa/outbox/ack`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${config.FERMI_BEARER_TOKEN}`,
			},
			body: JSON.stringify({ ids }),
		})
		if (!res.ok) log(`ack non-2xx for ${ids.join(',')}: ${res.status}`)
	} catch (err) {
		log(`ack network error for ${ids.join(',')}: ${String(err)}`)
	}
}

// Pull the participant list into the directory (names + LID/phone pairs) and
// report which jid family the group is addressed with. Cached per group.
const metadataCache = new Map<string, { at: number; mode: JidMode }>()
async function syncGroup(sock: WASocket, jid: string, directory: MentionDirectory): Promise<JidMode> {
	const cached = metadataCache.get(jid)
	if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.mode
	try {
		const meta = await sock.groupMetadata(jid)
		for (const p of meta.participants) {
			const ids = [p.id, p.lid, p.phoneNumber].filter((x): x is string => typeof x === 'string')
			directory.record(jid, {
				pn: ids.find((x) => x.endsWith('@s.whatsapp.net')),
				lid: ids.find((x) => x.endsWith('@lid')),
				name: p.notify ?? p.name,
			})
		}
		const mode: JidMode = meta.addressingMode === 'pn' ? 'pn' : 'lid'
		metadataCache.set(jid, { at: Date.now(), mode })
		logDebug(`group ${jid} addressingMode=${meta.addressingMode ?? 'unknown'} participants=${meta.participants.length}`)
		return mode
	} catch (err) {
		log(`groupMetadata failed for ${jid}: ${String(err)}`)
		return cached?.mode ?? 'lid'
	}
}

// Send one body to a chat, turning "@Nombre" into real mentions for groups.
async function sendBody(
	config: Config,
	sock: WASocket,
	directory: MentionDirectory,
	jid: string,
	body: string,
): Promise<void> {
	let text = body
	let mentions: string[] = []
	if (jid.endsWith('@g.us') && body.includes('@')) {
		const groupMode = await syncGroup(sock, jid, directory)
		const mode = config.MENTION_JID_MODE === 'auto' ? groupMode : config.MENTION_JID_MODE
		const r = directory.resolve(jid, body, mode)
		text = r.text
		mentions = r.mentions
	}
	for (const chunk of chunkText(text, MAX_CHUNK)) {
		// Human-like pacing between chunks to reduce ban risk.
		await sleep(2000 + Math.random() * 3000)
		const chunkMentions = mentionsIn(chunk, mentions)
		await sock.sendMessage(jid, chunkMentions.length ? { text: chunk, mentions: chunkMentions } : { text: chunk })
	}
}

// Group chat_ids arrive as full jids (contain '@g.us'); DMs are bare numbers.
function toJid(chatId: string): string {
	return chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
}

async function drainTestQueue(config: Config, sock: WASocket, directory: MentionDirectory): Promise<void> {
	const path = join(config.STATE_DIR, TEST_QUEUE_FILE)
	if (!existsSync(path)) return
	const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
	if (lines.length === 0) return
	writeFileSync(path, '')
	for (const line of lines) {
		try {
			const { jid, text } = JSON.parse(line) as { jid: string; text: string }
			log(`mention-test: sending to ${jid}`)
			await sendBody(config, sock, directory, toJid(jid), text)
		} catch (err) {
			log(`mention-test send failed: ${String(err)}`)
		}
	}
}

// Sequential loop — never overlaps a cycle with the previous one.
export async function runOutboxLoop(
	config: Config,
	socketState: SocketState,
	directory: MentionDirectory,
): Promise<void> {
	const outboxUrl = `${config.FERMI_URL}/wa/outbox`
	while (true) {
		if (!socketState.isOpen()) {
			await sleep(config.POLL_MS)
			continue
		}

		const testSock = socketState.currentSocket()
		if (testSock) await drainTestQueue(config, testSock, directory)

		let messages: OutboxMessage[]
		try {
			const res = await fetch(outboxUrl, {
				headers: { authorization: `Bearer ${config.FERMI_BEARER_TOKEN}` },
			})
			if (!res.ok) {
				log(`outbox fetch non-2xx: ${res.status}`)
				await sleep(config.POLL_MS)
				continue
			}
			const data = (await res.json()) as { messages?: OutboxMessage[] }
			messages = data.messages ?? []
		} catch (err) {
			log(`outbox fetch error: ${String(err)}`)
			await sleep(config.POLL_MS)
			continue
		}

		for (const msg of messages) {
			const sock = socketState.currentSocket()
			if (!sock || !socketState.isOpen()) break
			try {
				await sendBody(config, sock, directory, toJid(msg.chat_id), msg.body)
			} catch (err) {
				log(`send failed for message ${msg.id} (chat ${msg.chat_id}): ${String(err)}`)
				continue
			}
			// Ack per-message: a crash between send and ack may re-send this one.
			await ack(config, [msg.id])
		}

		await sleep(config.POLL_MS)
	}
}
