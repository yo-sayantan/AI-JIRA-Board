import { memo, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ColumnMeta } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'
import { DRAG_MIME, TicketCard } from './TicketCard'
import { hexToRgba } from '../../lib/format'
import { ColumnIcon } from '../common/Icons'

export const Column = memo(function Column({
  meta,
  tickets,
  now,
  onOpen,
  onArchive,
  onRefreshTicket,
  refreshingKeys,
  onMove,
  movingKeys,
}: {
  meta: ColumnMeta
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: ReadonlySet<string>
  /** Drop handler: the dragged ticket should take this column's status in Jira. */
  onMove?: (key: string, to: ColumnKey) => void
  movingKeys?: ReadonlySet<string>
}) {
  const [over, setOver] = useState(false)
  const accepts = (e: DragEvent) => !!onMove && e.dataTransfer.types.includes(DRAG_MIME)
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!over) setOver(true)
  }
  const onDragLeave = (e: DragEvent) => {
    // Leaving for a child element still counts as inside the column.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setOver(false)
  }
  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    setOver(false)
    const key = e.dataTransfer.getData(DRAG_MIME)
    if (key) onMove?.(key, meta.key)
  }
  return (
    <section className="flex min-w-[244px] flex-1 flex-col" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="mb-2 flex items-center gap-2 px-1">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-md" style={{ background: hexToRgba(meta.accent, 0.16) }}>
          <ColumnIcon col={meta.key} color={meta.accent} size={13} />
        </span>
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: meta.accent }}>
          {meta.label}
        </span>
        <span
          className="ml-auto min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums"
          style={{ color: meta.accent, background: hexToRgba(meta.accent, 0.14) }}
        >
          {tickets.length}
        </span>
      </header>

      <div
        className="relative rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-200"
        style={{
          borderColor: hexToRgba(meta.accent, over ? 0.7 : 0.22),
          background: hexToRgba(meta.accent, over ? 0.12 : 0.04),
          boxShadow: over ? `0 0 0 3px ${hexToRgba(meta.accent, 0.18)}, 0 12px 28px -16px ${hexToRgba(meta.accent, 0.5)}` : undefined,
        }}
      >
        <div className="flex flex-col gap-2">
          <AnimatePresence mode="popLayout" initial={false}>
            {tickets.map((t) => (
              <TicketCard
                key={t.key}
                ticket={t}
                now={now}
                onOpen={onOpen}
                onArchive={onArchive}
                onRefreshTicket={onRefreshTicket}
                refreshing={refreshingKeys?.has(t.key)}
                draggable={!!onMove}
                moving={movingKeys?.has(t.key)}
              />
            ))}
          </AnimatePresence>

          {tickets.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center justify-center rounded-lg py-6 text-[11px] italic text-[var(--muted)]"
            >
              {over ? `Drop to move to ${meta.label}` : 'Nothing here'}
            </motion.div>
          )}
        </div>
      </div>
    </section>
  )
})
