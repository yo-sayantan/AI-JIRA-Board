import { useEffect, useState } from 'react'
import { motion, useSpring } from 'motion/react'
import { BOARD_COLUMNS } from '../lib/columns'
import type { ColumnKey, Ticket } from '../types'
import { hexToRgba } from '../lib/format'
import { TrophyIcon } from './Icons'

function AnimatedNumber({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 110, damping: 22 })
  const [display, setDisplay] = useState(value)
  useEffect(() => {
    spring.set(value)
  }, [value, spring])
  useEffect(() => spring.on('change', (v) => setDisplay(Math.round(v))), [spring])
  return <span className="tabular-nums">{display}</span>
}

export function Stats({
  tickets,
  completedCount,
  active,
  onSelect,
  onOpenCompleted,
}: {
  tickets: Ticket[]
  completedCount: number
  active: ColumnKey | null
  onSelect: (key: ColumnKey | null) => void
  onOpenCompleted?: () => void
}) {
  const counts = (k: ColumnKey) => tickets.filter((t) => t.column === k).length
  const total = tickets.filter((t) => t.column !== 'hold').length

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <button
        onClick={() => onSelect(null)}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-all ${
          active === null
            ? 'border-transparent bg-[var(--ink)] text-[var(--bg)]'
            : 'border-[var(--line)] bg-[var(--surface-solid)] text-[var(--ink-soft)] hover:border-[var(--muted)]'
        }`}
      >
        <AnimatedNumber value={total} /> active
      </button>

      {BOARD_COLUMNS.map((c) => {
        const n = counts(c.key)
        const isActive = active === c.key
        return (
          <motion.button
            key={c.key}
            whileHover={{ scale: 1.05, y: -1 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            onClick={() => onSelect(isActive ? null : c.key)}
            className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors"
            style={{
              borderColor: isActive ? c.accent : 'var(--line)',
              background: isActive ? hexToRgba(c.accent, 0.16) : 'var(--surface-solid)',
              color: isActive ? c.accent : 'var(--ink-soft)',
              boxShadow: isActive ? `0 0 0 1px ${hexToRgba(c.accent, 0.4)}` : 'none',
            }}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.accent }} />
            {c.label}
            <b style={{ color: c.accent }}>
              <AnimatedNumber value={n} />
            </b>
          </motion.button>
        )
      })}

      <motion.button
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 400, damping: 22 }}
        onClick={onOpenCompleted}
        title="View all completed tickets"
        className="gold-sheen ml-auto inline-flex items-center rounded-full border-[3px] px-4 py-2 text-[13.5px] font-extrabold text-[#5b3d00]"
        style={{ borderColor: '#b45309' }}
      >
        <span className="relative z-[1] inline-flex items-center gap-2">
          <TrophyIcon size={16} glint /> Completed{' '}
          <b>
            <AnimatedNumber value={completedCount} />
          </b>
        </span>
      </motion.button>
    </div>
  )
}
