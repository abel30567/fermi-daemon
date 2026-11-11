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
	const s = siteURL(site)
	if (!s) return false
	if (url === 'about:blank') return true
	let u
	try {
		u = new URL(url)
	} catch {
		return false
	}
	if (u.protocol !== 'https:' || u.port !== s.port || u.username || u.password) return false
	return u.hostname === s.hostname || u.hostname.endsWith(`.${s.hostname}`)
}

// The lease record's site as a URL, or null unless it is an https URL string
// (an array would otherwise be stringified by new URL()).
function siteURL(site) {
	if (typeof site !== 'string') return null
	try {
		const s = new URL(site)
		return s.protocol === 'https:' ? s : null
	} catch {
		return null
	}
}

function assertSite(site) {
	if (!siteURL(site)) throw new Error(`${ORIGIN_DENIED}: no site for session`)
}

export function assertNav(url, site) {
	if (!navAllowed(url, site)) throw new Error(`${ORIGIN_DENIED}: ${String(url).slice(0, 200)}`)
}

// Check run before every op, whatever its type: an op whose lease record has
// no usable site is denied even if it carries no url (click, extract, ...).
export function assertOp(p) {
	assertSite(p.site)
	if (p.args.url) assertNav(p.args.url, p.site)
}

// The session's cached context, confined to `site` (the CURRENT op's lease
// record). A cached context confined to another site is closed with its pages
// and rebuilt by create(), so the guards never judge an op by a stale site.
// A missing site throws before anything is created or cached.
export async function sessionContext(contexts, pages, session, site, create) {
	assertSite(site)
	const cached = contexts.get(session)
	if (cached?.site === site) return cached
	if (cached) {
		contexts.delete(session)
		for (const [key, page] of pages) if (page.context() === cached.context) pages.delete(key)
		await cached.context.close().catch(() => {})
	}
	const entry = await create()
	await confineContext(entry.context, site)
	entry.site = site
	contexts.set(session, entry)
	return entry
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
