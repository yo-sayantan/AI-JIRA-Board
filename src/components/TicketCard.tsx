import { useEffect, useMemo, useState, type PointerEvent } from 'react'
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring } from 'motion/react'
import type { Ticket } from '../types'
import { COLUMN_META } from '../lib/columns'
import { DONE_BOARD_DAYS } from '../data'
import { priorityMeta, typeMeta, effectiveType, isClosedPr, prListOf, branchesOf, relTime, shortBranch, hexToRgba } from '../lib/format'
import { Pill, PriorityGlyph, PrBadge, Approvals, PointsTag } from './ui'
import { TypeIcon, CommentIcon, RefreshIcon, TrophyIcon } from './Icons'

const RED = '#ef4444'

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

/** Done tickets that have had their confetti this page load — a card remounting because a filter
 *  changed must not celebrate the same win twice. */
const celebrated = new Set<string>()

const CONFETTI = ['#fbbf24', '#22c55e', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c']

/**
 * A small burst inside a Done card when the board loads: a warm flash, then sixteen bits of
 * confetti thrown outward that tumble and fade. Transform + opacity only, and it unmounts itself.
 */
function Celebration() {
  const parts = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => {
        const angle = ((i / 16) * 360 + (i % 2 ? 11 : -7)) * (Math.PI / 180)
        const dist = 44 + (i % 3) * 16
        return {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist * 0.75 + 22, // a little gravity
          color: CONFETTI[i % CONFETTI.length],
          delay: 0.04 * (i % 5),
          size: 4 + (i % 3) * 2,
          spin: 160 + i * 23,
          dur: 1.05 + (i % 3) * 0.15,
        }
      }),
    [],
  )
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-xl">
      <motion.span
        className="absolute inset-0"
        initial={{ opacity: 0.7 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 1.2, ease: 'easeOut' }}
        style={{ background: 'radial-gradient(circle at 50% 45%, rgba(251,191,36,0.38), transparent 62%)' }}
      />
      {parts.map((p, i) => (
        <motion.span
          key={i}
          className="absolute left-1/2 top-[44%] rounded-[1.5px]"
          style={{ width: p.size, height: Math.max(3, p.size * 0.6), background: p.color }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.5 }}
          animate={{ x: p.x, y: p.y, opacity: 0, rotate: p.spin, scale: 1 }}
          transition={{ duration: p.dur, delay: 0.12 + p.delay, ease: [0.2, 0.75, 0.3, 1] }}
        />
      ))}
    </span>
  )
}

/**
 * One board card. Every card is the same size — 160px tall in an equal grid cell — with fixed
 * rows: key line (20px), two lines of title (34px), two rows of badges (46px), footer (16px). Content
 * fills what it needs and the rest stays empty, so a card never grows with its content and the
 * worst case (priority + PR state + approvals + extra PRs + archive timer + carried-over sprint) still
 * fits inside the badge rows. Hover tilts the card toward the pointer with a moving highlight.
 */
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
  // Carried over: the ticket has lived in more than one sprint.
  const sprints = ticket.sprints ?? []
  const spilled = sprints.length > 1

  // Real drop shadow + a stronger, accent-tinted lift on hover. (The accent bar is an inset shadow,
  // so it must be composed together with the drop shadow in ONE box-shadow value.) A carried-over
  // ticket wears a red ring instead of the urgency ring — it is the louder of the two signals.
  const ring = spilled ? `, 0 0 0 1px ${hexToRgba(RED, 0.45)}` : urgent ? `, 0 0 0 1px ${hexToRgba(prio.color, 0.3)}` : ''
  const baseShadow = `inset 3px 0 0 ${accent}, 0 1px 2px rgba(2,6,23,0.10), 0 10px 22px -12px rgba(2,6,23,0.40)${ring}`
  const hoverShadow = `inset 3px 0 0 ${accent}, 0 22px 40px -14px ${hexToRgba(accent, 0.55)}, 0 8px 16px -8px rgba(2,6,23,0.45)${ring}`

  // ── 3D tilt toward the pointer + a highlight that follows it ──
  const reduced = useReducedMotion()
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const rotateX = useSpring(rx, { stiffness: 260, damping: 24, mass: 0.6 })
  const rotateY = useSpring(ry, { stiffness: 260, damping: 24, mass: 0.6 })
  const gx = useMotionValue(50)
  const gy = useMotionValue(50)
  const glare = useMotionTemplate`radial-gradient(220px circle at ${gx}% ${gy}%, rgba(255,255,255,0.20), transparent 62%)`
  const motionOff = () => reduced || document.documentElement.classList.contains('jb-no-anim')
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (motionOff()) return
    const r = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    ry.set((px - 0.5) * 9)
    rx.set((0.5 - py) * 7)
    gx.set(px * 100)
    gy.set(py * 100)
  }
  const onLeave = () => {
    rx.set(0)
    ry.set(0)
  }

  // ── Confetti for a Done ticket, once per page load ──
  const [celebrate, setCelebrate] = useState(() => ticket.column === 'done' && !reduced && !celebrated.has(ticket.key))
  useEffect(() => {
    if (!celebrate) return
    celebrated.add(ticket.key)
    const t = setTimeout(() => setCelebrate(false), 1900)
    return () => clearTimeout(t)
  }, [celebrate, ticket.key])

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
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      initial={{ opacity: 0, y: 8, boxShadow: baseShadow }}
      animate={{ opacity: 1, y: 0, boxShadow: baseShadow }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      whileHover={{ y: -5, boxShadow: hoverShadow }}
      whileTap={{ scale: 0.985 }}
      className="group relative flex h-[160px] w-full cursor-pointer flex-col overflow-hidden rounded-xl border bg-[var(--surface-solid)] p-3 text-left"
      style={{ boxShadow: baseShadow, rotateX, rotateY, transformPerspective: 900, borderColor: spilled ? RED : 'var(--line)' }}
      title={spilled ? `Carried over ${sprints.length} sprints: ${sprints.join(' → ')}` : undefined}
    >
      {/* hover gradient wash + top sheen in the column colour, and the pointer-following highlight */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `linear-gradient(135deg, ${hexToRgba(accent, 0.18)}, ${hexToRgba(accent, 0.04)} 45%, transparent 70%)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `linear-gradient(90deg, ${spilled ? RED : accent}, transparent)` }}
      />
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: glare }}
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

      {/* Row 1 — key · points · age (20px) */}
      <div className="relative flex h-5 items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-bold tracking-wide" style={{ color: accent }}>
          <TypeIcon type={effectiveType(ticket)} color={tm.color} size={13} />
          {ticket.key}
          <PointsTag points={ticket.storyPoints} />
        </span>
        {rel && <span className="shrink-0 text-[10px] text-[var(--muted)]">{rel}</span>}
      </div>

      {/* Row 2 — title, always two lines of room (34px) */}
      <div className="relative mt-1 h-[34px] text-[13px] font-semibold leading-[17px] text-[var(--ink)] line-clamp-2">{ticket.title}</div>

      {/* Row 3 — badges: two rows reserved (46px); wraps inside, never grows the card */}
      <div className="relative mt-2 flex h-[46px] flex-wrap content-start items-center gap-x-1.5 gap-y-1 overflow-hidden">
        <PriorityGlyph priority={ticket.priority} />
        {spilled && (
          <Pill color={RED} filled title={`Carried over ${sprints.length} sprints: ${sprints.join(' → ')}`}>
            ↻ {sprints.length} sprints
          </Pill>
        )}
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

      {/* Row 4 — footer pinned to the bottom (16px) */}
      <div className="relative mt-auto flex h-4 items-center gap-3 text-[10.5px] text-[var(--muted)]">
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

      {celebrate && <Celebration />}
    </motion.div>
  )
}
