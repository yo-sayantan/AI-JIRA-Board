import { useCallback, useMemo, useRef, useState } from 'react'
import type { ColumnKey, Ticket } from '../types'
import { COLUMN_META } from '../lib/columns'
import { moveTicketInJira, type MoveTarget } from '../lib/runner'
import type { ToastFn } from './useToasts'

export const MOVE_TARGETS: ReadonlySet<ColumnKey> = new Set<ColumnKey>(['todo', 'prog', 'rev', 'qa', 'done'])

/**
 * Drag-and-drop status changes. The card jumps to its new column the moment it is dropped and
 * Jira is updated in the background; the user keeps working meanwhile. When Jira refuses (Done
 * with an unmerged PR / open QA), the override is dropped and the card slides back to where it
 * was. Successful moves keep their override until the follow-up refresh lands the real status.
 */
export function useTicketMoves({ served, toast, reload }: { served: boolean; toast: ToastFn; reload: () => Promise<void> }) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ColumnKey>>(new Map())
  const [movingKeys, setMovingKeys] = useState<ReadonlySet<string>>(new Set())
  const inFlight = useRef(new Set<string>())

  const setOverride = useCallback((key: string, column: ColumnKey | null) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      if (column) next.set(key, column)
      else next.delete(key)
      return next
    })
  }, [])
  const markMoving = useCallback((key: string, on: boolean) => {
    setMovingKeys((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const moveTicket = useCallback(
    async (ticket: Ticket, to: ColumnKey) => {
      const from = ticket.column
      if (to === from || !MOVE_TARGETS.has(to)) return
      if (!served) return void toast('Moving tickets needs the local server — run `npm run serve`.', 'info')
      if (inFlight.current.has(ticket.key)) return void toast(`${ticket.key} is already being moved.`, 'info')
      inFlight.current.add(ticket.key)
      markMoving(ticket.key, true)
      setOverride(ticket.key, to)
      const label = COLUMN_META[to].label

      const verdict = await moveTicketInJira(ticket.key, to as MoveTarget)
      inFlight.current.delete(ticket.key)
      markMoving(ticket.key, false)

      if (!verdict.ok) {
        // Bounce back: the card returns to its previous column.
        setOverride(ticket.key, null)
        if (verdict.blocked) toast(`${ticket.key} stays in ${COLUMN_META[from].label}. ${verdict.reason ?? ''}`.trim(), 'error')
        else toast(`Couldn't move ${ticket.key} to ${label}: ${verdict.error ?? 'unknown error'}.`, 'error')
        return
      }
      toast(verdict.moved ? `${ticket.key} → ${verdict.status ?? label} in Jira.` : `${ticket.key} was already in ${label}.`, 'success')
      for (const w of verdict.warnings ?? []) toast(`${ticket.key}: ${w}`, 'info')
      // The server queued a single-ticket refresh; its reload brings the real status through.
      void reload()
    },
    [served, toast, reload, setOverride, markMoving],
  )

  /** Drop an override once the dump itself agrees with it (the refresh landed). */
  const applyOverrides = useCallback(
    (tickets: Ticket[]): Ticket[] => {
      if (overrides.size === 0) return tickets
      const landed: string[] = []
      const out = tickets.map((t) => {
        const col = overrides.get(t.key)
        if (!col) return t
        if (t.column === col) {
          landed.push(t.key)
          return t
        }
        return { ...t, column: col, done: col === 'done', onHold: false }
      })
      if (landed.length) {
        queueMicrotask(() =>
          setOverrides((prev) => {
            const next = new Map(prev)
            for (const k of landed) next.delete(k)
            return next
          }),
        )
      }
      return out
    },
    [overrides],
  )

  return useMemo(() => ({ moveTicket, applyOverrides, movingKeys }), [moveTicket, applyOverrides, movingKeys])
}
