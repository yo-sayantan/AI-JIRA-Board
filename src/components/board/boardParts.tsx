import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { hexToRgba } from '../../lib/format'

// Pieces every space on the board shares — a column, the On Hold space under Blocked, an empty
// column's rail or drop zone — so they cannot drift apart in size or colour.

export const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const

/** A dashed drop box: faint at rest, lit while a card hovers it. */
export function dropBoxStyle(accent: string, active: boolean): CSSProperties {
  return {
    borderColor: hexToRgba(accent, active ? 0.72 : 0.26),
    background: hexToRgba(accent, active ? 0.13 : 0.045),
    boxShadow: active ? `0 0 0 3px ${hexToRgba(accent, 0.18)}, 0 12px 28px -16px ${hexToRgba(accent, 0.5)}` : undefined,
  }
}

export function CountPill({ accent, count }: { accent: string; count: number }) {
  return (
    <span
      className="ml-auto min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums"
      style={{ color: accent, background: hexToRgba(accent, 0.14) }}
    >
      {count}
    </span>
  )
}

/** A space's header: icon chip, uppercase label, count. `folded` keeps only the icon (a rail). */
export function SpaceHeader({
  accent,
  icon,
  label,
  count,
  folded = false,
  title,
}: {
  accent: string
  icon: ReactNode
  label: string
  /** Omitted while an empty column is a drop zone — "0" would only add noise. */
  count?: number
  folded?: boolean
  title?: string
}) {
  return (
    <header className="mb-2 flex h-5 items-center gap-2 px-1">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ background: hexToRgba(accent, 0.16) }} title={title}>
        {icon}
      </span>
      <AnimatePresence initial={false}>
        {!folded && (
          <motion.span
            key="label"
            className="flex min-w-0 flex-1 items-center gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <span className="truncate text-[11px] font-bold uppercase tracking-wider" style={{ color: accent }}>
              {label}
            </span>
            {count !== undefined && <CountPill accent={accent} count={count} />}
          </motion.span>
        )}
      </AnimatePresence>
    </header>
  )
}

/** Where a hovering card will land: the bottom of the space, labelled with what the drop does. */
export function LandingSlot({ accent, show, label }: { accent: string; show: boolean; label: string }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="slot"
          layout
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 44 }}
          exit={{ opacity: 0, height: 0 }}
          transition={SPRING}
          className="flex items-center justify-center overflow-hidden rounded-xl border-2 border-dashed text-[11px] font-semibold"
          style={{ borderColor: hexToRgba(accent, 0.55), background: hexToRgba(accent, 0.1), color: accent }}
        >
          {label}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
