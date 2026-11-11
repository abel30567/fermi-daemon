// DMN-55: tools/broker-origin.mjs confines each broker session's tab to the lease
// record's site. Browser-free: route and CDP events are faked with the shapes
// Playwright and Chromium hand the handlers.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { assertNav, confineRoute, navAllowed, redirectVerdict } from '../tools/broker-origin.mjs'

const SITE = 'https://chatgpt.com'

// A fake Playwright Route for one request. frame: 'main' | 'iframe' | 'popup'
// (a popup's first request has no frame yet, so frame() throws).
function fakeRoute(url, { nav = true, frame = 'main' } = {}) {
	const calls = []
	const parent = { parentFrame: () => null }
	const req = {
		url: () => url,
		isNavigationRequest: () => nav,
		frame: () => {
			if (frame === 'popup') throw new Error('Frame for this navigation request is not available')
			return frame === 'iframe' ? { parentFrame: () => parent } : parent
		},
	}
	return {
		calls,
		request: () => req,
		abort: (code) => calls.push(['abort', code]),
		fallback: () => calls.push(['fallback']),
	}
}

// opts.site overrides SITE, even when it is undefined.
const routeOutcome = (url, opts = {}) => {
	const route = fakeRoute(url, opts)
	confineRoute('site' in opts ? opts.site : SITE)(route)
	return route.calls[0][0]
}

const paused = (url, frameId = 'MAIN') => ({ requestId: 'r1', frameId, resourceType: 'Document', request: { url } })

describe('acceptance criteria', () => {
	test('file:///etc/hosts is blocked', () => {
		assert.equal(navAllowed('file:///etc/hosts', SITE), false)
		assert.throws(() => assertNav('file:///etc/hosts', SITE), /origin_not_allowed/)
		assert.equal(routeOutcome('file:///etc/hosts'), 'abort')
	})

	test('an https URL off the allowlist is blocked', () => {
		for (const url of ['https://example.org/', 'https://169.254.169.254/latest/meta-data', 'https://127.0.0.1/']) {
			assert.equal(navAllowed(url, SITE), false, url)
			assert.equal(routeOutcome(url), 'abort', url)
		}
	})

	test('an https URL on the allowlist works, subdomains included', () => {
		for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/c/abc?x=1', 'https://auth.chatgpt.com/login']) {
			assert.equal(navAllowed(url, SITE), true, url)
			assert.doesNotThrow(() => assertNav(url, SITE))
			assert.equal(routeOutcome(url), 'fallback', url)
		}
	})
})

describe('blocked schemes and look-alikes', () => {
	test('javascript: and data: URLs are blocked', () => {
		for (const url of ['javascript:alert(document.cookie)', 'data:text/html,<script>1</script>']) {
			assert.equal(navAllowed(url, SITE), false, url)
		}
	})

	test('plain http, another port and suffix look-alikes are blocked', () => {
		for (const url of [
			'http://chatgpt.com/',
			'https://chatgpt.com:8443/',
			'https://evilchatgpt.com/',
			'https://chatgpt.com.evil.example/',
			'https://chatgpt.com@evil.example/',
			'not a url',
		]) {
			assert.equal(navAllowed(url, SITE), false, url)
		}
	})

	test('a non-https site allows nothing', () => {
		assert.equal(navAllowed('http://intranet.local/', 'http://intranet.local'), false)
	})
})

describe('edge-case matrix', () => {
	test('session with no origin set: every navigation is denied', () => {
		for (const site of [undefined, null, '', 'chatgpt.com']) {
			assert.equal(navAllowed('https://chatgpt.com/', site), false, String(site))
			assert.equal(navAllowed('about:blank', site), false, String(site))
			assert.throws(() => assertNav('https://chatgpt.com/', site), /origin_not_allowed/)
			assert.equal(routeOutcome('https://chatgpt.com/', { site }), 'abort', String(site))
		}
	})

	test('about:blank is allowed', () => {
		assert.equal(navAllowed('about:blank', SITE), true)
		assert.doesNotThrow(() => assertNav('about:blank', SITE))
		// Other about: pages are not.
		assert.equal(navAllowed('about:settings', SITE), false)
	})

	test('download URLs get the same check as any navigation', () => {
		// A link that ends in a download is a top-level navigation request.
		assert.equal(routeOutcome('https://example.org/payload.dmg'), 'abort')
		assert.equal(routeOutcome('data:application/octet-stream;base64,AAAA'), 'abort')
		assert.equal(routeOutcome('https://chatgpt.com/backend-api/files/export.zip'), 'fallback')
		assert.equal(redirectVerdict(paused('https://cdn.example.org/export.zip'), 'MAIN', SITE)[0], 'Fetch.failRequest')
	})
})

describe('redirects', () => {
	test('a top-level redirect hop off the site is failed before it is sent', () => {
		const [method, params] = redirectVerdict(paused('https://127.0.0.1/secret'), 'MAIN', SITE)
		assert.equal(method, 'Fetch.failRequest')
		assert.deepEqual(params, { requestId: 'r1', errorReason: 'Aborted' })
	})

	test('a top-level redirect hop that stays on the site continues', () => {
		assert.deepEqual(redirectVerdict(paused('https://chatgpt.com/home'), 'MAIN', SITE), [
			'Fetch.continueRequest',
			{ requestId: 'r1' },
		])
	})

	test('iframe documents continue (cross-origin bot checks run in frames)', () => {
		assert.equal(redirectVerdict(paused('https://challenges.cloudflare.com/x', 'CHILD'), 'MAIN', SITE)[0], 'Fetch.continueRequest')
	})
})

describe('route scope', () => {
	test('subresources and iframe navigations off the site pass', () => {
		assert.equal(routeOutcome('https://cdn.oaistatic.com/app.js', { nav: false }), 'fallback')
		assert.equal(routeOutcome('https://challenges.cloudflare.com/turnstile', { frame: 'iframe' }), 'fallback')
	})

	test("a popup's first navigation is aborted even on the site", () => {
		assert.equal(routeOutcome('https://chatgpt.com/redirect-elsewhere', { frame: 'popup' }), 'abort')
	})
})
