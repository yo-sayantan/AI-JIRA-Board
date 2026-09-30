import { readFile, unlink } from 'node:fs/promises'
import { PATHS } from './config.mjs'

// Matches the runners' own 1800s ceiling with headroom, so a SIGKILL never wedges Refresh.
const LOCK_MAX_AGE_MS = 45 * 60 * 1000

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return e.code !== 'ESRCH'
  }
}

/**
 * Lock files hold "<pid> <ISO-timestamp>". A lock is stale when its PID is dead, when it is this
 * server's own PID (a leftover from an `exec node` entrypoint), or when a PID-less lock is older
 * than LOCK_MAX_AGE_MS. Stale locks are deleted so the shell runners stop refusing work.
 */
async function lockState(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { held: false, startedAt: null }
  }
  const [pidStr, startedAt = null] = raw.trim().split(/\s+/)
  const pid = Number(pidStr)
  const validPid = Number.isInteger(pid) && pid > 0

  let held
  if (validPid) {
    held = pid !== process.pid && pidAlive(pid)
  } else if (startedAt) {
    const age = Date.now() - Date.parse(startedAt)
    held = Number.isFinite(age) && age <= LOCK_MAX_AGE_MS
  } else {
    held = true
  }

  if (!held) unlink(path).catch(() => {})
  return { held, startedAt }
}

/** Is any data.json writer (daily run or archive rebuild) holding its lock? */
export async function dataLocksHeld() {
  const [daily, archive] = await Promise.all([lockState(PATHS.internLock), lockState(PATHS.completedLock)])
  return { held: daily.held || archive.held, startedAt: daily.startedAt ?? archive.startedAt }
}

export function removeLock(path) {
  return unlink(path).catch(() => {})
}
