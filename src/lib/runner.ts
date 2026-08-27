// Talks to the optional local server (serve.mjs). On file:// none of this is reachable,
// so callers fall back to a plain reload.

export const RUN_COMMAND = 'bash .ai/jira-intern/local-runner/run-intern.sh'

/** True when the board was opened through the local server (http/https), not file://. */
export function isServed(): boolean {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol)
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
