import { useEffect, useState } from 'react'
import { POLLING } from '../lib/appConfig'
import type { InternStatus } from '../lib/runner'
import { subscribeStatus } from '../lib/statusPoller'

function hasWork(s: InternStatus | null): boolean {
  return !!(s?.running || s?.reportsGenerating?.length || (s?.reportsEnriching?.length && !s.ai?.down))
}

function rateFor(s: InternStatus | null): number {
  if (s?.ai?.state === 'pulling') return POLLING.aiBusyMs
  if (s?.ai?.state === 'working' || hasWork(s)) return POLLING.reportsBusyMs
  return POLLING.aiIdleMs
}

/**
 * The latest intern status, polled while `keepAlive` holds or the intern has work in flight.
 * Otherwise it only listens to polls other watchers make.
 */
export function useInternStatus(served: boolean, keepAlive: boolean): InternStatus | null {
  const [status, setStatus] = useState<InternStatus | null>(null)
  const rate = served && (keepAlive || hasWork(status)) ? rateFor(status) : Infinity
  useEffect(() => subscribeStatus((s) => s && setStatus(s), rate), [rate])
  return status
}
