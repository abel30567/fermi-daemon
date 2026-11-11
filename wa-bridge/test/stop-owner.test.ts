// DMN-57: an inbound "stop" interrupts the running turn only when the sender is in
// WA_OWNER_NUMBERS (empty = nobody) and the warm worker accepts the chat as its active one.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { type Config, parseOwnerNumbers } from '../src/config.ts'
import { makeInboundHandler } from '../src/inbound.ts'

const OWNER = '15555550100'
const STRANGER = '15555550199'
const OWNER_DM = OWNER
const GROUP = '120363000000000000@g.us'
const OTHER_GROUP = '120363000000000001@g.us'

const home = mkdtempSync(join(tmpdir(), 'wa-stop-owner-'))
mkdirSync(join(home, 'run'))
writeFileSync(join(home, 'poll.sh'), '#!/bin/sh\nexit 0\n')
chmodSync(join(home, 'poll.sh'), 0o700)

// Fake warm worker on run/control.sock with the same rule as warm-worker.mjs /abort:
// 200 only for the chat the running turn claimed, 400 otherwise.
let activeChat: string | null = null
const aborts: { chat_id: string; status: number }[] = []
const worker = http.createServer((req, res) => {
	let body = ''
	req.on('data', (c) => (body += c))
	req.on('end', () => {
		const { channel, chat_id } = JSON.parse(body)
		const status = channel === 'wa' && chat_id === activeChat ? 200 : 400
		aborts.push({ chat_id, status })
		res.writeHead(status).end('{}')
	})
})

// Fake Fermi /wa/webhook: records what the bridge enqueued.
const webhooks: { sender: string; chat_id: string; text: string }[] = []
const fermi = http.createServer((req, res) => {
	let body = ''
	req.on('data', (c) => (body += c))
	req.on('end', () => {
		webhooks.push(JSON.parse(body))
		res.writeHead(200).end('{}')
	})
})

let fermiUrl = ''
before(async () => {
	await new Promise<void>((r) => worker.listen(join(home, 'run/control.sock'), r))
	await new Promise<void>((r) => fermi.listen(0, '127.0.0.1', r))
	fermiUrl = `http://127.0.0.1:${(fermi.address() as AddressInfo).port}`
})
after(() => {
	worker.close()
	fermi.close()
	rmSync(home, { recursive: true, force: true })
})
beforeEach(() => {
	aborts.length = 0
	webhooks.length = 0
	activeChat = null
})

function handler(owners: string | undefined) {
	const config: Config = {
		FERMI_URL: fermiUrl,
		FERMI_BEARER_TOKEN: 'test-bearer',
		WA_WEBHOOK_SECRET: 'test-secret',
		POLL_MS: 3000,
		DAEMON_HOME: home,
		AUTH_DIR: join(home, 'wa-auth'),
		STATE_DIR: join(home, 'state'),
		MENTION_JID_MODE: 'auto',
		DEBUG: false,
		OWNER_NUMBERS: parseOwnerNumbers(owners),
	}
	return makeInboundHandler(config)
}

test('owner stop in the DM whose task is running: interrupts, not enqueued', async () => {
	activeChat = OWNER_DM
	await handler(OWNER)(OWNER, OWNER_DM, 'stop')
	assert.deepEqual(aborts, [{ chat_id: OWNER_DM, status: 200 }])
	assert.equal(webhooks.length, 0)
})

test('non-owner stop is a no-op: no abort signal, delivered as a normal message', async () => {
	activeChat = STRANGER
	await handler(OWNER)(STRANGER, STRANGER, 'stop')
	assert.deepEqual(aborts, [])
	assert.deepEqual(webhooks, [{ sender: STRANGER, chat_id: STRANGER, text: 'stop' }])
})

test('group chat stop by a non-owner, while a task for that group runs: no abort', async () => {
	activeChat = GROUP
	await handler(OWNER)(STRANGER, GROUP, 'stop now')
	assert.deepEqual(aborts, [])
	assert.equal(webhooks.length, 1)
})

test('owner in group: stop in the group whose task is running interrupts it', async () => {
	activeChat = GROUP
	await handler(OWNER)(OWNER, GROUP, 'stop')
	assert.deepEqual(aborts, [{ chat_id: GROUP, status: 200 }])
	assert.equal(webhooks.length, 0)
})

test('owner stop from a different conversation than the running task: worker refuses, nothing interrupted', async () => {
	activeChat = GROUP
	await handler(OWNER)(OWNER, OTHER_GROUP, 'stop')
	assert.deepEqual(aborts, [{ chat_id: OTHER_GROUP, status: 400 }])
	assert.equal(webhooks.length, 1, 'falls back to a normal enqueue')
})

test('non-owner stop in an unrelated chat: ignored, no abort signal', async () => {
	activeChat = GROUP
	await handler(OWNER)(STRANGER, OTHER_GROUP, 'abort')
	assert.deepEqual(aborts, [])
})

for (const [label, raw] of [
	['missing', undefined],
	['empty', ''],
	['only separators', ' , ,'],
] as const) {
	test(`allowlist ${label} fails closed: even the would-be owner's stop sends no abort`, async () => {
		activeChat = OWNER_DM
		await handler(raw)(OWNER, OWNER_DM, 'stop')
		assert.deepEqual(aborts, [])
		assert.equal(webhooks.length, 1)
	})
}

test('non-stop text from an owner never signals abort', async () => {
	activeChat = OWNER_DM
	await handler(OWNER)(OWNER, OWNER_DM, 'stop by the store later')
	assert.deepEqual(aborts, [])
	assert.equal(webhooks.length, 1)
})

test('parseOwnerNumbers: comma-separated E.164, "+"/spaces/dashes ignored, bad entries rejected', () => {
	assert.deepEqual([...parseOwnerNumbers('+1 555-555-0100, 447700900123,')], ['15555550100', '447700900123'])
	assert.equal(parseOwnerNumbers(undefined).size, 0)
	assert.throws(() => parseOwnerNumbers('15555550100,abc'), /invalid WA_OWNER_NUMBERS entry: abc/)
	assert.throws(() => parseOwnerNumbers('123'), /invalid WA_OWNER_NUMBERS/)
})
