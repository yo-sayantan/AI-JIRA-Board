import { useEffect, useState } from 'react'
import { motion, useSpring } from 'motion/react'
import { BOARD_COLUMNS, NEXT_SPRINT_SECTION } from '../lib/columns'
import type { ColumnKey, Ticket } from '../types'
import { hexToRgba } from '../lib/format'
import { TrophyIcon, TicketGlyph } from './Icons'

/**
 * What the top chip row currently has selected. A column key filters the board to that
 * column; 'next' reveals the Next Sprint bar; 'all' reveals everything (board + Next Sprint
 * expanded); null is the default view. Selections are mutually exclusive — picking any chip
 * clears the others, which is what hides the Next Sprint bar when another chip is chosen.
 */
export type StatSelection = ColumnKey | 'next' | 'all' | null

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
  nextSprintCount = 0,
  active,
  onSelect,
  onOpenCompleted,
}: {
  /** Board + On Hold tickets only — next-sprint work is counted separately. */
  tickets: Ticket[]
  completedCount: number
  /** To Do tickets whose sprint hasn't started (rendered in the Next Sprint section). */
  nextSprintCount?: number
  active: StatSelection
  onSelect: (key: StatSelection) => void
  onOpenCompleted?: () => void
}) {
  const counts = (k: ColumnKey) => tickets.filter((t) => t.column === k).length
  const total = tickets.filter((t) => t.column !== 'hold').length
  const NS = NEXT_SPRINT_SECTION.accent

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

      {/* A toggle, not a filter: it shows/hides the Next Sprint bar below the board. Selecting any
          other chip clears `active`, so the bar closes on its own — no cross-component wiring. */}
      {nextSprintCount > 0 &&
        (() => {
          const on = active === 'next'
          return (
            <motion.button
              whileHover={{ scale: 1.05, y: -1 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              onClick={() => onSelect(on ? null : 'next')}
              aria-pressed={on}
              title="Assigned to you, but the sprint hasn’t started — show or hide the Next Sprint bar"
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors"
              style={{
                borderColor: on ? NS : hexToRgba(NS, 0.5),
                background: on ? hexToRgba(NS, 0.16) : 'var(--surface-solid)',
                color: NS,
                boxShadow: on ? `0 0 0 1px ${hexToRgba(NS, 0.4)}` : 'none',
              }}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: NS }} />
              {NEXT_SPRINT_SECTION.label}
              <b>
                <AnimatedNumber value={nextSprintCount} />
              </b>
            </motion.button>
          )
        })()}

      {/* "All" — reveal everything at once: every column plus the Next Sprint queue, expanded. */}
      {(() => {
        const on = active === 'all'
        return (
          <motion.button
            whileHover={{ scale: 1.05, y: -1 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            onClick={() => onSelect(on ? null : 'all')}
            aria-pressed={on}
            title="Show every ticket at once — all columns plus the Next Sprint queue, expanded"
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-all ${
              on
                ? 'border-transparent bg-[var(--ink)] text-[var(--bg)]'
                : 'border-[var(--line)] bg-[var(--surface-solid)] text-[var(--ink-soft)] hover:border-[var(--muted)]'
            }`}
          >
            <TicketGlyph size={13} /> All
          </motion.button>
        )
      })()}

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
