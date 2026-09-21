import { useEffect, useState } from 'react'
import { motion, useSpring } from 'motion/react'
import { BOARD_COLUMNS, NEXT_SPRINT_SECTION } from '../lib/columns'
import type { ColumnKey, Ticket } from '../types'
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
  /** Column identity — a 6px dot, the one bit of colour a segment carries. */
  color?: string
  title: string
}

/**
 * One segmented control instead of a row of pills: a single quiet track, and a solid thumb that
 * slides to whichever segment is chosen. Colour is withheld to the column dots and the selected
 * count, so the control reads as one object rather than nine.
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
    { id: null, label: 'Active', n: total, title: 'Everything in flight — every column of the board' },
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
    { id: 'all', label: 'All', title: 'Show every ticket at once — all columns plus the Next Sprint queue, expanded' },
  ]

  return (
    <div className="mb-4 flex items-center gap-3">
      <div
        role="group"
        aria-label="Filter the board"
        className="no-scrollbar flex h-8 max-w-full shrink items-center gap-[2px] overflow-x-auto rounded-[9px] border border-[var(--line)] bg-[var(--surface-2)] p-[2px]"
      >
        {segments.map((s) => {
          const on = active === s.id
          return (
            <motion.button
              key={String(s.id)}
              type="button"
              whileTap={{ scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 600, damping: 30 }}
              onClick={() => onSelect(on && s.id !== null ? null : s.id)}
              aria-pressed={on}
              title={s.title}
              className={`relative flex h-full shrink-0 items-center rounded-[7px] px-3 text-[12px] font-semibold whitespace-nowrap transition-colors duration-150 ${
                on ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'
              }`}
            >
              {on && (
                <motion.span
                  layoutId="jb-filter-thumb"
                  className="absolute inset-0 rounded-[7px] bg-[var(--surface-solid)]"
                  style={{ boxShadow: '0 1px 2px rgba(16,24,40,0.10), 0 0 0 0.5px var(--line)' }}
                  transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                />
              )}
              <span className="relative z-[1] inline-flex items-center gap-1.5">
                {s.color && <span className="h-[6px] w-[6px] rounded-full" style={{ background: s.color }} />}
                {s.label}
                {s.n != null && (
                  <span className="tabular-nums" style={{ color: on ? (s.color ?? 'var(--ink)') : 'var(--muted)' }}>
                    <AnimatedNumber value={s.n} />
                  </span>
                )}
              </span>
            </motion.button>
          )
        })}
      </div>

      {/* The one celebratory element on the page keeps its gold, sized to the same 32px line. */}
      {completedCount != null && (
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 600, damping: 30 }}
          onClick={onOpenCompleted}
          title="View all completed tickets"
          className="gold-sheen ml-auto inline-flex h-8 shrink-0 items-center rounded-full border-2 px-3.5 text-[12.5px] font-extrabold text-[#5b3d00]"
          style={{ borderColor: '#b45309' }}
        >
          <span className="relative z-[1] inline-flex items-center gap-1.5">
            <TrophyIcon size={12} glint /> Completed{' '}
            <b>
              <AnimatedNumber value={completedCount} />
            </b>
          </span>
        </motion.button>
      )}
    </div>
  )
}
