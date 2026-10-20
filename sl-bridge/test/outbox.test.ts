import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MediaRejected } from '../../bridge-lib/outbound-media.ts'
import { buildSlackUpload } from '../src/outbox.ts'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'fermi-daemon-')))
const out = join(home, 'media', 'out')
mkdirSync(out, { recursive: true })
const png = join(out, 'chart.png')
writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
const base = { id: 'a', chat_id: 'C1', created_at: 0 }

test('local attachment streams the file with the caption as initial_comment', async () => {
	const up = await buildSlackUpload({ ...base, body: 'Sales', media: { kind: 'image', path: png, file_name: 'Chart.png' } }, home)
	assert.equal(up.channel_id, 'C1')
	assert.equal(up.filename, 'Chart.png')
	assert.equal(up.initial_comment, 'Sales')
	assert.equal(typeof (up.file as { pipe?: unknown }).pipe, 'function')
	;(up.file as { destroy(): void }).destroy()
})

test('paths outside media/out are rejected', async () => {
	await assert.rejects(
		buildSlackUpload({ ...base, body: '', media: { kind: 'image', path: join(home, 'x.png') } }, home),
		MediaRejected,
	)
})
