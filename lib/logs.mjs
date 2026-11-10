// logs.mjs — the daemon's persisted logs: owner-only (0600) and redacted line by line
// (lib/redact.mjs), and runs/ pruned after RUNS_RETENTION_DAYS.
import { createWriteStream, fchmodSync, lstatSync, openSync, readdirSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { createLineRedactor } from './redact.mjs'

// A write stream to `path` (opened now, so it exists on return) that redacts every line.
// The file is 0600 even if it already existed (poll.sh's `>>` creates it first).
export function openLog(path, flags = 'a') {
  const fd = openSync(path, flags, 0o600)
  fchmodSync(fd, 0o600)
  const file = createWriteStream(null, { fd })
  const r = createLineRedactor()
  return new Writable({
    decodeStrings: false,
    write(chunk, _enc, cb) {
      const s = r.write(String(chunk))
      if (s) file.write(s, cb)
      else cb()
    },
    final(cb) {
      const s = r.end()
      if (s) file.write(s)
      file.end(cb)
    },
  })
}

// Regular files directly under `dir` (none if it does not exist).
function files(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  return names.map((n) => [join(dir, n), lstatSync(join(dir, n))]).filter(([, st]) => st.isFile())
}

// chmod 0600 every file under `dirs` that group or others can access (logs written before DMN-51).
export function secureLogs(dirs) {
  for (const dir of dirs) for (const [path, st] of files(dir)) if (st.mode & 0o077) chmodSync(path, 0o600)
}

// Removes files under `dir` last modified more than `days` days ago; days <= 0 keeps everything.
// Returns how many were removed.
export function pruneRuns(dir, days, now = Date.now()) {
  if (!(days > 0)) return 0
  const old = files(dir).filter(([, st]) => st.mtimeMs < now - days * 86_400_000)
  for (const [path] of old) rmSync(path, { force: true })
  return old.length
}
