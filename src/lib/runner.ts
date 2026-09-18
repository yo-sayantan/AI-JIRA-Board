// Talks to the optional local server (serve.mjs). On file:// none of this is reachable,
// so callers fall back to a plain reload.
import { summarizeReport, type PrReport, type PrReportSummary } from './reportTypes'

export const RUN_COMMAND = 'bash .ai/jira-intern/local-runner/run-intern.sh'

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
export function guideUrl(): string {
  return isServed() ? '/docs/index.html' : '../docs/index.html'
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
  /** Which writer is busy: the fast daily fetch, the deep archive rebuild, or a terminal-launched run. */
  job?: 'daily' | 'archive' | 'external' | null
  lastExit: number | null
  lastRunAt: string | null
  dataModified: number | null
  /** Active + queued refresh keys, in FIFO order (active first). */
  refreshingKeys?: string[]
  /** Key whose refresh-ticket.sh child is running right now (null when idle/draining wait). */
  refreshActive?: string | null
  /** Keys waiting behind the active one. */
  refreshQueue?: string[]
  /** Exit codes for recently finished per-ticket refreshes (key → code). */
  refreshExits?: Record<string, number>
  /** Live ticket-count progress for the button fill (null when idle). */
  progress?: InternProgress | null
  /** PR Readiness Reports being generated right now (server queue ∪ cron/terminal runs). */
  reportsGenerating?: string[]
  /** Exit codes for recently finished report generations (key → code). */
  reportExits?: Record<string, number>
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

/**
 * Push the settings the shell runners care about to the server. Only the AI level matters to
 * them; everything else is presentation and stays in localStorage.
 */
export async function saveServerSettings(patch: { aiLevel?: string }): Promise<boolean> {
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

export async function getInternStatus(): Promise<InternStatus | null> {
  try {
    const r = await fetch('/api/intern-status', { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as InternStatus
  } catch {
    return null
  }
}

export interface RunStartResult {
  ok: boolean
  /** HTTP status from the start endpoint (202 started, 409 already running, 0 on network fail). */
  status: number
  running?: boolean
}

async function startRun(path: string): Promise<RunStartResult> {
  try {
    const r = await fetch(path, { method: 'POST' })
    let running: boolean | undefined
    try {
      const body = (await r.json()) as { running?: boolean }
      running = body.running
    } catch {
      /* non-JSON */
    }
    return { ok: r.ok, status: r.status, running }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function startInternRun(): Promise<RunStartResult> {
  return startRun('/api/run-intern')
}

/** Kick off the DEEP archive rebuild (update-completed.sh) — slow; re-scans every completed ticket. */
export async function startArchiveRun(): Promise<RunStartResult> {
  return startRun('/api/run-archive')
}
