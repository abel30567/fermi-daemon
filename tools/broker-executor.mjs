#!/usr/bin/env node
// Session broker executor (#32). Polls Fermi for browser ops submitted by cloud
// boxes, drives the REAL logged-in session with Playwright locally (on the
// Mac's residential IP), and returns only the requested result. Cookies never
// leave this machine — the box only ever sees op results (text, screenshots).
//
// Trust boundary: this is the ONLY process that fetches decrypted storageState
// (via /admin/session/state, admin bearer). Run it on the Mac, not on a box.
//
// Usage: node tools/broker-executor.mjs   (loops; Ctrl-C to stop)
// Requires: FERMI_URL + FERMI_BEARER_TOKEN in env/.env, `playwright` installed.

import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

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
if (!FERMI_URL || !TOKEN) {
	console.error('need FERMI_URL and FERMI_BEARER_TOKEN')
	process.exit(1)
}
const POLL_MS = Number(env.BROKER_POLL_MS || 2000)

const admin = (path, opts = {}) =>
	fetch(FERMI_URL + path, {
		...opts,
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(opts.headers ?? {}) },
	})

const log = (...a) => console.log(new Date().toISOString(), ...a)

// Cache one browser context per session for the executor's lifetime so repeated
// ops on the same session reuse the login. Re-fetched if the session rotates.
const contexts = new Map() // session -> { browser, context }

async function contextFor(session) {
	if (contexts.has(session)) return contexts.get(session)
	const res = await admin(`/admin/session/state?name=${encodeURIComponent(session)}`)
	if (!res.ok) throw new Error(`session_state_${res.status}`)
	const { storage_state } = await res.json()
	const browser = await chromium.launch()
	const context = await browser.newContext({ storageState: JSON.parse(storage_state) })
	const entry = { browser, context }
	contexts.set(session, entry)
	return entry
}

async function runOp(op) {
	const p = JSON.parse(op.payload)
	const { context } = await contextFor(p.session)
	const page = await context.newPage()
	try {
		switch (p.op) {
			case 'goto':
				await page.goto(p.args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
				return { url: page.url(), title: await page.title() }
			case 'click':
				if (p.args.url) await page.goto(p.args.url, { waitUntil: 'domcontentloaded' })
				await page.locator(p.args.selector).first().click({ timeout: 15_000 })
				return { url: page.url() }
			case 'fill':
				if (p.args.url) await page.goto(p.args.url, { waitUntil: 'domcontentloaded' })
				await page.locator(p.args.selector).first().fill(p.args.value ?? '', { timeout: 15_000 })
				return { url: page.url() }
			case 'extract': {
				if (p.args.url) await page.goto(p.args.url, { waitUntil: 'domcontentloaded' })
				const loc = page.locator(p.args.selector ?? 'body')
				const n = await loc.count()
				const rows = []
				for (let i = 0; i < Math.min(n, 50); i++) rows.push((await loc.nth(i).textContent())?.trim())
				return { rows }
			}
			case 'screenshot': {
				if (p.args.url) await page.goto(p.args.url, { waitUntil: 'domcontentloaded' })
				const buf = await page.screenshot({ fullPage: false })
				return { screenshot_base64: buf.toString('base64') }
			}
			default:
				throw new Error(`unknown_op_${p.op}`)
		}
	} finally {
		await page.close()
	}
}

async function loop() {
	log('broker executor up; polling', FERMI_URL)
	for (;;) {
		let op = null
		try {
			const res = await admin('/admin/broker/claim', { method: 'POST', body: '{}' })
			op = (await res.json()).op
		} catch (e) {
			log('claim error', String(e))
		}
		if (!op) {
			await new Promise((r) => setTimeout(r, POLL_MS))
			continue
		}
		const p = JSON.parse(op.payload)
		log(`op ${op.id} ${p.op} on ${p.session}`)
		try {
			const data = await runOp(op)
			await admin('/admin/broker/complete', {
				method: 'POST',
				body: JSON.stringify({ op_id: op.id, ok: true, data }),
			})
		} catch (e) {
			log(`op ${op.id} failed:`, String(e))
			// Session may have rotated/invalidated — drop the cached context.
			const ctx = contexts.get(p.session)
			if (ctx) {
				await ctx.browser.close().catch(() => {})
				contexts.delete(p.session)
			}
			await admin('/admin/broker/complete', {
				method: 'POST',
				body: JSON.stringify({ op_id: op.id, ok: false, error: String(e.message ?? e) }),
			})
		}
	}
}

loop().catch((e) => {
	console.error(e)
	process.exit(1)
})
