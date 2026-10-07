import { memo, useMemo } from 'react'
import { BOARD_COLUMNS } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'
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
}: {
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  focus?: ColumnKey | null
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: ReadonlySet<string>
  /** Drag-and-drop status change, written through to Jira. */
  onMove?: (key: string, to: ColumnKey) => void
  movingKeys?: ReadonlySet<string>
}) {
  const byColumn = useMemo(() => {
    const groups = new Map<ColumnKey, Ticket[]>(BOARD_COLUMNS.map((c) => [c.key, []]))
    for (const t of tickets) groups.get(t.column)?.push(t)
    for (const [key, list] of groups) list.sort(key === 'done' ? byRecency : byUrgency)
    return groups
  }, [tickets])
  const cols = focus ? BOARD_COLUMNS.filter((c) => c.key === focus) : BOARD_COLUMNS
  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {cols.map((meta) => (
        <Column
          key={meta.key}
          meta={meta}
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
        />
      ))}
    </div>
  )
})
