import { readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { PATHS } from './config.mjs'

// Two staleness rules, mirrored by lock-util.sh for the shell runners:
//   • PID rule — a lock whose PID is dead (or is this server's own PID, a leftover from an
//     `exec node` entrypoint) is stale at once. This is what recovers from a SIGKILLed runner,
//     whose EXIT trap never got to remove its lock.
//   • Age rule — a lock with no usable PID is stale after LOCK_MAX_AGE_MS: the runners' 1800 s
//     daily ceiling with headroom, since age is all there is to go on.
// A live PID keeps the lock held however old it is (an archive legitimately runs for hours), but
// HARD_MAX_AGE_MS bounds even that: after a container recreate the PID can belong to an unrelated
// process, and nothing here holds data.json for anything like that long.
const LOCK_MAX_AGE_MS = 45 * 60 * 1000
const HARD_MAX_AGE_MS = 8 * 60 * 60 * 1000

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
 * Lock files hold "<pid> <ISO-timestamp> [<hostname>]". PID 0 and PID 1 (a container's init) can
 * never be a runner, so they count as no PID. When the lock names a different host (the Mac vs
 * this container — separate PID namespaces), the PID is meaningless here, so only the age rules
 * apply. Stale locks are deleted so the shell runners stop refusing work.
 */
async function lockState(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { held: false, startedAt: null }
  }
  const [pidStr, startedAt = null, owner = null] = raw.trim().split(/\s+/)
  const pid = Number(pidStr)
  const sameHost = !owner || owner === hostname()
  const validPid = sameHost && Number.isInteger(pid) && pid > 1
  const age = startedAt ? Date.now() - Date.parse(startedAt) : NaN

  let held
  if (Number.isFinite(age) && age > HARD_MAX_AGE_MS) {
    held = false
  } else if (validPid) {
    held = pid !== process.pid && pidAlive(pid)
  } else if (startedAt) {
    held = Number.isFinite(age) && age <= LOCK_MAX_AGE_MS
  } else {
    held = true
  }

  // Awaited: a fire-and-forget unlink could land after a runner spawned a moment later has
  // written its fresh lock, and delete that instead.
  if (!held) await unlink(path).catch(() => {})
  return { held, startedAt }
}

/** Is any data.json writer (daily run or archive rebuild) holding its lock? */
export async function dataLocksHeld() {
  const [daily, archive] = await Promise.all([lockState(PATHS.internLock), lockState(PATHS.completedLock)])
  return { held: daily.held || archive.held, startedAt: daily.startedAt ?? archive.startedAt }
}

/** Delete `path` only if it records `pid` as its owner; a lock written by anyone else stays put. */
export async function removeLockOwnedBy(path, pid) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return false
  }
  if (raw.trim().split(/\s+/)[0] !== String(pid)) return false
  await unlink(path).catch(() => {})
  return true
}
