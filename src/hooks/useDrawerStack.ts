import { useCallback, useEffect, useState } from 'react'
import type { Ticket } from '../types'

/**
 * Stack of open ticket drawers. Opening from the board resets it; opening a sub-task pushes a
 * drawer on top; Esc or Back pops one. Keys that vanish after a data swap drop out on their own.
 */
export function useDrawerStack(byKey: ReadonlyMap<string, Ticket>) {
  const [stack, setStack] = useState<string[]>([])
  const open = stack.length > 0

  const openTicket = useCallback((key: string) => setStack([key]), [])
  const pushTicket = useCallback((key: string) => setStack((s) => (s[s.length - 1] === key ? s : [...s, key])), [])
  const goBack = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const closeAll = useCallback(() => setStack([]), [])
  const jumpTo = useCallback((depth: number) => setStack((s) => s.slice(0, depth + 1)), [])

  useEffect(() => {
    setStack((s) => {
      const next = s.filter((k) => byKey.has(k))
      return next.length === s.length ? s : next
    })
  }, [byKey])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') goBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, goBack])

  return { stack, open, openTicket, pushTicket, goBack, closeAll, jumpTo }
}
