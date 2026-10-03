// Usage: npm run mention-test -- <groupJid> "<texto>"
// Shows how the text would resolve against the stored directory/aliases, then
// queues it for the running bridge (which owns the WhatsApp session) to send.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { MentionDirectory } from './mentions.ts'
import { TEST_QUEUE_FILE } from './outbox.ts'

const [jid, ...rest] = process.argv.slice(2)
const text = rest.join(' ')
if (!jid || !text) {
	console.error('usage: npm run mention-test -- <groupJid> "<texto>"')
	process.exit(1)
}

const config = loadConfig()
const directory = new MentionDirectory(config.STATE_DIR)
const members = directory.members(jid)
console.log(`known members for ${jid}: ${members.length}`)
for (const m of members) console.log(`  ${m.names.join(' | ') || '(no name)'}  pn=${m.pn ?? '-'}  lid=${m.lid ?? '-'}`)
for (const mode of ['lid', 'pn'] as const) {
	const r = directory.resolve(jid, text, mode)
	console.log(`\n[${mode}] text: ${r.text}`)
	console.log(`[${mode}] mentions: ${r.mentions.join(', ') || '(none)'}`)
	if (r.unresolved.length) console.log(`[${mode}] unresolved: ${r.unresolved.join(', ')}`)
}

mkdirSync(config.STATE_DIR, { recursive: true })
appendFileSync(join(config.STATE_DIR, TEST_QUEUE_FILE), `${JSON.stringify({ jid, text })}\n`)
console.log(`\nqueued for the running bridge (mode=${config.MENTION_JID_MODE}); watch logs/wa-bridge.log`)
