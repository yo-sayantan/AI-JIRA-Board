import { memo, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import type { Ticket } from '../../types'
import { LandingSlot, SpaceHeader, dropBoxStyle } from './boardParts'

/**
 * A second, separate space under a column's own box, in the same column: On Hold under Blocked,
 * QA In Progress under QA. Its own header and its own box, never nested inside the column's; slim
 * when empty. `droppable` ones (On Hold) are drop targets — the Column's one set of drag listeners
 * tells them apart (`data-drop`); locked ones (QA In Progress, which only the QA team fills in Jira)
 * are shown but never accept a card.
 */
export const SubSection = memo(function SubSection({
  id,
  label,
  accent,
  icon,
  tickets,
  card,
  over,
  dragging,
  droppable,
  texts,
  hint,
  bare = false,
}: {
  /** Drop-target id, matched by Column's `targetOf` (droppable sections only). */
  id: string
  label: string
  accent: string
  icon: ReactNode
  tickets: Ticket[]
  /** The column's card renderer, so cards here look and behave like every other card. */
  card: (t: Ticket) => ReactNode
  /** A card is hovering this section. */
  over: boolean
  /** A card is being dragged somewhere on the board. */
  dragging: boolean
  droppable: boolean
  texts: { idle: string; dragging: string; slot: string }
  /** Tooltip while empty. */
  hint?: string
  /** The column already wears this space's header (its own box is off): no second header, fill the column. */
  bare?: boolean
}) {
  const empty = tickets.length === 0
  return (
    <div
      data-drop={droppable ? id : undefined}
      role="group"
      className={bare ? 'flex flex-1 flex-col' : undefined}
      aria-label={`${label} · ${tickets.length}${droppable && dragging ? ' — drop here' : ''}`}
    >
      {!bare && <SpaceHeader accent={accent} icon={icon} label={label} count={tickets.length} />}
      <div
        className={`flex flex-col gap-2 ${bare ? 'flex-1' : ''} rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow,opacity] duration-150`}
        title={empty ? hint : undefined}
        style={{ ...dropBoxStyle(accent, droppable && over), opacity: !droppable && dragging ? 0.55 : 1 }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {tickets.map(card)}
        </AnimatePresence>
        {droppable && <LandingSlot accent={accent} show={over} label={texts.slot} />}
        {empty && !(droppable && over) && (
          <div className="flex items-center justify-center py-2.5 text-center text-[11px] italic" style={{ color: droppable && dragging ? accent : 'var(--muted)' }}>
            {dragging ? texts.dragging : texts.idle}
          </div>
        )}
      </div>
    </div>
  )
})
