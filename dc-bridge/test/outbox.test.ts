import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MediaRejected } from '../../bridge-lib/outbound-media.ts'
import { buildDiscordSend } from '../src/outbox.ts'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'fermi-daemon-')))
const out = join(home, 'media', 'out')
mkdirSync(out, { recursive: true })
const png = join(out, 'chart.png')
writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
const base = { id: 'a', chat_id: '1', created_at: 0 }

test('text rows become plain content', () => {
	assert.deepEqual(buildDiscordSend({ ...base, body: 'hello', media: null }, home), { content: 'hello' })
})

test('local attachment becomes a file upload with the caption as content', () => {
	const send = buildDiscordSend({ ...base, body: 'Sales', media: { kind: 'image', path: png } }, home)
	assert.equal(send.content, 'Sales')
	assert.equal(send.files?.length, 1)
	assert.equal(send.files?.[0].name, 'chart.png')
	assert.equal(send.files?.[0].attachment, png)
})

test('remote attachment keeps the url and the given file_name; bad local path is rejected', () => {
	const send = buildDiscordSend(
		{ ...base, body: '', media: { kind: 'document', url: 'https://x.test/r.pdf', file_name: 'Report.pdf', caption: 'Q3' } },
		home,
	)
	assert.equal(send.content, 'Q3')
	assert.equal(send.files?.[0].name, 'Report.pdf')
	assert.equal(send.files?.[0].attachment, 'https://x.test/r.pdf')
	assert.throws(() => buildDiscordSend({ ...base, body: '', media: { kind: 'image', path: join(home, 'x.png') } }, home), MediaRejected)
})
