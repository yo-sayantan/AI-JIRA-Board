import { useEffect, useState } from 'react'
import { motion, useSpring } from 'motion/react'
import { BOARD_COLUMNS, NEXT_SPRINT_SECTION } from '../lib/columns'
import type { ColumnKey, Ticket } from '../types'
import { hexToRgba } from '../lib/format'
import { TrophyIcon } from './Icons'

/**
 * What the filter row currently has selected. A column key filters the board to that column;
 * 'next' reveals the Next Sprint bar; 'all' reveals everything (board + Next Sprint expanded);
 * null is the default view. Selections are mutually exclusive — picking any segment clears the
 * others, which is what hides the Next Sprint bar when another segment is chosen.
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

type Segment = {
  id: StatSelection
  label: string
  /** Count shown after the label; omitted for "All". */
  n?: number
  /** Column identity — its dot and count wear this colour, and the thumb tints with it when chosen. */
  color?: string
  /** "Active" and "All" have no column colour: chosen, they invert to solid ink instead. */
  invert?: boolean
  title: string
}

const FALLBACK = '#64748b'

/**
 * One segmented control instead of a row of nine pills: a single track, and one thumb that slides
 * to whichever segment is chosen. Each column keeps its colour — the dot, the bold count, and the
 * tinted thumb when selected — so the row is compact without going grey.
 */
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
  /** null hides the Completed control entirely (Settings → Completed archive off). */
  completedCount: number | null
  /** To Do tickets whose sprint hasn't started (rendered in the Next Sprint section). */
  nextSprintCount?: number
  active: StatSelection
  onSelect: (key: StatSelection) => void
  onOpenCompleted?: () => void
}) {
  const counts = (k: ColumnKey) => tickets.filter((t) => t.column === k).length
  const total = tickets.filter((t) => t.column !== 'hold').length

  const segments: Segment[] = [
    { id: null, label: 'Active', n: total, invert: true, title: 'Everything in flight — every column of the board' },
    ...BOARD_COLUMNS.map<Segment>((c) => ({ id: c.key, label: c.label, n: counts(c.key), color: c.accent, title: `Only the ${c.label} column` })),
    ...(nextSprintCount > 0
      ? [
          {
            id: 'next' as const,
            label: NEXT_SPRINT_SECTION.label,
            n: nextSprintCount,
            color: NEXT_SPRINT_SECTION.accent,
            title: 'Assigned to you, but the sprint hasn’t started — show or hide the Next Sprint bar',
          },
        ]
      : []),
    { id: 'all', label: 'All', invert: true, title: 'Show every ticket at once — all columns plus the Next Sprint queue, expanded' },
  ]

  return (
    <div className="mb-4 flex items-center gap-3">
      <div
        role="group"
        aria-label="Filter the board"
        className="no-scrollbar flex h-9 max-w-full shrink items-center gap-[3px] overflow-x-auto rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] p-[3px]"
      >
        {segments.map((s) => {
          const on = active === s.id
          const accent = s.color ?? FALLBACK
          // Next Sprint is always written in its own colour (it's a toggle, not a filter); the rest
          // colour up only when chosen.
          const color = on ? (s.invert ? 'var(--bg)' : accent) : s.id === 'next' ? accent : 'var(--ink-soft)'
          return (
            <motion.button
              key={String(s.id)}
              type="button"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              onClick={() => onSelect(on && s.id !== null ? null : s.id)}
              aria-pressed={on}
              title={s.title}
              className="relative flex h-full shrink-0 items-center rounded-[9px] px-3 text-[12px] font-semibold whitespace-nowrap transition-colors duration-150"
              style={{ color }}
            >
              {on && (
                <motion.span
                  layoutId="jb-filter-thumb"
                  className="absolute inset-0 rounded-[9px]"
                  style={
                    s.invert
                      ? { background: 'var(--ink)' }
                      : { background: hexToRgba(accent, 0.16), boxShadow: `0 0 0 1px ${hexToRgba(accent, 0.45)}` }
                  }
                  transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                />
              )}
              <span className="relative z-[1] inline-flex items-center gap-1.5">
                {s.color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />}
                {s.label}
                {s.n != null && (
                  <b style={{ color: s.invert ? 'inherit' : accent }}>
                    <AnimatedNumber value={s.n} />
                  </b>
                )}
              </span>
            </motion.button>
          )
        })}
      </div>

      {completedCount != null && (
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 400, damping: 22 }}
          onClick={onOpenCompleted}
          title="View all completed tickets"
          className="gold-sheen ml-auto inline-flex h-9 shrink-0 items-center rounded-full border-[3px] px-4 text-[13.5px] font-extrabold text-[#5b3d00]"
          style={{ borderColor: '#b45309' }}
        >
          <span className="relative z-[1] inline-flex items-center gap-2">
            <TrophyIcon size={16} glint /> Completed{' '}
            <b>
              <AnimatedNumber value={completedCount} />
            </b>
          </span>
        </motion.button>
      )}
    </div>
  )
}
