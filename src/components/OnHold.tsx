import { AnimatePresence, motion } from 'motion/react'
import type { Ticket } from '../types'
import { HOLD_COLUMN } from '../lib/columns'
import { TicketCard } from './TicketCard'
import { hexToRgba } from '../lib/format'
import { PauseIcon } from './Icons'

/** Rendered ONLY when something is on hold — otherwise it stays out of the way. */
export function OnHold({ tickets, now, onOpen }: { tickets: Ticket[]; now: number; onOpen: (key: string) => void }) {
  return (
    <AnimatePresence initial={false}>
      {tickets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, height: 'auto', marginTop: 24 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 30 }}
          className="overflow-hidden"
        >
          <div
            className="rounded-2xl border p-4"
            style={{ borderColor: hexToRgba(HOLD_COLUMN.accent, 0.4), background: hexToRgba(HOLD_COLUMN.accent, 0.06) }}
          >
            <div className="mb-3 flex items-center gap-2">
              <span
                className="grid h-7 w-7 place-items-center rounded-lg pulse-attention"
                style={{ background: hexToRgba(HOLD_COLUMN.accent, 0.18), ['--ring' as string]: HOLD_COLUMN.accent }}
              >
                <PauseIcon size={15} color={HOLD_COLUMN.accent} />
              </span>
              <h2 className="text-[14px] font-bold" style={{ color: HOLD_COLUMN.accent }}>
                On Hold
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                style={{ color: HOLD_COLUMN.accent, background: hexToRgba(HOLD_COLUMN.accent, 0.16) }}
              >
                {tickets.length}
              </span>
              <span className="text-[11.5px] text-[var(--muted)]">blocked / waiting — needs a nudge</span>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {tickets.map((t) => (
                <TicketCard key={t.key} ticket={t} now={now} onOpen={onOpen} />
              ))}
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
