// Origin confinement for the broker executor (DMN-55). A queued op may only
// take a session's tab to that session's own site (the lease record's `site`,
// stamped on every op payload by the cloud). The cloud pre-filters op URLs, but
// the executor checks again locally on every top-level navigation, redirects
// included, because the cookies and the residential network live here.
// No playwright import, so the tests run without a browser.

export const ORIGIN_DENIED = 'origin_not_allowed'

// https only, on the site's host or a subdomain of it (the cloud's rule) and on
// the same port. about:blank is the only non-https URL allowed, since every new
// tab starts there. A missing or unparseable site denies everything.
export function navAllowed(url, site) {
	let u
	let s
	try {
		s = new URL(site)
		if (url === 'about:blank') return true
		u = new URL(url)
	} catch {
		return false
	}
	if (s.protocol !== 'https:' || u.protocol !== 'https:') return false
	if (u.port !== s.port) return false
	return u.hostname === s.hostname || u.hostname.endsWith(`.${s.hostname}`)
}

export function assertNav(url, site) {
	if (!navAllowed(url, site)) throw new Error(`${ORIGIN_DENIED}: ${String(url).slice(0, 200)}`)
}

// Handler for context.route('**/*'). It sees the FIRST request of every
// top-level navigation in the context (op tabs, popups, links that end in a
// download) and aborts it if it leaves the site. Subresources and iframes pass:
// sites load scripts from CDNs and run bot checks (Cloudflare Turnstile) in
// cross-origin frames. Playwright does not route redirect hops, so
// redirectVerdict below covers those.
export function confineRoute(site) {
	return (route) => {
		const req = route.request()
		if (req.isNavigationRequest()) {
			// A popup's first request comes before its frame exists (frame()
			// throws) and before guardPage can attach, so its redirect hops would
			// go unchecked. Ops never read popups, so popups stay on about:blank.
			let frame
			try {
				frame = req.frame()
			} catch {
				return route.abort('aborted')
			}
			if (!frame.parentFrame() && !navAllowed(req.url(), site)) return route.abort('aborted')
		}
		return route.fallback()
	}
}

// Decides a CDP Fetch.requestPaused event (Document requests only). Chromium
// pauses every redirect hop here, before the hop is sent.
export function redirectVerdict(event, mainFrameId, site) {
	const topLevel = event.frameId === mainFrameId
	if (topLevel && !navAllowed(event.request.url, site)) {
		return ['Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }]
	}
	return ['Fetch.continueRequest', { requestId: event.requestId }]
}

const guarded = new WeakMap() // page -> Promise of its CDP guard

// Pause every Document request of `page` over CDP and fail the top-level ones
// that leave the site. Idempotent; a failed attach rejects so the caller denies
// the op instead of driving an unguarded tab.
export function guardPage(context, page, site) {
	if (!guarded.has(page)) {
		guarded.set(
			page,
			(async () => {
				const cdp = await context.newCDPSession(page)
				const { frameTree } = await cdp.send('Page.getFrameTree')
				cdp.on('Fetch.requestPaused', (e) => {
					const [method, params] = redirectVerdict(e, frameTree.frame.id, site)
					cdp.send(method, params).catch(() => {})
				})
				await cdp.send('Fetch.enable', {
					patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
				})
			})(),
		)
	}
	return guarded.get(page)
}

// Confine a whole browser context to `site`: the route for first requests, a
// CDP guard on every page it has or opens for redirect hops.
export async function confineContext(context, site) {
	await context.route('**/*', confineRoute(site))
	context.on('page', (page) => guardPage(context, page, site).catch(() => {}))
	await Promise.all(context.pages().map((page) => guardPage(context, page, site)))
}
