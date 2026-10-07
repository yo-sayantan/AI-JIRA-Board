// Optional local server for the board. Zero dependencies.
//
//   node serve.mjs            (or: npm run serve)
//
// Serving the board (http://localhost:4321) unlocks the live Refresh button, per-ticket refresh,
// the archive rebuild and PR report generation. Without it the board still works from file://.
import { createServer } from 'node:http'
import { stat } from 'node:fs/promises'
import { BOARD_PATH, DATE_RE, HOST, KEY_RE, PATHS, PORT, ROOT, YEAR_RE } from './server/config.mjs'
import { createStaticHandler, json, readBody } from './server/http.mjs'
import { runStatus, startArchive, startDaily, startRaised, stopArchive, ticketRefresh } from './server/jobs.mjs'
import { externalGenerating, readReport, reportQueue, reportsIndex, resolveReportKeys, stopReports } from './server/reports.mjs'
import { aiStatus, enrichingKeys, localCatalog, proxyAi } from './server/ai.mjs'
import { readBoardSettings, updateBoardSettings } from './server/settings.mjs'
import { startScheduler } from './server/schedule.mjs'

const serveStatic = createStaticHandler(ROOT, [
  /^\/dist\//,
  /^\/docs\//,
  /^\/setup\//,
  /^\/ai-intern\/models\.json$/,
  /^\/jira-intern\/data\.js(on)?$/,
  /^\/jira-intern\/reports\/index\.js$/,
])

const param = (url, name) => (url.searchParams.get(name) || '').trim()

async function reportsGenerating() {
  return [...new Set([...reportQueue.pending, ...(await externalGenerating())])]
}

/** Archive scope from the query string, or an error message. */
function archiveScope(url) {
  const scope = param(url, 'scope').toLowerCase() || 'all'
  const year = param(url, 'year')
  const since = param(url, 'since')
  const key = param(url, 'key').toUpperCase()
  if (!['all', 'year', 'since', 'key'].includes(scope)) return { error: 'bad scope' }
  if (scope === 'key' && !KEY_RE.test(key)) return { error: 'bad key' }
  if (scope === 'year' && !YEAR_RE.test(year)) return { error: 'bad year' }
  if (scope === 'since' && !DATE_RE.test(since)) return { error: 'bad since' }
  const env = { ARCHIVE_SCOPE: scope }
  if (scope === 'year') env.ARCHIVE_YEAR = year
  if (scope === 'since') env.ARCHIVE_SINCE = since
  if (scope === 'key') env.ARCHIVE_KEY = key
  return { env }
}

/** Ticket keys for a bulk report run, or an error message. */
async function bulkReportKeys(url) {
  const scope = param(url, 'scope') || 'all'
  if (scope === 'keys') {
    return {
      keys: param(url, 'keys')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => KEY_RE.test(s)),
    }
  }
  const year = param(url, 'year')
  const since = param(url, 'since')
  if (scope === 'year' && !YEAR_RE.test(year)) return { error: 'bad year' }
  if (scope === 'since' && !DATE_RE.test(since)) return { error: 'bad since date' }
  return {
    keys: await resolveReportKeys({
      year: scope === 'year' ? year : null,
      since: scope === 'since' ? since : null,
      force: url.searchParams.get('force') === '1',
    }),
  }
}

const routes = {
  'POST /api/run-intern': async (req, res) => {
    const runAt = await startDaily()
    if (!runAt) return json(res, 409, { ok: false, running: true })
    json(res, 202, { ok: true, started: true, runAt })
  },

  'POST /api/run-archive': async (req, res, url) => {
    const { env, error } = archiveScope(url)
    if (error) return json(res, 400, { ok: false, error })
    const runAt = await startArchive(env)
    if (!runAt) return json(res, 409, { ok: false, running: true })
    json(res, 202, { ok: true, started: true, runAt })
  },

  'POST /api/run-archive/stop': async (req, res) => {
    await stopArchive()
    json(res, 200, { ok: true, stopped: true })
  },

  // Raised-by-me only — the refresh button inside the Raised view. One quick JQL search.
  'POST /api/run-raised': async (req, res) => {
    const runAt = await startRaised()
    if (!runAt) return json(res, 409, { ok: false, running: true })
    json(res, 202, { ok: true, started: true, runAt })
  },

  // Already active or queued is an idempotent success, so the UI can keep watching.
  'POST /api/refresh-ticket': (req, res, url) => {
    const key = param(url, 'key')
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    const added = ticketRefresh.add(key)
    const pending = ticketRefresh.pending
    json(res, 202, {
      ok: true,
      ...(added ? { queued: true, started: ticketRefresh.active === key } : { already: true }),
      key,
      active: ticketRefresh.active,
      position: pending.indexOf(key),
      pending,
    })
  },

  'GET /api/reports': async (req, res) => {
    const [reports, generating] = await Promise.all([reportsIndex(), reportsGenerating()])
    json(res, 200, { reports, generating, exits: Object.fromEntries(reportQueue.exits) })
  },

  'POST /api/report': (req, res, url) => {
    const key = param(url, 'key').toUpperCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    const added = reportQueue.add(key)
    json(res, 202, { ok: true, ...(added ? { queued: true } : { already: true }), key, pending: reportQueue.pending })
  },

  // Queued through the same one-at-a-time pump as single reports, skipping anything already in
  // flight here or in a terminal/cron backfill: two writers on one report file would race.
  'POST /api/reports/bulk': async (req, res, url) => {
    const { keys, error } = await bulkReportKeys(url)
    if (error) return json(res, 400, { ok: false, error })
    const busy = new Set(await externalGenerating())
    const queued = keys.filter((key) => !busy.has(key) && reportQueue.add(key))
    json(res, 202, { ok: true, scope: param(url, 'scope') || 'all', matched: keys.length, queued, pending: reportQueue.pending })
  },

  'POST /api/reports/stop': async (req, res) => {
    await stopReports()
    json(res, 200, { ok: true, stopped: true })
  },

  'GET /api/settings': async (req, res) => {
    json(res, 200, { ok: true, settings: await readBoardSettings() })
  },

  'POST /api/settings': async (req, res) => {
    const body = await readBody(req, 4096)
    if (body === null) return json(res, 413, { ok: false, error: 'too large' })
    let patch
    try {
      patch = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'bad json' })
    }
    try {
      const { settings, error } = await updateBoardSettings(patch)
      if (error) return json(res, 400, { ok: false, error })
      json(res, 200, { ok: true, settings })
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  },

  'GET /api/ai-status': async (req, res) => {
    json(res, 200, await aiStatus())
  },

  'GET /api/ai-models': async (req, res) => {
    const ai = await aiStatus()
    if (!ai.down) return proxyAi(req, res, '/api/models')
    json(res, 200, { ok: false, down: true, catalog: ai.catalog || (await localCatalog()), installed: ai.installedModels || [], ollamaOk: false })
  },

  'GET /api/cloud-models': (req, res) => proxyAi(req, res, '/api/cloud-models'),
  'POST /api/ai-models/pull': (req, res) => proxyAi(req, res, '/api/models/pull'),
  'POST /api/ai-jobs': (req, res) => proxyAi(req, res, '/api/jobs'),

  // One call carries everything the board polls for: run state, queues, reports, AI intern.
  'GET /api/intern-status': async (req, res) => {
    const [run, dataModified, ai, generating] = await Promise.all([
      runStatus(),
      stat(PATHS.data).then((s) => s.mtimeMs, () => null),
      aiStatus(),
      reportsGenerating(),
    ])
    json(res, 200, {
      ...run,
      dataModified,
      refreshingKeys: ticketRefresh.pending,
      refreshExits: Object.fromEntries(ticketRefresh.exits),
      reportsGenerating: generating,
      reportsEnriching: [...new Set(enrichingKeys(ai))],
      ai,
    })
  },
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = decodeURIComponent(url.pathname)
  if (path === '/') {
    res.writeHead(302, { Location: BOARD_PATH }).end()
    return
  }
  const route = routes[`${req.method} ${path}`]
  if (route) return route(req, res, url)

  if (req.method === 'GET' && path.startsWith('/api/reports/')) {
    const key = path.slice('/api/reports/'.length).trim().toUpperCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(await readReport(key))
    } catch {
      json(res, 404, { ok: false, error: 'no report yet' })
    }
    return
  }
  if (path.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' })
  return serveStatic(req, res, path)
})

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST
  console.log(`\n  🎫  My Jira Board  →  http://${shown}:${PORT}${BOARD_PATH}`)
  console.log(`      Live Refresh enabled (runs the intern). Press Ctrl+C to stop.\n`)
  startScheduler().catch((e) => console.error('[schedule] failed to start', e))
})
