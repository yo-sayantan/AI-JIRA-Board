import { memo, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { HOLD_COLUMN, QA_IN_PROGRESS, columnMode, isQaInProgress, type ColumnMeta, type ColumnMode } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'
import { DRAG_MIME, TicketCard } from './TicketCard'
import { hexToRgba } from '../../lib/format'
import { ColumnIcon, LockIcon, PauseIcon } from '../common/Icons'
import { OnHoldShelf } from './OnHold'

const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const

// Widths per mode (lib/columns.ts::columnMode). A full column grows to share the width the empty ones
// give up; a drop zone is just wide enough to aim at; a rail is a labelled sliver.
const WIDTH: Record<ColumnMode, { flex: string; minWidth: string }> = {
  full: { flex: '1 1 13.5rem', minWidth: '13.5rem' },
  drop: { flex: '0 0 7rem', minWidth: '7rem' },
  rail: { flex: '0 0 2.75rem', minWidth: '2.75rem' },
}

/** Which of a column's drop targets a card is over: the column itself, or Blocked's On Hold shelf. */
type DropTarget = 'col' | 'hold'

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
  held,
}: {
  meta: ColumnMeta
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: ReadonlySet<string>
  /** Drop handler: the dragged ticket should take this column's status (or On Hold) in Jira. */
  onMove?: (key: string, to: ColumnKey) => void
  movingKeys?: ReadonlySet<string>
  /** A card is being dragged somewhere on the board. */
  dragActive?: boolean
  /** This is the only column shown (a stat chip filtered the board to it). */
  focused?: boolean
  /** Blocked only: the On Hold shelf's tickets. Undefined = no shelf (Settings → On Hold is off). */
  held?: Ticket[]
}) {
  // One set of drag listeners serves both of Blocked's targets: the pointer is "on hold" when it is
  // inside the shelf (data-drop="hold"), otherwise on the column. No nested listeners to keep in step.
  const [over, setOver] = useState<DropTarget | null>(null)
  const accepts = (e: DragEvent) => !!onMove && e.dataTransfer.types.includes(DRAG_MIME)
  const targetOf = (e: DragEvent): DropTarget =>
    held && (e.target as Element | null)?.closest?.('[data-drop="hold"]') ? 'hold' : 'col'
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const t = targetOf(e)
    if (over !== t) setOver(t)
  }
  const onDragLeave = (e: DragEvent) => {
    // Leaving for a child element still counts as inside the column.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setOver(null)
  }
  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    const to = targetOf(e) === 'hold' ? HOLD_COLUMN.key : meta.key
    setOver(null)
    const key = e.dataTransfer.getData(DRAG_MIME)
    if (key) onMove?.(key, to)
  }

  // QA is one drop target with two shelves. Cards land on the top one (a ready-for-QA status);
  // the QA team moves them to "QA In Progress" in Jira, so that shelf is never a drop target.
  const inProgress = meta.key === 'qa' ? tickets.filter((t) => isQaInProgress(t.status)) : []
  const ready = inProgress.length ? tickets.filter((t) => !isQaInProgress(t.status)) : tickets

  // An empty column has nothing to show: it folds to a rail and its width goes to the columns with
  // cards. While a card is dragged it opens only to a compact drop zone. Blocked counts its shelf.
  const dragging = !!onMove && (dragActive || over != null)
  const mode = columnMode({ count: tickets.length, held: held?.length, focused, dragging })
  const hasShelf = held !== undefined
  const dropLabel = meta.key === 'blocked' ? 'Drop to mark as Blocked' : `Drop to move to ${meta.label}`
  const emptyHint = meta.key === 'blocked' ? (dragging ? 'Drag a stuck card here' : 'Nothing blocked') : 'Nothing here'
  const name = hasShelf ? `${meta.label} and ${HOLD_COLUMN.label}` : meta.label

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
      className={`jb-col jb-col-${mode} flex flex-col ${mode === 'rail' ? 'jb-col-rail' : ''}`}
      style={WIDTH[mode]}
      aria-label={
        mode === 'full'
          ? `${meta.label} · ${tickets.length}${hasShelf ? ` · ${HOLD_COLUMN.label} · ${held.length}` : ''}`
          : `${name} — empty${mode === 'drop' ? ', drop a card here' : ''}`
      }
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="mb-2 flex h-5 items-center gap-2 px-1">
        <span
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
          style={{ background: hexToRgba(meta.accent, 0.16) }}
          title={mode === 'rail' ? `${name} — empty. Drag a card here to move it in Jira.` : undefined}
        >
          <ColumnIcon col={meta.key} color={meta.accent} size={13} />
        </span>
        <AnimatePresence initial={false}>
          {mode !== 'rail' && (
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
              {mode === 'full' && (
                <span
                  className="ml-auto min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums"
                  style={{ color: meta.accent, background: hexToRgba(meta.accent, 0.14) }}
                >
                  {tickets.length}
                </span>
              )}
            </motion.span>
          )}
        </AnimatePresence>
      </header>

      {mode === 'rail' ? (
        <Rail meta={meta} withHold={hasShelf} />
      ) : mode === 'drop' ? (
        <div className="flex flex-1 flex-col gap-2">
          {/* Blocked and On Hold: two separate drop boxes, both at the top where the eye is. */}
          <DropZone accent={meta.accent} label={meta.label} active={over === 'col'} size={hasShelf ? 'top' : 'fill'} />
          {hasShelf && <DropZone accent={HOLD_COLUMN.accent} label={HOLD_COLUMN.label} active={over === 'hold'} size="top" hold />}
        </div>
      ) : (
        <div className={`flex flex-1 flex-col ${hasShelf ? 'gap-4' : ''}`}>
        {/* The column's own box. Alone it fills the column's height, so a drop anywhere below the
            cards counts; in Blocked it is sized to its cards, and On Hold follows as its own space. */}
        <div
          className={`relative flex flex-col gap-2 rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-200 ${hasShelf ? '' : 'flex-1'}`}
          style={{
            borderColor: hexToRgba(meta.accent, over === 'col' ? 0.7 : 0.22),
            background: hexToRgba(meta.accent, over === 'col' ? 0.12 : 0.04),
            boxShadow: over === 'col' ? `0 0 0 3px ${hexToRgba(meta.accent, 0.18)}, 0 12px 28px -16px ${hexToRgba(meta.accent, 0.5)}` : undefined,
          }}
        >
          <div className="flex flex-1 flex-col gap-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {ready.map(card)}
            </AnimatePresence>

            {/* Landing slot while a card hovers: it opens where the card will land — the bottom. */}
            <AnimatePresence initial={false}>
              {over === 'col' && (
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

            {ready.length === 0 && over !== 'col' && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                // Compact when only the shelf has cards: the Blocked part then has nothing to say.
                className={`flex items-center justify-center rounded-lg text-[11px] italic text-[var(--muted)] ${hasShelf ? 'py-3' : 'py-6'}`}
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
                    animate={{ opacity: over === 'col' ? 0.5 : 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={SPRING}
                    className={`overflow-hidden ${over === 'col' ? 'pointer-events-none' : ''}`}
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

        </div>

        {/* On Hold: a separate space under Blocked — its own header and box, slim when empty. */}
        {hasShelf && <OnHoldShelf tickets={held} over={over === 'hold'} dragging={dragging} card={card} />}
        </div>
      )}
    </section>
  )
})

/** The folded column: a vertical label. Blocked's rail is two separate boxes, Blocked above On Hold. */
function Rail({ meta, withHold }: { meta: ColumnMeta; withHold: boolean }) {
  const box = (accent: string, label: string, hold: boolean) => (
    <div
      {...(hold ? { 'data-drop': 'hold' } : {})}
      className={`jb-rail-zone flex flex-col items-center gap-1.5 rounded-2xl border border-dashed py-2 ${withHold ? 'min-h-[132px]' : 'flex-1'}`}
      style={{ borderColor: hexToRgba(accent, 0.3), background: hexToRgba(accent, 0.04) }}
    >
      {hold && <PauseIcon size={11} color={accent} />}
      <span className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: hexToRgba(accent, 0.85) }}>
        {label}
      </span>
    </div>
  )
  return (
    <div className="flex flex-1 flex-col gap-3">
      {box(meta.accent, meta.label, false)}
      {withHold && box(HOLD_COLUMN.accent, HOLD_COLUMN.label, true)}
    </div>
  )
}

/** An empty column during a drag: just wide enough to aim at, labelled with where the card goes. */
function DropZone({
  accent,
  label,
  active,
  hold = false,
  size = 'fill',
}: {
  accent: string
  label: string
  active: boolean
  hold?: boolean
  /** fill = the whole column; top = a fixed block at the top (Blocked's two targets, stacked). */
  size?: 'fill' | 'top'
}) {
  return (
    <div
      {...(hold ? { 'data-drop': 'hold' } : {})}
      // The label sits near the top: on a tall board the middle of the column is below the fold.
      className={`flex flex-col items-center gap-1 rounded-2xl border-2 border-dashed px-1 text-center transition-[background,border-color,box-shadow] duration-200 ${size === 'top' ? 'h-[132px] justify-center' : 'flex-1 justify-start pt-16'}`}
      style={{
        borderColor: hexToRgba(accent, active ? 0.8 : 0.4),
        background: hexToRgba(accent, active ? 0.16 : 0.06),
        boxShadow: active ? `0 0 0 3px ${hexToRgba(accent, 0.18)}` : undefined,
      }}
    >
      {hold && <PauseIcon size={13} color={accent} />}
      <span className="text-[11px] font-bold leading-tight" style={{ color: accent }}>
        {active ? 'Release' : 'Drop here'}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wider leading-tight" style={{ color: hexToRgba(accent, 0.75) }}>
        {label}
      </span>
    </div>
  )
}
