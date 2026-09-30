import { BOARD_COLUMNS } from '../lib/columns'
import type { ColumnKey, Ticket } from '../types'
import { priorityMeta } from '../lib/format'
import { Column } from './Column'

// Within a column: most urgent first, then most recently touched. The Done column
// instead shows the freshest win on top (priority is moot once it's shipped).
const byUrgency = (a: Ticket, b: Ticket) =>
  priorityMeta(b.priority).rank - priorityMeta(a.priority).rank ||
  (b.lastUpdate ?? '').localeCompare(a.lastUpdate ?? '')
const byRecency = (a: Ticket, b: Ticket) =>
  (b.resolved ?? b.lastUpdate ?? '').localeCompare(a.resolved ?? a.lastUpdate ?? '')

export function Board({
  tickets,
  now,
  onOpen,
  focus,
  onArchive,
  onRefreshTicket,
  refreshingKeys,
}: {
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  focus?: ColumnKey | null
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: Set<string>
}) {
  const cols = focus ? BOARD_COLUMNS.filter((c) => c.key === focus) : BOARD_COLUMNS
  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {cols.map((meta) => (
        <Column
          key={meta.key}
          meta={meta}
          tickets={tickets.filter((t) => t.column === meta.key).sort(meta.key === 'done' ? byRecency : byUrgency)}
          now={now}
          onOpen={onOpen}
          // Only Done cards can be moved to Completed (off the board, into the archive).
          onArchive={meta.key === 'done' ? onArchive : undefined}
          // Per-ticket refresh only for in-flight columns (the card also guards on column).
          onRefreshTicket={meta.key === 'done' ? undefined : onRefreshTicket}
          refreshingKeys={refreshingKeys}
        />
      ))}
    </div>
  )
}
