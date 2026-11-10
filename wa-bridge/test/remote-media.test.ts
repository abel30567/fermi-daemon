// SSRF guard for fetchRemoteMedia (DMN-53). No network: DNS and fetch are injected.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type LookupAll, MediaRejected, fetchRemoteMedia, isBlockedAddress } from '../../bridge-lib/outbound-media.ts'

const PUBLIC_V4 = '93.184.215.14'
const PUBLIC_V6 = '2606:2800:21f:cb07::1'

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function harness(dns: Record<string, string[]>, routes: Record<string, Handler>) {
	const looked: string[] = []
	const fetched: string[] = []
	const lookup: LookupAll = async (host) => {
		looked.push(host)
		const a = dns[host]
		if (!a) throw new Error(`ENOTFOUND ${host}`)
		return a
	}
	const fakeFetch = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
		const url = new URL(String(input))
		fetched.push(url.href)
		assert.equal(init.redirect, 'manual', 'redirects must be followed manually')
		const route = routes[url.href]
		if (!route) throw new Error(`unexpected fetch ${url.href}`)
		return route(url, init)
	}) as typeof fetch
	return { looked, fetched, opts: { lookup, fetch: fakeFetch } }
}

const ok = (body = 'png-bytes', headers: Record<string, string> = { 'content-type': 'image/png' }): Handler => () =>
	new Response(body, { status: 200, headers })
const redirect = (location: string, status = 302): Handler => () => new Response(null, { status, headers: { location } })

async function rejects(url: string, dns: Record<string, string[]> = {}, pattern = /private address/) {
	const h = harness(dns, {})
	await assert.rejects(fetchRemoteMedia({ kind: 'image', url }, 1_000_000, h.opts), (err: unknown) => {
		assert.ok(err instanceof MediaRejected, `${url}: expected MediaRejected, got ${String(err)}`)
		assert.match((err as Error).message, pattern, url)
		return true
	})
	assert.deepEqual(h.fetched, [], `${url} must be rejected before any request`)
}

test('loopback: v4 literal, alternate v4 encodings, v6 ::1 and a name resolving to 127.0.0.1 are rejected', async () => {
	await rejects('http://127.0.0.1/a.png')
	await rejects('http://127.1.2.3:8080/a.png')
	await rejects('http://2130706433/a.png') // WHATWG URL normalises to 127.0.0.1
	await rejects('http://0x7f.1/a.png')
	await rejects('http://[::1]/a.png')
	await rejects('http://0.0.0.0/a.png')
	await rejects('http://localhost/a.png', { localhost: ['127.0.0.1'] })
})

test('RFC1918: 10/8, 172.16/12 and 192.168/16 are rejected, literal and resolved', async () => {
	await rejects('http://10.0.0.5/a.png')
	await rejects('http://172.16.0.1/a.png')
	await rejects('http://172.31.255.254/a.png')
	await rejects('https://192.168.1.1/a.png')
	await rejects('https://intranet.example/a.png', { 'intranet.example': ['10.1.2.3'] })
	assert.equal(isBlockedAddress('172.32.0.1'), false, '172.32/16 is outside 172.16/12')
})

test('link-local: 169.254.169.254 metadata endpoint and fe80::/10 are rejected', async () => {
	await rejects('http://169.254.169.254/latest/meta-data/')
	await rejects('http://metadata.example/computeMetadata/v1/', { 'metadata.example': ['169.254.169.254'] })
	await rejects('http://[fe80::1]/a.png')
	await rejects('http://ll.example/a.png', { 'll.example': ['fe80::abcd'] })
})

test('IPv6 ULA (fc00::/7) is rejected, literal and resolved', async () => {
	await rejects('http://[fd00::1]/a.png')
	await rejects('http://[fc00::42]/a.png')
	await rejects('http://ula.example/a.png', { 'ula.example': ['fd12:3456:789a::1'] })
})

test('IPv4-mapped IPv6 is checked against the v4 rules', async () => {
	await rejects('http://[::ffff:127.0.0.1]/a.png')
	await rejects('http://[::ffff:10.0.0.1]/a.png')
	await rejects('http://mapped.example/a.png', { 'mapped.example': ['::ffff:169.254.169.254'] })
	assert.equal(isBlockedAddress(`::ffff:${PUBLIC_V4}`), false)
})

test('non-http(s) schemes and unresolvable hosts are rejected', async () => {
	await rejects('file:///etc/passwd', {}, /unsupported url scheme/)
	await rejects('ftp://cdn.example/a.png', {}, /unsupported url scheme/)
	await rejects('http://nxdomain.example/a.png', {}, /cannot resolve/)
	await rejects('http://empty.example/a.png', { 'empty.example': [] }, /cannot resolve/)
})

test('redirect to loopback is rejected before the second request is made', async () => {
	const h = harness(
		{ 'cdn.example': [PUBLIC_V4] },
		{ 'https://cdn.example/a.png': redirect('http://127.0.0.1:8317/secret') },
	)
	await assert.rejects(fetchRemoteMedia({ kind: 'image', url: 'https://cdn.example/a.png' }, 1_000_000, h.opts), /private address \(127\.0\.0\.1\)/)
	assert.deepEqual(h.fetched, ['https://cdn.example/a.png'])
})

test('redirect to a name that resolves to a private address is rejected (each hop re-resolved)', async () => {
	const h = harness(
		{ 'cdn.example': [PUBLIC_V4], 'internal.example': ['192.168.0.10'] },
		{ 'https://cdn.example/a.png': redirect('https://internal.example/a.png', 307) },
	)
	await assert.rejects(fetchRemoteMedia({ kind: 'image', url: 'https://cdn.example/a.png' }, 1_000_000, h.opts), MediaRejected)
	assert.deepEqual(h.looked, ['cdn.example', 'internal.example'])
	assert.deepEqual(h.fetched, ['https://cdn.example/a.png'])
})

test('up to 3 redirects (relative and absolute) are followed; a 4th is rejected', async () => {
	const routes: Record<string, Handler> = {
		'https://cdn.example/0': redirect('/1', 301),
		'https://cdn.example/1': redirect('https://cdn2.example/2', 302),
		'https://cdn2.example/2': redirect('3', 308),
		'https://cdn2.example/3': ok(),
	}
	const dns = { 'cdn.example': [PUBLIC_V4], 'cdn2.example': [PUBLIC_V6] }
	const h = harness(dns, routes)
	const res = await fetchRemoteMedia({ kind: 'image', url: 'https://cdn.example/0' }, 1_000_000, h.opts)
	assert.equal(res.buffer.toString(), 'png-bytes')
	assert.equal(h.fetched.length, 4)

	const h4 = harness(dns, { ...routes, 'https://cdn2.example/3': redirect('/4'), 'https://cdn2.example/4': ok() })
	await assert.rejects(fetchRemoteMedia({ kind: 'image', url: 'https://cdn.example/0' }, 1_000_000, h4.opts), /too many redirects/)
	assert.ok(!h4.fetched.includes('https://cdn2.example/4'))
})

test('oversize stream without content-length is aborted once it passes the cap', async () => {
	let pulled = 0
	let cancelled = false
	const chunk = new Uint8Array(1024)
	const endless: Handler = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				pull(c) {
					pulled++
					c.enqueue(chunk)
				},
				cancel() {
					cancelled = true
				},
			}),
			{ status: 200 },
		)
	const h = harness({ 'cdn.example': [PUBLIC_V4] }, { 'https://cdn.example/big.mp4': endless })
	await assert.rejects(fetchRemoteMedia({ kind: 'video', url: 'https://cdn.example/big.mp4' }, 10 * 1024, h.opts), (err: unknown) => {
		assert.ok(err instanceof MediaRejected)
		assert.match((err as Error).message, /too large/)
		return true
	})
	assert.ok(cancelled, 'stream must be cancelled')
	assert.ok(pulled < 20, `read ${pulled} chunks; must stop right after the 10 KB cap`)
})

test('declared content-length over the cap is rejected without reading the body', async () => {
	const h = harness({ 'cdn.example': [PUBLIC_V4] }, { 'https://cdn.example/big.mp4': ok('x', { 'content-length': String(500 * 1_048_576) }) })
	await assert.rejects(fetchRemoteMedia({ kind: 'video', url: 'https://cdn.example/big.mp4' }, 1_048_576, h.opts), /too large \(500 MB\)/)
})

test('a stalled download times out as a transient (retryable) error', async () => {
	const stall: Handler = (_url, init) =>
		new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
	const h = harness({ 'cdn.example': [PUBLIC_V4] }, { 'https://cdn.example/slow.png': stall })
	const keepAlive = setTimeout(() => {}, 5_000) // AbortSignal.timeout's timer is unref'd
	await assert.rejects(
		fetchRemoteMedia({ kind: 'image', url: 'https://cdn.example/slow.png' }, 1_000_000, { ...h.opts, timeoutMs: 50 }),
		(err: unknown) => {
			assert.ok(!(err instanceof MediaRejected), 'timeouts are retried, not abandoned')
			assert.match((err as Error).message, /timed out after 50 ms/)
			return true
		},
	)
	clearTimeout(keepAlive)
})

test('DNS rebinding: a name with any private record is rejected even if another record is public', async () => {
	await rejects('https://rebind.example/a.png', { 'rebind.example': [PUBLIC_V4, '127.0.0.1'] })
	await rejects('https://rebind6.example/a.png', { 'rebind6.example': [PUBLIC_V6, 'fd00::1'] })
})

test('legit CDN behind public v4/v6 addresses is unaffected', async () => {
	const h = harness(
		{ 'cdn.example': [PUBLIC_V4, PUBLIC_V6] },
		{ 'https://cdn.example/media/report.pdf?sig=abc': ok('%PDF-1.7', { 'content-type': 'application/pdf; charset=binary', 'content-length': '8' }) },
	)
	const res = await fetchRemoteMedia({ kind: 'document', url: 'https://cdn.example/media/report.pdf?sig=abc' }, 1_000_000, h.opts)
	assert.deepEqual(res, { buffer: Buffer.from('%PDF-1.7'), mimetype: 'application/pdf', fileName: 'report.pdf' })

	const lit = harness({}, { [`http://${PUBLIC_V4}/x.png`]: ok() })
	assert.equal((await fetchRemoteMedia({ kind: 'image', url: `http://${PUBLIC_V4}/x.png` }, 1_000_000, lit.opts)).mimetype, 'image/png')
	assert.deepEqual(lit.looked, [], 'IP literals skip DNS')
	for (const a of [PUBLIC_V4, PUBLIC_V6, '8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) assert.equal(isBlockedAddress(a), false, a)
})

test('empty and non-2xx responses keep their existing rejections', async () => {
	const h = harness(
		{ 'cdn.example': [PUBLIC_V4] },
		{ 'https://cdn.example/empty.png': ok(''), 'https://cdn.example/404.png': () => new Response('no', { status: 404 }) },
	)
	await assert.rejects(fetchRemoteMedia({ kind: 'image', url: 'https://cdn.example/empty.png' }, 1_000_000, h.opts), /empty/)
	await assert.rejects(fetchRemoteMedia({ kind: 'image', url: 'https://cdn.example/404.png' }, 1_000_000, h.opts), /download failed \(404\)/)
})
