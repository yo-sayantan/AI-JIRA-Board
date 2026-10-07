import { readFile, unlink } from 'node:fs/promises'
import { PATHS } from './config.mjs'
import { dataLocksHeld, removeLock } from './locks.mjs'
import { KeyQueue, runCapture, runProcess } from './queue.mjs'

// The daily fetch and the archive rebuild both rewrite data.json, so at most one runs at a time.
// Lock files stay the source of truth (they survive a server restart and cover terminal runs);
// these flags only cover the gap before a runner has written its lock.
const state = {
  daily: false,
  archive: null,
  raised: false,
  lastExit: null,
  lastRunAt: null,
}

export async function dataWriterBusy() {
  if (state.daily || state.archive || state.raised) return true
  return (await dataLocksHeld()).held
}

/** Per-ticket refresh: every click queues, one child at a time, never during a daily/archive run. */
export const ticketRefresh = new KeyQueue({
  run: (key) => runProcess('bash', [PATHS.refreshScript, key]),
  isBlocked: dataWriterBusy,
})

export const MOVE_TARGETS = new Set(['todo', 'prog', 'rev', 'qa', 'done'])
const moving = new Set()

/**
 * Drag-and-drop write-through: transition.py checks the PR / QA gates on live Jira and moves the
 * ticket. It never touches data.json, so it may run while a fetch is busy; on success the usual
 * single-ticket refresh is queued so the board's own copy catches up.
 */
export async function moveTicket(key, target) {
  if (moving.has(key)) return { ok: false, error: `${key} is already being moved` }
  moving.add(key)
  try {
    const { out, code } = await runCapture('python3', [PATHS.transitionPy, key, target])
    let verdict
    try {
      verdict = JSON.parse(out.split('\n').pop() || '')
    } catch {
      verdict = { ok: false, error: code === 127 ? 'python3 is not available' : `transition exited ${code} without a verdict` }
    }
    if (verdict.ok && verdict.moved) ticketRefresh.add(key)
    return verdict
  } finally {
    moving.delete(key)
  }
}

function markStarted() {
  state.lastExit = null
  state.lastRunAt = new Date().toISOString()
  return state.lastRunAt
}

/** Returns the new run's lastRunAt stamp, or null when a writer is already busy. */
export async function startDaily() {
  if (await dataWriterBusy()) return null
  state.daily = true
  const runAt = markStarted()
  runProcess('bash', [PATHS.dailyScript]).then((code) => {
    state.daily = false
    state.lastExit = code
  })
  return runAt
}

/** Raised-by-me only: one quick JQL search merged into data.json — same writer rules. */
export async function startRaised() {
  if (await dataWriterBusy()) return null
  state.raised = true
  const runAt = markStarted()
  runProcess('bash', [PATHS.raisedScript]).then((code) => {
    state.raised = false
    state.lastExit = code
  })
  return runAt
}

/** Refused while any writer (or a queued ticket refresh) would race it on data.json. */
export async function startArchive(scopeEnv) {
  if (ticketRefresh.size > 0 || (await dataWriterBusy())) return null
  const runAt = markStarted()
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
  return runAt
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
  const running = state.daily || !!state.archive || state.raised || locks.held
  let progress = null
  if (running) {
    progress = await readFile(PATHS.progress, 'utf8').then(JSON.parse, () => null)
  } else {
    // A killed run can leave a progress file behind; drop it so the button doesn't look busy.
    unlink(PATHS.progress).catch(() => {})
  }
  return {
    running,
    job: state.archive ? 'archive' : state.daily ? 'daily' : state.raised ? 'raised' : locks.held ? 'external' : null,
    lastExit: state.lastExit,
    lastRunAt: state.lastRunAt,
    startedAt: locks.startedAt ?? state.lastRunAt,
    progress,
  }
}
