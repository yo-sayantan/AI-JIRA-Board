import { useEffect, useState } from 'react'

/** Wall-clock time that advances every `stepMs`, so relative labels and the theme schedule stay current. */
export function useClock(stepMs = 60_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs)
    return () => clearInterval(id)
  }, [stepMs])
  return now
}
