import { memo, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { QA_IN_PROGRESS, isQaInProgress, type ColumnMeta } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'
import { DRAG_MIME, TicketCard } from './TicketCard'
import { hexToRgba } from '../../lib/format'
import { ColumnIcon, LockIcon } from '../common/Icons'

const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const
const FULL = { flex: '1 1 13.5rem', minWidth: '13.5rem' } as const
const RAIL = { flex: '0 0 2.75rem', minWidth: '2.75rem' } as const

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
  dragActive = false,
  focused = false,
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
  /** A card is being dragged somewhere on the board. */
  dragActive?: boolean
  /** This is the only column shown (a stat chip filtered the board to it). */
  focused?: boolean
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

  // QA is one drop target with two shelves. Cards land on the top one (a ready-for-QA status);
  // the QA team moves them to "QA In Progress" in Jira, so that shelf is never a drop target.
  const inProgress = meta.key === 'qa' ? tickets.filter((t) => isQaInProgress(t.status)) : []
  const ready = inProgress.length ? tickets.filter((t) => !isQaInProgress(t.status)) : tickets

  // An empty Blocked column folds to a rail — until a drag starts, when it opens as a target.
  const collapsed = !!meta.collapsible && tickets.length === 0 && !dragActive && !over && !focused
  const dropLabel = meta.key === 'blocked' ? 'Drop to mark as Blocked' : `Drop to move to ${meta.label}`
  const emptyHint = meta.key === 'blocked' ? (dragActive ? 'Drag a stuck card here' : 'Nothing blocked') : 'Nothing here'

  const card = (t: Ticket) => (
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
  )

  return (
    <section
      className={`jb-col flex flex-col ${collapsed ? 'jb-col-rail' : ''}`}
      style={collapsed ? RAIL : FULL}
      aria-label={`${meta.label}${collapsed ? ' — empty' : ` · ${tickets.length}`}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="mb-2 flex h-5 items-center gap-2 px-1">
        <span
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
          style={{ background: hexToRgba(meta.accent, 0.16) }}
          title={collapsed ? `${meta.label} — empty. Drag a card here when its work is stuck; it is marked ${meta.label} in Jira.` : undefined}
        >
          <ColumnIcon col={meta.key} color={meta.accent} size={13} />
        </span>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.span
              key="label"
              className="flex min-w-0 flex-1 items-center gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <span className="truncate text-[11px] font-bold uppercase tracking-wider" style={{ color: meta.accent }}>
                {meta.label}
              </span>
              <span
                className="ml-auto min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums"
                style={{ color: meta.accent, background: hexToRgba(meta.accent, 0.14) }}
              >
                {tickets.length}
              </span>
            </motion.span>
          )}
        </AnimatePresence>
      </header>

      {/* The drop zone fills the column's height, so a drop anywhere below the cards counts. */}
      <div
        className={`relative flex-1 rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-200 ${collapsed ? 'jb-rail-zone' : ''}`}
        style={{
          borderColor: hexToRgba(meta.accent, over ? 0.7 : collapsed ? 0.3 : 0.22),
          background: hexToRgba(meta.accent, over ? 0.12 : 0.04),
          boxShadow: over ? `0 0 0 3px ${hexToRgba(meta.accent, 0.18)}, 0 12px 28px -16px ${hexToRgba(meta.accent, 0.5)}` : undefined,
        }}
      >
        {collapsed ? (
          <div className="flex h-full min-h-[120px] justify-center pt-1.5">
            <span
              className="text-[10px] font-bold uppercase tracking-[0.18em]"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: hexToRgba(meta.accent, 0.85) }}
            >
              {meta.label}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {ready.map(card)}
            </AnimatePresence>

            {/* Landing slot while a card hovers: it opens where the card will land — the bottom. */}
            <AnimatePresence initial={false}>
              {over && (
                <motion.div
                  key="slot"
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 44 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={SPRING}
                  className="flex items-center justify-center overflow-hidden rounded-xl border-2 border-dashed text-[11px] font-semibold"
                  style={{ borderColor: hexToRgba(meta.accent, 0.55), background: hexToRgba(meta.accent, 0.1), color: meta.accent }}
                >
                  {dropLabel}
                </motion.div>
              )}
            </AnimatePresence>

            {ready.length === 0 && !over && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center rounded-lg py-6 text-[11px] italic text-[var(--muted)]"
              >
                {emptyHint}
              </motion.div>
            )}

            {meta.key === 'qa' && (
              <AnimatePresence initial={false}>
                {inProgress.length > 0 && (
                  <motion.div
                    key="qa-in-progress"
                    layout
                    initial={{ opacity: 0, height: 0 }}
                    // Dimmed while a card hovers the column: this shelf is not where it lands.
                    animate={{ opacity: over ? 0.5 : 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={SPRING}
                    className={`overflow-hidden ${over ? 'pointer-events-none' : ''}`}
                    aria-label={`${QA_IN_PROGRESS.label} · ${inProgress.length}`}
                  >
                    <div
                      className="rounded-xl border p-1.5"
                      style={{
                        borderColor: hexToRgba(QA_IN_PROGRESS.accent, 0.38),
                        background: hexToRgba(QA_IN_PROGRESS.accent, 0.09),
                        boxShadow: `inset 3px 0 0 ${QA_IN_PROGRESS.accent}`,
                      }}
                      title="Picked up by the QA team in Jira. Cards cannot be dropped here — drop them on QA and QA takes it from there."
                    >
                      <div className="mb-1.5 flex items-center gap-1.5 px-1 pt-0.5">
                        <ColumnIcon col="qa" color={QA_IN_PROGRESS.accent} size={11} />
                        <span className="truncate text-[10px] font-bold uppercase tracking-wider" style={{ color: QA_IN_PROGRESS.accent }}>
                          {QA_IN_PROGRESS.label}
                        </span>
                        <LockIcon size={10} color={hexToRgba(QA_IN_PROGRESS.accent, 0.8)} />
                        <span
                          className="ml-auto min-w-[20px] rounded-full px-1.5 text-center text-[10px] font-bold tabular-nums"
                          style={{ color: QA_IN_PROGRESS.accent, background: hexToRgba(QA_IN_PROGRESS.accent, 0.16) }}
                        >
                          {inProgress.length}
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        <AnimatePresence mode="popLayout" initial={false}>
                          {inProgress.map(card)}
                        </AnimatePresence>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </div>
        )}
      </div>
    </section>
  )
})
