import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import type { JiraData } from '../types'
import { currentSprint, fmtDate, fmtDateShort, freshness, hexToRgba, sprintStatus } from '../lib/format'
import { CalendarIcon, QuestionIcon, RefreshIcon, SearchIcon, SunIcon, MoonIcon, TicketGlyph, TrophyIcon } from './Icons'
import { guideUrl } from '../lib/runner'

export type RunProgress = {
  done: number
  total: number
  pct: number
  current?: string | null
  phase?: string
}

/**
 * Overall completion 0–100 for the button fill. Prep phases (search → devinfo) take the bar
 * to ~24%; the rest fills linearly as tickets are built, so the fill reflects real progress.
 */
function displayPct(p: RunProgress | null | undefined): number {
  if (!p) return 6
  const PREP = 24
  const BUILD_MAX = 96
  const floor: Record<string, number> = {
    starting: 4,
    searching: 10,
    subtasks: 16,
    parents: 16,
    devinfo: PREP,
    writing: 97,
    done: 100,
  }
  if (p.phase === 'building' || p.phase === 'assembling') {
    if (p.total > 0) return PREP + (BUILD_MAX - PREP) * (p.done / p.total)
    return PREP
  }
  return floor[p.phase || ''] ?? 6
}

/** True once we have a real ticket count to show as x/y. */
function hasCount(p: RunProgress | null | undefined): boolean {
  return !!(p && p.total > 0 && (p.phase === 'building' || p.phase === 'assembling'))
}

/**
 * A fixed-width button that doubles as its own progress bar. Idle: solid bright gradient with
 * a label. Busy: the same bright colour fills left→right (the unfilled part is dimmed/faded),
 * and the label is just `x/y · z%` — no word, so the width never has to change.
 */
function ProgressButton({
  busy,
  progress,
  onClick,
  disabled,
  ariaLabel,
  title,
  idleLabel,
  gradient,
  shadow,
  idleIcon,
}: {
  busy: boolean
  progress: RunProgress | null | undefined
  onClick: () => void
  disabled: boolean
  ariaLabel: string
  title: string
  idleLabel: string
  gradient: string
  shadow: string
  idleIcon: ReactNode
}) {
  const pctNum = busy ? Math.max(4, Math.min(100, displayPct(progress))) : 0
  const pct = Math.round(pctNum)
  const label = busy ? (hasCount(progress) ? `${progress!.done}/${progress!.total} · ${pct}%` : `${pct}%`) : idleLabel

  return (
    <motion.button
      whileHover={disabled ? undefined : { scale: 1.04, y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      title={
        busy && progress?.current
          ? `${title}\nNow: ${progress.current}${progress.total ? ` (${progress.done}/${progress.total})` : ''}`
          : title
      }
      // Fixed width so the label swapping (idle text ↔ x/y · %) never resizes the button.
      className="relative inline-flex h-9 w-[168px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-xl px-3 text-[13px] font-bold text-white transition-[filter] hover:brightness-[1.08]"
      style={{ background: gradient, boxShadow: `0 6px 18px -6px ${shadow}`, opacity: disabled && !busy ? 0.6 : 1 }}
    >
      {/* Dimming scrim over the UNFILLED (right) portion — recedes as pct grows, so the deep
          bright colour "fills in" from the left. */}
      {busy && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-0"
          initial={false}
          animate={{ left: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 22, mass: 0.6 }}
          style={{ background: 'rgba(0,0,0,0.34)' }}
        />
      )}
      {/* Bright leading edge at the fill boundary for a crisp "wet paint" look. */}
      {busy && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-[1] w-[3px]"
          initial={false}
          animate={{ left: `calc(${pct}% - 1.5px)` }}
          transition={{ type: 'spring', stiffness: 120, damping: 22, mass: 0.6 }}
          style={{ background: 'rgba(255,255,255,0.85)', boxShadow: '0 0 8px rgba(255,255,255,0.6)' }}
        />
      )}
      {/* Shimmer while we don't yet have a ticket count (early phases). */}
      {busy && !hasCount(progress) && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-[1] w-1/4"
          animate={{ left: ['-25%', '100%'] }}
          transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}
          style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)' }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.35)' }}>
        <motion.span
          className="inline-flex"
          animate={busy ? { rotate: 360 } : { rotate: 0 }}
          transition={busy ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { type: 'spring', stiffness: 300, damping: 20 }}
        >
          {busy ? <RefreshIcon size={15} color="#fff" /> : idleIcon}
        </motion.span>
        <span className="tabular-nums">{label}</span>
      </span>
    </motion.button>
  )
}

export function Header({
  data,
  now,
  query,
  setQuery,
  dark,
  toggleTheme,
  refreshing,
  archiveRefreshing,
  runProgress,
  served,
  onRefresh,
  onArchiveRefresh,
}: {
  data: JiraData
  now: number
  query: string
  setQuery: (v: string) => void
  dark: boolean
  toggleTheme: () => void
  refreshing: boolean
  archiveRefreshing: boolean
  /** Live done/total from the running fetch — fills the active button. */
  runProgress?: RunProgress | null
  served: boolean
  onRefresh: () => void
  onArchiveRefresh: () => void
}) {
  const fr = freshness(data.generatedAt, now)
  const name = data.user?.name?.split(',')[1]?.trim() || data.user?.name || 'you'
  // Headline sprint: the active one on the board's tickets (else the next future one).
  const sprint = currentSprint(data.tickets)
  const sp = sprint ? sprintStatus(sprint, now) : null
  const dailyProgress = refreshing ? runProgress : null
  const archiveProgress = archiveRefreshing ? runProgress : null

  return (
    <header className="sticky top-0 z-30 -mx-4 mb-4 border-b border-[var(--line)] bg-[var(--bg)]/80 px-4 py-3 backdrop-blur-xl md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2.5">
          <motion.span
            initial={{ rotate: -12, scale: 0.8, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 18 }}
            className="grid h-9 w-9 place-items-center rounded-xl"
            style={{ background: 'linear-gradient(135deg, #6d5bd0, #3b82f6)' }}
          >
            <TicketGlyph size={20} />
          </motion.span>
          <div className="leading-tight">
            <h1 className="bg-gradient-to-r from-[var(--ink)] to-[var(--muted)] bg-clip-text text-[17px] font-extrabold tracking-tight text-transparent">
              My Jira Board
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--muted)]">
              <span>{name}</span>
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px]"
                style={{ borderColor: hexToRgba(fr.color, 0.45), background: hexToRgba(fr.color, 0.1) }}
                title={
                  data.generatedAt
                    ? `The board reflects JIRA as of ${fr.full} (the last intern run). It is ${fr.label} relative to now.`
                    : 'The intern has not produced a dump yet.'
                }
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: fr.color }} />
                {data.generatedAt ? (
                  <>
                    <span className="text-[var(--ink-soft)]">last run {fr.full}</span>
                    <b style={{ color: fr.color }}>· {fr.label}</b>
                  </>
                ) : (
                  <b style={{ color: fr.color }}>no intern run yet</b>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Current sprint — compact two-line block: name + workdays left, dates + progress. */}
          {sprint && sp && (
            <div
              className="hidden shrink-0 flex-col gap-0.5 rounded-xl border px-2.5 py-1 leading-tight md:flex"
              style={{ borderColor: hexToRgba(sp.color, 0.4), background: hexToRgba(sp.color, 0.08) }}
              title={
                (sprint.start && sprint.end
                  ? `Sprint ${sprint.name}: ${fmtDate(sprint.start)} → ${fmtDate(sprint.end)}`
                  : `Sprint ${sprint.name}`) + ` — ${sp.label} (working days, Mon–Fri)`
              }
            >
              <span className="flex items-center gap-1.5 text-[10.5px] font-bold text-[var(--ink-soft)]">
                <CalendarIcon size={10} color={sp.color} />
                {/* The pill sizes to the NAME — sprint names vary in length ("FraudBus Sprint 13.2"
                    alone needs ~118px, so the old 110px cap clipped every one of them). 280px is a
                    backstop against a pathological name squeezing the search box, not a budget. */}
                <span className="max-w-[280px] shrink-0 truncate whitespace-nowrap">{sprint.name}</span>
                <b className="ml-auto shrink-0 whitespace-nowrap pl-1" style={{ color: sp.color }}>
                  {sp.label}
                </b>
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
                {sprint.start && sprint.end ? (
                  <span className="whitespace-nowrap tabular-nums">{fmtDateShort(sprint.start)} → {fmtDateShort(sprint.end)}</span>
                ) : (
                  <span>{sprint.state || 'sprint'}</span>
                )}
                {sp.pct != null && (
                  <span className="relative h-1 min-w-8 flex-1 overflow-hidden rounded-full" style={{ background: hexToRgba(sp.color, 0.18) }}>
                    <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(sp.pct * 100)}%`, background: sp.color }} />
                  </span>
                )}
              </span>
            </div>
          )}

          <label className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-1.5 card-shadow focus-within:border-[var(--muted)]">
            <span className="text-[var(--muted)]">
              <SearchIcon size={14} />
            </span>
            <input
              id="jb-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              type="search"
              placeholder="Search…  ( / )"
              className="w-36 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] md:w-60"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-[var(--muted)] hover:text-[var(--ink)]" aria-label="Clear">
                ✕
              </button>
            )}
          </label>

          <ProgressButton
            busy={refreshing}
            progress={dailyProgress}
            onClick={onRefresh}
            disabled={refreshing || archiveRefreshing}
            ariaLabel={served ? 'Refresh the board (active tickets only)' : 'Reload latest data'}
            title={
              served
                ? 'QUICK refresh — re-fetches only your ACTIVE tickets (seconds). The Completed archive is not touched.  (r)'
                : 'Reload the latest data dump from disk  (r)'
            }
            idleLabel={served ? 'Refresh board' : 'Reload'}
            gradient="linear-gradient(135deg, #7c5cff, #2684ff)"
            shadow="rgba(38,132,255,0.55)"
            idleIcon={<RefreshIcon size={15} color="#fff" />}
          />

          {served && (
            <ProgressButton
              busy={archiveRefreshing}
              progress={archiveProgress}
              onClick={onArchiveRefresh}
              disabled={refreshing || archiveRefreshing}
              ariaLabel="Rebuild the Completed archive (slow, deep scan)"
              title="DEEP rebuild of the COMPLETED archive — re-scans every closed ticket plus its PRs & branches from Jira and Bitbucket. Takes minutes; run after closing tickets or when the archive looks stale. Not the everyday refresh!"
              idleLabel="Rebuild archive"
              gradient="linear-gradient(135deg, #10d29a, #16a34a)"
              shadow="rgba(16,185,129,0.5)"
              idleIcon={<TrophyIcon size={15} />}
            />
          )}

          {/* Help — opens the Setup & Deployment guide. An <a>, not a fetch/route, so it still works
              when the server is down (file:// falls back to the sibling docs/ folder). */}
          <motion.a
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
            href={guideUrl()}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Setup and deployment guide"
            title="Setup & deployment guide — requirements, install steps for Windows/macOS/Linux, git & Docker commands, troubleshooting"
            className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] text-[var(--ink-soft)] card-shadow hover:border-[var(--muted)] hover:text-[var(--ink)]"
          >
            <QuestionIcon size={16} />
          </motion.a>

          <motion.button
            whileHover={{ scale: 1.08, rotate: dark ? -8 : 8 }}
            whileTap={{ scale: 0.9, rotate: -15 }}
            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] card-shadow hover:border-[var(--muted)]"
          >
            {dark ? <MoonIcon size={16} /> : <SunIcon size={16} />}
          </motion.button>
        </div>
      </div>
    </header>
  )
}
