import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnKey, Ticket } from '../types'
import { MOVE_TARGETS, moveTargetOf, targetLabel, type MoveTarget } from '../lib/columns'
import { checkMove, shortReason, type TicketLookup } from '../lib/moveRules'
import { demoMoveVerdict } from '../demo'
import { moveTicketInJira, type MoveMode } from '../lib/runner'
import type { ToastFn } from './useToasts'

/** How long a finished move can be undone, and a refused one forced from its toast. */
export const UNDO_SECONDS = 8

export interface MoveRequest {
  mode?: MoveMode
  /** ⌥ was held on drop: the user asked to force past a PR / QA gate — confirm first. */
  forceAsk?: boolean
  /** The tickets the board knows, so a sub-ticket's parent can be read for the gates. */
  lookup?: TicketLookup
  /** Where the card is now, when that is not where the ticket's data says (an Undo right after a move). */
  from?: MoveTarget
}

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
 * dropped and Jira is updated in the background; the user keeps working meanwhile. The move rules
 * (lib/moveRules.ts) are checked first against the cached data: the QA lane refuses outright; a PR /
 * QA gate refuses with a "Move anyway" button (⌥ on drop asks the same question up front). When Jira
 * refuses, the pin is dropped and the card slides back — with "Move anyway" when the refusal was a
 * gate. A finished move offers Undo for UNDO_SECONDS. A successful move keeps the card where it was
 * dropped: the column override lasts until the follow-up refresh brings the real status through,
 * the bottom-of-column order for the rest of the session.
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

  // Toast buttons (Undo, Move anyway) run later, after re-renders: they call the latest moveTicket.
  const moveRef = useRef<(ticket: Ticket, to: MoveTarget, req?: MoveRequest) => Promise<void>>(async () => {})

  const moveTicket = useCallback(
    async (ticket: Ticket, to: MoveTarget, req: MoveRequest = {}) => {
      const mode = req.mode ?? 'normal'
      const from = req.from ?? moveTargetOf(ticket)
      const key = ticket.key
      if (to === from || !MOVE_TARGETS.has(to)) return
      const label = targetLabel(to)
      if (!served && !demo) return void toast('Moving tickets needs the local server — run `npm run serve`.', 'info')
      if (mode !== 'undo') {
        // Judged here first, from the cached data, exactly as the server will judge live Jira.
        const c = checkMove(ticket, to, req.lookup)
        if (c.kind === 'lane') return void toast(`${key} stays where it is. ${c.reason}`, 'error')
        if (c.kind === 'gate' && mode === 'normal') {
          const force = { label: req.forceAsk ? 'Force move' : 'Move anyway', run: () => void moveRef.current(ticket, to, { ...req, mode: 'force' }) }
          const msg = req.forceAsk ? `Force ${key} to ${label}? ${shortReason(c)}.` : `${key} stays in ${targetLabel(from)}. ${c.reason}`
          return void toast(msg, req.forceAsk ? 'info' : 'error', { action: force, seconds: UNDO_SECONDS + 4 })
        }
      }
      if (inFlight.current.has(key)) return void toast(`${key} is already being moved.`, 'info')
      inFlight.current.add(key)
      markMoving(key, true)
      const previous = pins.get(key) ?? null
      setPin(key, to)

      // Demo mode runs the same rules in the browser, so a refusal still bounces back.
      const verdict = demo ? demoMoveVerdict(ticket, to, mode, req.lookup) : await moveTicketInJira(key, to, mode)
      inFlight.current.delete(key)
      markMoving(key, false)

      if (!verdict.ok) {
        // Bounce back: the card returns to the column (and spot) it came from.
        setPins((prev) => {
          const next = new Map(prev)
          if (previous) next.set(key, previous)
          else next.delete(key)
          return next
        })
        if (verdict.blocked) {
          const anyway = verdict.forcible && mode === 'normal'
          toast(`${key} stays in ${targetLabel(from)}. ${verdict.reason ?? ''}`.trim(), 'error', anyway ? { action: { label: 'Move anyway', run: () => void moveRef.current(ticket, to, { ...req, mode: 'force' }) }, seconds: UNDO_SECONDS + 4 } : undefined)
        } else toast(`Couldn't move ${key} to ${label}: ${verdict.error ?? 'unknown error'}.`, 'error')
        return
      }
      const where = demo ? 'on the demo board' : 'in Jira'
      const done = verdict.moved ? `${key} → ${verdict.status ?? label} ${where}${mode === 'force' ? ' (forced)' : ''}.` : `${key} was already in ${label}.`
      // Undo puts it back where it came from — no rules: it is only returning.
      const undo = verdict.moved && mode !== 'undo' ? { action: { label: 'Undo', run: () => void moveRef.current(ticket, from, { lookup: req.lookup, mode: 'undo', from: to }) }, seconds: UNDO_SECONDS } : undefined
      toast(done, 'success', undo)
      for (const w of verdict.warnings ?? []) toast(`${key}: ${w}`, 'info')
      // The server queued this ticket's refresh; attach to it so the real status lands on the board.
      if (verdict.moved && !demo) void refreshTicket(key)
    },
    [served, demo, toast, refreshTicket, pins, setPin, markMoving],
  )
  useEffect(() => {
    moveRef.current = moveTicket
  }, [moveTicket])

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
