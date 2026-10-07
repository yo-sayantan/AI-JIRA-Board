import { unlink } from 'node:fs/promises'
import { PATHS } from './config.mjs'
import { readJson } from './http.mjs'
import { dataLocksHeld, removeLockOwnedBy } from './locks.mjs'
import { KeyQueue, runProcess } from './queue.mjs'

// The daily fetch and the archive rebuild both rewrite data.json, so at most one runs at a time.
// Lock files stay the source of truth (they survive a server restart and cover terminal runs);
// the flags close the two gaps the files cannot. `claiming` is set synchronously before the
// async lock check, so two start requests arriving together cannot both pass it. `daily` and
// `archive` cover the moment between spawning a runner and the runner writing its own lock.
const state = {
  claiming: false,
  daily: false,
  archive: null,
  lastExit: null,
  lastRunAt: null,
}

export async function dataWriterBusy() {
  if (state.claiming || state.daily || state.archive) return true
  return (await dataLocksHeld()).held
}

/** Per-ticket refresh: every click queues, one child at a time, never during a daily/archive run. */
export const ticketRefresh = new KeyQueue({
  run: (key) => runProcess('bash', [PATHS.refreshScript, key]),
  isBlocked: dataWriterBusy,
})

function markStarted() {
  state.lastExit = null
  state.lastRunAt = new Date().toISOString()
  return state.lastRunAt
}

/**
 * Hold the writer slot across the lock check, then run `start` only if nothing else holds it.
 * `start` runs synchronously inside the claim, so whatever flag it sets is up before the claim
 * is released and nothing can slip in between.
 */
async function claimWriter(start) {
  if (state.claiming || state.daily || state.archive) return null
  state.claiming = true
  try {
    if ((await dataLocksHeld()).held) return null
    return start()
  } finally {
    state.claiming = false
  }
}

/** Returns the new run's lastRunAt stamp, or null when a writer is already busy. */
export function startDaily() {
  return claimWriter(() => {
    state.daily = true
    const runAt = markStarted()
    runProcess('bash', [PATHS.dailyScript]).then((code) => {
      state.daily = false
      state.lastExit = code
    })
    return runAt
  })
}

/** Refused while any writer (or a queued ticket refresh) would race it on data.json. */
export function startArchive(scopeEnv) {
  if (ticketRefresh.size > 0) return Promise.resolve(null)
  return claimWriter(() => {
    // A refresh may have queued while the lock check was in flight.
    if (ticketRefresh.size > 0) return null
    const runAt = markStarted()
    let child = null
    // spawn() is synchronous, so onSpawn has set state.archive before start() returns.
    runProcess('bash', [PATHS.archiveScript], {
      env: { ...process.env, ...scopeEnv },
      detached: true,
      onSpawn: (c) => {
        child = c
        state.archive = c
      },
    }).then((code) => {
      if (state.archive !== child) return
      state.archive = null
      state.lastExit = code
    })
    return runAt
  })
}

/**
 * Stop the archive rebuild this server started; resolves false when there is none. A rebuild
 * launched from a terminal or cron is left alone, lock and all: it is not ours to kill.
 */
export async function stopArchive() {
  const child = state.archive
  if (!child?.pid) return false
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  state.archive = null
  // The runner's EXIT trap removes its own lock; this only covers a trap that never ran, and
  // only when the lock still names the child we just killed.
  await Promise.all([unlink(PATHS.progress).catch(() => {}), removeLockOwnedBy(PATHS.completedLock, child.pid)])
  return true
}

export async function runStatus() {
  const locks = await dataLocksHeld()
  const running = state.daily || !!state.archive || locks.held
  let progress = null
  if (running) {
    progress = await readJson(PATHS.progress, null)
    if (progress !== null && (typeof progress !== 'object' || Array.isArray(progress))) progress = null
  } else {
    // A killed run can leave a progress file behind; drop it so the button doesn't look busy.
    unlink(PATHS.progress).catch(() => {})
  }
  return {
    running,
    job: state.archive ? 'archive' : state.daily ? 'daily' : locks.held ? 'external' : null,
    lastExit: state.lastExit,
    lastRunAt: state.lastRunAt,
    startedAt: locks.startedAt ?? state.lastRunAt,
    progress,
  }
}
