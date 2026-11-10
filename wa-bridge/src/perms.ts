import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const AUTH_UMASK = 0o077
const DIR_MODE = 0o700
const FILE_MODE = 0o600

type Failure = { path: string; code: string }

// Make the WhatsApp session dir owner-only: umask 077 for everything this process
// creates from now on, then repair what is already on disk (dirs 0700, files 0600).
// Never throws: a failed chmod (read-only FS, foreign owner) is logged loudly and the
// bridge keeps going. Entries that vanish mid-walk (a second bridge, Baileys rotating
// keys) are skipped silently. Symlinks are not followed or chmodded.
export function lockDownAuthDir(dir: string, log: (msg: string) => void, chmod = chmodSync): Failure[] {
	process.umask(AUTH_UMASK)
	const failures: Failure[] = []
	const fail = (path: string, err: unknown): void => {
		const code = (err as NodeJS.ErrnoException).code ?? String(err)
		if (code !== 'ENOENT') failures.push({ path, code })
	}

	try {
		mkdirSync(dir, { recursive: true, mode: DIR_MODE })
	} catch (err) {
		fail(dir, err)
	}

	const walk = (path: string): void => {
		let st
		try {
			st = lstatSync(path)
		} catch (err) {
			fail(path, err)
			return
		}
		if (st.isSymbolicLink()) return
		const want = st.isDirectory() ? DIR_MODE : FILE_MODE
		try {
			if ((st.mode & 0o777) !== want) chmod(path, want)
		} catch (err) {
			// Keep going: the children may still be fixable.
			fail(path, err)
		}
		if (!st.isDirectory()) return
		let names: string[]
		try {
			names = readdirSync(path)
		} catch (err) {
			fail(path, err)
			return
		}
		for (const name of names) walk(join(path, name))
	}
	walk(dir)

	for (const f of failures) {
		log(`SECURITY WARNING: could not lock down ${f.path} (${f.code}) — WhatsApp credentials may be readable by other users.`)
	}
	if (failures.length > 0) {
		log(
			`SECURITY WARNING: ${failures.length} path(s) under ${dir} are not owner-only. Fix by hand: ` +
				`find '${dir}' -type d -exec chmod 700 {} + && find '${dir}' -type f -exec chmod 600 {} +`,
		)
	}
	return failures
}
