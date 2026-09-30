import { getInternStatus, type InternStatus } from './runner'

/**
 * One poller for /api/intern-status, shared by every watcher on the page. Each subscriber asks
 * for a rate; the fastest one wins, and the poller stops when nobody needs it or the tab is hidden.
 * A subscriber asking for Infinity only listens and never drives a request.
 */
export type StatusListener = (status: InternStatus | null) => void

const rates = new Map<StatusListener, number>()
let lastAt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<InternStatus | null> | null = null

function schedule(): void {
  clearTimeout(timer)
  if (inflight || document.hidden || rates.size === 0) return
  const rate = Math.min(...rates.values())
  if (!Number.isFinite(rate)) return
  timer = setTimeout(pollNow, Math.max(0, lastAt + rate - Date.now()))
}

/** Fetch now (joining a request already in flight) and notify every subscriber. */
export function pollNow(): Promise<InternStatus | null> {
  inflight ??= getInternStatus().then((status) => {
    inflight = null
    lastAt = Date.now()
    for (const listener of [...rates.keys()]) if (rates.has(listener)) listener(status)
    schedule()
    return status
  })
  return inflight
}

export function subscribeStatus(listener: StatusListener, rateMs: number): () => void {
  rates.set(listener, rateMs)
  schedule()
  return () => {
    rates.delete(listener)
    schedule()
  }
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', schedule)
