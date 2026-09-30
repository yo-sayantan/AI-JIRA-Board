import { readFile, unlink } from 'node:fs/promises'
import { PATHS } from './config.mjs'
import { dataLocksHeld, removeLock } from './locks.mjs'
import { KeyQueue, runProcess } from './queue.mjs'

// The daily fetch and the archive rebuild both rewrite data.json, so at most one runs at a time.
// Lock files stay the source of truth (they survive a server restart and cover terminal runs);
// these flags only cover the gap before a runner has written its lock.
const state = {
  daily: false,
  archive: null,
  lastExit: null,
  lastRunAt: null,
}

export async function dataWriterBusy() {
  if (state.daily || state.archive) return true
  return (await dataLocksHeld()).held
}

/** Per-ticket refresh: every click queues, one child at a time, never during a daily/archive run. */
export const ticketRefresh = new KeyQueue({
  run: (key) => runProcess('bash', [PATHS.refreshScript, key]),
  isBlocked: dataWriterBusy,
})

export async function startDaily() {
  if (await dataWriterBusy()) return false
  state.daily = true
  state.lastRunAt = new Date().toISOString()
  runProcess('bash', [PATHS.dailyScript]).then((code) => {
    state.daily = false
    state.lastExit = code
  })
  return true
}

/** Refused while any writer (or a queued ticket refresh) would race it on data.json. */
export async function startArchive(scopeEnv) {
  if (ticketRefresh.size > 0 || (await dataWriterBusy())) return false
  state.lastRunAt = new Date().toISOString()
  let child = null
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
  return true
}

export function stopArchive() {
  const child = state.archive
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  state.archive = null
  unlink(PATHS.progress).catch(() => {})
  return removeLock(PATHS.completedLock)
}

export async function runStatus() {
  const locks = await dataLocksHeld()
  const running = state.daily || !!state.archive || locks.held
  let progress = null
  if (running) {
    progress = await readFile(PATHS.progress, 'utf8').then(JSON.parse, () => null)
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
