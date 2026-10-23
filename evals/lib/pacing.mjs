// Pacing for runs that share one inference subscription. Every attempt of a run
// with --auth proxy|keychain|fd holds that backend's lock file,
// ~/.agent-orch/evals/locks/<backend>.lock, so concurrent runner processes on the
// same backend run their attempts one at a time, and starts at least --min-gap-ms
// after the previous attempt on that backend ended (in any process).
// The lock is advisory: an exclusively created file holding the owner's pid. A lock
// whose pid is gone is stale and is removed, under a short-lived steal lock so two
// processes recovering it at once cannot remove each other's fresh lock. So is an
// empty lock older than EMPTY_STALE_MS: its creator died before writing its pid.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const LOCKED_BACKENDS = ['proxy', 'keychain', 'fd']
const STEAL_STALE_MS = 10_000 // a steal lock is only held for an unlink; older means its holder died
const EMPTY_STALE_MS = 5_000 // an empty lock is one being written; this old, its writer died

export const lockDir = (home = homedir()) => join(home, '.agent-orch/evals/locks')

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// O_EXCL create; → true if this process now owns `path`.
function create(path) {
  try {
    const fd = openSync(path, 'wx')
    try {
      writeSync(fd, `${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

// The lock's owner pid; an empty file is a lock being written, so counts as live.
const owner = (path) => Number(read(path)?.trim()) || null

// Its owner is dead, or it is still empty EMPTY_STALE_MS after it was created.
function stale(path) {
  const pid = owner(path)
  if (pid) return !alive(pid)
  try {
    return read(path)?.trim() === '' && Date.now() - statSync(path).mtimeMs > EMPTY_STALE_MS
  } catch {
    return false
  }
}

function recoverStale(path) {
  const steal = `${path}.steal`
  if (!create(steal)) {
    try {
      if (Date.now() - statSync(steal).mtimeMs > STEAL_STALE_MS) unlinkSync(steal)
    } catch {}
    return
  }
  try {
    if (stale(path)) unlinkSync(path) // re-checked under the steal lock
  } catch {
  } finally {
    try {
      unlinkSync(steal)
    } catch {}
  }
}

// Wait for `path`, then hold it; → release().
export async function acquireLock(path, { pollMs = 100 } = {}) {
  for (;;) {
    if (create(path)) {
      let held = true
      return () => {
        if (held && owner(path) === process.pid) unlinkSync(path)
        held = false
      }
    }
    if (stale(path)) recoverStale(path)
    await sleep(pollMs)
  }
}

// → { run(fn) }: fn() with this backend's lock held, minGapMs after the last attempt ended.
// `--auth none` has no shared subscription: no lock, the gap is per process.
export function createPacer({ backend = 'none', minGapMs = 0, home, pollMs } = {}) {
  const locked = LOCKED_BACKENDS.includes(backend)
  const dir = lockDir(home)
  const lock = join(dir, `${backend}.lock`)
  const last = join(dir, `${backend}.last`) // when the backend's last attempt ended (ms)
  let lastEnd = 0
  return {
    lockPath: locked ? lock : null,
    async run(fn) {
      let release = () => {}
      if (locked) {
        mkdirSync(dir, { recursive: true })
        release = await acquireLock(lock, { pollMs })
      }
      try {
        const prev = Math.max(lastEnd, locked ? Number(read(last)) || 0 : 0)
        const wait = prev + minGapMs - Date.now()
        if (minGapMs > 0 && wait > 0) await sleep(wait)
        return await fn()
      } finally {
        lastEnd = Date.now()
        if (locked) writeFileSync(last, `${lastEnd}\n`)
        release()
      }
    },
  }
}
