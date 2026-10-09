import { memo, useMemo, useState } from 'react'
import { BOARD_COLUMNS } from '../../lib/columns'
import { ALL_SECTIONS, type BoardSections } from '../../lib/boardView'
import type { ColumnKey, Ticket } from '../../types'
import type { MoveTarget } from '../../lib/columns'
import { priorityMeta } from '../../lib/format'
import { Column } from './Column'

// Within a column: most urgent first, then most recently touched. The Done column
// instead shows the freshest win on top (priority is moot once it's shipped).
const byUrgency = (a: Ticket, b: Ticket) =>
  priorityMeta(b.priority).rank - priorityMeta(a.priority).rank ||
  (b.lastUpdate ?? '').localeCompare(a.lastUpdate ?? '')
const byRecency = (a: Ticket, b: Ticket) =>
  (b.resolved ?? b.lastUpdate ?? '').localeCompare(a.resolved ?? a.lastUpdate ?? '')

export const Board = memo(function Board({
  tickets,
  now,
  onOpen,
  focus,
  onArchive,
  onRefreshTicket,
  refreshingKeys,
  onMove,
  movingKeys,
  bottomOrder,
  held,
  sections = ALL_SECTIONS,
}: {
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  focus?: ColumnKey | null
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: ReadonlySet<string>
  /** Drag-and-drop status change, written through to Jira. */
  onMove?: (key: string, to: MoveTarget) => void
  movingKeys?: ReadonlySet<string>
  /** Cards dropped by hand sit at the bottom of their column, in drop order, below the sorted rest. */
  bottomOrder?: ReadonlyMap<string, number>
  /** On Hold tickets, shown as their own space under Blocked. Undefined = Settings → On Hold is off. */
  held?: Ticket[]
  /** Which optional sections are on (Settings → Board sections). */
  sections?: BoardSections
}) {
  const byColumn = useMemo(() => {
    const groups = new Map<ColumnKey, Ticket[]>(BOARD_COLUMNS.map((c) => [c.key, []]))
    for (const t of tickets) groups.get(t.column)?.push(t)
    const pin = (t: Ticket) => bottomOrder?.get(t.key) ?? 0
    for (const [key, list] of groups) {
      const natural = key === 'done' ? byRecency : byUrgency
      list.sort((a, b) => pin(a) - pin(b) || natural(a, b))
    }
    return groups
  }, [tickets, bottomOrder])
  const heldSorted = useMemo(() => {
    if (!held) return undefined
    const pin = (t: Ticket) => bottomOrder?.get(t.key) ?? 0
    return [...held].sort((a, b) => pin(a) - pin(b) || byUrgency(a, b))
  }, [held, bottomOrder])
  // Blocked is also the home of the On Hold space: with Blocked off and On Hold on the column stays, as On Hold alone.
  const shown = BOARD_COLUMNS.filter((c) => c.key !== 'blocked' || sections.blocked || held !== undefined)
  const cols = focus ? shown.filter((c) => c.key === focus) : shown
  // Card drags start inside this element and bubble up, so one pair of listeners tells every
  // column that a drag is in flight — empty columns open from a rail to a compact drop zone.
  // The ticket being carried, so each zone can tell whether it may land there (QA lane rules).
  const [dragKey, setDragKey] = useState<string | null>(null)
  const dragActive = dragKey !== null
  const dragged = useMemo(() => (dragKey ? [...tickets, ...(held ?? [])].find((t) => t.key === dragKey) : undefined), [dragKey, tickets, held])
  return (
    <div
      // Columns overlap their neighbours' gap by 6px a side (Column.tsx), so drop areas touch; the
      // container's matching padding keeps the first and last from being clipped. While a drag is in
      // flight widths change instantly (jb-dragging): zones sliding under the pointer were why a hover
      // sometimes "missed" and the drop felt late.
      className={`-mx-1.5 flex items-stretch gap-3 overflow-x-auto px-1.5 pb-3 ${dragActive ? 'jb-dragging' : ''}`}
      onDragStart={(e) => setDragKey((e.target as HTMLElement).closest?.('[data-ticket-key]')?.getAttribute('data-ticket-key') ?? '')}
      onDragEnd={() => setDragKey(null)}
      onDrop={() => setDragKey(null)}
    >
      {cols.map((meta) => (
        <Column
          key={meta.key}
          meta={meta}
          dragActive={dragActive}
          dragged={dragged}
          focused={cols.length === 1}
          tickets={byColumn.get(meta.key) ?? []}
          now={now}
          onOpen={onOpen}
          // Only Done cards can be moved to Completed (off the board, into the archive).
          onArchive={meta.key === 'done' ? onArchive : undefined}
          // Per-ticket refresh only for in-flight columns (the card also guards on column).
          onRefreshTicket={meta.key === 'done' ? undefined : onRefreshTicket}
          refreshingKeys={refreshingKeys}
          onMove={onMove}
          movingKeys={movingKeys}
          held={meta.key === 'blocked' ? heldSorted : undefined}
          hideOwn={meta.key === 'blocked' && !sections.blocked}
          showQaInProgress={sections.qaInProgress}
        />
      ))}
    </div>
  )
})
