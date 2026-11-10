import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, rmSync, symlinkSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useMultiFileAuthState } from 'baileys'
import { lockDownAuthDir } from '../src/perms.ts'

const root = mkdtempSync(join(tmpdir(), 'wa-perms-'))
const initialUmask = process.umask()
after(() => {
	process.umask(initialUmask)
	rmSync(root, { recursive: true, force: true })
})

const mode = (p: string): number => statSync(p).mode & 0o777

// Every non-symlink under dir that has any group/other bit — i.e. what
// `find dir -perm /go+rwx` (GNU) / the gates.sh scan would report.
function leaky(dir: string): string[] {
	const out: string[] = []
	const walk = (p: string): void => {
		const st = lstatSync(p)
		if (st.isSymbolicLink()) return
		if (st.mode & 0o077) out.push(p)
		if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n))
	}
	walk(dir)
	return out
}

test('pre-existing 0644 dir is repaired: dirs 0700, files 0600, symlink targets untouched', () => {
	const dir = join(root, 'repair')
	mkdirSync(join(dir, 'sub'), { recursive: true })
	writeFileSync(join(dir, 'creds.json'), '{}')
	writeFileSync(join(dir, 'sub', 'pre-key-1.json'), '{}')
	const outside = join(root, 'outside.txt')
	writeFileSync(outside, 'x')
	chmodSync(outside, 0o644)
	symlinkSync(outside, join(dir, 'link'))
	chmodSync(join(dir, 'creds.json'), 0o644)
	chmodSync(join(dir, 'sub', 'pre-key-1.json'), 0o644)
	chmodSync(join(dir, 'sub'), 0o755)
	chmodSync(dir, 0o644) // not even traversable until repaired

	const logs: string[] = []
	const failures = lockDownAuthDir(dir, (m) => logs.push(m))

	assert.deepEqual(failures, [])
	assert.deepEqual(logs, [])
	assert.equal(mode(dir), 0o700)
	assert.equal(mode(join(dir, 'sub')), 0o700)
	assert.equal(mode(join(dir, 'creds.json')), 0o600)
	assert.equal(mode(join(dir, 'sub', 'pre-key-1.json')), 0o600)
	assert.equal(mode(outside), 0o644)
	assert.deepEqual(leaky(dir), [])
})

test('missing auth dir is created 0700 and new Baileys creds/keys files are born 0600', async () => {
	process.umask(0o022)
	const dir = join(root, 'fresh', 'wa-auth')
	lockDownAuthDir(dir, () => {})
	assert.equal(process.umask(), 0o077)
	assert.equal(mode(dir), 0o700)

	const { state, saveCreds } = await useMultiFileAuthState(dir)
	await saveCreds()
	await state.keys.set({ 'app-state-sync-version': { regular: { version: 1, hash: Buffer.alloc(0), indexValueMap: {} } } } as any)
	const files = readdirSync(dir)
	assert.ok(files.includes('creds.json'), `creds.json written: ${files}`)
	assert.ok(files.length >= 2, `key file written: ${files}`)
	for (const f of files) assert.equal(mode(join(dir, f)), 0o600, f)
	assert.deepEqual(leaky(dir), [])
})

test('read-only FS: chmod failures are logged loudly and do not throw', () => {
	const dir = join(root, 'rofs')
	mkdirSync(dir)
	writeFileSync(join(dir, 'creds.json'), '{}')
	chmodSync(join(dir, 'creds.json'), 0o644)
	chmodSync(dir, 0o755)
	const erofs = (): never => {
		throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
	}

	const logs: string[] = []
	const failures = lockDownAuthDir(dir, (m) => logs.push(m), erofs)

	assert.deepEqual(failures, [
		{ path: dir, code: 'EROFS' },
		{ path: join(dir, 'creds.json'), code: 'EROFS' },
	])
	assert.equal(logs.length, 3)
	assert.ok(logs.every((l) => l.startsWith('SECURITY WARNING:')), logs.join('\n'))
	assert.match(logs[0], /rofs \(EROFS\)/)
	assert.match(logs[1], /creds\.json \(EROFS\)/)
	assert.match(logs[2], /chmod 700 .*chmod 600/)
})

test('concurrent bridge instances: parallel repairs while files churn never fail or warn', async () => {
	const dir = join(root, 'concurrent')
	mkdirSync(dir)
	for (let i = 0; i < 50; i++) writeFileSync(join(dir, `pre-key-${i}.json`), '{}', { mode: 0o644 })
	const perms = fileURLToPath(new URL('../src/perms.ts', import.meta.url))
	const repairer = `
		import { lockDownAuthDir } from ${JSON.stringify(perms)}
		let n = 0
		const end = performance.now() + 1000
		while (performance.now() < end) n += lockDownAuthDir(${JSON.stringify(dir)}, console.log).length
		process.exit(n === 0 ? 0 : 1)`
	// Mimics Baileys rotating keys: files appear (0644, foreign umask) and vanish mid-walk.
	const churner = `
		import { writeFileSync, rmSync } from 'node:fs'
		const end = performance.now() + 1200
		for (let i = 0; performance.now() < end; i++) {
			const p = ${JSON.stringify(dir)} + '/pre-key-' + (i % 50) + '.json'
			if (Math.floor(i / 50) % 2) rmSync(p, { force: true }); else writeFileSync(p, '{}', { mode: 0o644 })
		}`
	const run = (src: string): Promise<{ code: number | null; out: string }> =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] })
			let out = ''
			child.stdout.on('data', (d) => (out += d))
			child.stderr.on('data', (d) => (out += d))
			child.on('close', (code) => resolve({ code, out }))
		})

	const results = await Promise.all([run(repairer), run(repairer), run(churner)])
	for (const r of results) {
		assert.equal(r.code, 0, r.out)
		assert.doesNotMatch(r.out, /SECURITY WARNING/)
	}
	assert.deepEqual(lockDownAuthDir(dir, () => {}), [])
	assert.deepEqual(leaky(dir), [])
})
