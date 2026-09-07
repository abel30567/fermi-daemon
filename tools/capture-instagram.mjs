#!/usr/bin/env node
// Autologin capture for Instagram → Fermi session vault (broker E2E).
// Drives the login programmatically per the instagram-login skill (React
// nativeInputValueSetter), handles the post-login "Not Now" dismissals, detects
// 2FA (bails for human), exports the Playwright storageState, and posts it to
// /admin/session/capture. Credentials are passed via env by the caller.
//
// Usage: IG_USER=.. IG_PASS=.. node tools/capture-instagram.mjs
// Env: FERMI_URL, FERMI_BEARER_TOKEN, IG_USER, IG_PASS, [IG_HEADFUL=1]

import { existsSync, readFileSync } from 'node:fs'

function loadEnv() {
	const out = { ...process.env }
	if (existsSync('.env')) {
		for (const line of readFileSync('.env', 'utf8').split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
			if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
		}
	}
	return out
}

const env = loadEnv()
const FERMI_URL = (env.FERMI_URL || '').replace(/\/$/, '')
const TOKEN = env.FERMI_BEARER_TOKEN
const USER = env.IG_USER
const PASS = env.IG_PASS
if (!FERMI_URL || !TOKEN || !USER || !PASS) {
	console.error('need FERMI_URL, FERMI_BEARER_TOKEN, IG_USER, IG_PASS')
	process.exit(1)
}

const { chromium } = await import('playwright')
const browser = await chromium.launch({ headless: env.IG_HEADFUL !== '1' })
const context = await browser.newContext({
	userAgent:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
	viewport: { width: 1280, height: 900 },
})
const page = await context.newPage()
const log = (...a) => console.log(new Date().toISOString(), ...a)

try {
	await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' })
	// Cookie consent (EU-style) if present.
	await page
		.locator('button:has-text("Allow all cookies"), button:has-text("Only allow essential")')
		.first()
		.click({ timeout: 4000 })
		.catch(() => {})

	await page.waitForSelector('input[name="username"], input[name="email"]', { timeout: 20_000 })
	// React-safe fill via nativeInputValueSetter (per skill).
	await page.evaluate(
		({ user, pass }) => {
			const u =
				document.querySelector('input[name="username"]') ||
				document.querySelector('input[name="email"]')
			const p = document.querySelector('input[name="password"]') ||
				document.querySelector('input[name="pass"]')
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
			setter.call(u, user)
			u.dispatchEvent(new Event('input', { bubbles: true }))
			setter.call(p, pass)
			p.dispatchEvent(new Event('input', { bubbles: true }))
		},
		{ user: USER, pass: PASS },
	)
	// Submit: press Enter in the password field (robust across IG's changing
	// button markup — div[role=button] vs button vs input[type=submit]).
	const pw = page.locator('input[name="password"], input[name="pass"]').first()
	await pw.focus()
	await pw.press('Enter')
	log('login submitted; waiting for navigation')

	// Give IG time to process; watch for 2FA / error / feed.
	await page.waitForTimeout(6000)
	const url = page.url()
	const twofa = await page
		.locator('input[name="verificationCode"], input[autocomplete="one-time-code"]')
		.count()
	if (twofa > 0 || /two_factor|challenge/.test(url)) {
		log('2FA/challenge required — cannot proceed autonomously. URL:', url)
		await browser.close()
		process.exit(2)
	}
	const errText = await page
		.locator('#slfErrorAlert, [role="alert"]')
		.first()
		.textContent()
		.catch(() => null)
	if (errText && /incorrect|wasn|problem|try again/i.test(errText)) {
		log('login error:', errText.trim().slice(0, 120))
		await browser.close()
		process.exit(3)
	}

	// Dismiss "Save login info" and notification prompts.
	for (let i = 0; i < 2; i++) {
		await page.waitForTimeout(2500)
		await page
			.locator('button:has-text("Not now"), button:has-text("Not Now"), div[role=button]:has-text("Not Now")')
			.first()
			.click({ timeout: 4000 })
			.catch(() => {})
	}

	// Confirm signed-in: the nav bar / profile avatar appears on the feed.
	await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' })
	await page.waitForTimeout(3000)
	const signedIn = await page
		.locator('svg[aria-label="Home"], a[href="/direct/inbox/"], nav')
		.first()
		.count()
	const state = await context.storageState()
	const igCookies = state.cookies.filter((c) => /instagram/.test(c.domain) && c.name === 'sessionid')
	log(`cookies: ${state.cookies.length}, sessionid present: ${igCookies.length > 0}, signedIn markers: ${signedIn}`)
	if (igCookies.length === 0) {
		log('no sessionid cookie — login likely failed')
		await browser.close()
		process.exit(4)
	}

	const res = await fetch(`${FERMI_URL}/admin/session/capture`, {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			name: 'instagram',
			site: 'https://www.instagram.com',
			storage_state: JSON.stringify(state),
			max_concurrent: 2,
			ttl_seconds: 6 * 3600,
		}),
	})
	const out = await res.json()
	log(res.ok ? `captured "instagram" (${state.cookies.length} cookies)` : `capture failed: ${JSON.stringify(out)}`)
	await browser.close()
	process.exit(res.ok ? 0 : 5)
} catch (e) {
	log('capture error:', String(e.message ?? e).slice(0, 300))
	await page.screenshot({ path: '/tmp/ig-capture-error.png', fullPage: false }).catch(() => {})
	log('debug screenshot: /tmp/ig-capture-error.png  url:', page.url())
	await browser.close().catch(() => {})
	process.exit(1)
}
