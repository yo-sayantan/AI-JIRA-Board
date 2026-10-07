// AI-Ollama lifecycle: the Ollama container only runs while something can use it.
//
//   wanted   = aiLevel ≠ none  AND  aiBackend = local  AND  not "host Ollama"
//   has models — remembered in jira-intern/.ollama-state.json from the last time Ollama answered
//
// Boot / deploy: start only when wanted AND models are known to exist (unknown counts as yes,
// so a fresh install can pull its first model). Settings change: wanted → start, otherwise stop.
// A model pull starts it on demand. Containers are driven through the Docker Engine API on the
// mounted socket; without the socket every call reports 'unavailable' and the board carries on.
//
//   node server/ollama.mjs wanted      → prints "yes" / "no" for start-jira-board.sh
import { request } from 'node:http'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { PATHS } from './config.mjs'
import { readBoardSettings } from './settings.mjs'

const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock'
const CONTAINER = process.env.OLLAMA_CONTAINER || 'AI-Ollama'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434'
const STOP_GRACE_S = 10
const READY_WAIT_MS = 45_000

export function ollamaWanted(settings) {
  return settings.aiLevel !== 'none' && settings.aiBackend !== 'cloud' && !settings.aiUseHostOllama
}

// ── model memory ─────────────────────────────────────────────────────────────

async function readState() {
  try {
    const s = JSON.parse(await readFile(PATHS.ollamaState, 'utf8'))
    return typeof s?.hasModels === 'boolean' ? s : {}
  } catch {
    return {}
  }
}

async function remember(hasModels, models) {
  const tmp = `${PATHS.ollamaState}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ hasModels, models, at: new Date().toISOString() }, null, 2) + '\n').catch(() => {})
  await rename(tmp, PATHS.ollamaState).catch(() => {})
}

/** Ask the container's Ollama for its tags; null when it is not answering. */
export async function probeModels(timeoutMs = 3000) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await r.json()
    const models = Array.isArray(body?.models) ? body.models.map((m) => m?.name).filter(Boolean) : []
    await remember(models.length > 0, models)
    return models
  } catch {
    return null
  }
}

// ── Docker Engine API over the socket ────────────────────────────────────────

function docker(method, path) {
  return new Promise((resolve) => {
    const req = request({ socketPath: SOCK, method, path, timeout: 20_000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end()
  })
}

/** { available, exists, running } for the Ollama container. */
export async function ollamaContainer() {
  const r = await docker('GET', `/containers/${CONTAINER}/json`)
  if (r.status === 0) return { available: false, exists: false, running: false }
  if (r.status === 404) return { available: true, exists: false, running: false }
  let running = false
  try {
    running = !!JSON.parse(r.body)?.State?.Running
  } catch {
    /* treat as stopped */
  }
  return { available: true, exists: r.status === 200, running }
}

let chain = Promise.resolve()
const serial = (fn) => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/** Start the container if it is not running. 'started' | 'running' | 'unavailable' */
export function startOllama() {
  return serial(async () => {
    const c = await ollamaContainer()
    if (!c.available || !c.exists) return 'unavailable'
    if (c.running) return 'running'
    const r = await docker('POST', `/containers/${CONTAINER}/start`)
    const ok = r.status === 204 || r.status === 304
    console.log(`[ollama] start → ${ok ? 'ok' : `HTTP ${r.status}`}`)
    return ok ? 'started' : 'unavailable'
  })
}

/** Stop the container if it is running. 'stopped' | 'idle' | 'unavailable' */
export function stopOllama() {
  return serial(async () => {
    const c = await ollamaContainer()
    if (!c.available || !c.exists) return 'unavailable'
    if (!c.running) return 'idle'
    const r = await docker('POST', `/containers/${CONTAINER}/stop?t=${STOP_GRACE_S}`)
    const ok = r.status === 204 || r.status === 304
    console.log(`[ollama] stop → ${ok ? 'ok' : `HTTP ${r.status}`}`)
    return ok ? 'stopped' : 'unavailable'
  })
}

/** Start Ollama (if wanted and possible) and wait until it answers, for an on-demand pull. */
export async function ensureOllamaReady() {
  const started = await startOllama()
  if (started === 'unavailable') return false
  const until = Date.now() + READY_WAIT_MS
  while (Date.now() < until) {
    if ((await probeModels(2000)) !== null) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

/**
 * Bring the container in line with the settings.
 *  `boot: true` (server start / deploy) also honours the no-models rule.
 * Returns what happened: 'started' | 'stopped' | 'unchanged' | 'no-models' | 'unavailable'.
 */
export async function reconcileOllama(settings, { boot = false } = {}) {
  if (!ollamaWanted(settings)) {
    const r = await stopOllama()
    return r === 'stopped' ? 'stopped' : r === 'idle' ? 'unchanged' : 'unavailable'
  }
  if (boot && (await readState()).hasModels === false) {
    const c = await ollamaContainer()
    if (c.running) {
      // It is up anyway (compose started it): confirm models are still absent before stopping.
      const models = await probeModels()
      if (models && models.length > 0) return 'unchanged'
      await stopOllama()
    }
    console.log('[ollama] not started: no local models installed (pull one from Settings to start it)')
    return 'no-models'
  }
  const r = await startOllama()
  return r === 'started' ? 'started' : r === 'running' ? 'unchanged' : 'unavailable'
}

/** Deploy-time answer for start-jira-board.sh — same rule as a boot reconcile, read from disk. */
export async function ollamaWantedOnDeploy() {
  const settings = await readBoardSettings()
  if (!ollamaWanted(settings)) return false
  return (await readState()).hasModels !== false
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()) && process.argv[2] === 'wanted') {
  ollamaWantedOnDeploy().then((w) => {
    console.log(w ? 'yes' : 'no')
  }, () => console.log('yes'))
}
