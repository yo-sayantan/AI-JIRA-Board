import { memo, useRef, useState, type DragEvent, type Ref } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { HOLD_COLUMN, QA_IN_PROGRESS, columnMode, isQaInProgress, type ColumnMeta, type ColumnMode } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'
import { DRAG_MIME, TicketCard } from './TicketCard'
import { hexToRgba } from '../../lib/format'
import { ColumnIcon, LockIcon, PauseIcon } from '../common/Icons'
import { SubSection } from './SubSection'
import { LandingSlot, SpaceHeader, dropBoxStyle } from './boardParts'

// Widths per mode (lib/columns.ts::columnMode). Every column carries 6px of invisible padding per
// side (see the section style) so the hit areas of neighbouring columns touch — a card dragged across
// the gap between two columns is never over nothing — which is why each width is 0.75rem more than
// what is drawn. Full columns come in two weights: the slim edges (To Do · QA · Done) start narrower
// and grow less, so spare width goes to Blocked · In Progress · In Review, whose cards carry the most.
const WIDTH: Record<ColumnMode, { flex: string; minWidth: string }> = {
  full: { flex: '1.45 1 15.75rem', minWidth: '15.25rem' },
  drop: { flex: '0 0 7.75rem', minWidth: '7.75rem' },
  rail: { flex: '0 0 3.5rem', minWidth: '3.5rem' },
}
const WIDTH_SLIM = { flex: '0.55 1 12.25rem', minWidth: '11.75rem' } as const

/** Which of a column's drop targets a card is over: the column itself, or its second space. */
type DropTarget = 'col' | 'sub'

/** The second space under a column's own box: On Hold under Blocked, QA In Progress under QA. */
interface Sub {
  id: 'hold' | 'qaip'
  label: string
  accent: string
  /** A drop target (On Hold) or shown only (QA In Progress — the QA team moves cards there in Jira). */
  droppable: boolean
}
const SUB_HOLD: Sub = { id: 'hold', label: HOLD_COLUMN.label, accent: HOLD_COLUMN.accent, droppable: true }
const SUB_QAIP: Sub = { id: 'qaip', label: QA_IN_PROGRESS.label, accent: QA_IN_PROGRESS.accent, droppable: false }
const SUB_TEXTS = {
  hold: { idle: 'Nothing on hold', dragging: 'Drop here to put on hold', slot: 'Drop to put on hold' },
  qaip: { idle: 'Nobody testing yet', dragging: 'Picked up by QA — not a drop target', slot: '' },
} as const

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
  hideOwn = false,
  showQaInProgress = true,
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
  /** Settings → Blocked off while On Hold is on: the column is just the On Hold space, no Blocked box. */
  hideOwn?: boolean
  /** Settings → QA In Progress off: no second space under QA. */
  showQaInProgress?: boolean
}) {
  // QA's cards split in two spaces: waiting for QA (the column's own box) and picked up by QA.
  const inProgress = meta.key === 'qa' ? tickets.filter((t) => isQaInProgress(t.status)) : []
  const own = meta.key === 'qa' ? tickets.filter((t) => !isQaInProgress(t.status)) : tickets
  const sub: Sub | null = meta.key === 'qa' ? (showQaInProgress ? SUB_QAIP : null) : meta.key === 'blocked' && held !== undefined ? SUB_HOLD : null
  const subTickets = sub?.id === 'hold' ? (held ?? []) : inProgress
  // With its own box off, the column IS its second space: it wears that space's header and fills with it.
  const ownOff = hideOwn && sub?.id === 'hold'

  // The column's own box, whatever the mode draws it as. With a droppable second space, the pointer is
  // on it when inside it or anywhere BELOW the column's own box — so the blank part of the column under
  // it is never a surprise "Blocked". The line moves with the landing slot, which keeps the target
  // steady at the boundary instead of flipping back and forth.
  const ownBox = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<DropTarget | null>(null)
  const accepts = (e: DragEvent) => !!onMove && e.dataTransfer.types.includes(DRAG_MIME)
  const targetOf = (e: DragEvent): DropTarget => {
    if (ownOff) return 'sub'
    if (!sub?.droppable) return 'col'
    if ((e.target as Element | null)?.closest?.(`[data-drop="${sub.id}"]`)) return 'sub'
    const box = ownBox.current?.getBoundingClientRect()
    return box && box.height > 0 && e.clientY > box.bottom ? 'sub' : 'col'
  }
  // dragenter AND dragover both arm the target: a zone must light up the moment the pointer arrives,
  // not on the next dragover tick (Safari and Firefox ignore a drop target that never cancelled
  // dragenter, which showed as a lag before a drop would "take").
  const arm = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const t = targetOf(e)
    setOver((cur) => (cur === t ? cur : t))
  }
  const onDragLeave = (e: DragEvent) => {
    // Still inside this column? Decided by position: relatedTarget is null in Safari and Firefox, which
    // used to clear the highlight on every child-element crossing and made zones flicker.
    const r = e.currentTarget.getBoundingClientRect()
    if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setOver(null)
  }
  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    const to = targetOf(e) === 'sub' && sub?.id === 'hold' ? HOLD_COLUMN.key : meta.key
    setOver(null)
    const key = e.dataTransfer.getData(DRAG_MIME)
    if (key) onMove?.(key, to)
  }

  // An empty column has nothing to show: it folds to a rail and its width goes to the columns with
  // cards. While a card is dragged it opens only to a compact drop zone. A second space counts too.
  const dragging = !!onMove && (dragActive || over != null)
  const mode = columnMode({ count: own.length, held: subTickets.length, focused, dragging })
  const dropLabel = meta.key === 'blocked' ? 'Drop to mark as Blocked' : `Drop to move to ${meta.label}`
  const emptyHint = meta.key === 'blocked' ? (dragging ? 'Drag a stuck card here' : 'Nothing blocked') : meta.key === 'qa' ? 'Nothing waiting for QA' : 'Nothing here'
  const name = ownOff ? sub!.label : sub ? `${meta.label} and ${sub.label}` : meta.label
  const stacked = !!sub && !ownOff

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
      style={{ ...(mode === 'full' && meta.slim ? WIDTH_SLIM : WIDTH[mode]), marginInline: -6, paddingInline: 6 }}
      aria-label={
        mode === 'full'
          ? ownOff
            ? `${sub!.label} · ${subTickets.length}`
            : `${meta.label} · ${own.length}${sub ? ` · ${sub.label} · ${subTickets.length}` : ''}`
          : `${name} — empty${mode === 'drop' ? ', drop a card here' : ''}`
      }
      onDragEnter={arm}
      onDragOver={arm}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SpaceHeader
        accent={ownOff ? sub!.accent : meta.accent}
        icon={ownOff ? <PauseIcon size={13} color={sub!.accent} /> : <ColumnIcon col={meta.key} color={meta.accent} size={13} />}
        label={ownOff ? sub!.label : meta.label}
        count={mode === 'full' ? (ownOff ? subTickets.length : own.length) : undefined}
        folded={mode === 'rail'}
        title={mode === 'rail' ? `${name} — empty. Drag a card here to move it in Jira.` : undefined}
      />

      {mode === 'rail' ? (
        <div className="flex flex-1 flex-col gap-3">
          {!ownOff && <RailBox boxRef={ownBox} accent={meta.accent} label={meta.label} stacked={stacked} />}
          {sub && <RailBox accent={sub.accent} label={sub.label} stacked={!ownOff} sub={sub} />}
        </div>
      ) : mode === 'drop' ? (
        <div className="flex flex-1 flex-col gap-2">
          {!ownOff && <DropZone boxRef={ownBox} accent={meta.accent} label={meta.label} active={over === 'col'} stacked={stacked} />}
          {sub && <DropZone accent={sub.accent} label={sub.label} active={over === 'sub'} stacked={!ownOff} sub={sub} />}
        </div>
      ) : (
        <div className={`flex flex-1 flex-col ${stacked ? 'gap-4' : ''}`}>
          {/* The column's own box. Alone it fills the column's height, so a drop anywhere below the
              cards counts; with a second space it is sized to its cards and that space follows. */}
          {!ownOff && (
          <div
            ref={ownBox}
            className={`relative flex flex-col gap-2 rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-150 ${stacked ? '' : 'flex-1'}`}
            style={dropBoxStyle(meta.accent, over === 'col')}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {own.map(card)}
            </AnimatePresence>
            <LandingSlot accent={meta.accent} show={over === 'col'} label={dropLabel} />
            {own.length === 0 && over !== 'col' && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                // Compact when a second space follows: this part then has nothing to say.
                className={`flex items-center justify-center rounded-lg text-[11px] italic text-[var(--muted)] ${stacked ? 'py-3' : 'py-6'}`}
              >
                {emptyHint}
              </motion.div>
            )}
          </div>
          )}

          {/* The second space: its own header and box, slim when empty. */}
          {sub && (
            <SubSection
              id={sub.id}
              label={sub.label}
              accent={sub.accent}
              icon={sub.id === 'hold' ? <PauseIcon size={12} color={sub.accent} /> : <ColumnIcon col="qa" color={sub.accent} size={12} />}
              tickets={subTickets}
              card={card}
              over={over === 'sub'}
              dragging={dragging}
              droppable={sub.droppable}
              bare={ownOff}
              texts={SUB_TEXTS[sub.id]}
              hint={sub.droppable ? 'Drag a card here to put it on hold in Jira.' : 'Picked up by the QA team in Jira. Cards cannot be dropped here — drop them on QA and QA takes it from there.'}
            />
          )}
        </div>
      )}
    </section>
  )
})

/**
 * One box of a folded column. Alone it fills the column; `stacked` (a column with a second space) gives
 * each box a fixed height at the top, so both stay on screen however tall the board is.
 */
function RailBox({ boxRef, accent, label, stacked, sub }: { boxRef?: Ref<HTMLDivElement>; accent: string; label: string; stacked: boolean; sub?: Sub }) {
  return (
    <div
      ref={boxRef}
      data-drop={sub?.droppable ? sub.id : undefined}
      className={`jb-rail-zone flex flex-col items-center gap-1.5 rounded-2xl border border-dashed py-2 ${stacked ? 'min-h-[132px]' : 'flex-1'}`}
      style={dropBoxStyle(accent, false)}
    >
      {sub && (sub.droppable ? <PauseIcon size={11} color={accent} /> : <LockIcon size={10} color={hexToRgba(accent, 0.8)} />)}
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
  sub,
}: {
  boxRef?: Ref<HTMLDivElement>
  accent: string
  label: string
  active: boolean
  stacked: boolean
  sub?: Sub
}) {
  const locked = !!sub && !sub.droppable
  return (
    <div
      ref={boxRef}
      data-drop={sub?.droppable ? sub.id : undefined}
      // The label sits near the top: on a tall board the middle of the column is below the fold.
      className={`flex flex-col items-center gap-1 rounded-2xl border-2 border-dashed px-1 text-center transition-[background,border-color,box-shadow,opacity] duration-150 ${stacked ? 'h-[132px] justify-center' : 'flex-1 justify-start pt-16'}`}
      style={{ ...dropBoxStyle(accent, active), opacity: locked ? 0.55 : 1 }}
    >
      {sub && (locked ? <LockIcon size={12} color={hexToRgba(accent, 0.8)} /> : <PauseIcon size={13} color={accent} />)}
      <span className="text-[11px] font-bold leading-tight" style={{ color: accent }}>
        {locked ? 'QA only' : active ? 'Release' : 'Drop here'}
      </span>
      <span className="text-[10px] font-semibold uppercase leading-tight tracking-wider" style={{ color: hexToRgba(accent, 0.75) }}>
        {label}
      </span>
    </div>
  )
}
