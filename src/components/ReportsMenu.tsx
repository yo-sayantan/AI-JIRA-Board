import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ReportScope } from '../lib/runner'
import { currentYear, dateInputDaysAgo, hexToRgba } from '../lib/format'
import { APP_CONFIG } from '../lib/appConfig'
import { SparkleIcon } from './Icons'

const AI = '#a855f7'

/** Twinkling sparkle while reports generate. The glyph stays; it does not spin like a refresh. */
function AiSpark({ busy }: { busy: boolean }) {
  return (
    <span className="relative grid place-items-center">
      <motion.span
        className="inline-flex"
        animate={busy ? { scale: [1, 1.2, 0.94, 1.12, 1], rotate: [0, -14, 12, 0] } : { scale: 1, rotate: 0 }}
        transition={busy ? { duration: 1.35, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
      >
        <SparkleIcon size={16} color={AI} />
      </motion.span>
      {busy && (
        <>
          <motion.span
            aria-hidden
            className="absolute -right-1 -top-1 h-1 w-1 rounded-full"
            style={{ background: AI }}
            animate={{ opacity: [0, 1, 0], scale: [0.3, 1.3, 0.3] }}
            transition={{ duration: 1.05, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.span
            aria-hidden
            className="absolute -left-1 bottom-0 h-[3px] w-[3px] rounded-full"
            style={{ background: '#e9d5ff' }}
            animate={{ opacity: [0, 1, 0], scale: [0.2, 1.1, 0.2] }}
            transition={{ duration: 1.05, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
          />
        </>
      )}
    </span>
  )
}

/** ISO date N days back — the date inputs and the preset windows share one clock. */
function daysAgo(n: number): string {
  return dateInputDaysAgo(n, APP_CONFIG.timeZone)
}

/**
 * Batch entry point for PR Readiness Reports: run every ticket that has a pull request, or narrow
 * to a time window or a single ticket. Generation always happens on the server, one ticket at a
 * time through the same queue the per-ticket buttons use, so a 40-ticket run and a single click
 * can't race each other onto the agent.
 */
export interface ReportsMenuProps {
  served: boolean
  /** Keys generating right now — server queue ∪ terminal/cron runs. */
  generating: Set<string>
  /** Tickets on the board that have at least one pull request (the eligible population). */
  withPrCount: number
  /** How many of those already have a report on disk. */
  reportCount: number
  onBulk: (target: ReportScope, force: boolean) => void
  onOne: (key: string) => void
  onStop: () => void
  /** Ticket the intern is enriching right now, if any. */
  currentKey?: string | null
  /** Saved cloud model actually running, e.g. "grok-4.5 · medium". */
  modelLabel?: string | null
}

export function ReportsMenu({ served, generating, withPrCount, reportCount, onBulk, onOne, onStop, currentKey, modelLabel }: ReportsMenuProps) {
  const [open, setOpen] = useState(false)
  const [force, setForce] = useState(false)
  const [since, setSince] = useState(() => daysAgo(APP_CONFIG.reports?.defaultWindowDays ?? 30))
  const [key, setKey] = useState('')
  const [peak, setPeak] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const busy = generating.size
  // The queue arrives all at once, then shrinks as each report finishes. Peak is the batch size.
  useEffect(() => {
    if (busy === 0) setPeak(0)
    else setPeak((n) => Math.max(n, busy))
  }, [busy])
  const done = peak > 0 ? Math.max(0, peak - busy) : 0
  const pct = peak > 0 ? Math.round((done / peak) * 100) : 0
  const fill = busy > 0 ? Math.max(8, pct) : 0

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const thisYear = useMemo(() => currentYear(APP_CONFIG.timeZone), [])
  const windows = APP_CONFIG.reports?.presetWindowDays?.length ? APP_CONFIG.reports.presetWindowDays : [30, 90]
  const run = (target: ReportScope) => {
    onBulk(target, force)
  }
  const keyValid = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(key.trim())

  return (
    <div className="relative" ref={wrapRef}>
      {/* Same 9×9 icon button as Help / theme. While reports generate, the sparkle twinkles — progress stays in the window. */}
      <motion.button
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.9 }}
        transition={{ type: 'spring', stiffness: 400, damping: 18 }}
        onClick={() => setOpen((o) => !o)}
        aria-label={busy ? `Generating ${busy} PR readiness report${busy === 1 ? '' : 's'} — open report options` : 'Generate PR readiness reports'}
        aria-expanded={open}
        title={
          busy
            ? `${busy} PR readiness report${busy === 1 ? '' : 's'} generating in the background — click for options`
            : 'Generate PR Readiness Reports — all tickets with a pull request, a time window, or one ticket'
        }
        className="grid h-9 w-9 place-items-center rounded-xl border bg-[var(--surface-solid)] card-shadow hover:border-[var(--muted)]"
        style={{ borderColor: busy ? hexToRgba(AI, 0.5) : 'var(--line)' }}
      >
        <AiSpark busy={busy > 0} />
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 z-50 mt-2 w-[330px] origin-top-right rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-2xl"
            role="menu"
          >
            <div
              className="relative overflow-hidden border-b border-[var(--line)] px-3.5 py-2.5"
              style={{ background: hexToRgba(AI, busy ? 0.16 : 0.07) }}
              role={busy ? 'progressbar' : undefined}
              aria-valuenow={busy ? pct : undefined}
              aria-valuemin={busy ? 0 : undefined}
              aria-valuemax={busy ? 100 : undefined}
              aria-label={busy ? `Report generation ${done} of ${peak}` : undefined}
            >
              {busy > 0 && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0"
                  initial={false}
                  animate={{ width: `${fill}%` }}
                  transition={{ type: 'spring', stiffness: 120, damping: 22, mass: 0.6 }}
                  style={{ background: `linear-gradient(90deg, ${hexToRgba(AI, 0.55)}, ${hexToRgba(AI, 0.28)})` }}
                />
              )}
              {busy > 0 && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 z-[1] w-[2px]"
                  initial={false}
                  animate={{ left: `calc(${fill}% - 1px)` }}
                  transition={{ type: 'spring', stiffness: 120, damping: 22, mass: 0.6 }}
                  style={{ background: 'rgba(255,255,255,0.85)' }}
                />
              )}
              {busy > 0 && pct === 0 && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 z-[1] w-1/3"
                  animate={{ left: ['-33%', '100%'] }}
                  transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}
                  style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)' }}
                />
              )}
              <div className="relative">
                <div className="text-[12px] font-extrabold" style={{ color: AI }}>
                  Generate PR Readiness Reports
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                  {reportCount} of {withPrCount} tickets with a pull request have a report.
                  {busy > 0 ? ` ${done}/${peak} done${currentKey ? ` · ${currentKey}` : ''}${modelLabel ? ` · ${modelLabel}` : ''}` : ''}
                </div>
              </div>
            </div>

            {!served ? (
              <div className="px-3.5 py-3 text-[11.5px] text-[var(--muted)]">
                Generation needs the local server or Docker. From a terminal:
                <code className="mt-1 block rounded bg-[var(--surface-2)] px-1.5 py-1 text-[10.5px]">
                  bash jira-intern/local-runner/pr-reports-backfill.sh --all-years
                </code>
              </div>
            ) : (
              <div className="flex flex-col gap-1 p-2">
                <MenuItem label="All tickets with a PR" hint={`${withPrCount} tickets · merged and open`} onClick={() => run({ scope: 'all' })} />
                <MenuItem label={`This year (${thisYear})`} hint="tickets created or updated this year" onClick={() => run({ scope: 'year', year: thisYear })} />
                {windows.map((days) => (
                  <MenuItem key={days} label={`Last ${days} days`} hint={`since ${daysAgo(days)}`} onClick={() => run({ scope: 'since', since: daysAgo(days) })} />
                ))}

                <div className="mt-1 border-t border-[var(--line)] pt-2">
                  <div className="px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">Custom window</div>
                  <div className="flex items-center gap-1.5 px-1.5">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={since}
                      placeholder="YYYY-MM-DD"
                      onChange={(e) => setSince(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
                      aria-label="Generate reports for tickets since this date, YYYY-MM-DD"
                    />
                    <button
                      type="button"
                      onClick={() => since && run({ scope: 'since', since })}
                      disabled={!/^\d{4}-\d{2}-\d{2}$/.test(since)}
                      className="shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-bold text-white disabled:opacity-50"
                      style={{ background: AI }}
                    >
                      Run
                    </button>
                  </div>
                </div>

                <div className="mt-1 border-t border-[var(--line)] pt-2">
                  <div className="px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">One ticket</div>
                  <div className="flex items-center gap-1.5 px-1.5">
                    <input
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && keyValid) {
                          onOne(key.trim().toUpperCase())
                          setKey('')
                        }
                      }}
                      placeholder="TICKET-123"
                      className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
                      aria-label="Ticket key to generate a report for"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        onOne(key.trim().toUpperCase())
                        setKey('')
                      }}
                      disabled={!keyValid}
                      className="shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-bold text-white disabled:opacity-50"
                      style={{ background: AI }}
                    >
                      Run
                    </button>
                  </div>
                </div>

                <label className="mt-1.5 flex cursor-pointer items-start gap-2 rounded-lg border-t border-[var(--line)] px-1.5 pt-2.5 text-[11px] text-[var(--ink-soft)]">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-[2px]" />
                  <span>
                    <span className="font-semibold">Force rebuild</span>
                    <span className="text-[var(--muted)]"> — also redo reports that are still current. Off: only missing or out-of-date ones.</span>
                  </span>
                </label>
                {busy > 0 && (
                  <button
                    type="button"
                    onClick={onStop}
                    className="mt-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-bold"
                    style={{ borderColor: hexToRgba(AI, 0.45), color: AI }}
                  >
                    Stop reports
                  </button>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MenuItem({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]"
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: AI }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold text-[var(--ink)]">{label}</span>
        <span className="block text-[10.5px] text-[var(--muted)]">{hint}</span>
      </span>
    </button>
  )
}
