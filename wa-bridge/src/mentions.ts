import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log, logDebug } from './log.ts'

// A group member as far as mentions are concerned: the jids we know for them
// (phone and/or LID) plus every display name we've seen them use.
export type Member = { pn?: string; lid?: string; names: string[] }

export type JidMode = 'lid' | 'pn'

export type MentionResult = {
	text: string
	mentions: string[]
	resolved: { token: string; jid: string }[]
	unresolved: string[]
}

export function digitsOf(jid: string): string {
	return jid.split('@')[0].split(':')[0]
}

// "Sebastián" -> "sebastian": lowercase, strip diacritics.
export function fold(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.trim()
}

// Tokens: "@Nombre" (letters/digits/_ with inner . ' -) or "@[Juan Pérez]".
// Not matched when glued to a preceding word char (e-mail addresses).
const TOKEN_RE = /(?<![\p{L}\p{N}_])@(?:\[([^\]\n]+)\]|([\p{L}\p{M}\p{N}_]+(?:[.'-][\p{L}\p{M}\p{N}_]+)*))/gu

export function parseTokens(text: string): { token: string; name: string; index: number }[] {
	const out: { token: string; name: string; index: number }[] = []
	for (const m of text.matchAll(TOKEN_RE)) {
		out.push({ token: m[0], name: (m[1] ?? m[2]).trim(), index: m.index })
	}
	return out
}

function pickJid(member: Member, mode: JidMode): string | undefined {
	return mode === 'lid' ? (member.lid ?? member.pn) : (member.pn ?? member.lid)
}

// Name -> member lookup: alias exact, alias folded, name exact, name folded,
// then a unique folded prefix across both. Returns undefined when ambiguous.
function findMember(name: string, members: Member[], aliases: Record<string, string>): Member | undefined {
	const byJid = (jid: string): Member => {
		const d = digitsOf(jid)
		return members.find((m) => (m.pn && digitsOf(m.pn) === d) || (m.lid && digitsOf(m.lid) === d)) ?? jidToMember(jid)
	}
	if (aliases[name]) return byJid(aliases[name])
	const folded = fold(name)
	for (const [alias, jid] of Object.entries(aliases)) if (fold(alias) === folded) return byJid(jid)

	let hit = members.find((m) => m.names.includes(name))
	if (hit) return hit
	hit = members.find((m) => m.names.some((n) => fold(n) === folded))
	if (hit) return hit

	if (/^\d+$/.test(name)) {
		hit = members.find((m) => (m.pn && digitsOf(m.pn) === name) || (m.lid && digitsOf(m.lid) === name))
		if (hit) return hit
	}

	const prefix = new Set<Member>()
	for (const [alias, jid] of Object.entries(aliases)) if (fold(alias).startsWith(folded)) prefix.add(byJid(jid))
	for (const m of members) if (m.names.some((n) => fold(n).startsWith(folded))) prefix.add(m)
	return prefix.size === 1 ? [...prefix][0] : undefined
}

function jidToMember(jid: string): Member {
	const full = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
	return full.endsWith('@lid') ? { lid: full, names: [] } : { pn: full, names: [] }
}

// Rewrite "@Nombre" tokens to "@<digits>" and collect the jids for `mentions`.
// Unresolvable tokens are left untouched.
export function resolveMentions(
	text: string,
	members: Member[],
	aliases: Record<string, string>,
	mode: JidMode,
): MentionResult {
	const tokens = parseTokens(text)
	const result: MentionResult = { text, mentions: [], resolved: [], unresolved: [] }
	if (tokens.length === 0) return result
	let out = ''
	let last = 0
	for (const t of tokens) {
		const member = findMember(t.name, members, aliases)
		const jid = member && pickJid(member, mode)
		out += text.slice(last, t.index)
		if (jid) {
			out += `@${digitsOf(jid)}`
			if (!result.mentions.includes(jid)) result.mentions.push(jid)
			result.resolved.push({ token: t.token, jid })
		} else {
			out += t.token
			result.unresolved.push(t.token)
		}
		last = t.index + t.token.length
	}
	result.text = out + text.slice(last)
	return result
}

// Split into chunks of at most `max` chars without cutting an "@digits" token.
export function chunkText(text: string, max: number): string[] {
	if (text.length <= max) return [text]
	const chunks: string[] = []
	let start = 0
	while (start < text.length) {
		let cut = Math.min(start + max, text.length)
		if (cut < text.length) {
			for (const m of text.slice(start, cut + 1).matchAll(/@\d+/g)) {
				const s = start + m.index
				const e = s + m[0].length
				if (s < cut && e > cut && s > start) cut = s
			}
		}
		chunks.push(text.slice(start, cut))
		start = cut
	}
	return chunks
}

// Mentions that actually appear (as "@digits") in a given chunk.
export function mentionsIn(chunk: string, mentions: string[]): string[] {
	return mentions.filter((jid) => new RegExp(`@${digitsOf(jid)}(?!\\d)`).test(chunk))
}

// --- persistence -------------------------------------------------------------

type Directory = Record<string, Member[]>

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T
	} catch (err) {
		log(`warn: could not parse ${path}: ${String(err)}`)
		return fallback
	}
}

export class MentionDirectory {
	private dir: Directory
	private aliases: Record<string, Record<string, string>> = {}
	private aliasesMtime = -1
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	readonly dirPath: string
	readonly aliasPath: string

	constructor(stateDir: string) {
		this.dirPath = join(stateDir, 'mentions.json')
		this.aliasPath = join(stateDir, 'mention-aliases.json')
		this.dir = readJson<Directory>(this.dirPath, {})
	}

	// Merge a sighting of a member (from an inbound message or group metadata).
	record(groupJid: string, info: { pn?: string; lid?: string; name?: string }): void {
		const pn = info.pn?.endsWith('@s.whatsapp.net') ? info.pn : undefined
		const lid = info.lid?.endsWith('@lid') ? info.lid : undefined
		if (!pn && !lid) return
		const members = (this.dir[groupJid] ??= [])
		let m = members.find((x) => (pn && x.pn === pn) || (lid && x.lid === lid))
		if (!m) {
			m = { names: [] }
			members.push(m)
		}
		let changed = false
		if (pn && m.pn !== pn) ((m.pn = pn), (changed = true))
		if (lid && m.lid !== lid) ((m.lid = lid), (changed = true))
		const name = info.name?.trim()
		if (name && !m.names.includes(name)) {
			m.names.push(name)
			changed = true
		}
		if (changed) this.scheduleSave()
	}

	members(groupJid: string): Member[] {
		return this.dir[groupJid] ?? []
	}

	// Aliases are re-read whenever the file changes so edits need no restart.
	aliasesFor(groupJid: string): Record<string, string> {
		try {
			const mtime = existsSync(this.aliasPath) ? statSync(this.aliasPath).mtimeMs : 0
			if (mtime !== this.aliasesMtime) {
				this.aliases = readJson(this.aliasPath, {})
				this.aliasesMtime = mtime
			}
		} catch (err) {
			log(`warn: reading aliases failed: ${String(err)}`)
		}
		return this.aliases[groupJid] ?? {}
	}

	resolve(groupJid: string, text: string, mode: JidMode): MentionResult {
		const r = resolveMentions(text, this.members(groupJid), this.aliasesFor(groupJid), mode)
		if (r.resolved.length || r.unresolved.length) {
			logDebug(
				`mentions ${groupJid} mode=${mode} resolved=[${r.resolved.map((x) => `${x.token}->${x.jid}`).join(' ')}] unresolved=[${r.unresolved.join(' ')}]`,
			)
		}
		return r
	}

	private scheduleSave(): void {
		if (this.saveTimer) return
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null
			this.save()
		}, 1000)
	}

	save(): void {
		try {
			mkdirSync(dirname(this.dirPath), { recursive: true })
			const tmp = `${this.dirPath}.tmp`
			writeFileSync(tmp, JSON.stringify(this.dir, null, '\t'))
			renameSync(tmp, this.dirPath)
		} catch (err) {
			log(`warn: saving ${this.dirPath} failed: ${String(err)}`)
		}
	}
}
