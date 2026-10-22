import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const event = { type: 'message', user: 'U1', channel: 'C1', text: 'hi', ts: '1700000000.000100' }

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ann', 'T1')
	assert.equal(msg.message_id, 'abc-123')
})

test('message_id falls back to ts without client_msg_id', () => {
	const msg = buildInbound(event, 'Ann', 'T1')
	assert.equal(msg.message_id, '1700000000.000100')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ann',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hi',
		message_id: '1700000000.000100',
	})
})

test('a retried POST carries the same message_id', async (t) => {
	const home = mkdtempSync(join(tmpdir(), 'sl-bridge-'))
	writeFileSync(join(home, 'poll.sh'), '#!/bin/sh\n')
	chmodSync(join(home, 'poll.sh'), 0o755)
	const config = { FERMI_URL: 'http://fermi.test', SLACK_BRIDGE_SECRET: 's', DAEMON_HOME: home } as Config
	const bodies: { message_id?: string }[] = []
	t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(init.body as string))
		return new Response(null, { status: bodies.length === 1 ? 500 : 200 })
	})
	t.mock.method(console, 'log', () => {})
	await forwardToWorker(config, buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ann', 'T1'))
	assert.equal(bodies.length, 2)
	assert.equal(bodies[0].message_id, 'abc-123')
	assert.equal(bodies[1].message_id, 'abc-123')
})
