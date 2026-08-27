import { AnimatePresence, motion } from 'motion/react'
import type { Ticket } from '../types'
import { NEXT_SPRINT_SECTION as SEC } from '../lib/columns'
import { TicketCard } from './TicketCard'
import { fmtDate, futureSprintOf, hexToRgba, priorityMeta, workdaysBetween, type SprintInfo } from '../lib/format'
import { CalendarIcon } from './Icons'

/** Same order as the board's To Do column: most urgent first, then most recently touched. */
const byUrgency = (a: Ticket, b: Ticket) =>
  priorityMeta(b.priority).rank - priorityMeta(a.priority).rank ||
  (b.lastUpdate ?? '').localeCompare(a.lastUpdate ?? '')

/** How far off the sprint is. A grooming bucket ("FraudBus READY") carries no dates at all;
 *  a `future` sprint whose planned start already slipped still reads as not started.
 *  Working days, to match the header's sprint chip. */
function whenLabel(sp: SprintInfo, now: number): string {
  const startTs = sp.start ? Date.parse(`${sp.start}T00:00:00`) : NaN
  if (Number.isNaN(startTs)) return 'not started yet'
  if (now >= startTs) return `not started yet · was planned ${fmtDate(sp.start)}`
  const d = workdaysBetween(now + 86_400_000, startTs)
  return `starts in ${d} day${d === 1 ? '' : 's'} · ${fmtDate(sp.start)}`
}

interface Group {
  info: SprintInfo
  tickets: Ticket[]
}

/** Group by sprint (there can be several: a READY bucket *and* a dated next sprint).
 *  Dated sprints come first, soonest first; undated grooming buckets sink to the bottom. */
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
    .sort((a, b) => (a.info.start ?? '9999').localeCompare(b.info.start ?? '9999') || a.info.name.localeCompare(b.info.name))
}

/**
 * Tickets assigned to you whose sprint hasn't started — rendered ONLY when there are any.
 * They deliberately do NOT sit in the To Do column: clearing the current sprint's To Do
 * should leave that column empty, not permanently occupied by next sprint's queue.
 */
export function NextSprint({
  tickets,
  now,
  onOpen,
  onRefreshTicket,
  refreshingKeys,
}: {
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: Set<string>
}) {
  const groups = groupBySprint(tickets, now)

  return (
    <AnimatePresence initial={false}>
      {tickets.length > 0 && (
        <motion.section
          id="jb-next-sprint"
          initial={{ opacity: 0, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, height: 'auto', marginTop: 24 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 30 }}
          className="overflow-hidden"
        >
          <div
            className="rounded-2xl border p-4"
            style={{ borderColor: hexToRgba(SEC.accent, 0.4), background: hexToRgba(SEC.accent, 0.06) }}
          >
            <div className="mb-3 flex items-center gap-2">
              <span
                className="grid h-7 w-7 place-items-center rounded-lg"
                style={{ background: hexToRgba(SEC.accent, 0.18) }}
              >
                <CalendarIcon size={15} color={SEC.accent} />
              </span>
              <h2 className="text-[14px] font-bold" style={{ color: SEC.accent }}>
                {SEC.label}
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                style={{ color: SEC.accent, background: hexToRgba(SEC.accent, 0.16) }}
              >
                {tickets.length}
              </span>
              <span className="text-[11.5px] text-[var(--muted)]">
                queued for a sprint that hasn’t started — not this sprint’s work
              </span>
            </div>

            {groups.map((g) => (
              <div key={g.info.name} className="mt-3 first:mt-0">
                {/* One sub-heading per sprint — a READY grooming bucket and a dated next
                    sprint are different commitments and shouldn't be piled together. */}
                <div className="mb-2 flex flex-wrap items-center gap-2 px-0.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: SEC.accent }}>
                    {g.info.name}
                  </span>
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums"
                    style={{ color: SEC.accent, background: hexToRgba(SEC.accent, 0.14) }}
                  >
                    {g.tickets.length}
                  </span>
                  <span className="text-[10.5px] text-[var(--muted)]">{whenLabel(g.info, now)}</span>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {g.tickets.map((t) => (
                      <TicketCard
                        key={t.key}
                        ticket={t}
                        now={now}
                        onOpen={onOpen}
                        onRefreshTicket={onRefreshTicket}
                        refreshing={refreshingKeys?.has(t.key)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            ))}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
