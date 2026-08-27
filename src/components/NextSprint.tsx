import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Ticket } from '../types'
import { NEXT_SPRINT_SECTION as SEC } from '../lib/columns'
import {
  effectiveType,
  fmtDateShort,
  futureSprintOf,
  hexToRgba,
  priorityMeta,
  relTime,
  typeMeta,
  workdaysBetween,
  type SprintInfo,
} from '../lib/format'
import { CalendarIcon, ChevronIcon, PriorityIcon, TypeIcon } from './Icons'

/** Stats' "Next Sprint" chip fires this before scrolling here, so a collapsed section opens itself. */
export const OPEN_NEXT_SPRINT_EVENT = 'jb-open-next-sprint'

const LS_KEY = 'jb-next-sprint-open'
const readOpen = () => {
  try {
    return localStorage.getItem(LS_KEY) !== '0'
  } catch {
    return true // file:// localStorage may be blocked
  }
}

/** Most urgent first, then most recently touched — same order as the board's To Do column. */
const byUrgency = (a: Ticket, b: Ticket) =>
  priorityMeta(b.priority).rank - priorityMeta(a.priority).rank ||
  (b.lastUpdate ?? '').localeCompare(a.lastUpdate ?? '')

/** How far off the sprint is. A grooming bucket ("FraudBus READY") carries no dates at all, and a
 *  `future` sprint whose planned start has slipped is still not started. Working days, like the
 *  header's sprint chip. Kept SHORT — it shares one line with the sprint name. */
function whenLabel(sp: SprintInfo, now: number): string {
  const startTs = sp.start ? Date.parse(`${sp.start}T00:00:00`) : NaN
  if (Number.isNaN(startTs) || now >= startTs) return 'not started'
  const d = workdaysBetween(now + 86_400_000, startTs)
  return `starts in ${d} day${d === 1 ? '' : 's'} · ${fmtDateShort(sp.start)}`
}

interface Group {
  info: SprintInfo
  tickets: Ticket[]
}

/** Group by sprint — there can be two (an undated READY bucket AND a dated next sprint).
 *  Dated sprints first, soonest first; undated grooming buckets sink to the bottom. */
function groupBySprint(tickets: Ticket[], now: number): Group[] {
  const groups = new Map<string, Group>()
  for (const t of tickets) {
    const info = futureSprintOf(t.sprint, now)
    if (!info) continue // isNextSprint() already vetted these — belt & braces
    const g = groups.get(info.name)
    if (g) g.tickets.push(t)
    else groups.set(info.name, { info, tickets: [t] })
  }
  return [...groups.values()]
    .map((g) => ({ ...g, tickets: g.tickets.sort(byUrgency) }))
    .sort(
      (a, b) =>
        (a.info.start ?? '9999').localeCompare(b.info.start ?? '9999') || a.info.name.localeCompare(b.info.name),
    )
}

/** One ticket = one line. Everything the board card shows that can't help you decide "do I care
 *  about this yet?" (PR state, approvals, branch, comment count) is deliberately dropped — none of
 *  it exists yet on work that hasn't started. */
function Row({ ticket, now, onOpen }: { ticket: Ticket; now: number; onOpen: (key: string) => void }) {
  const prio = priorityMeta(ticket.priority)
  const type = effectiveType(ticket)
  const rel = relTime(ticket.lastUpdate, now)
  return (
    <div
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
      className="group flex cursor-pointer items-center gap-2.5 border-t border-[var(--line)] px-3 py-[7px] transition-colors hover:bg-[var(--surface-solid)] focus-visible:bg-[var(--surface-solid)] focus-visible:outline-none"
    >
      <TypeIcon type={type} color={typeMeta(type).color} size={13} />
      <span className="shrink-0 font-mono text-[11px] font-bold tracking-tight text-[var(--ink-soft)]">
        {ticket.key}
      </span>
      {typeof ticket.storyPoints === 'number' && (
        <span
          className="shrink-0 rounded border border-[var(--line)] px-1 text-[9.5px] font-bold tabular-nums text-[var(--muted)]"
          title={`${ticket.storyPoints} story point${ticket.storyPoints === 1 ? '' : 's'}`}
        >
          {ticket.storyPoints}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--ink)]" title={ticket.title}>
        {ticket.title}
      </span>
      {/* Colour only where it earns its keep: nothing below High goes coloured in here. */}
      {prio.rank >= 4 && <PriorityIcon rank={prio.rank} color={prio.color} size={12} />}
      {rel && <span className="shrink-0 text-[10px] tabular-nums text-[var(--muted)]">{rel}</span>}
      <ChevronIcon
        size={11}
        className="shrink-0 text-[var(--muted)] opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  )
}

/**
 * Tickets assigned to you whose sprint hasn't started — rendered ONLY when there are any.
 *
 * Design brief: this is the least urgent thing on the page, so it gets the least ink — a single
 * collapsible strip of one-line rows, no tinted panel, no board-size cards. It must never look
 * like current-sprint work, and it must never cost more than ~1 row of height per ticket.
 */
export function NextSprint({
  tickets,
  now,
  onOpen,
}: {
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
}) {
  const [open, setOpen] = useState(readOpen)
  const toggle = useCallback(() => {
    setOpen((v) => {
      try {
        localStorage.setItem(LS_KEY, v ? '0' : '1')
      } catch {
        /* file:// localStorage may be blocked */
      }
      return !v
    })
  }, [])

  // Jumping here from the stats chip should reveal the rows, not land on a closed strip.
  useEffect(() => {
    const onJump = () => setOpen(true)
    window.addEventListener(OPEN_NEXT_SPRINT_EVENT, onJump)
    return () => window.removeEventListener(OPEN_NEXT_SPRINT_EVENT, onJump)
  }, [])

  const groups = groupBySprint(tickets, now)
  const points = tickets.reduce((n, t) => n + (typeof t.storyPoints === 'number' ? t.storyPoints : 0), 0)
  // One sprint → name it in the header and skip the per-group caption entirely (that duplication is
  // most of what made this section feel big). Several → summarise, and let the captions do the work.
  const summary =
    groups.length === 1
      ? `${groups[0].info.name} · ${whenLabel(groups[0].info, now)}`
      : `${groups.length} sprints · ${groups.map((g) => g.info.name).join(', ')}`

  return (
    <AnimatePresence initial={false}>
      {tickets.length > 0 && (
        <motion.section
          id="jb-next-sprint"
          initial={{ opacity: 0, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, height: 'auto', marginTop: 16 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 30 }}
          className="overflow-hidden"
        >
          <div
            className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-2)]"
            style={{ boxShadow: `inset 2px 0 0 ${hexToRgba(SEC.accent, 0.55)}` }}
          >
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-controls="jb-next-sprint-rows"
              title="Assigned to you, but the sprint hasn’t started — not part of the current sprint"
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-solid)]"
            >
              <CalendarIcon size={13} color={SEC.accent} />
              <span className="shrink-0 text-[12px] font-bold" style={{ color: SEC.accent }}>
                {SEC.label}
              </span>
              <span
                className="shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-bold tabular-nums"
                style={{ color: SEC.accent, background: hexToRgba(SEC.accent, 0.14) }}
              >
                {tickets.length}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]">{summary}</span>
              {points > 0 && (
                <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--muted)]">{points} pts</span>
              )}
              <motion.span
                className="shrink-0 text-[var(--muted)]"
                animate={{ rotate: open ? 90 : 0 }}
                transition={{ duration: 0.18 }}
              >
                <ChevronIcon size={12} />
              </motion.span>
            </button>

            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  id="jb-next-sprint-rows"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                  className="overflow-hidden"
                >
                  {/* Bounded so a big grooming bucket can never push the page around. */}
                  <div className={tickets.length > 8 ? 'max-h-[288px] overflow-y-auto' : ''}>
                    {groups.map((g) => (
                      <div key={g.info.name}>
                        {groups.length > 1 && (
                          <div className="flex items-center gap-2 border-t border-[var(--line)] px-3 py-1">
                            <span
                              className="min-w-0 truncate text-[9.5px] font-bold uppercase tracking-wider"
                              style={{ color: hexToRgba(SEC.accent, 0.85) }}
                            >
                              {g.info.name}
                            </span>
                            <span className="shrink-0 text-[9.5px] tabular-nums text-[var(--muted)]">
                              {g.tickets.length} · {whenLabel(g.info, now)}
                            </span>
                          </div>
                        )}
                        {g.tickets.map((t) => (
                          <Row key={t.key} ticket={t} now={now} onOpen={onOpen} />
                        ))}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
