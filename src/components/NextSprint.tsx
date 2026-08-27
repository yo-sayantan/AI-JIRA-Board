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
  workdaysBetween,
  type SprintInfo,
} from '../lib/format'
import { ChevronIcon, TypeIcon } from './Icons'

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

/**
 * One ticket = one 30px line, no card, no separator. Alignment does the work a border would:
 * the key column is fixed width, so every title starts at the same x and the rows read as a table.
 *
 * Colour is granted in exactly one place — the priority dot, and only from High upwards. Type is
 * carried by the glyph's SHAPE, not its hue: six issue-type colours would make a list that is
 * supposed to recede louder than the board above it.
 */
function Row({ ticket, now, onOpen }: { ticket: Ticket; now: number; onOpen: (key: string) => void }) {
  const prio = priorityMeta(ticket.priority)
  const rel = relTime(ticket.lastUpdate, now)
  const pts = typeof ticket.storyPoints === 'number' ? ticket.storyPoints : null
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(ticket.key)}
        aria-label={`Open ${ticket.key}: ${ticket.title} — ${prio.label} priority`}
        className="group flex min-h-[30px] w-full items-center gap-2.5 rounded-md px-3 py-[6px] text-left transition-colors duration-150 hover:bg-[var(--surface-solid)] focus-visible:bg-[var(--surface-solid)]"
      >
        {/* Urgent gets a dot; everything else gets the same 6px of nothing, so the columns still line
            up. A near-invisible hollow ring would read as "unread", which is not what this means. */}
        {prio.rank >= 4 ? (
          <span
            aria-hidden
            title={`${prio.label} priority`}
            className="h-[6px] w-[6px] shrink-0 rounded-full"
            style={{ background: prio.color, boxShadow: `0 0 0 3px ${hexToRgba(prio.color, 0.14)}` }}
          />
        ) : (
          <span aria-hidden className="h-[6px] w-[6px] shrink-0" />
        )}
        <span className="inline-flex shrink-0 text-[var(--muted)] opacity-70 transition-opacity group-hover:opacity-100">
          <TypeIcon type={effectiveType(ticket)} size={10} />
        </span>
        {/* Fixed at 104px: FRAUDBUSTE-227 is 14 mono chars ≈ 92px, so real keys never truncate. */}
        <span className="w-[104px] shrink-0 truncate font-mono text-[11px] font-semibold tracking-tight text-[var(--muted)] transition-colors group-hover:text-[var(--ink-soft)]">
          {ticket.key}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-[17px] text-[var(--ink-soft)] transition-colors group-hover:text-[var(--ink)]"
          title={ticket.title}
        >
          {ticket.title}
        </span>
        {pts != null && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--muted)]">
            {pts} pt{pts === 1 ? '' : 's'}
          </span>
        )}
        {/* relTime is '' when lastUpdate is missing — flex-1 on the title holds the rail, so no ml-auto. */}
        {rel && <span className="shrink-0 text-[10px] tabular-nums text-[var(--muted)]">{rel}</span>}
        <ChevronIcon
          size={10}
          className="shrink-0 text-[var(--muted)] opacity-0 transition-opacity group-hover:opacity-100"
        />
      </button>
    </li>
  )
}

/**
 * Tickets assigned to you whose sprint hasn't started — rendered ONLY when there are any.
 *
 * Design brief: this is the least urgent thing on the page, so it gets the least ink. The board's
 * cards have a drop shadow and a column accent; On Hold has a warm tint and a pulsing icon because
 * blocked work needs a nudge. This has neither — hierarchy comes from type size, ink level and
 * withheld colour, so the section recedes until you go looking for it.
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
  // One sprint → name it in the header and drop the per-group caption entirely (that duplication is
  // most of what made this section feel big). Several → summarise, and let the captions do the work.
  const multi = groups.length > 1
  // Only the multi-sprint header needs a rolled-up string; a single sprint renders as
  // name + when so the name itself can be held back from truncating.
  const summary = multi ? `${groups.length} sprints · ${groups.map((g) => g.info.name).join(', ')}` : ''

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
          {/* Bounded, NOT full-bleed. The board and On Hold span the page; this deliberately stops
              short of them (≈60% of a 1512px screen, all of a small one) so parked work reads as a
              footnote to the board rather than another section competing with it. 56rem is the
              narrowest width that still leaves ~94 characters of title before truncation. */}
          <div className="w-full max-w-[56rem] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-2)]">
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-controls="jb-next-sprint-rows"
              title="Assigned to you, but the sprint hasn’t started — not part of the current sprint"
              className="flex w-full items-center gap-2 px-3 py-[7px] text-left transition-colors hover:bg-[var(--surface-solid)]"
            >
              {/* Same 8px dot the stats chip uses — one glyph, echoed, so the jump target is obvious. */}
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEC.accent }} />
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--ink-soft)]">
                {SEC.label}
              </span>
              <span className="shrink-0 text-[10.5px] font-semibold tabular-nums text-[var(--ink-soft)]">
                · {tickets.length}
              </span>
              {/* The sprint NAME is the point of this header, so it never shrinks and never fades:
                  11px on --ink, whitespace-nowrap. Only the "when" suffix is allowed to truncate.
                  (It was previously 10.5px --muted — the smallest, faintest thing in the row.) */}
              {groups.length === 1 ? (
                <>
                  <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-[var(--ink)]">
                    {groups[0].info.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--muted)]">
                    · {whenLabel(groups[0].info, now)}
                  </span>
                </>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--ink-soft)]">{summary}</span>
              )}
              {points > 0 && (
                <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--muted)]">{points} pts</span>
              )}
              <motion.span
                className="shrink-0 text-[var(--muted)]"
                animate={{ rotate: open ? 90 : 0 }}
                transition={{ duration: 0.18 }}
              >
                <ChevronIcon size={10} />
              </motion.span>
            </button>

            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  id="jb-next-sprint-rows"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 32 }}
                  className="overflow-hidden border-t border-[var(--line)]"
                >
                  {/* py-1 keeps the global focus ring (outline-offset: 2px) off the first/last row's
                      edge. Bounded above 8 so a big grooming bucket can't push the page around. */}
                  <div className={tickets.length > 8 ? 'max-h-[288px] overflow-y-auto py-1' : 'py-1'}>
                    {groups.map((g, i) => (
                      <div key={g.info.name}>
                        {multi && (
                          // id is index-based, never the sprint name: aria-labelledby is a
                          // space-separated ID list, and "FraudBus READY" contains a space.
                          <div
                            id={`jb-ns-g${i}`}
                            className="mt-2 mb-0.5 flex items-baseline gap-1.5 px-3 first:mt-0"
                          >
                            <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--ink-soft)]">
                              {g.info.name}
                            </span>
                            <span className="shrink-0 text-[10.5px] text-[var(--muted)]">
                              {whenLabel(g.info, now)}
                            </span>
                            <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-[var(--muted)]">
                              {g.tickets.length}
                            </span>
                          </div>
                        )}
                        <ul role="list" aria-labelledby={multi ? `jb-ns-g${i}` : undefined}>
                          {g.tickets.map((t) => (
                            <Row key={t.key} ticket={t} now={now} onOpen={onOpen} />
                          ))}
                        </ul>
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
