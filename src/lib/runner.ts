// Talks to the optional local server (serve.mjs). On file:// none of this is reachable,
// so callers fall back to a plain reload.
import type { JiraData } from '../types'
import { summarizeReport, type PrReport, type PrReportSummary } from './reportTypes'
import type { ServerSettings } from './settings'

export const RUN_COMMAND = 'bash jira-intern/local-runner/run-intern.sh'

/** True when the board was opened through the local server (http/https), not file://. */
export function isServed(): boolean {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol)
}

/**
 * Where the Setup & Deployment guide lives, from wherever the board was opened.
 *  • served (Docker / `npm run serve`) → `/docs/index.html` off the server root.
 *    The Dockerfile copies `docs/` into the image so this resolves in the container too.
 *  • file:// (double-clicked `dist/index.html`) → the sibling `../docs/index.html`.
 * Deliberately a plain relative path so it works with no server at all — the guide is the
 * thing you reach for WHEN the server is broken.
 */
export function guideUrl(hash?: string): string {
  const base = isServed() ? '/docs/index.html' : '../docs/index.html'
  if (!hash) return base
  return `${base}#${hash.replace(/^#/, '')}`
}

export interface InternProgress {
  job?: 'daily' | 'archive' | string
  phase?: string
  done?: number
  total?: number
  /** 0–100, derived from done/total. */
  pct?: number
  current?: string | null
  updatedAt?: string
}

export interface InternStatus {
  running: boolean
  /** Which writer is busy: the fast daily fetch, the deep archive rebuild, the raised-by-me
   *  refresh, or a terminal-launched run. */
  job?: 'daily' | 'archive' | 'raised' | 'external' | null
  lastExit: number | null
  lastRunAt: string | null
  dataModified: number | null
  /** Active + queued refresh keys, in FIFO order (active first). */
  refreshingKeys?: string[]
  /** Exit codes for recently finished per-ticket refreshes (key → code). */
  refreshExits?: Record<string, number>
  /** Live ticket-count progress for the button fill (null when idle). */
  progress?: InternProgress | null
  /** Base PR reports being built right now (server queue ∪ cron/terminal runs). */
  reportsGenerating?: string[]
  /** Reports the AI intern has queued or is enriching. */
  reportsEnriching?: string[]
  /** JIRA-AI-Intern health, current job, installed models. */
  ai?: AiInternStatus
}

export interface AiCatalogModel {
  id: string
  label: string
  pull: string
  params: string
  ramGb: number
  level: string
  fits: 'container' | 'host' | string
  why: string
  /** Ollama library page for this tag. */
  ollama?: string
  /** Direct Hugging Face .gguf download (Q4_K_M when available). */
  gguf?: string
  ggufFile?: string
  /** Repo to browse if the GGUF is split across files. */
  ggufPage?: string
}

export interface AiPullProgress {
  model?: string
  status?: string
  completed?: number
  total?: number
  percent?: number
  label?: string
}

export interface AiInternStatus {
  ok?: boolean
  down?: boolean
  state?: string
  current?: { type?: string; key?: string; model?: string } | null
  /** Every job running right now — report jobs run several at a time. */
  active?: { type?: string; key?: string; model?: string }[]
  /** How many report jobs the intern runs at once. */
  parallel?: number
  lastError?: string | null
  backend?: string
  model?: string
  cloudEffort?: string
  useHostOllama?: boolean
  ollamaOk?: boolean
  ollamaError?: string | null
  installedModels?: string[]
  catalog?: { models?: AiCatalogModel[]; defaultLocal?: string; source?: string; hostOnlyRamGb?: number }
  memGb?: number | null
  pulling?: string | null
  /** Live Ollama pull bytes / percent while state is pulling. */
  pullProgress?: AiPullProgress | null
  queuedKeys?: string[]
  queued?: number
  error?: string
}

/** How many enrich-report jobs the AI intern is running right now (queued ones excluded). */
export function enrichJobsRunning(ai: AiInternStatus | null): number {
  const jobs = ai?.active?.length ? ai.active : ai?.current ? [ai.current] : []
  return jobs.filter((job) => job.type === 'enrich-report').length
}

export function aiModelLabel(ai: AiInternStatus | null): string | null {
  if (!ai?.model) return null
  return ai.cloudEffort ? `${ai.model} · ${ai.cloudEffort}` : ai.model
}

// ── PR Readiness Reports ──────────────────────────────────────────────────────
// Served mode talks to /api/reports*. file:// mode reads window.__JIRA_PR_REPORTS__, written by
// local-runner/sync-reports.mjs and injected by the build next to data.js (see vite.config.ts).

export interface PrReportsIndex {
  reports: Record<string, PrReportSummary>
  generating: string[]
  exits?: Record<string, number>
}

type ReportsGlobal = { __JIRA_PR_REPORTS__?: { reports?: Record<string, PrReport>; generating?: string[] } }

/** Every report on disk, keyed by ticket. Header fields only in served mode; full reports on file://. */
export async function getReportsIndex(): Promise<PrReportsIndex | null> {
  if (!isServed()) {
    const g = (window as unknown as ReportsGlobal).__JIRA_PR_REPORTS__
    if (!g?.reports) return null
    const reports: Record<string, PrReportSummary> = {}
    for (const [k, r] of Object.entries(g.reports)) reports[k] = summarizeReport(r)
    return { reports, generating: g.generating ?? [] }
  }
  try {
    const r = await fetch('/api/reports', { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as PrReportsIndex
  } catch {
    return null
  }
}

/** One full report, or null when none exists yet. */
export async function getReport(key: string): Promise<PrReport | null> {
  if (!isServed()) {
    return (window as unknown as ReportsGlobal).__JIRA_PR_REPORTS__?.reports?.[key] ?? null
  }
  try {
    const r = await fetch(`/api/reports/${encodeURIComponent(key)}`, { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as PrReport
  } catch {
    return null
  }
}

export interface ReportStart {
  ok: boolean
  already?: boolean
  queued?: boolean
  pending?: string[]
}

/** Ask the server to (re)generate one ticket's report in the background (served mode only). */
export async function startReportGeneration(key: string): Promise<ReportStart | null> {
  try {
    const r = await fetch(`/api/report?key=${encodeURIComponent(key)}`, { method: 'POST' })
    if (!r.ok) return null
    return (await r.json()) as ReportStart
  } catch {
    return null
  }
}

/** Push the settings the server-side jobs honour; everything else stays in localStorage. */
export async function saveServerSettings(patch: ServerSettings): Promise<boolean> {
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return r.ok
  } catch {
    return false
  }
}

/** Which tickets a bulk report run should cover. */
export type ReportScope =
  | { scope: 'all' }
  | { scope: 'year'; year: number }
  | { scope: 'since'; since: string }
  | { scope: 'keys'; keys: string[] }

export interface BulkReportStart {
  ok: boolean
  /** Tickets the scope matched, before anything already queued was skipped. */
  matched: number
  /** Tickets this call actually added to the queue. */
  queuedKeys: string[]
  pending?: string[]
}

/**
 * Queue a whole scope of reports. Every ticket with a pull request is eligible; `force` also
 * rebuilds ones whose stored report still matches the current PR fingerprint.
 */
export async function startBulkReportGeneration(target: ReportScope, force = false): Promise<BulkReportStart | null> {
  const q = new URLSearchParams({ scope: target.scope })
  if (target.scope === 'year') q.set('year', String(target.year))
  if (target.scope === 'since') q.set('since', target.since)
  if (target.scope === 'keys') q.set('keys', target.keys.join(','))
  if (force) q.set('force', '1')
  try {
    const r = await fetch(`/api/reports/bulk?${q}`, { method: 'POST' })
    if (!r.ok) return null
    const body = (await r.json()) as { ok?: boolean; matched?: number; queued?: string[]; pending?: string[] }
    return {
      ok: body.ok !== false,
      matched: body.matched ?? 0,
      queuedKeys: Array.isArray(body.queued) ? body.queued : [],
      pending: body.pending,
    }
  } catch {
    return null
  }
}

export interface TicketRefreshStart {
  ok: boolean
  already?: boolean
  queued?: boolean
  started?: boolean
  key?: string
  active?: string | null
  position?: number
  pending?: string[]
}

/** Trigger a targeted background fetch for ONE ticket (served mode only).
 *  Always queues when another refresh is in flight — never drops later clicks. */
export async function startTicketRefresh(key: string): Promise<TicketRefreshStart | null> {
  try {
    const r = await fetch(`/api/refresh-ticket?key=${encodeURIComponent(key)}`, { method: 'POST' })
    if (!r.ok) return null
    return (await r.json()) as TicketRefreshStart
  } catch {
    return null
  }
}

export interface CloudModelChoice {
  id: string
  label: string
  /** Cursor effort values this model accepts. Empty for Claude. */
  efforts?: string[]
}

export interface CloudProviderModels {
  configured: boolean
  models: CloudModelChoice[]
  error?: string | null
}

export async function getCloudModels(): Promise<{
  ok: boolean
  claude?: CloudProviderModels
  cursor?: CloudProviderModels
  gemini?: CloudProviderModels
  error?: string
} | null> {
  try {
    const r = await fetch('/api/cloud-models', { cache: 'no-store' })
    return (await r.json()) as {
      ok: boolean
      claude?: CloudProviderModels
      cursor?: CloudProviderModels
      gemini?: CloudProviderModels
    }
  } catch {
    return { ok: false, error: 'AI intern unreachable' }
  }
}

export async function getAiModels(): Promise<{
  ok: boolean
  down?: boolean
  catalog?: AiInternStatus['catalog']
  installed?: string[]
  ollamaOk?: boolean
  memGb?: number | null
} | null> {
  try {
    const r = await fetch('/api/ai-models', { cache: 'no-store' })
    return (await r.json()) as { ok: boolean; down?: boolean; catalog?: AiInternStatus['catalog']; installed?: string[] }
  } catch {
    return { ok: false, down: true }
  }
}

export async function pullAiModel(model: string, useHostOllama = false): Promise<boolean> {
  try {
    const r = await fetch('/api/ai-models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, useHostOllama }),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      console.error('[jira-ai] pull failed', r.status, text || model)
      return false
    }
    return true
  } catch (e) {
    console.error('[jira-ai] pull failed', model, e)
    return false
  }
}

let lastStatus: { text: string; value: InternStatus } | null = null

/** Unchanged payloads return the previous object, so state setters can bail out of a re-render. */
export async function getInternStatus(): Promise<InternStatus | null> {
  try {
    const r = await fetch('/api/intern-status', { cache: 'no-store' })
    if (!r.ok) return null
    const text = await r.text()
    if (lastStatus?.text !== text) lastStatus = { text, value: JSON.parse(text) as InternStatus }
    return lastStatus.value
  } catch {
    return null
  }
}

/** The raw dump behind data.js. Revalidates against the server's ETag, so an unchanged file costs a 304. */
export async function getDataDump(): Promise<JiraData | null> {
  try {
    const r = await fetch('/jira-intern/data.json', { cache: 'no-cache' })
    if (!r.ok) return null
    const raw = (await r.json()) as JiraData
    return Array.isArray(raw?.tickets) ? raw : null
  } catch {
    return null
  }
}

/** Machine-wide AI choices: central defaults overlaid by jira-intern/.settings.json. */
export async function getServerSettings(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch('/api/settings', { cache: 'no-store' })
    if (!r.ok) return null
    const body = (await r.json()) as { settings?: Record<string, unknown> }
    return body.settings ?? null
  } catch {
    return null
  }
}

export interface RunStartResult {
  ok: boolean
  /** HTTP status from the start endpoint (202 started, 409 already running, 0 on network fail). */
  status: number
  /** The started run's lastRunAt stamp, for telling its completion apart from an older run's. */
  runAt?: string
}

async function startRun(path: string): Promise<RunStartResult> {
  try {
    const r = await fetch(path, { method: 'POST' })
    const body = (await r.json().catch(() => ({}))) as { runAt?: string }
    return { ok: r.ok, status: r.status, runAt: body.runAt }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function startInternRun(): Promise<RunStartResult> {
  return startRun('/api/run-intern')
}

/** Re-fetch ONLY the raised-by-me list (tickets I reported). One quick JQL search server-side. */
export async function startRaisedRun(): Promise<RunStartResult> {
  return startRun('/api/run-raised')
}

export type ArchiveScope =
  | { scope: 'all' }
  | { scope: 'year'; year: number }
  | { scope: 'since'; since: string }
  | { scope: 'key'; key: string }

/** Kick off the Completed archive rebuild. A scope updates only that slice; all rebuilds the whole archive. */
export async function startArchiveRun(target: ArchiveScope = { scope: 'all' }): Promise<RunStartResult> {
  const q = new URLSearchParams()
  q.set('scope', target.scope)
  if (target.scope === 'year') q.set('year', String(target.year))
  if (target.scope === 'since') q.set('since', target.since)
  if (target.scope === 'key') q.set('key', target.key)
  return startRun(`/api/run-archive?${q.toString()}`)
}

export async function stopArchiveRun(): Promise<void> {
  await fetch('/api/run-archive/stop', { method: 'POST' }).catch(() => {})
}

export async function stopReportRun(): Promise<void> {
  await fetch('/api/reports/stop', { method: 'POST' }).catch(() => {})
}
