import { AnimatePresence, motion } from 'motion/react'
import type { ColumnMeta } from '../lib/columns'
import type { Ticket } from '../types'
import { TicketCard } from './TicketCard'
import { hexToRgba } from '../lib/format'
import { ColumnIcon } from './Icons'

export function Column({
  meta,
  tickets,
  now,
  onOpen,
  onArchive,
  onRefreshTicket,
  refreshingKeys,
}: {
  meta: ColumnMeta
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: Set<string>
}) {
  return (
    <section className="flex min-w-[244px] flex-1 flex-col">
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
        className="relative rounded-2xl border border-dashed p-2"
        style={{ borderColor: hexToRgba(meta.accent, 0.22), background: hexToRgba(meta.accent, 0.04) }}
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
              />
            ))}
          </AnimatePresence>

          {tickets.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center justify-center rounded-lg py-6 text-[11px] italic text-[var(--muted)]"
            >
              Nothing here
            </motion.div>
          )}
        </div>
      </div>
    </section>
  )
}
