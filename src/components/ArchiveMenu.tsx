import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ArchiveScope } from '../lib/runner'
import { currentYear, dateInputDaysAgo, hexToRgba } from '../lib/format'
import { APP_CONFIG } from '../lib/appConfig'
import { TrophyIcon } from './Icons'

const GREEN = '#16a34a'

function daysAgo(n: number): string {
  return dateInputDaysAgo(n, APP_CONFIG.timeZone)
}

export interface ArchiveMenuProps {
  served: boolean
  busy: boolean
  /** Another intern job (the quick refresh) owns data.json, so a rebuild cannot start. */
  blocked: boolean
  done: number
  total: number
  pct: number
  current?: string | null
  onRun: (target: ArchiveScope) => void
  onStop: () => void
}

/** Small green archive button. The scope menu and the progress fill live in the window under it. */
export function ArchiveMenu({ served, busy, blocked, done, total, pct, current, onRun, onStop }: ArchiveMenuProps) {
  const [open, setOpen] = useState(false)
  const [since, setSince] = useState(() => daysAgo(APP_CONFIG.archive?.defaultWindowDays ?? 30))
  const [key, setKey] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const fill = busy ? Math.max(8, Math.min(100, pct)) : 0
  const keyValid = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(key.trim())
  const thisYear = useMemo(() => currentYear(APP_CONFIG.timeZone), [])
  const windows = APP_CONFIG.archive?.presetWindowDays?.length ? APP_CONFIG.archive.presetWindowDays : [30, 90]

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

  const run = (target: ArchiveScope) => {
    if (busy || blocked) return
    onRun(target)
  }

  return (
    <div className="relative" ref={wrapRef}>
      <motion.button
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.9 }}
        transition={{ type: 'spring', stiffness: 400, damping: 18 }}
        onClick={() => setOpen((o) => !o)}
        aria-label={busy ? 'Archive rebuild in progress — open options' : 'Rebuild the Completed archive'}
        aria-expanded={open}
        title={
          busy
            ? `Rebuilding the Completed archive${current ? ` — ${current}` : ''}. Open for progress.`
            : 'Rebuild the Completed archive — all closed tickets, a date range, or one ticket'
        }
        className={`relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl text-white card-shadow${busy ? ' jb-archive-busy' : ''}`}
        style={{
          background: 'linear-gradient(135deg, #10d29a, #16a34a)',
          boxShadow: '0 6px 16px -8px rgba(16,185,129,0.75)',
        }}
      >
        {busy && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-[3px] rounded-lg"
            animate={{ opacity: [0.25, 0.9, 0.25] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            style={{ boxShadow: 'inset 0 0 0 1.5px rgba(255,253,242,0.85)' }}
          />
        )}
        <motion.span
          className="relative inline-flex"
          animate={busy ? { y: [0, -1.5, 0] } : { y: 0 }}
          transition={busy ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
        >
          <TrophyIcon size={13} glint={busy} />
        </motion.span>
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
              style={{ background: hexToRgba(GREEN, busy ? 0.16 : 0.08) }}
              role={busy ? 'progressbar' : undefined}
              aria-valuenow={busy ? fill : undefined}
              aria-valuemin={busy ? 0 : undefined}
              aria-valuemax={busy ? 100 : undefined}
              aria-label={busy ? `Archive rebuild ${done} of ${total || '…'}` : undefined}
            >
              {busy && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0"
                  initial={false}
                  animate={{ width: `${fill}%` }}
                  transition={{ type: 'spring', stiffness: 120, damping: 22, mass: 0.6 }}
                  style={{ background: `linear-gradient(90deg, ${hexToRgba(GREEN, 0.55)}, ${hexToRgba(GREEN, 0.28)})` }}
                />
              )}
              {busy && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 z-[1] w-[2px]"
                  initial={false}
                  animate={{ left: `calc(${fill}% - 1px)` }}
                  transition={{ type: 'spring', stiffness: 120, damping: 22, mass: 0.6 }}
                  style={{ background: 'rgba(255,255,255,0.9)' }}
                />
              )}
              {busy && !total && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 z-[1] w-1/3"
                  animate={{ left: ['-33%', '100%'] }}
                  transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}
                  style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)' }}
                />
              )}
              <div className="relative">
                <div className="text-[12px] font-extrabold" style={{ color: GREEN }}>
                  Rebuild Completed archive
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                  {busy
                    ? total > 0
                      ? `${done}/${total} · ${Math.round(fill)}%${current ? ` · ${current}` : ''}`
                      : 'Starting the scan…'
                    : 'Closed tickets you owned. A range or one ticket updates only those rows.'}
                </div>
              </div>
            </div>

            {!served ? (
              <div className="px-3.5 py-3 text-[11.5px] text-[var(--muted)]">
                Rebuild needs the local server or Docker. From a terminal:
                <code className="mt-1 block rounded bg-[var(--surface-2)] px-1.5 py-1 text-[10.5px]">
                  bash jira-intern/local-runner/update-completed.sh
                </code>
              </div>
            ) : (
              <div className="flex flex-col gap-1 p-2">
                <MenuItem label="All completed tickets" hint="full archive, incremental" disabled={busy || blocked} onClick={() => run({ scope: 'all' })} />
                <MenuItem label={`This year (${thisYear})`} hint="resolved this year" disabled={busy || blocked} onClick={() => run({ scope: 'year', year: thisYear })} />
                {windows.map((days) => (
                  <MenuItem key={days} label={`Last ${days} days`} hint={`resolved since ${daysAgo(days)}`} disabled={busy || blocked} onClick={() => run({ scope: 'since', since: daysAgo(days) })} />
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
                      aria-label="Rebuild tickets resolved since this date, YYYY-MM-DD"
                    />
                    <button
                      type="button"
                      onClick={() => since && run({ scope: 'since', since })}
                      disabled={!/^\d{4}-\d{2}-\d{2}$/.test(since) || busy || blocked}
                      className="shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-bold text-white disabled:opacity-50"
                      style={{ background: GREEN }}
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
                          run({ scope: 'key', key: key.trim().toUpperCase() })
                          setKey('')
                        }
                      }}
                      placeholder="TICKET-123"
                      className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
                      aria-label="Ticket key to rebuild in the archive"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        run({ scope: 'key', key: key.trim().toUpperCase() })
                        setKey('')
                      }}
                      disabled={!keyValid || busy || blocked}
                      className="shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-bold text-white disabled:opacity-50"
                      style={{ background: GREEN }}
                    >
                      Run
                    </button>
                  </div>
                </div>
                {blocked && !busy && (
                  <p className="px-1.5 pt-1 text-[10.5px] text-[var(--muted)]">Wait for the board refresh to finish.</p>
                )}
                {busy && (
                  <button
                    type="button"
                    onClick={onStop}
                    className="mt-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-bold"
                    style={{ borderColor: hexToRgba(GREEN, 0.45), color: GREEN }}
                  >
                    Stop rebuild
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

function MenuItem({ label, hint, onClick, disabled }: { label: string; hint: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: GREEN }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold text-[var(--ink)]">{label}</span>
        <span className="block text-[10.5px] text-[var(--muted)]">{hint}</span>
      </span>
    </button>
  )
}
