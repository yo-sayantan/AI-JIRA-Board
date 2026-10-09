import { memo, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Ticket } from '../../types'
import { HOLD_COLUMN } from '../../lib/columns'
import { hexToRgba } from '../../lib/format'
import { PauseIcon } from '../common/Icons'

const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const
const ACCENT = HOLD_COLUMN.accent

/**
 * On Hold: its own space in the Blocked column — a second header and a second box under Blocked's,
 * never inside it. Usually it holds nothing, so it stays a slim box; but it is always there to drop
 * on: a card dropped here is put On Hold in Jira. It is a drop target through `data-drop="hold"`:
 * the Column's one set of drag listeners checks whether the pointer is inside it (Column.tsx).
 */
export const OnHoldShelf = memo(function OnHoldShelf({
  tickets,
  over,
  dragging,
  card,
}: {
  tickets: Ticket[]
  /** A card is hovering the shelf itself. */
  over: boolean
  /** A card is being dragged somewhere on the board. */
  dragging: boolean
  /** The column's card renderer, so held cards look and behave like every other card. */
  card: (t: Ticket) => ReactNode
}) {
  const empty = tickets.length === 0
  return (
    <div data-drop="hold" role="group" aria-label={`${HOLD_COLUMN.label} · ${tickets.length}${dragging ? ' — drop here to put a ticket on hold' : ''}`}>
      {/* Its own header, matching a column's */}
      <header className="mb-2 flex h-5 items-center gap-2 px-1">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ background: hexToRgba(ACCENT, 0.16) }}>
          <PauseIcon size={12} color={ACCENT} />
        </span>
        <span className="truncate text-[11px] font-bold uppercase tracking-wider" style={{ color: ACCENT }}>
          {HOLD_COLUMN.label}
        </span>
        <span
          className="ml-auto min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums"
          style={{ color: ACCENT, background: hexToRgba(ACCENT, 0.14) }}
        >
          {tickets.length}
        </span>
      </header>

      {/* Its own box: slim when empty, sized to its cards otherwise */}
      <div
        className="flex flex-col gap-2 rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-200"
        title={empty ? 'Drag a card here to put it on hold in Jira.' : undefined}
        style={{
          borderColor: hexToRgba(ACCENT, over ? 0.75 : 0.32),
          background: hexToRgba(ACCENT, over ? 0.14 : 0.05),
          boxShadow: over ? `0 0 0 3px ${hexToRgba(ACCENT, 0.18)}` : undefined,
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {tickets.map(card)}
        </AnimatePresence>

        {/* Landing slot while a card hovers, like any column's */}
        <AnimatePresence initial={false}>
          {over && (
            <motion.div
              key="hold-slot"
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 40 }}
              exit={{ opacity: 0, height: 0 }}
              transition={SPRING}
              className="flex items-center justify-center overflow-hidden rounded-lg border-2 border-dashed text-[11px] font-semibold"
              style={{ borderColor: hexToRgba(ACCENT, 0.55), background: hexToRgba(ACCENT, 0.1), color: ACCENT }}
            >
              Drop to put on hold
            </motion.div>
          )}
        </AnimatePresence>

        {empty && !over && (
          <div className="flex items-center justify-center py-2.5 text-[11px] italic" style={{ color: dragging ? ACCENT : 'var(--muted)' }}>
            {dragging ? 'Drop here to put on hold' : 'Nothing on hold'}
          </div>
        )}
      </div>
    </div>
  )
})
