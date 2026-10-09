import { useCallback, useMemo, useRef, useState } from 'react'
import type { ColumnKey, Ticket } from '../types'
import { MOVE_TARGETS, moveBlockedReason, moveTargetOf, targetLabel, type MoveTarget } from '../lib/columns'
import { demoMoveVerdict } from '../demo'
import { moveTicketInJira } from '../lib/runner'
import type { ToastFn } from './useToasts'


interface Pin {
  /** What was dropped on — QA and QA In Progress are one column, so the column alone cannot say. */
  target: MoveTarget
  column: ColumnKey
  /** Drop order — later drops sit lower in the column. */
  seq: number
  /** Status to show until the real one arrives, so badges and the QA shelf follow the card. */
  status: string
}

/**
 * Drag-and-drop status changes. The card lands at the bottom of its new column the moment it is
 * dropped and Jira is updated in the background; the user keeps working meanwhile. When Jira
 * refuses (Done with an unmerged PR / open QA), the pin is dropped and the card slides back to
 * where it was. A successful move keeps the card where it was dropped: the column override lasts
 * until the follow-up refresh brings the real status through, the bottom-of-column order for the
 * rest of the session.
 */
export function useTicketMoves({
  served,
  toast,
  refreshTicket,
  demo = false,
}: {
  served: boolean
  toast: ToastFn
  /** Watches the server-side refresh queued by the move and swaps the fresh data in. */
  refreshTicket: (key: string) => Promise<void>
  /** Demo mode: judge the move locally (same gates) and never call the server. */
  demo?: boolean
}) {
  const [pins, setPins] = useState<ReadonlyMap<string, Pin>>(new Map())
  const [movingKeys, setMovingKeys] = useState<ReadonlySet<string>>(new Set())
  const inFlight = useRef(new Set<string>())
  const seq = useRef(0)

  const setPin = useCallback((key: string, target: MoveTarget | null) => {
    setPins((prev) => {
      const next = new Map(prev)
      if (target) {
        // QA In Progress is a space inside the QA column: column 'qa', and a status the board reads as in progress.
        const column: ColumnKey = target === 'qaip' ? 'qa' : target
        next.set(key, { target, column, seq: ++seq.current, status: targetLabel(target) })
      } else next.delete(key)
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
    async (ticket: Ticket, to: MoveTarget) => {
      const from = moveTargetOf(ticket)
      if (to === from || !MOVE_TARGETS.has(to)) return
      // The QA lane (lib/columns.ts): refused here, before Jira is asked, exactly as the server would.
      const lane = moveBlockedReason(ticket, to)
      if (lane) return void toast(`${ticket.key} stays where it is. ${lane}`, 'error')
      if (!served && !demo) return void toast('Moving tickets needs the local server — run `npm run serve`.', 'info')
      if (inFlight.current.has(ticket.key)) return void toast(`${ticket.key} is already being moved.`, 'info')
      inFlight.current.add(ticket.key)
      markMoving(ticket.key, true)
      const previous = pins.get(ticket.key) ?? null
      setPin(ticket.key, to)
      const label = targetLabel(to)

      // Demo mode runs the same PR / QA gates in the browser, so a refused Done still bounces back.
      const verdict = demo ? demoMoveVerdict(ticket, to) : await moveTicketInJira(ticket.key, to as MoveTarget)
      inFlight.current.delete(ticket.key)
      markMoving(ticket.key, false)

      if (!verdict.ok) {
        // Bounce back: the card returns to the column (and spot) it came from.
        setPins((prev) => {
          const next = new Map(prev)
          if (previous) next.set(ticket.key, previous)
          else next.delete(ticket.key)
          return next
        })
        if (verdict.blocked) toast(`${ticket.key} stays in ${targetLabel(from)}. ${verdict.reason ?? ''}`.trim(), 'error')
        else toast(`Couldn't move ${ticket.key} to ${label}: ${verdict.error ?? 'unknown error'}.`, 'error')
        return
      }
      const where = demo ? 'on the demo board' : 'in Jira'
      toast(verdict.moved ? `${ticket.key} → ${verdict.status ?? label} ${where}.` : `${ticket.key} was already in ${label}.`, 'success')
      for (const w of verdict.warnings ?? []) toast(`${ticket.key}: ${w}`, 'info')
      // The server queued this ticket's refresh; attach to it so the real status lands on the board.
      if (verdict.moved && !demo) void refreshTicket(ticket.key)
    },
    [served, demo, toast, refreshTicket, pins, setPin, markMoving],
  )

  /** Show pinned tickets in their dropped column until the dump itself agrees. */
  const applyOverrides = useCallback(
    (tickets: Ticket[]): Ticket[] => {
      if (pins.size === 0) return tickets
      return tickets.map((t) => {
        const pin = pins.get(t.key)
        if (!pin || moveTargetOf(t) === pin.target) return t
        return { ...t, column: pin.column, status: pin.status, done: pin.column === 'done', onHold: pin.column === 'hold' }
      })
    },
    [pins],
  )

  /** key → drop order, for the Board to sort dropped cards to the bottom of their column. */
  const bottomOrder = useMemo(() => new Map([...pins].map(([k, p]) => [k, p.seq] as const)), [pins])

  return useMemo(() => ({ moveTicket, applyOverrides, bottomOrder, movingKeys }), [moveTicket, applyOverrides, bottomOrder, movingKeys])
}
