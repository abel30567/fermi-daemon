import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	MediaRejected,
	SendAttempts,
	captionFor,
	parseOutboxMessages,
	remoteFileName,
	resolveLocalMedia,
} from '../../bridge-lib/outbound-media.ts'
import { buildWaMediaContent } from '../src/media.ts'

// 1x1 PNG fixture written into a throwaway daemon home.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
)

function fixtureHome(): { home: string; out: string; png: string } {
	const home = realpathSync(mkdtempSync(join(tmpdir(), 'fermi-daemon-')))
	const out = join(home, 'media', 'out')
	mkdirSync(out, { recursive: true })
	const png = join(out, 'chart.png')
	writeFileSync(png, PNG)
	return { home, out, png }
}

test('resolveLocalMedia accepts a file inside media/out and infers the mimetype', () => {
	const { home, png } = fixtureHome()
	const local = resolveLocalMedia({ kind: 'image', path: png }, home, 1_000_000)
	assert.equal(local.mimetype, 'image/png')
	assert.equal(local.fileName, 'chart.png')
	assert.equal(local.size, PNG.length)
})

test('resolveLocalMedia rejects paths outside media/out, traversal, symlink escapes, and oversize', () => {
	const { home, out, png } = fixtureHome()
	const secret = join(home, 'secret.txt')
	writeFileSync(secret, 'nope')
	symlinkSync(secret, join(out, 'link.txt'))
	mkdirSync(join(home, 'media', 'in'), { recursive: true })
	writeFileSync(join(home, 'media', 'in', 'x.png'), PNG)

	const bad = [secret, join(out, 'link.txt'), join(out, '..', 'in', 'x.png'), join(out, 'missing.png'), out]
	for (const path of bad) {
		assert.throws(() => resolveLocalMedia({ kind: 'document', path }, home, 1_000_000), MediaRejected, path)
	}
	assert.throws(() => resolveLocalMedia({ kind: 'image', path: png }, home, 10), /limit/)
})

test('parseOutboxMessages keeps text rows and drops malformed media blocks', () => {
	const msgs = parseOutboxMessages({
		messages: [
			{ id: 'a', chat_id: '1', body: 'hi', created_at: 1 },
			{ id: 'b', chat_id: '1', body: '', created_at: 2, media: { kind: 'image', path: '/x/chart.png', caption: 'c' } },
			{ id: 'c', chat_id: '1', body: 'bad', created_at: 3, media: { kind: 'sticker', url: 'https://x' } },
			{ id: 'd', chat_id: '1', body: 'nosrc', created_at: 4, media: { kind: 'image' } },
			{ id: 5, chat_id: '1', body: 'skip' },
		],
	})
	assert.deepEqual(
		msgs.map((m) => [m.id, m.media?.kind ?? null]),
		[
			['a', null],
			['b', 'image'],
			['c', null],
			['d', null],
		],
	)
	assert.deepEqual(msgs[1].media, { kind: 'image', path: '/x/chart.png', caption: 'c' })
	assert.deepEqual(parseOutboxMessages({}), [])
})

test('captionFor and remoteFileName', () => {
	assert.equal(captionFor({ id: 'a', chat_id: '1', body: 'text', created_at: 0, media: { kind: 'image', url: 'u' } }), 'text')
	assert.equal(
		captionFor({ id: 'a', chat_id: '1', body: 'text', created_at: 0, media: { kind: 'image', url: 'u', caption: 'cap' } }),
		'cap',
	)
	assert.equal(captionFor({ id: 'a', chat_id: '1', body: '', created_at: 0, media: null }), undefined)
	assert.equal(remoteFileName('https://x.test/a/b/report.pdf?x=1', 'document'), 'report.pdf')
	assert.equal(remoteFileName('https://x.test/img', 'image'), 'img.jpg')
})

test('SendAttempts gives up immediately on MediaRejected and after 3 transient failures', () => {
	const a = new SendAttempts()
	assert.equal(a.fail('x', new MediaRejected('bad')), true)
	assert.equal(a.fail('y', new Error('net')), false)
	assert.equal(a.fail('y', new Error('net')), false)
	assert.equal(a.fail('y', new Error('net')), true)
})

test('buildWaMediaContent: image with caption from body, document with fileName, audio caption as follow-up', () => {
	const { home, png } = fixtureHome()
	const base = { id: 'a', chat_id: '1', created_at: 0 }
	const image = buildWaMediaContent({ ...base, body: 'Sales', media: { kind: 'image', path: png } }, home)
	assert.deepEqual(image.content, { image: { url: png }, caption: 'Sales', mimetype: 'image/png' })
	assert.equal(image.followUpText, undefined)

	const doc = buildWaMediaContent(
		{ ...base, body: '', media: { kind: 'document', path: png, file_name: 'Chart.png', caption: 'see attached' } },
		home,
	)
	assert.deepEqual(doc.content, {
		document: { url: png },
		mimetype: 'image/png',
		fileName: 'Chart.png',
		caption: 'see attached',
	})

	const audio = buildWaMediaContent(
		{ ...base, body: 'listen', media: { kind: 'audio', url: 'https://x.test/a.m4a' } },
		home,
	)
	assert.deepEqual(audio.content, { audio: { url: 'https://x.test/a.m4a' }, mimetype: 'audio/mp4', ptt: false })
	assert.equal(audio.followUpText, 'listen')

	assert.throws(
		() => buildWaMediaContent({ ...base, body: '', media: { kind: 'image', path: join(home, 'x.png') } }, home),
		MediaRejected,
	)
})
