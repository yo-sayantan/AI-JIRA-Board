import { memo, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import type { Ticket } from '../../types'
import { HOLD_COLUMN } from '../../lib/columns'
import { PauseIcon } from '../common/Icons'
import { LandingSlot, SpaceHeader, dropBoxStyle } from './boardParts'

const ACCENT = HOLD_COLUMN.accent

/**
 * On Hold: its own space in the Blocked column — a second header and a second box under Blocked's,
 * never inside it. Usually it holds nothing, so it stays a slim box; but it is always there to drop
 * on: a card dropped here is put On Hold in Jira. The Column's one set of drag listeners decides the
 * target (Column.tsx `targetOf`): this box (`data-drop="hold"`) and everything below Blocked's box.
 */
export const OnHoldSection = memo(function OnHoldSection({
  tickets,
  over,
  dragging,
  card,
}: {
  tickets: Ticket[]
  /** A card is hovering On Hold. */
  over: boolean
  /** A card is being dragged somewhere on the board. */
  dragging: boolean
  /** The column's card renderer, so held cards look and behave like every other card. */
  card: (t: Ticket) => ReactNode
}) {
  const empty = tickets.length === 0
  return (
    <div data-drop="hold" role="group" aria-label={`${HOLD_COLUMN.label} · ${tickets.length}${dragging ? ' — drop here to put a ticket on hold' : ''}`}>
      <SpaceHeader accent={ACCENT} icon={<PauseIcon size={12} color={ACCENT} />} label={HOLD_COLUMN.label} count={tickets.length} />
      <div
        className="flex flex-col gap-2 rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-200"
        title={empty ? 'Drag a card here to put it on hold in Jira.' : undefined}
        style={dropBoxStyle(ACCENT, over)}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {tickets.map(card)}
        </AnimatePresence>
        <LandingSlot accent={ACCENT} show={over} label="Drop to put on hold" />
        {empty && !over && (
          <div className="flex items-center justify-center py-2.5 text-[11px] italic" style={{ color: dragging ? ACCENT : 'var(--muted)' }}>
            {dragging ? 'Drop here to put on hold' : 'Nothing on hold'}
          </div>
        )}
      </div>
    </div>
  )
})
