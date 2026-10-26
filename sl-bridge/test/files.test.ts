import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { SL_MAX_MEDIA_BYTES, saveSlackFile } from '../src/files.ts'
import { buildInbound, forwardToWorker, inboundText, isForwardable, type SlackMessageEvent } from '../src/inbound.ts'

const TOKEN = 'xoxb-test-token'
const DOWNLOAD_URL = 'https://files.slack.com/files-pri/T0000000000-F0000000000/download/chart.png'
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

const image = {
	id: 'F0000000000',
	name: 'chart.png',
	mimetype: 'image/png',
	size: PNG.length,
	url_private_download: DOWNLOAD_URL,
}
const upload = {
	type: 'message',
	subtype: 'file_share',
	user: 'U0000000000',
	channel: 'C0000000000',
	ts: '1700000000.000100',
	files: [image],
}

function setup(t: TestContext) {
	const home = mkdtempSync(join(tmpdir(), 'sl-bridge-files-'))
	writeFileSync(join(home, 'poll.sh'), '#!/bin/sh\n')
	chmodSync(join(home, 'poll.sh'), 0o755)
	const config = {
		FERMI_URL: 'http://fermi.test',
		SLACK_BRIDGE_SECRET: 's',
		SLACK_BOT_TOKEN: TOKEN,
		DAEMON_HOME: home,
	} as Config
	const downloads: { url: string; auth: string | null }[] = []
	const webhooks: { text: string }[] = []
	t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
		if (url === 'http://fermi.test/sl/webhook') {
			webhooks.push(JSON.parse(init.body as string))
			return new Response(null, { status: 200 })
		}
		downloads.push({ url, auth: new Headers(init.headers).get('authorization') })
		return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
	})
	const logs: string[] = []
	t.mock.method(console, 'log', (line: string) => logs.push(line))
	return { home, config, downloads, webhooks, logs }
}

// What index.ts does for one slack_event.
async function handle(config: Config, event: SlackMessageEvent): Promise<void> {
	if (!isForwardable(event)) return
	const text = await inboundText(config, event)
	await forwardToWorker(
		config,
		buildInbound({ ...event, user: event.user as string, channel: event.channel as string, text }, 'Ann', 'T1'),
	)
}

function savedPath(text: string): string {
	const m = text.match(/\[image attachment saved to (.+?); original name: chart\.png; type: image\/png\]/)
	assert.ok(m, `no attachment line in ${text}`)
	return m[1]
}

test('file_share with a caption forwards the caption plus the attachment line', async (t) => {
	const { home, config, downloads, webhooks, logs } = setup(t)
	await handle(config, { ...upload, text: 'Q3 numbers' })
	assert.equal(webhooks.length, 1)
	const [caption, line] = webhooks[0].text.split('\n')
	assert.equal(caption, 'Q3 numbers')
	const path = savedPath(line)
	assert.equal(dirname(path), join(home, 'media'))
	assert.deepEqual(readFileSync(path), PNG)
	assert.deepEqual(downloads, [{ url: DOWNLOAD_URL, auth: `Bearer ${TOKEN}` }])
	for (const l of logs) {
		assert.ok(!l.includes(TOKEN) && !l.includes(DOWNLOAD_URL), `leaked in log: ${l}`)
	}
})

test('file_share without text still forwards the attachment line', async (t) => {
	const { config, webhooks } = setup(t)
	await handle(config, { ...upload, text: '' })
	assert.equal(webhooks.length, 1)
	assert.ok(existsSync(savedPath(webhooks[0].text)))
	assert.ok(webhooks[0].text.startsWith('[image attachment saved to '))
})

test('oversize files are skipped and noted without downloading', async (t) => {
	const { home, config, downloads, webhooks } = setup(t)
	await handle(config, { ...upload, files: [{ ...image, size: SL_MAX_MEDIA_BYTES + 1 }] })
	assert.equal(downloads.length, 0)
	assert.equal(webhooks.length, 1)
	assert.match(webhooks[0].text, /^\[image attachment skipped: \d+ bytes is over the \d+ byte limit; original name: chart\.png/)
	assert.ok(!existsSync(join(home, 'media')))
})

test('a body over the cap is not written even when size was understated', async (t) => {
	const { home, downloads } = setup(t)
	const r = await saveSlackFile({ ...image, size: 1 }, TOKEN, join(home, 'media'), 4)
	assert.equal(downloads.length, 1)
	assert.match(r.line, /could not be downloaded: file is over the 4 byte limit/)
	assert.ok(!existsSync(join(home, 'media')))
})

test('non-https or non-slack.com download hosts never get the token', async (t) => {
	const { home, downloads } = setup(t)
	for (const url of [
		'http://files.slack.com/x',
		'https://files.slack.com.evil.test/x',
		'https://evil.test/files.slack.com',
	]) {
		const r = await saveSlackFile({ ...image, url_private_download: url }, TOKEN, join(home, 'media'))
		assert.match(r.line, /could not be downloaded: download host is not https on slack\.com/)
		assert.ok(!r.line.includes(url))
	}
	assert.equal(downloads.length, 0)
})

test('file names cannot escape the media dir', async (t) => {
	const { home } = setup(t)
	for (const name of ['../../etc/passwd', '..', '/abs/evil.png']) {
		const r = await saveSlackFile({ ...image, name }, TOKEN, join(home, 'media'))
		assert.ok(r.path)
		assert.equal(dirname(r.path), join(home, 'media'))
	}
	assert.equal(readdirSync(home).sort().join(','), 'media,poll.sh')
})

test('edits, deletes, bot messages and joins are ignored', async (t) => {
	const { config, downloads, webhooks } = setup(t)
	for (const subtype of ['message_changed', 'message_deleted', 'bot_message', 'channel_join']) {
		await handle(config, { ...upload, subtype, text: 'x' })
	}
	await handle(config, { ...upload, bot_id: 'B0000000000', text: 'x' })
	assert.equal(downloads.length, 0)
	assert.equal(webhooks.length, 0)
})

test('plain text messages still forward unchanged', async (t) => {
	const { config, webhooks } = setup(t)
	await handle(config, { type: 'message', user: 'U0000000000', channel: 'C0000000000', text: 'hi', ts: '1' })
	assert.deepEqual(
		webhooks.map((w) => w.text),
		['hi'],
	)
})
