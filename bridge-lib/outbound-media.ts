// Shared by wa-bridge / dc-bridge / sl-bridge: the outbox message shape, the
// local-path guardrail for outbound attachments, and a generic poll loop.
// Imported by relative path (`../../bridge-lib/outbound-media.ts`); Node strips
// the types at load time, so there is no build step.
import { lookup as dnsLookup } from 'node:dns/promises'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { BlockList, isIP } from 'node:net'
import { basename, extname, join, sep } from 'node:path'

export type MediaKind = 'image' | 'document' | 'audio' | 'video'
const MEDIA_KINDS: readonly string[] = ['image', 'document', 'audio', 'video']

export type OutboundMedia = {
	kind: MediaKind
	path?: string
	url?: string
	mimetype?: string
	caption?: string
	file_name?: string
}

export type OutboxMessage = {
	id: string
	chat_id: string
	body: string
	created_at: number
	media?: OutboundMedia | null
}

/** Only files under ~/fermi-daemon/media/out are ever sent from local disk. */
export const MEDIA_OUT_SUBDIR = join('media', 'out')

export function mediaOutDir(daemonHome: string): string {
	return join(daemonHome, MEDIA_OUT_SUBDIR)
}

export function ensureMediaOutDir(daemonHome: string): string {
	const dir = mediaOutDir(daemonHome)
	mkdirSync(dir, { recursive: true })
	return dir
}

/** The attachment can never be sent (bad path, too big, …): report, don't retry. */
export class MediaRejected extends Error {}

const EXT_MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	aac: 'audio/aac',
	pdf: 'application/pdf',
	csv: 'text/csv',
	txt: 'text/plain',
	md: 'text/markdown',
	json: 'application/json',
	zip: 'application/zip',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

const KIND_FALLBACK: Record<MediaKind, string> = {
	image: 'image/jpeg',
	video: 'video/mp4',
	audio: 'audio/mp4',
	document: 'application/octet-stream',
}

export function inferMimetype(name: string, kind: MediaKind): string {
	const ext = extname(name).slice(1).toLowerCase()
	return EXT_MIME[ext] ?? KIND_FALLBACK[kind]
}

export type LocalMedia = { path: string; size: number; mimetype: string; fileName: string }

/**
 * Resolve a local attachment path and enforce the allowlist: the real path
 * (symlinks followed) must be a regular file inside media/out and under the
 * size cap. Throws MediaRejected with a user-readable reason.
 */
export function resolveLocalMedia(media: OutboundMedia, daemonHome: string, maxBytes: number): LocalMedia {
	const raw = media.path
	if (!raw) throw new MediaRejected('no local path')
	const outDir = ensureMediaOutDir(daemonHome)
	let real: string
	let realOut: string
	try {
		real = realpathSync(raw)
		realOut = realpathSync(outDir)
	} catch {
		throw new MediaRejected(`file not found: ${raw}`)
	}
	if (!real.startsWith(realOut + sep)) {
		throw new MediaRejected(`path is outside ${outDir}: ${raw}`)
	}
	const st = statSync(real)
	if (!st.isFile()) throw new MediaRejected(`not a regular file: ${raw}`)
	if (st.size === 0) throw new MediaRejected(`file is empty: ${raw}`)
	if (st.size > maxBytes) {
		throw new MediaRejected(`file is ${Math.round(st.size / 1_048_576)} MB; limit is ${Math.round(maxBytes / 1_048_576)} MB`)
	}
	const fileName = media.file_name ?? basename(real)
	return { path: real, size: st.size, mimetype: media.mimetype ?? inferMimetype(fileName, media.kind), fileName }
}

/**
 * A media.url from the cloud payload must be a plain https:// URL. Rejects file://,
 * data:, http:// (incl. localhost), bare paths and URLs with userinfo. Returns the
 * normalized href so the transport never sees a string it would treat as a path.
 */
export function assertHttpsMediaUrl(raw: string): string {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new MediaRejected(`media url must be https://: ${raw}`)
	}
	if (url.protocol !== 'https:') throw new MediaRejected(`media url must be https://: ${url.protocol}`)
	if (url.username || url.password) throw new MediaRejected('media url must not contain credentials')
	return url.href
}

export type RemoteMedia ={ buffer: Buffer; mimetype: string; fileName: string }

// Destinations a remote attachment URL may never reach: loopback, private,
// link-local (incl. the 169.254.169.254 cloud metadata endpoint), CGNAT,
// unspecified, multicast and reserved, for v4 and v6. BlockList also matches
// IPv4-mapped v6 (::ffff:127.0.0.1) against the v4 rules.
const BLOCKED = new BlockList()
for (const [net, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const) {
	BLOCKED.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
	['::', 128],
	['::1', 128],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
] as const) {
	BLOCKED.addSubnet(net, prefix, 'ipv6')
}

/** True for an IP literal that outbound media must not be fetched from. */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address)
	if (family === 0) return true
	return BLOCKED.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

export type LookupAll = (hostname: string) => Promise<string[]>

const systemLookup: LookupAll = async (hostname) =>
	(await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address)

export type RemoteFetchOptions = {
	/** Resolve a hostname to all of its addresses (default: the system resolver). */
	lookup?: LookupAll
	fetch?: typeof fetch
	/** Whole download, redirects included. */
	timeoutMs?: number
	maxRedirects?: number
}

export const REMOTE_MEDIA_TIMEOUT_MS = 60_000
export const REMOTE_MEDIA_MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Reject a URL unless it is http(s) and every address its host resolves to is
 * public. This is a precheck: fetch() resolves the name again when it
 * connects, so a DNS-rebinding server with a near-zero TTL can still swap in a
 * private address between the two lookups. Rejecting when ANY record is
 * private and re-checking every redirect hop narrows that window; closing it
 * needs connection-level pinning, which global fetch does not expose.
 */
async function assertPublicUrl(raw: string, lookup: LookupAll): Promise<URL> {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new MediaRejected(`invalid url: ${raw}`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new MediaRejected(`unsupported url scheme ${url.protocol} ${raw}`)
	}
	const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
	let addresses: string[]
	if (isIP(host)) {
		addresses = [host]
	} else {
		try {
			addresses = await lookup(host)
		} catch {
			throw new MediaRejected(`cannot resolve host ${host}`)
		}
	}
	if (addresses.length === 0) throw new MediaRejected(`cannot resolve host ${host}`)
	const blocked = addresses.find(isBlockedAddress)
	if (blocked) throw new MediaRejected(`url resolves to a private address (${blocked}): ${raw}`)
	return url
}

function tooLarge(bytes: number): MediaRejected {
	return new MediaRejected(`remote file is too large (${Math.round(bytes / 1_048_576)} MB)`)
}

/**
 * Download a remote attachment into memory. Every hop (max 3 redirects) must
 * resolve to a public address; the body is streamed and aborted as soon as it
 * passes maxBytes; the whole download is bounded by timeoutMs.
 */
export async function fetchRemoteMedia(media: OutboundMedia, maxBytes: number, opts: RemoteFetchOptions = {}): Promise<RemoteMedia> {
	const url = media.url
	if (!url) throw new MediaRejected('no url')
	const lookup = opts.lookup ?? systemLookup
	const doFetch = opts.fetch ?? fetch
	const maxRedirects = opts.maxRedirects ?? REMOTE_MEDIA_MAX_REDIRECTS
	const timeoutMs = opts.timeoutMs ?? REMOTE_MEDIA_TIMEOUT_MS
	const signal = AbortSignal.timeout(timeoutMs)
	try {
		let current = await assertPublicUrl(url, lookup)
		let res: Response
		for (let hop = 0; ; hop++) {
			res = await doFetch(current, { redirect: 'manual', signal })
			if (!REDIRECT_STATUSES.has(res.status)) break
			await res.body?.cancel()
			const location = res.headers.get('location')
			if (!location) throw new MediaRejected(`download failed (${res.status} without location): ${url}`)
			if (hop >= maxRedirects) throw new MediaRejected(`too many redirects (> ${maxRedirects}): ${url}`)
			current = await assertPublicUrl(new URL(location, current).href, lookup)
		}
		if (!res.ok) throw new MediaRejected(`download failed (${res.status}): ${url}`)
		const declared = Number(res.headers.get('content-length') ?? '0')
		if (declared > maxBytes) {
			await res.body?.cancel()
			throw tooLarge(declared)
		}
		const chunks: Uint8Array[] = []
		let total = 0
		if (res.body) {
			const reader = res.body.getReader()
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				total += value.byteLength
				if (total > maxBytes) {
					await reader.cancel()
					throw tooLarge(total)
				}
				chunks.push(value)
			}
		}
		const buffer = Buffer.concat(chunks, total)
		if (buffer.length === 0) throw new MediaRejected(`remote file is empty: ${url}`)
		const fileName = media.file_name ?? remoteFileName(url, media.kind)
		const header = res.headers.get('content-type')?.split(';')[0].trim()
		const mimetype = media.mimetype ?? (header && header !== 'application/octet-stream' ? header : inferMimetype(fileName, media.kind))
		return { buffer, mimetype, fileName }
	} catch (err) {
		// A timeout is transient like any network error: retried, not rejected.
		if (signal.aborted && !(err instanceof MediaRejected)) throw new Error(`download timed out after ${timeoutMs} ms: ${url}`)
		throw err
	}
}

export function remoteFileName(url: string, kind: MediaKind): string {
	let name = ''
	try {
		name = basename(new URL(url).pathname)
	} catch {}
	if (name && extname(name)) return name
	const ext = Object.entries(EXT_MIME).find(([, m]) => m === KIND_FALLBACK[kind])?.[0] ?? 'bin'
	return `${name || kind}.${ext}`
}

/** Caption shown with the attachment: media.caption, else the body. */
export function captionFor(msg: OutboxMessage): string | undefined {
	const caption = msg.media?.caption ?? msg.body
	return caption === '' ? undefined : caption
}

/** Validate the worker's outbox JSON; rows with an unusable media block are kept but media-less. */
export function parseOutboxMessages(data: unknown): OutboxMessage[] {
	const list = (data as { messages?: unknown })?.messages
	if (!Array.isArray(list)) return []
	const out: OutboxMessage[] = []
	for (const row of list) {
		if (!row || typeof row !== 'object') continue
		const r = row as Record<string, unknown>
		if (typeof r.id !== 'string' || typeof r.chat_id !== 'string' || typeof r.body !== 'string') continue
		const msg: OutboxMessage = {
			id: r.id,
			chat_id: r.chat_id,
			body: r.body,
			created_at: typeof r.created_at === 'number' ? r.created_at : Date.now(),
			media: null,
		}
		const m = r.media
		if (m && typeof m === 'object') {
			const mm = m as Record<string, unknown>
			const hasSource = typeof mm.path === 'string' || typeof mm.url === 'string'
			if (typeof mm.kind === 'string' && MEDIA_KINDS.includes(mm.kind) && hasSource) {
				msg.media = {
					kind: mm.kind as MediaKind,
					...(typeof mm.path === 'string' ? { path: mm.path } : {}),
					...(typeof mm.url === 'string' ? { url: mm.url } : {}),
					...(typeof mm.mimetype === 'string' ? { mimetype: mm.mimetype } : {}),
					...(typeof mm.caption === 'string' ? { caption: mm.caption } : {}),
					...(typeof mm.file_name === 'string' ? { file_name: mm.file_name } : {}),
				}
			}
		}
		out.push(msg)
	}
	return out
}

export async function fetchOutbox(fermiUrl: string, token: string, channel: string): Promise<OutboxMessage[]> {
	const res = await fetch(`${fermiUrl}/${channel}/outbox`, { headers: { authorization: `Bearer ${token}` } })
	if (!res.ok) throw new Error(`outbox fetch non-2xx: ${res.status}`)
	return parseOutboxMessages(await res.json())
}

export async function ackOutbox(fermiUrl: string, token: string, channel: string, ids: string[]): Promise<void> {
	const res = await fetch(`${fermiUrl}/${channel}/outbox/ack`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({ ids }),
	})
	if (!res.ok) throw new Error(`ack non-2xx: ${res.status}`)
}

/** Give up on a message after this many failed delivery attempts (in-memory). */
export const MAX_SEND_ATTEMPTS = 3

export class SendAttempts {
	private counts = new Map<string, number>()
	/** Record a failure; true when the message should be abandoned. */
	fail(id: string, err: unknown): boolean {
		if (err instanceof MediaRejected) return true
		const n = (this.counts.get(id) ?? 0) + 1
		this.counts.set(id, n)
		return n >= MAX_SEND_ATTEMPTS
	}
	clear(id: string): void {
		this.counts.delete(id)
	}
}

export function failureNotice(err: unknown): string {
	const reason = err instanceof Error ? err.message : String(err)
	return `⚠️ Couldn't send the attachment: ${reason}`
}

export type OutboxLoopOptions = {
	fermiUrl: string
	token: string
	channel: 'wa' | 'dc' | 'sl'
	pollMs: number
	log: (line: string) => void
	/** False while the transport is not connected; the loop just waits. */
	ready: () => boolean
	/** Deliver one message. Throw to retry on the next poll (MediaRejected = give up now). */
	send: (msg: OutboxMessage) => Promise<void>
	/** Tell the chat an attachment was abandoned. Best-effort. */
	notifyFailure: (msg: OutboxMessage, err: unknown) => Promise<void>
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Sequential poll → send → ack loop shared by dc-bridge and sl-bridge. */
export async function runOutboxLoop(opts: OutboxLoopOptions): Promise<void> {
	const attempts = new SendAttempts()
	while (true) {
		if (!opts.ready()) {
			await sleep(opts.pollMs)
			continue
		}
		let messages: OutboxMessage[]
		try {
			messages = await fetchOutbox(opts.fermiUrl, opts.token, opts.channel)
		} catch (err) {
			opts.log(`outbox fetch error: ${String(err)}`)
			await sleep(opts.pollMs)
			continue
		}
		for (const msg of messages) {
			if (!opts.ready()) break
			try {
				await opts.send(msg)
				attempts.clear(msg.id)
			} catch (err) {
				opts.log(`send failed for message ${msg.id} (chat ${msg.chat_id}): ${String(err)}`)
				if (!attempts.fail(msg.id, err)) continue
				attempts.clear(msg.id)
				await opts.notifyFailure(msg, err).catch((e) => opts.log(`failure notice failed: ${String(e)}`))
			}
			// Ack per-message: a crash between send and ack may re-send this one.
			await ackOutbox(opts.fermiUrl, opts.token, opts.channel, [msg.id]).catch((e) =>
				opts.log(`ack error for ${msg.id}: ${String(e)}`),
			)
		}
		await sleep(opts.pollMs)
	}
}
