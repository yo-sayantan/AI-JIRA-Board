// Talks to the optional local server (serve.mjs). On file:// none of this is reachable,
// so callers fall back to a plain reload.

export const RUN_COMMAND = 'bash .ai/jira-intern/local-runner/run-intern.sh'

/** True when the board was opened through the local server (http/https), not file://. */
export function isServed(): boolean {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol)
}

export interface InternStatus {
  running: boolean
  lastExit: number | null
  lastRunAt: string | null
  dataModified: number | null
  /** Keys currently being refreshed one-by-one in the background. */
  refreshingKeys?: string[]
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

export async function startInternRun(): Promise<boolean> {
  try {
    const r = await fetch('/api/run-intern', { method: 'POST' })
    return r.ok
  } catch {
    return false
  }
}

/** Trigger a targeted background fetch for ONE ticket (served mode only). */
export async function startTicketRefresh(key: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/refresh-ticket?key=${encodeURIComponent(key)}`, { method: 'POST' })
    return r.ok
  } catch {
    return false
  }
}
