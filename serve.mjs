// Optional local server for the board. Zero dependencies.
//
//   node serve.mjs            (or: npm run serve)
//
// Opening the board through this server (http://localhost:4321) unlocks the live
// Refresh button — it runs jira-intern/local-runner/run-intern.sh on your machine
// and reloads when fresh data lands. Without the server the board still works from
// file://; Refresh there just reloads the latest dump.
import { createServer } from 'node:http'
import { readFile, stat, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, normalize } from 'node:path'

const ROOT = import.meta.dirname // the jira-board/ project — everything lives inside it
const INTERN = join(ROOT, 'jira-intern')
const SCRIPT = join(INTERN, 'local-runner/run-intern.sh')
const ARCHIVE_SCRIPT = join(INTERN, 'local-runner/update-completed.sh')
const REFRESH_SCRIPT = join(INTERN, 'local-runner/refresh-ticket.sh')
const DATA = join(INTERN, 'data.json')
const LOCK = join(INTERN, '.intern.lock')
const COMPLETED_LOCK = join(INTERN, '.completed.lock')
const PROGRESS = join(INTERN, '.progress.json')
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i
// A lock older than this (no live PID) is treated as stale and ignored — matches the
// runner's own 1800s ceiling with headroom, so a SIGKILL/power-loss never wedges Refresh.
const LOCK_MAX_AGE_MS = 45 * 60 * 1000

// Is a lock file currently held by a LIVE run? A lock is stale (→ false) when its PID is
// dead (process.kill(pid,0) throws ESRCH) or its timestamp is older than LOCK_MAX_AGE_MS.
// Reads "<pid> <ISO-timestamp>". Returns { held, startedAt }.
// Stale lock files are deleted so the shell runners don't keep refusing work after a Docker
// recreate left a dead-PID lock on the mounted volume.
async function lockState(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { held: false, startedAt: null }
  }
  const [pidStr, startedAt] = raw.trim().split(/\s+/)
  const pid = Number(pidStr)
  let live = false
  if (Number.isInteger(pid) && pid > 0) {
    // Never treat OUR OWN pid as an intern lock. Background entrypoint refresh used to
    // write `$$` after `exec node`, leaving a lock that matched this server forever and
    // wedged Refresh / Rebuild archive (always 409 / "already running").
    if (pid === process.pid) {
      unlink(path).catch(() => {})
      return { held: false, startedAt: startedAt ?? null }
    }
    try {
      process.kill(pid, 0) // does not kill — just probes existence
      live = true
    } catch (e) {
      // ESRCH: dead PID → stale. EPERM: process exists but owned by another user → held.
      if (e.code !== 'ESRCH') live = true
    }
  }
  let held = live
  if (!held && startedAt) {
    const age = Date.now() - Date.parse(startedAt)
    // No live PID: a recent lock without a probeable PID is still treated as held (paranoid);
    // an aged-out or dead-PID lock is stale.
    if (!(Number.isInteger(pid) && pid > 0) && Number.isFinite(age) && age <= LOCK_MAX_AGE_MS) {
      held = true
    }
  } else if (!held && !(Number.isInteger(pid) && pid > 0) && !startedAt) {
    held = true // malformed but present — refuse to race it
  }
  if (!held) {
    unlink(path).catch(() => {})
    return { held: false, startedAt: startedAt ?? null }
  }
  return { held: true, startedAt: startedAt ?? null }
}

/** Any data.json writer running (daily run OR weekly archive)? */
async function anyInternRunning() {
  const [a, b] = await Promise.all([lockState(LOCK), lockState(COMPLETED_LOCK)])
  return { running: a.held || b.held, startedAt: a.startedAt ?? b.startedAt }
}

// Per-ticket refresh queue. Writes hit the SHARED data.json, so only ONE child runs at a
// time; later clicks are FIFO-queued instead of 409'd. `refreshActive` is the key currently
// spawning refresh-ticket.sh; `refreshQueue` holds keys waiting their turn (order preserved).
let refreshActive = null
const refreshQueue = []
// Last exit code per key (survives briefly after the child exits so the UI can tell
// "failed" apart from "already up to date"). Cleared when a new refresh for that key starts.
const refreshExits = new Map()
let refreshPumpTimer = null

/** Active key + queued keys, in start order (active first). */
function refreshPendingKeys() {
  return refreshActive ? [refreshActive, ...refreshQueue] : [...refreshQueue]
}

function refreshPendingCount() {
  return (refreshActive ? 1 : 0) + refreshQueue.length
}

/** Start the next queued ticket when idle and no daily/archive writer is mid-flight. */
async function pumpRefreshQueue() {
  if (refreshPumpTimer) {
    clearTimeout(refreshPumpTimer)
    refreshPumpTimer = null
  }
  if (refreshActive) return
  if (refreshQueue.length === 0) return

  // Daily / archive own data.json — wait, don't drop the queue.
  if (running || archiveRunning) {
    refreshPumpTimer = setTimeout(() => {
      refreshPumpTimer = null
      void pumpRefreshQueue()
    }, 2000)
    return
  }
  const { running: internBusy } = await anyInternRunning()
  if (internBusy) {
    refreshPumpTimer = setTimeout(() => {
      refreshPumpTimer = null
      void pumpRefreshQueue()
    }, 2000)
    return
  }

  const key = refreshQueue.shift()
  if (!key) return
  refreshActive = key
  try {
    const child = spawn('bash', [REFRESH_SCRIPT, key], { cwd: ROOT, stdio: 'ignore' })
    child.on('exit', (code, signal) => {
      refreshActive = null
      // signal-kill → treat as failure (non-zero) so the board doesn't claim success.
      refreshExits.set(key, signal ? 1 : (code ?? 1))
      void pumpRefreshQueue()
    })
    child.on('error', () => {
      refreshActive = null
      refreshExits.set(key, 1)
      void pumpRefreshQueue()
    })
  } catch {
    refreshActive = null
    refreshExits.set(key, 1)
    void pumpRefreshQueue()
  }
}
const BOARD = '/dist/index.html'
// Port: env PORT > jira-intern/config.json app.servePort > 4321.
async function configuredPort() {
  try {
    const cfg = JSON.parse(await readFile(join(INTERN, 'config.json'), 'utf8'))
    const p = Number(cfg?.app?.servePort)
    if (Number.isInteger(p) && p > 0) return p
  } catch {}
  return 4321
}
const PORT = Number(process.env.PORT) || (await configuredPort())
// Interface to bind. Defaults to loopback so a laptop run stays private; the Docker image
// sets BIND_HOST=0.0.0.0 so the board is reachable via the published port.
const HOST = process.env.BIND_HOST || '127.0.0.1'

let running = false
let archiveRunning = false
let lastExit = null
let lastRunAt = null

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

const json = (res, code, obj) =>
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj))

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = decodeURIComponent(url.pathname)

  if (path === '/') {
    res.writeHead(302, { Location: BOARD }).end()
    return
  }

  if (path === '/api/run-intern' && req.method === 'POST') {
    const { running: locked } = await anyInternRunning()
    if (running || archiveRunning || locked) return json(res, 409, { ok: false, running: true })
    running = true
    lastRunAt = new Date().toISOString()
    try {
      const child = spawn('bash', [SCRIPT], { cwd: ROOT, stdio: 'ignore' })
      child.on('exit', (code) => {
        running = false
        lastExit = code
      })
      child.on('error', () => {
        running = false
        lastExit = -1
      })
    } catch {
      running = false
      lastExit = -1
    }
    return json(res, 202, { ok: true, started: true })
  }

  // The DEEP job: rebuilds the Completed archive (update-completed.sh). Same data.json as the
  // daily run, so the two never overlap — either being busy 409s the other.
  if (path === '/api/run-archive' && req.method === 'POST') {
    const { running: locked } = await anyInternRunning()
    if (running || archiveRunning || locked || refreshPendingCount() > 0) return json(res, 409, { ok: false, running: true })
    archiveRunning = true
    lastRunAt = new Date().toISOString()
    try {
      const child = spawn('bash', [ARCHIVE_SCRIPT], { cwd: ROOT, stdio: 'ignore' })
      child.on('exit', (code) => {
        archiveRunning = false
        lastExit = code
      })
      child.on('error', () => {
        archiveRunning = false
        lastExit = -1
      })
    } catch {
      archiveRunning = false
      lastExit = -1
    }
    return json(res, 202, { ok: true, started: true })
  }

  if (path === '/api/refresh-ticket' && req.method === 'POST') {
    const key = (url.searchParams.get('key') || '').trim()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    // Already active or queued → idempotent success so the UI can keep watching.
    if (refreshActive === key || refreshQueue.includes(key)) {
      const pending = refreshPendingKeys()
      return json(res, 202, {
        ok: true,
        already: true,
        key,
        active: refreshActive,
        position: pending.indexOf(key),
        pending,
      })
    }
    // Enqueue FIFO. The pump runs one at a time (shared data.json); if a daily/archive
    // run is mid-write the key stays queued until that finishes — never dropped.
    refreshExits.delete(key)
    refreshQueue.push(key)
    void pumpRefreshQueue()
    const pending = refreshPendingKeys()
    return json(res, 202, {
      ok: true,
      queued: true,
      started: refreshActive === key,
      key,
      active: refreshActive,
      position: pending.indexOf(key),
      pending,
    })
  }

  if (path === '/api/intern-status') {
    let dataModified = null
    try {
      dataModified = (await stat(DATA)).mtimeMs
    } catch {}
    // The lock files are the source of truth for "is a run in progress" — they survive this
    // server restarting and are also written by terminal-launched runs. In-memory `running` is a
    // fast backup. Both the daily (.intern.lock) and weekly (.completed.lock) jobs count, and a
    // stale lock (dead PID / too old) is ignored so a killed run never wedges the board.
    const { running: locked, startedAt: lockStartedAt } = await anyInternRunning()
    const startedAt = lockStartedAt ?? lastRunAt
    const isRunning = running || archiveRunning || locked
    // Live ticket-count progress written by daily_fetch / completed_archive (button fill).
    // Drop stale leftovers from a killed run so the button doesn't look mid-progress when idle.
    let progress = null
    if (isRunning) {
      try {
        progress = JSON.parse(await readFile(PROGRESS, 'utf8'))
      } catch {}
    } else {
      unlink(PROGRESS).catch(() => {})
    }
    return json(res, 200, {
      running: isRunning,
      job: archiveRunning ? 'archive' : running ? 'daily' : locked ? 'external' : null,
      lastExit,
      lastRunAt,
      startedAt,
      dataModified,
      // Active + queued (FIFO order). UI spinners use this; do not treat dataModified alone
      // as "this key finished" when several are pending.
      refreshingKeys: refreshPendingKeys(),
      refreshActive,
      refreshQueue: [...refreshQueue],
      // Exit codes for recently finished per-ticket refreshes (key → number).
      refreshExits: Object.fromEntries(refreshExits),
      progress,
    })
  }

  // static files, constrained to ROOT
  const safe = normalize(path).replace(/^(\.\.([/\\]|$))+/, '')
  const file = join(ROOT, safe)
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body)
  } catch {
    res.writeHead(404).end('Not found')
  }
})

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST
  console.log(`\n  🎫  My Jira Board  →  http://${shown}:${PORT}${BOARD}`)
  console.log(`      Live Refresh enabled (runs the intern). Press Ctrl+C to stop.\n`)
})
