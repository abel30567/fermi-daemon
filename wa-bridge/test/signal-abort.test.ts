// DMN-56: signalAbort reaches the warm worker over its unix control socket.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { signalAbort } from '../src/inbound.ts'

const dir = mkdtempSync(join(tmpdir(), 'wa-abort-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// A fake worker on a unix socket answering /abort with `status`; records each request.
async function fakeWorker(status: number): Promise<{ sock: string; seen: { method?: string; url?: string; body: string }[]; close: () => void }> {
	const sock = join(dir, `control-${status}.sock`)
	const seen: { method?: string; url?: string; body: string }[] = []
	const server = http.createServer((req, res) => {
		let body = ''
		req.on('data', (c) => (body += c))
		req.on('end', () => {
			seen.push({ method: req.method, url: req.url, body })
			res.writeHead(status).end('{}')
		})
	})
	await new Promise<void>((r) => server.listen(sock, r))
	return { sock, seen, close: () => server.close() }
}

test('posts {channel: "wa", chat_id} to /abort on the socket; true on 200', async () => {
	const w = await fakeWorker(200)
	assert.equal(await signalAbort(w.sock, '15555550100@s.whatsapp.net'), true)
	assert.deepEqual(w.seen, [{ method: 'POST', url: '/abort', body: JSON.stringify({ channel: 'wa', chat_id: '15555550100@s.whatsapp.net' }) }])
	w.close()
})

test('false when the worker refuses (400: not the active chat), so the stop is enqueued instead', async () => {
	const w = await fakeWorker(400)
	assert.equal(await signalAbort(w.sock, 'other@s.whatsapp.net'), false)
	w.close()
})

test('false when no worker listens on the socket', async () => {
	assert.equal(await signalAbort(join(dir, 'missing.sock'), 'x'), false)
})
