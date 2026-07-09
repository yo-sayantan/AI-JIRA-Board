// Optional local server for the board. Zero dependencies.
//
//   node serve.mjs            (or: npm run serve)
//
// Opening the board through this server (http://localhost:4321) unlocks the live
// Refresh button — it runs jira-intern/local-runner/run-intern.sh on your machine
// and reloads when fresh data lands. Without the server the board still works from
// file://; Refresh there just reloads the latest dump.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, normalize } from 'node:path'

const ROOT = import.meta.dirname // the jira-board/ project — everything lives inside it
const INTERN = join(ROOT, 'jira-intern')
const SCRIPT = join(INTERN, 'local-runner/run-intern.sh')
const REFRESH_SCRIPT = join(INTERN, 'local-runner/refresh-ticket.sh')
const DATA = join(INTERN, 'data.json')
const LOCK = join(INTERN, '.intern.lock')
const COMPLETED_LOCK = join(INTERN, '.completed.lock')
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i
// A lock older than this (no live PID) is treated as stale and ignored — matches the
// runner's own 1800s ceiling with headroom, so a SIGKILL/power-loss never wedges Refresh.
const LOCK_MAX_AGE_MS = 45 * 60 * 1000

// Is a lock file currently held by a LIVE run? A lock is stale (→ false) when its PID is
// dead (process.kill(pid,0) throws ESRCH) or its timestamp is older than LOCK_MAX_AGE_MS.
// Reads "<pid> <ISO-timestamp>". Returns { held, startedAt }.
async function lockState(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { held: false, startedAt: null }
  }
  const [pidStr, startedAt] = raw.trim().split(/\s+/)
  const pid = Number(pidStr)
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0) // does not kill — just probes existence
    } catch (e) {
      if (e.code === 'ESRCH') return { held: false, startedAt: startedAt ?? null } // dead PID → stale
      // EPERM: process exists but owned by another user — treat as held.
    }
  }
  if (startedAt) {
    const age = Date.now() - Date.parse(startedAt)
    if (Number.isFinite(age) && age > LOCK_MAX_AGE_MS) return { held: false, startedAt }
  }
  return { held: true, startedAt: startedAt ?? null }
}

/** Any data.json writer running (daily run OR weekly archive)? */
async function anyInternRunning() {
  const [a, b] = await Promise.all([lockState(LOCK), lockState(COMPLETED_LOCK)])
  return { running: a.held || b.held, startedAt: a.startedAt ?? b.startedAt }
}

// Keys currently being refreshed one-by-one in the background.
const refreshing = new Set()
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

let running = false
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
    if (running || locked) return json(res, 409, { ok: false, running: true })
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

  if (path === '/api/refresh-ticket' && req.method === 'POST') {
    const key = (url.searchParams.get('key') || '').trim()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    if (refreshing.has(key)) return json(res, 409, { ok: false, running: true, key })
    // A single-ticket refresh rewrites the SHARED data.json. Refuse if a full daily run
    // or the weekly archive is mid-write, or another refresh is in flight (they too have
    // no data.json lock) — otherwise concurrent writers clobber each other.
    const { running: internBusy } = await anyInternRunning()
    if (internBusy || refreshing.size > 0) return json(res, 409, { ok: false, running: true, key })
    refreshing.add(key)
    try {
      const child = spawn('bash', [REFRESH_SCRIPT, key], { cwd: ROOT, stdio: 'ignore' })
      child.on('exit', () => refreshing.delete(key))
      child.on('error', () => refreshing.delete(key))
    } catch {
      refreshing.delete(key)
      return json(res, 500, { ok: false, key })
    }
    return json(res, 202, { ok: true, started: true, key })
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
    return json(res, 200, { running: running || locked, lastExit, lastRunAt, startedAt, dataModified, refreshingKeys: [...refreshing] })
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🎫  My Jira Board  →  http://localhost:${PORT}${BOARD}`)
  console.log(`      Live Refresh enabled (runs the intern). Press Ctrl+C to stop.\n`)
})
