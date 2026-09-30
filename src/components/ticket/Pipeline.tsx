import { motion } from 'motion/react'
import { BOARD_COLUMNS, HOLD_COLUMN } from '../lib/columns'
import type { ColumnKey } from '../types'
import { hexToRgba } from '../lib/format'
import { ColumnIcon, PauseIcon } from './Icons'

/** Horizontal status pipeline: To Do → In Progress → In Review → QA → Done. */
export function Pipeline({ current, rawStatus }: { current: ColumnKey; rawStatus?: string | null }) {
  const onHold = current === 'hold'
  const currentIdx = BOARD_COLUMNS.findIndex((c) => c.key === current)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-1.5">
        {BOARD_COLUMNS.map((c, i) => {
          const reached = !onHold && i <= currentIdx
          const isCurrent = !onHold && i === currentIdx
          const accent = c.accent
          return (
            <div key={c.key} className="flex flex-1 flex-col items-center gap-1">
              <div className="relative h-1.5 w-full overflow-hidden rounded-full" style={{ background: hexToRgba(accent, 0.16) }}>
                <motion.div
                  className="absolute inset-0 rounded-full"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: reached ? 1 : 0 }}
                  transition={{ duration: 0.5, delay: 0.05 * i, ease: 'easeOut' }}
                  style={{ background: accent, transformOrigin: 'left' }}
                />
              </div>
              <div
                className="flex items-center gap-1 text-[10px] font-semibold"
                style={{ color: reached ? accent : 'var(--muted)' }}
              >
                <ColumnIcon col={c.key} color={reached ? accent : 'var(--muted)'} size={12} />
                <span className={isCurrent ? '' : 'hidden sm:inline'}>{c.label}</span>
              </div>
            </div>
          )
        })}
      </div>
      {onHold && (
        <div
          className="inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-[11px] font-semibold pulse-attention"
          style={{ color: HOLD_COLUMN.accent, background: hexToRgba(HOLD_COLUMN.accent, 0.14), ['--ring' as string]: HOLD_COLUMN.accent }}
        >
          <PauseIcon size={12} color={HOLD_COLUMN.accent} /> On Hold{rawStatus ? ` · ${rawStatus}` : ''}
        </div>
      )}
    </div>
  )
}
