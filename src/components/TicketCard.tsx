import { motion } from 'motion/react'
import type { Ticket } from '../types'
import { COLUMN_META } from '../lib/columns'
import { DONE_BOARD_DAYS } from '../data'
import { priorityMeta, typeMeta, effectiveType, isClosedPr, prListOf, branchesOf, relTime, shortBranch, hexToRgba } from '../lib/format'
import { Pill, PriorityBadge, PrBadge, Approvals, PointsTag } from './ui'
import { TypeIcon, CommentIcon, RefreshIcon, TrophyIcon } from './Icons'

/** Days until this Done card auto-retires from the board into the Completed archive. */
function archivesInDays(t: Ticket, now: number): number | null {
  if (t.column !== 'done') return null
  const when = t.resolved ?? t.lastUpdate
  if (!when) return null
  const ts = Date.parse(when)
  if (Number.isNaN(ts)) return null
  const left = ts + DONE_BOARD_DAYS * 86_400_000 - now
  return left > 0 ? Math.ceil(left / 86_400_000) : null
}

export function TicketCard({
  ticket,
  now,
  onOpen,
  onArchive,
  onRefreshTicket,
  refreshing,
}: {
  ticket: Ticket
  now: number
  onOpen: (key: string) => void
  /** Move this (Done) ticket to the Completed archive now — off the board immediately. */
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshing?: boolean
}) {
  const meta = COLUMN_META[ticket.column]
  const accent = meta?.accent ?? '#64748b'
  const prio = priorityMeta(ticket.priority)
  const tm = typeMeta(effectiveType(ticket))
  const urgent = prio.rank >= 4
  const rel = relTime(ticket.lastUpdate, now)
  const prs = prListOf(ticket)
  const pr = prs[0] ?? null
  const prKnownState = pr && pr.state && pr.state !== 'none'
  const branches = branchesOf(ticket)
  const archiveIn = archivesInDays(ticket, now)

  // Real drop shadow + a stronger, accent-tinted lift on hover. (The accent bar is an inset shadow,
  // so it must be composed together with the drop shadow in ONE box-shadow value.)
  const ring = urgent ? `, 0 0 0 1px ${hexToRgba(prio.color, 0.3)}` : ''
  const baseShadow = `inset 3px 0 0 ${accent}, 0 1px 2px rgba(2,6,23,0.10), 0 10px 22px -12px rgba(2,6,23,0.40)${ring}`
  const hoverShadow = `inset 3px 0 0 ${accent}, 0 16px 34px -12px ${hexToRgba(accent, 0.5)}, 0 6px 14px -6px rgba(2,6,23,0.4)${ring}`

  return (
    // Card shell is a div[role=button], NOT a <button>, so the dismiss/refresh controls inside it
    // are valid (a <button> may not contain interactive descendants). Enter/Space open it.
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`Open ${ticket.key}: ${ticket.title}`}
      onClick={() => onOpen(ticket.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(ticket.key)
        }
      }}
      initial={{ opacity: 0, y: 8, boxShadow: baseShadow }}
      animate={{ opacity: 1, y: 0, boxShadow: baseShadow }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      whileHover={{ y: -4, boxShadow: hoverShadow }}
      whileTap={{ scale: 0.985 }}
      className="group relative w-full cursor-pointer overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] p-3 text-left"
      style={{ boxShadow: baseShadow }}
    >
      {/* hover gradient wash + top sheen in the column color */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `linear-gradient(135deg, ${hexToRgba(accent, 0.18)}, ${hexToRgba(accent, 0.04)} 45%, transparent 70%)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }}
      />

      {onArchive && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onArchive(ticket.key)
          }}
          onKeyDown={(e) => e.stopPropagation()}
          title="Move to Completed now (removes it from the board)"
          aria-label="Move to Completed"
          className="absolute right-1 top-1 z-10 grid h-5 w-5 cursor-pointer place-items-center rounded-md border border-[var(--line)] bg-[var(--surface-solid)] leading-none opacity-0 transition-opacity hover:border-[#f59e0b] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <TrophyIcon size={10} />
        </button>
      )}

      {/* Per-ticket refresh — only for tickets still in flight (not Done). */}
      {onRefreshTicket && ticket.column !== 'done' && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (!refreshing) onRefreshTicket(ticket.key)
          }}
          onKeyDown={(e) => e.stopPropagation()}
          title="Fetch the latest status of this ticket (background)"
          aria-label="Refresh this ticket"
          className={`absolute right-1 top-1 z-10 grid h-5 w-5 cursor-pointer place-items-center rounded-md border border-[var(--line)] bg-[var(--surface-solid)] text-[var(--muted)] transition-opacity hover:border-[var(--muted)] hover:text-[var(--ink)] ${refreshing ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'}`}
        >
          <motion.span
            className="inline-flex"
            animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
            transition={refreshing ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { duration: 0.2 }}
          >
            <RefreshIcon size={11} color="currentColor" />
          </motion.span>
        </button>
      )}

      <div className="relative flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-bold tracking-wide" style={{ color: accent }}>
          <TypeIcon type={effectiveType(ticket)} color={tm.color} size={13} />
          {ticket.key}
          <PointsTag points={ticket.storyPoints} />
        </span>
        {rel && <span className="shrink-0 text-[10px] text-[var(--muted)]">{rel}</span>}
      </div>

      <div className="relative mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-[var(--ink)]">
        {ticket.title}
      </div>

      <div className="relative mt-2.5 flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={ticket.priority} />
        {pr && (prKnownState ? <PrBadge state={pr.state} /> : <Pill color="#94a3b8" title="Pull request linked">⊙ PR</Pill>)}
        {pr && !isClosedPr(pr) && <Approvals approvals={pr.approvals} />}
        {prs.length > 1 && (
          <Pill color="#a855f7" title={`${prs.length} pull requests`}>
            +{prs.length - 1} PR
          </Pill>
        )}
        {archiveIn != null && (
          <Pill color="#b45309" title={`Recent win — moves to the Completed archive in ${archiveIn} day${archiveIn === 1 ? '' : 's'}`}>
            <TrophyIcon size={10} /> archives in {archiveIn}d
          </Pill>
        )}
      </div>

      <div className="relative mt-2.5 flex items-center gap-3 text-[10.5px] text-[var(--muted)]">
        {typeof ticket.commentCount === 'number' && ticket.commentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <CommentIcon size={12} /> {ticket.commentCount}
          </span>
        )}
        {branches[0] && (
          <span className="ml-auto truncate font-mono text-[10px] opacity-80" title={branches.join('\n')}>
            {shortBranch(branches[0], 24)}
            {branches.length > 1 ? ` +${branches.length - 1}` : ''}
          </span>
        )}
      </div>
    </motion.div>
  )
}
