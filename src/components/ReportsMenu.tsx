import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ReportScope } from '../lib/runner'
import { hexToRgba } from '../lib/format'
import { SparkleIcon } from './Icons'

const AI = '#a855f7'

/** Indeterminate progress ring — the Reports glyph while generations are in flight. */
function LoadingRing({ size, color }: { size: number; color: string }) {
  const r = size / 2 - 1.5
  const circumference = 2 * Math.PI * r
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
      aria-hidden
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={hexToRgba(color, 0.25)} strokeWidth="2" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.3} ${circumference}`}
      />
    </motion.svg>
  )
}

/** ISO date N days back — the date inputs and the preset windows share one clock. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
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
}

export function ReportsMenu({ served, generating, withPrCount, reportCount, onBulk, onOne }: ReportsMenuProps) {
  const [open, setOpen] = useState(false)
  const [force, setForce] = useState(false)
  const [since, setSince] = useState(() => daysAgo(30))
  const [key, setKey] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const busy = generating.size

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

  const thisYear = useMemo(() => new Date().getFullYear(), [])
  const run = (target: ReportScope) => {
    onBulk(target, force)
    setOpen(false)
  }
  const keyValid = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(key.trim())

  return (
    <div className="relative" ref={wrapRef}>
      {/* Same 9×9 icon button as Help / theme — the count lives in the tooltip so the control stays
          a single glyph, and the glyph itself becomes the progress indicator while work is queued. */}
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
        {busy ? <LoadingRing size={16} color={AI} /> : <SparkleIcon size={16} color={AI} />}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="absolute right-0 z-50 mt-2 w-[330px] origin-top-right overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-2xl"
            role="menu"
          >
            <div className="border-b border-[var(--line)] px-3.5 py-2.5" style={{ background: hexToRgba(AI, 0.07) }}>
              <div className="text-[12px] font-extrabold" style={{ color: AI }}>
                Generate PR Readiness Reports
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                {reportCount} of {withPrCount} tickets with a pull request have a report.
                {busy > 0 ? ` ${busy} in progress.` : ''}
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
                <MenuItem label="Last 30 days" hint={`since ${daysAgo(30)}`} onClick={() => run({ scope: 'since', since: daysAgo(30) })} />
                <MenuItem label="Last 90 days" hint={`since ${daysAgo(90)}`} onClick={() => run({ scope: 'since', since: daysAgo(90) })} />

                <div className="mt-1 border-t border-[var(--line)] pt-2">
                  <div className="px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">Custom window</div>
                  <div className="flex items-center gap-1.5 px-1.5">
                    <input
                      type="date"
                      value={since}
                      max={daysAgo(0)}
                      onChange={(e) => setSince(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1 text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
                      aria-label="Generate reports for tickets since this date"
                    />
                    <button
                      type="button"
                      onClick={() => since && run({ scope: 'since', since })}
                      disabled={!since}
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
                          setOpen(false)
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
                        setOpen(false)
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
