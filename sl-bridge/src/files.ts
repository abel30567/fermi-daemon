import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Inbound Slack file uploads. Files are saved to ~/fermi-daemon/media and
// described with the same `[<kind> attachment saved to <path>; ...]` line as
// wa-bridge, so the worker sees one format for every channel.

// Keep in line with wa-bridge's outbound cap.
export const SL_MAX_MEDIA_BYTES = 64 * 1024 * 1024
const MAX_REDIRECTS = 3

export type SlackFile = {
	id?: string
	name?: string
	title?: string
	mimetype?: string
	size?: number
	url_private_download?: string
}

type Kind = 'image' | 'video' | 'audio' | 'document'

function kindOf(mimetype: string | undefined): Kind {
	const top = mimetype?.split('/')[0]
	return top === 'image' || top === 'video' || top === 'audio' ? top : 'document'
}

// Same character set as wa-bridge's sanitizeName, plus no leading dots so a
// name can never be `.` or `..`.
function sanitizeName(name: string): string {
	return name.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'
}

// Only https on slack.com hosts may receive the bot token.
function isSlackUrl(raw: string): boolean {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return false
	}
	return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
}

// Errors carry a short reason only: never the download URL or the token.
async function download(rawUrl: string, token: string, maxBytes: number): Promise<Buffer> {
	let url = rawUrl
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!isSlackUrl(url)) throw new Error('download host is not https on slack.com')
		const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' })
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get('location')
			if (!location) throw new Error(`redirect ${res.status} without location`)
			url = new URL(location, url).toString()
			continue
		}
		if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
		// Slack answers a token without files:read with its HTML login page.
		if (res.headers.get('content-type')?.startsWith('text/html')) {
			throw new Error('got an HTML page instead of the file (is the files:read scope granted?)')
		}
		const declared = Number(res.headers.get('content-length'))
		if (declared > maxBytes) throw new Error(`file is over the ${maxBytes} byte limit`)
		const chunks: Buffer[] = []
		let total = 0
		for await (const chunk of res.body) {
			total += chunk.length
			if (total > maxBytes) throw new Error(`file is over the ${maxBytes} byte limit`)
			chunks.push(Buffer.from(chunk))
		}
		return Buffer.concat(chunks)
	}
	throw new Error('too many redirects')
}

// Download one file and return the line to append to the forwarded text.
// Failures and oversize files become a note line instead of throwing.
export async function saveSlackFile(
	file: SlackFile,
	token: string,
	mediaDir: string,
	maxBytes = SL_MAX_MEDIA_BYTES,
): Promise<{ line: string; path?: string; error?: string }> {
	const kind = kindOf(file.mimetype)
	const name = file.name || file.title
	const details = `${name ? `; original name: ${name}` : ''}${file.mimetype ? `; type: ${file.mimetype}` : ''}`
	if (typeof file.size === 'number' && file.size > maxBytes) {
		const error = `${file.size} bytes is over the ${maxBytes} byte limit`
		return { line: `[${kind} attachment skipped: ${error}${details}]`, error }
	}
	try {
		if (!file.url_private_download) throw new Error('no download URL on the file')
		const buf = await download(file.url_private_download, token, maxBytes)
		mkdirSync(mediaDir, { recursive: true })
		const path = join(mediaDir, `${Date.now()}-${sanitizeName(name || `${kind}-${file.id ?? 'file'}`)}`)
		writeFileSync(path, buf)
		return { line: `[${kind} attachment saved to ${path}${details}]`, path }
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		return { line: `[${kind} attachment received but could not be downloaded: ${error}${details}]`, error }
	}
}
