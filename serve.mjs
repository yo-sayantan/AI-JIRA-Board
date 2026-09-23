// Optional local server for the board. Zero dependencies.
//
//   node serve.mjs            (or: npm run serve)
//
// Opening the board through this server (http://localhost:4321) unlocks the live
// Refresh button — it runs jira-intern/local-runner/run-intern.sh on your machine
// and reloads when fresh data lands. Without the server the board still works from
// file://; Refresh there just reloads the latest dump.
import { createServer } from 'node:http'
import { readFile, readdir, stat, unlink, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, normalize } from 'node:path'
import { cfg as PROJECT_CONFIG } from './jira-intern/local-runner/config.mjs'

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
// PR Readiness Report queue — mirrors the refresh queue. Reports write ONLY jira-intern/reports/
// (never data.json) but they read data.json and run the agent, so they wait for data writers and
// run one at a time. Generations started elsewhere (cron backfill, terminal) register themselves
// in reports/.status.json (pid + startedAt); /api/intern-status merges both so the board shows
// "generating" regardless of who started it.
const REPORT_SCRIPT = join(INTERN, 'local-runner/pr-report.sh')
const REPORTS_DIR = join(INTERN, 'reports')
const REPORTS_STATUS = join(REPORTS_DIR, '.status.json')
const SETTINGS_FILE = join(INTERN, '.settings.json')
const AI_QUEUE = join(INTERN, '.ai-queue')
const AI_INTERN = process.env.AI_INTERN_URL || 'http://127.0.0.1:4322'
const AI_LEVELS = ['none', 'low', 'moderate', 'full']
const AI_BACKENDS = ['local', 'cloud']
let reportActive = null
const reportQueue = []
const reportExits = new Map()
let reportPumpTimer = null

function reportPendingKeys() {
  return reportActive ? [reportActive, ...reportQueue] : [...reportQueue]
}

async function readBoardSettings() {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function aiQueueKeys() {
  try {
    const names = await readdir(AI_QUEUE)
    const keys = []
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      try {
        const j = JSON.parse(await readFile(join(AI_QUEUE, n), 'utf8'))
        if (j.type === 'enrich-report' && j.key) keys.push(String(j.key).toUpperCase())
      } catch {}
    }
    return keys
  } catch {
    return []
  }
}

async function enqueueEnrich(key, settings) {
  await mkdir(AI_QUEUE, { recursive: true })
  const id = `${Date.now()}-${key}`
  const backend = settings.aiBackend === 'cloud' ? 'cloud' : 'local'
  const job = {
    id,
    type: 'enrich-report',
    key,
    level: AI_LEVELS.includes(settings.aiLevel) ? settings.aiLevel : 'moderate',
    backend,
    model:
      backend === 'cloud'
        ? settings.aiCloudModel || ''
        : settings.aiLocalModel || 'qwen2.5-coder:7b',
    useHostOllama: !!settings.aiUseHostOllama,
    enqueuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  await writeFile(join(AI_QUEUE, `${id}.json`), JSON.stringify(job, null, 2) + '\n')
}

function runPython(args) {
  return new Promise((resolve) => {
    try {
      const child = spawn('python3', args, { cwd: ROOT, stdio: 'ignore' })
      child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
      child.on('error', () => resolve(1))
    } catch {
      resolve(1)
    }
  })
}

async function proxyAi(req, res, destPath) {
  try {
    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = Buffer.concat(chunks)
    }
    const r = await fetch(`${AI_INTERN}${destPath}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const text = await r.text()
    res
      .writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      })
      .end(text)
  } catch {
    json(res, 503, { ok: false, down: true, state: 'down', error: 'AI intern unreachable' })
  }
}

async function localAiCatalog() {
  try {
    return JSON.parse(await readFile(join(ROOT, 'ai-intern/models.json'), 'utf8'))
  } catch {
    return { models: [], defaultLocal: 'qwen2.5-coder:7b' }
  }
}

async function internAiStatus() {
  const queued = await aiQueueKeys()
  try {
    const r = await fetch(`${AI_INTERN}/api/status`, { signal: AbortSignal.timeout(4000) })
    const body = await r.json()
    return { ...body, ok: body.ok !== false, queuedKeys: queued, queued: queued.length }
  } catch {
    return {
      ok: false,
      down: true,
      state: 'down',
      queuedKeys: queued,
      queued: queued.length,
      error: 'AI intern unreachable',
      catalog: await localAiCatalog(),
    }
  }
}

async function pumpReportQueue() {
  if (reportPumpTimer) {
    clearTimeout(reportPumpTimer)
    reportPumpTimer = null
  }
  if (reportActive || reportQueue.length === 0) return
  const { running: internBusy } = await anyInternRunning()
  if (running || archiveRunning || internBusy) {
    reportPumpTimer = setTimeout(() => {
      reportPumpTimer = null
      void pumpReportQueue()
    }, 2000)
    return
  }
  const key = reportQueue.shift()
  if (!key) return
  reportActive = key
  const done = (code) => {
    reportActive = null
    reportExits.set(key, code)
    void pumpReportQueue()
  }
  try {
    const child = spawn('python3', [join(INTERN, 'pr_report.py'), 'base', key], { cwd: ROOT, stdio: 'ignore' })
    child.on('exit', async (code, signal) => {
      const exit = signal ? 1 : (code ?? 1)
      if (exit === 0) {
        const settings = await readBoardSettings()
        if ((settings.aiLevel || 'moderate') !== 'none') {
          try {
            await enqueueEnrich(key, settings)
          } catch (e) {
            console.error('enqueue enrich failed', e)
          }
        }
      }
      done(exit)
    })
    child.on('error', () => done(1))
  } catch {
    done(1)
  }
}

/**
 * Which tickets should a bulk run cover? pr_report.py already owns that decision (it knows which
 * tickets have a PR and whether a stored report still matches the PR fingerprint), so we ask it
 * rather than re-implementing the rules here. Spawned with an ARGUMENT ARRAY and pre-validated
 * values — never a shell string — so a crafted `since`/`year` can't turn into a command.
 */
function resolveReportKeys({ year, since, force }) {
  const args = [join(INTERN, 'pr_report.py'), 'needs-report']
  if (year) args.push('--year', String(year))
  if (since) args.push('--since', since)
  if (force) args.push('--force')
  return new Promise((resolve) => {
    let out = ''
    try {
      const child = spawn('python3', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.on('data', (d) => {
        out += d
      })
      child.on('error', () => resolve([]))
      child.on('close', () =>
        resolve(
          out
            .split('\n')
            .map((s) => s.trim().toUpperCase())
            .filter((s) => KEY_RE.test(s)),
        ),
      )
    } catch {
      resolve([])
    }
  })
}

/** Keys some OTHER process is generating right now (reports/.status.json) — dead PIDs ignored. */
async function externalGenerating() {
  try {
    const st = JSON.parse(await readFile(REPORTS_STATUS, 'utf8'))
    const out = []
    for (const [key, v] of Object.entries(st?.generating || {})) {
      const pid = Number(v?.pid)
      if (!Number.isInteger(pid) || pid <= 0) continue
      try {
        process.kill(pid, 0)
        out.push(key)
      } catch (e) {
        if (e.code !== 'ESRCH') out.push(key)
      }
    }
    return out
  } catch {
    return []
  }
}

/** Header-only index of every report on disk (key → verdict/generatedAt/enriched/fingerprint). */
async function reportsIndex() {
  const out = {}
  let names = []
  try {
    names = await readdir(REPORTS_DIR)
  } catch {
    return out
  }
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue
    try {
      const r = JSON.parse(await readFile(join(REPORTS_DIR, n), 'utf8'))
      if (r && typeof r.key === 'string') {
        out[r.key] = {
          key: r.key,
          title: r.title ?? null,
          generatedAt: r.generatedAt ?? null,
          enrichedAt: r.enrichedAt ?? null,
          enriched: !!r.enriched,
          fingerprint: r.fingerprint ?? null,
          verdict: r.verdict ?? null,
        }
      }
    } catch {}
  }
  return out
}

const BOARD = '/dist/index.html'
// Port: env PORT > merged project config → app.servePort.
const PORT = Number(process.env.PORT) || Number(PROJECT_CONFIG.app?.servePort) || 4321
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

  // ── PR Readiness Reports ────────────────────────────────────────────────────
  if (path === '/api/reports' && req.method === 'GET') {
    const [reports, external, queued] = await Promise.all([reportsIndex(), externalGenerating(), aiQueueKeys()])
    return json(res, 200, {
      reports,
      generating: [...new Set([...reportPendingKeys(), ...external, ...queued])],
      exits: Object.fromEntries(reportExits),
    })
  }
  if (path.startsWith('/api/reports/') && req.method === 'GET') {
    const key = path.slice('/api/reports/'.length).trim().toUpperCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    try {
      const body = await readFile(join(REPORTS_DIR, `${key}.json`))
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }).end(body)
    } catch {
      json(res, 404, { ok: false, error: 'no report yet' })
    }
    return
  }
  // Board settings the shell runners need. Written to jira-intern/.settings.json (git-ignored)
  // rather than into config.json — that file may resolve to the user's personal ~/.ai/config.json,
  // which the board has no business rewriting.
  if (path === '/api/settings' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 4096) return json(res, 413, { ok: false, error: 'too large' })
    }
    let patch
    try {
      patch = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'bad json' })
    }
    const LEVELS = ['none', 'low', 'moderate', 'full']
    const BACKENDS = ['local', 'cloud']
    if (patch.aiLevel !== undefined && !LEVELS.includes(patch.aiLevel)) {
      return json(res, 400, { ok: false, error: 'bad aiLevel' })
    }
    if (patch.aiBackend !== undefined && !BACKENDS.includes(patch.aiBackend)) {
      return json(res, 400, { ok: false, error: 'bad aiBackend' })
    }
    if (patch.aiLocalModel !== undefined && (typeof patch.aiLocalModel !== 'string' || patch.aiLocalModel.length > 80)) {
      return json(res, 400, { ok: false, error: 'bad aiLocalModel' })
    }
    if (patch.aiCloudModel !== undefined && (typeof patch.aiCloudModel !== 'string' || patch.aiCloudModel.length > 80)) {
      return json(res, 400, { ok: false, error: 'bad aiCloudModel' })
    }
    let current = {}
    try {
      current = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
    } catch {}
    const next = { ...current }
    if (patch.aiLevel !== undefined) next.aiLevel = patch.aiLevel
    if (patch.aiBackend !== undefined) next.aiBackend = patch.aiBackend
    if (patch.aiLocalModel !== undefined) next.aiLocalModel = patch.aiLocalModel
    if (patch.aiCloudModel !== undefined) next.aiCloudModel = patch.aiCloudModel
    if (patch.aiUseHostOllama !== undefined) next.aiUseHostOllama = !!patch.aiUseHostOllama
    try {
      await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n')
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
    return json(res, 200, { ok: true, settings: next })
  }
  if (path === '/api/settings' && req.method === 'GET') {
    try {
      return json(res, 200, { ok: true, settings: JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) })
    } catch {
      return json(res, 200, { ok: true, settings: {} })
    }
  }

  // Bulk generation — every ticket with a PR, a year, a date window, or an explicit selection.
  // Queued one at a time through the same pump as single reports, so a 40-ticket run never
  // stampedes the agent or collides with a data fetch.
  if (path === '/api/reports/bulk' && req.method === 'POST') {
    const scope = (url.searchParams.get('scope') || 'all').trim()
    const force = url.searchParams.get('force') === '1'
    let keys = []
    if (scope === 'keys') {
      keys = (url.searchParams.get('keys') || '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => KEY_RE.test(s))
    } else {
      const yearRaw = (url.searchParams.get('year') || '').trim()
      const sinceRaw = (url.searchParams.get('since') || '').trim()
      const year = scope === 'year' && /^\d{4}$/.test(yearRaw) ? yearRaw : null
      const since = scope === 'since' && /^\d{4}-\d{2}-\d{2}$/.test(sinceRaw) ? sinceRaw : null
      if (scope === 'year' && !year) return json(res, 400, { ok: false, error: 'bad year' })
      if (scope === 'since' && !since) return json(res, 400, { ok: false, error: 'bad since date' })
      keys = await resolveReportKeys({ year, since, force })
    }
    // Skip anything already in flight — ours OR a terminal/cron backfill's. Two agents writing
    // the same reports/<KEY>.json would race, and the loser's half-written file is what sticks.
    const pending = new Set([...reportPendingKeys(), ...(await externalGenerating())])
    const queued = []
    for (const key of keys) {
      if (pending.has(key)) continue
      pending.add(key)
      reportExits.delete(key)
      reportQueue.push(key)
      queued.push(key)
    }
    void pumpReportQueue()
    return json(res, 202, { ok: true, scope, matched: keys.length, queued, pending: reportPendingKeys() })
  }
  // Generate (or regenerate) one ticket's report in the background. Idempotent while queued.
  if (path === '/api/report' && req.method === 'POST') {
    const key = (url.searchParams.get('key') || '').trim().toUpperCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    if (reportActive === key || reportQueue.includes(key)) {
      return json(res, 202, { ok: true, already: true, key, pending: reportPendingKeys() })
    }
    reportExits.delete(key)
    reportQueue.push(key)
    void pumpReportQueue()
    return json(res, 202, { ok: true, queued: true, key, pending: reportPendingKeys() })
  }

  if (path === '/api/ai-status' && req.method === 'GET') {
    return json(res, 200, await internAiStatus())
  }
  if (path === '/api/ai-models' && req.method === 'GET') {
    const intern = await internAiStatus()
    if (intern.down) {
      return json(res, 200, {
        ok: false,
        down: true,
        catalog: intern.catalog || (await localAiCatalog()),
        installed: intern.installedModels || [],
        ollamaOk: false,
      })
    }
    await proxyAi(req, res, '/api/models')
    return
  }
  if (path === '/api/ai-models/pull' && req.method === 'POST') {
    await proxyAi(req, res, '/api/models/pull')
    return
  }
  if (path === '/api/ai-jobs' && req.method === 'POST') {
    await proxyAi(req, res, '/api/jobs')
    return
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
      // PR Readiness Reports in flight: this server's queue ∪ cron/terminal generations.
      reportsGenerating: [...new Set([...reportPendingKeys(), ...(await externalGenerating()), ...(await aiQueueKeys())])],
      reportExits: Object.fromEntries(reportExits),
      ai: await internAiStatus(),
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
