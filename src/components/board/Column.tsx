import { memo, useRef, useState, type DragEvent, type ReactNode, type Ref } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { HOLD_COLUMN, QA_IN_PROGRESS, columnMode, isQaInProgress, type ColumnMeta, type ColumnMode } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'
import { DRAG_MIME, TicketCard } from './TicketCard'
import { hexToRgba } from '../../lib/format'
import { ColumnIcon, LockIcon, PauseIcon } from '../common/Icons'
import { OnHoldSection } from './OnHold'
import { LandingSlot, SPRING, SpaceHeader, dropBoxStyle } from './boardParts'

// Widths per mode (lib/columns.ts::columnMode). A full column grows to share the width the empty ones
// give up; a drop zone is just wide enough to aim at; a rail is a labelled sliver.
const WIDTH: Record<ColumnMode, { flex: string; minWidth: string }> = {
  full: { flex: '1 1 13.5rem', minWidth: '13.5rem' },
  drop: { flex: '0 0 7rem', minWidth: '7rem' },
  rail: { flex: '0 0 2.75rem', minWidth: '2.75rem' },
}

/** Which of a column's drop targets a card is over: the column itself, or Blocked's On Hold space. */
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
  /** Blocked only: the On Hold space's tickets. Undefined = no On Hold space (Settings → On Hold off). */
  held?: Ticket[]
}) {
  const hasHold = held !== undefined
  // Blocked's own box, whatever the mode draws it as. With an On Hold space in the column the pointer
  // is on Hold when it is inside On Hold or anywhere BELOW this box — so the blank part of the column
  // under On Hold is On Hold too, never a surprise "Blocked". The line moves with Blocked's landing
  // slot, which keeps the target steady at the boundary instead of flipping back and forth.
  const ownBox = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<DropTarget | null>(null)
  const accepts = (e: DragEvent) => !!onMove && e.dataTransfer.types.includes(DRAG_MIME)
  const targetOf = (e: DragEvent): DropTarget => {
    if (!hasHold) return 'col'
    if ((e.target as Element | null)?.closest?.('[data-drop="hold"]')) return 'hold'
    const box = ownBox.current?.getBoundingClientRect()
    return box && box.height > 0 && e.clientY > box.bottom ? 'hold' : 'col'
  }
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
  // cards. While a card is dragged it opens only to a compact drop zone. Blocked counts On Hold too.
  const dragging = !!onMove && (dragActive || over != null)
  const mode = columnMode({ count: tickets.length, held: held?.length, focused, dragging })
  const dropLabel = meta.key === 'blocked' ? 'Drop to mark as Blocked' : `Drop to move to ${meta.label}`
  const emptyHint = meta.key === 'blocked' ? (dragging ? 'Drag a stuck card here' : 'Nothing blocked') : 'Nothing here'
  const name = hasHold ? `${meta.label} and ${HOLD_COLUMN.label}` : meta.label

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
      className={`jb-col jb-col-${mode} flex flex-col`}
      style={WIDTH[mode]}
      aria-label={
        mode === 'full'
          ? `${meta.label} · ${tickets.length}${hasHold ? ` · ${HOLD_COLUMN.label} · ${held.length}` : ''}`
          : `${name} — empty${mode === 'drop' ? ', drop a card here' : ''}`
      }
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SpaceHeader
        accent={meta.accent}
        icon={<ColumnIcon col={meta.key} color={meta.accent} size={13} />}
        label={meta.label}
        count={mode === 'full' ? tickets.length : undefined}
        folded={mode === 'rail'}
        title={mode === 'rail' ? `${name} — empty. Drag a card here to move it in Jira.` : undefined}
      />

      {mode === 'rail' ? (
        <div className="flex flex-1 flex-col gap-3">
          <RailBox boxRef={ownBox} accent={meta.accent} label={meta.label} stacked={hasHold} />
          {hasHold && <RailBox accent={HOLD_COLUMN.accent} label={HOLD_COLUMN.label} stacked hold />}
        </div>
      ) : mode === 'drop' ? (
        <div className="flex flex-1 flex-col gap-2">
          <DropZone boxRef={ownBox} accent={meta.accent} label={meta.label} active={over === 'col'} stacked={hasHold} />
          {hasHold && <DropZone accent={HOLD_COLUMN.accent} label={HOLD_COLUMN.label} active={over === 'hold'} stacked hold />}
        </div>
      ) : (
        <div className={`flex flex-1 flex-col ${hasHold ? 'gap-4' : ''}`}>
          {/* The column's own box. Alone it fills the column's height, so a drop anywhere below the
              cards counts; in Blocked it is sized to its cards and On Hold follows as its own space. */}
          <div
            ref={ownBox}
            className={`relative flex flex-col gap-2 rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-200 ${hasHold ? '' : 'flex-1'}`}
            style={dropBoxStyle(meta.accent, over === 'col')}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {ready.map(card)}
            </AnimatePresence>
            <LandingSlot accent={meta.accent} show={over === 'col'} label={dropLabel} />
            {ready.length === 0 && over !== 'col' && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                // Compact when On Hold follows: the Blocked part then has nothing to say.
                className={`flex items-center justify-center rounded-lg text-[11px] italic text-[var(--muted)] ${hasHold ? 'py-3' : 'py-6'}`}
              >
                {emptyHint}
              </motion.div>
            )}
            {meta.key === 'qa' && <QaInProgress tickets={inProgress} dimmed={over === 'col'} card={card} />}
          </div>

          {/* On Hold: a separate space under Blocked — its own header and box, slim when empty. */}
          {hasHold && <OnHoldSection tickets={held} over={over === 'hold'} dragging={dragging} card={card} />}
        </div>
      )}
    </section>
  )
})

/** QA's second shelf: picked up by the QA team in Jira, never a drop target. */
function QaInProgress({ tickets, dimmed, card }: { tickets: Ticket[]; dimmed: boolean; card: (t: Ticket) => ReactNode }) {
  const accent = QA_IN_PROGRESS.accent
  return (
    <AnimatePresence initial={false}>
      {tickets.length > 0 && (
        <motion.div
          key="qa-in-progress"
          layout
          initial={{ opacity: 0, height: 0 }}
          // Dimmed while a card hovers the column: this shelf is not where it lands.
          animate={{ opacity: dimmed ? 0.5 : 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={SPRING}
          className={`overflow-hidden ${dimmed ? 'pointer-events-none' : ''}`}
          aria-label={`${QA_IN_PROGRESS.label} · ${tickets.length}`}
        >
          <div
            className="rounded-xl border p-1.5"
            style={{ borderColor: hexToRgba(accent, 0.38), background: hexToRgba(accent, 0.09), boxShadow: `inset 3px 0 0 ${accent}` }}
            title="Picked up by the QA team in Jira. Cards cannot be dropped here — drop them on QA and QA takes it from there."
          >
            <div className="mb-1.5 flex items-center gap-1.5 px-1 pt-0.5">
              <ColumnIcon col="qa" color={accent} size={11} />
              <span className="truncate text-[10px] font-bold uppercase tracking-wider" style={{ color: accent }}>
                {QA_IN_PROGRESS.label}
              </span>
              <LockIcon size={10} color={hexToRgba(accent, 0.8)} />
              <span className="ml-auto min-w-[20px] rounded-full px-1.5 text-center text-[10px] font-bold tabular-nums" style={{ color: accent, background: hexToRgba(accent, 0.16) }}>
                {tickets.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {tickets.map(card)}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * One box of a folded column. Alone it fills the column; `stacked` (Blocked above On Hold) gives each
 * box a fixed height at the top, so both stay on screen however tall the board is.
 */
function RailBox({ boxRef, accent, label, stacked, hold = false }: { boxRef?: Ref<HTMLDivElement>; accent: string; label: string; stacked: boolean; hold?: boolean }) {
  return (
    <div
      ref={boxRef}
      data-drop={hold ? 'hold' : undefined}
      className={`jb-rail-zone flex flex-col items-center gap-1.5 rounded-2xl border border-dashed py-2 ${stacked ? 'min-h-[132px]' : 'flex-1'}`}
      style={dropBoxStyle(accent, false)}
    >
      {hold && <PauseIcon size={11} color={accent} />}
      <span className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: hexToRgba(accent, 0.85) }}>
        {label}
      </span>
    </div>
  )
}

/** An empty column during a drag: just wide enough to aim at, labelled with where the card goes. Same `stacked` rule as RailBox. */
function DropZone({
  boxRef,
  accent,
  label,
  active,
  stacked,
  hold = false,
}: {
  boxRef?: Ref<HTMLDivElement>
  accent: string
  label: string
  active: boolean
  stacked: boolean
  hold?: boolean
}) {
  return (
    <div
      ref={boxRef}
      data-drop={hold ? 'hold' : undefined}
      // The label sits near the top: on a tall board the middle of the column is below the fold.
      className={`flex flex-col items-center gap-1 rounded-2xl border-2 border-dashed px-1 text-center transition-[background,border-color,box-shadow] duration-200 ${stacked ? 'h-[132px] justify-center' : 'flex-1 justify-start pt-16'}`}
      style={dropBoxStyle(accent, active)}
    >
      {hold && <PauseIcon size={13} color={accent} />}
      <span className="text-[11px] font-bold leading-tight" style={{ color: accent }}>
        {active ? 'Release' : 'Drop here'}
      </span>
      <span className="text-[10px] font-semibold uppercase leading-tight tracking-wider" style={{ color: hexToRgba(accent, 0.75) }}>
        {label}
      </span>
    </div>
  )
}
