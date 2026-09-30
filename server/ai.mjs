import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AI_INTERN_URL, PATHS } from './config.mjs'
import { AI_LEVELS, CLOUD_PROVIDERS, DEFAULT_LOCAL_MODEL } from './settings.mjs'
import { json } from './http.mjs'

// A crashed claim leaves a .running file forever; only a recent one means the intern is on it.
const RUNNING_FRESH_MS = 30 * 60 * 1000
// Several tabs and several endpoints ask for the intern's status within the same second.
const STATUS_TTL_MS = 1000

async function readQueue() {
  let names
  try {
    names = await readdir(PATHS.aiQueue)
  } catch {
    return []
  }
  const freshAfter = Date.now() - RUNNING_FRESH_MS
  const jobs = await Promise.all(
    names.map(async (name) => {
      const running = name.endsWith('.json.running')
      if (name.startsWith('.') || (!running && !name.endsWith('.json'))) return null
      const path = join(PATHS.aiQueue, name)
      try {
        if (running && (await stat(path)).mtimeMs < freshAfter) return null
        return { path, running, job: JSON.parse(await readFile(path, 'utf8')) }
      } catch {
        return null
      }
    }),
  )
  return jobs.filter(Boolean)
}

/** Ticket keys with an enrich-report job queued or claimed by the intern. */
async function queuedEnrichKeys() {
  return (await readQueue())
    .filter(({ job }) => job.type === 'enrich-report' && job.key)
    .map(({ job }) => String(job.key).toUpperCase())
}

export async function enqueueEnrich(key, settings) {
  await mkdir(PATHS.aiQueue, { recursive: true })
  const id = `${Date.now()}-${key}`
  const backend = settings.aiBackend === 'cloud' ? 'cloud' : 'local'
  const job = {
    id,
    type: 'enrich-report',
    key,
    level: AI_LEVELS.includes(settings.aiLevel) ? settings.aiLevel : 'moderate',
    backend,
    model: backend === 'cloud' ? settings.aiCloudModel || '' : settings.aiLocalModel || DEFAULT_LOCAL_MODEL,
    cloudProvider: CLOUD_PROVIDERS.includes(settings.aiCloudProvider) ? settings.aiCloudProvider : 'cursor',
    cloudEffort: settings.aiCloudEffort === 'medium' ? 'medium' : 'low',
    useHostOllama: !!settings.aiUseHostOllama,
    enqueuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  await writeFile(join(PATHS.aiQueue, `${id}.json`), JSON.stringify(job, null, 2) + '\n')
  invalidateAiStatus()
}

/** Drop every enrich-report job that has not been claimed yet. */
export async function dropQueuedEnrichJobs() {
  const jobs = await readQueue()
  await Promise.all(
    jobs.filter(({ running, job }) => !running && job.type === 'enrich-report').map(({ path }) => unlink(path).catch(() => {})),
  )
  invalidateAiStatus()
}

export async function localCatalog() {
  return readFile(PATHS.modelCatalog, 'utf8').then(JSON.parse, () => ({ models: [], defaultLocal: DEFAULT_LOCAL_MODEL }))
}

async function fetchAiStatus() {
  const queuedKeys = await queuedEnrichKeys()
  try {
    const r = await fetch(`${AI_INTERN_URL}/api/status`, { signal: AbortSignal.timeout(4000) })
    const body = await r.json()
    return { ...body, ok: body.ok !== false, queuedKeys, queued: queuedKeys.length }
  } catch {
    return {
      ok: false,
      down: true,
      state: 'down',
      queuedKeys,
      queued: queuedKeys.length,
      error: 'AI intern unreachable',
      catalog: await localCatalog(),
    }
  }
}

const statusCache = { at: 0, value: null, inflight: null }

export function invalidateAiStatus() {
  statusCache.at = 0
}

/** JIRA-AI-Intern health, current jobs and installed models — shared across concurrent callers. */
export function aiStatus() {
  if (statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) return Promise.resolve(statusCache.value)
  statusCache.inflight ??= fetchAiStatus().then((value) => {
    statusCache.value = value
    statusCache.at = Date.now()
    statusCache.inflight = null
    return value
  })
  return statusCache.inflight
}

/** Keys the intern is enriching right now — queued, claimed, or reported active by the worker. */
export function enrichingKeys(ai) {
  const active = ai.active?.length ? ai.active : ai.current ? [ai.current] : []
  const running = active.filter((j) => j?.type === 'enrich-report' && j.key).map((j) => String(j.key).toUpperCase())
  return [...(ai.queuedKeys ?? []), ...running]
}

export async function proxyAi(req, res, destPath) {
  try {
    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = Buffer.concat(chunks)
      invalidateAiStatus()
    }
    const r = await fetch(`${AI_INTERN_URL}${destPath}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    res
      .writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' })
      .end(await r.text())
  } catch {
    json(res, 503, { ok: false, down: true, state: 'down', error: 'AI intern unreachable' })
  }
}
