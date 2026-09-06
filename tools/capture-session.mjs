#!/usr/bin/env node
// Capture a logged-in web session on the Mac (residential IP) for the Fermi
// session vault. Opens a real headed browser; YOU log in (incl. MFA) once, then
// press Enter here. The Playwright storageState is posted to Fermi and can be
// leased to N cloud boxes — MFA once, replay many.
//
// Usage: node tools/capture-session.mjs <name> <url> [--max N] [--boxes a,b] [--ttl-hours H]
// Requires: FERMI_URL and FERMI_BEARER_TOKEN in env (or .env), `playwright` installed.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

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
const [, , name, url, ...rest] = process.argv
if (!name || !url || !FERMI_URL || !TOKEN) {
	console.error('usage: node tools/capture-session.mjs <name> <url> [--max N] [--boxes a,b] [--ttl-hours H]')
	console.error('       (needs FERMI_URL and FERMI_BEARER_TOKEN in env or .env)')
	process.exit(1)
}
const flag = (k, d) => {
	const i = rest.indexOf(k)
	return i >= 0 ? rest[i + 1] : d
}

const { chromium } = await import('playwright')
const browser = await chromium.launch({ headless: false })
const context = await browser.newContext()
const page = await context.newPage()
await page.goto(url)

console.log(`\n▶ A browser opened at ${url}.`)
console.log('  Log in fully (including any MFA), get to the signed-in state, then press Enter here.')
await new Promise((resolve) => {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	rl.question('  Press Enter once logged in… ', () => {
		rl.close()
		resolve()
	})
})

const state = await context.storageState()
await browser.close()

const body = {
	name,
	site: new URL(url).origin,
	storage_state: JSON.stringify(state),
	max_concurrent: Number(flag('--max', 1)),
	...(flag('--boxes') ? { allowed_boxes: flag('--boxes').split(',') } : {}),
	...(flag('--ttl-hours') ? { ttl_seconds: Number(flag('--ttl-hours')) * 3600 } : {}),
}

const res = await fetch(`${FERMI_URL}/admin/session/capture`, {
	method: 'POST',
	headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
	body: JSON.stringify(body),
})
const out = await res.json()
console.log(res.ok ? `\n✓ Captured session "${name}" (${state.cookies.length} cookies). Boxes can now lease it.` : `\n✗ Capture failed: ${JSON.stringify(out)}`)
process.exit(res.ok ? 0 : 1)
