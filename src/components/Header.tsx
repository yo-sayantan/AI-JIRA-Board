import { useCallback, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { JiraData } from '../types'
import { currentSprint, fmtDate, fmtDateShort, freshness, hexToRgba, sprintStatus, type SprintInfo } from '../lib/format'
import { ChevronDownIcon, ClearIcon, GearIcon, MoonIcon, QuestionIcon, RefreshIcon, SearchIcon, SunIcon, TicketGlyph, TrophyIcon } from './Icons'
import { guideUrl } from '../lib/runner'
import { ReportsMenu, type ReportsMenuProps } from './ReportsMenu'
import { ACCENT, ControlGroup, Kbd, Menu, MenuItem, SURFACE, ToolButton, ToolLink, useDismiss } from './toolbar'

export type RunProgress = {
  done: number
  total: number
  pct: number
  current?: string | null
  phase?: string
}

type Job = 'daily' | 'archive' | null
type Freshness = ReturnType<typeof freshness>
type SprintStatus = ReturnType<typeof sprintStatus>

/**
 * Overall completion 0–100 for the progress line. Prep phases (search → devinfo) take the line
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

/** True once we have a real ticket count — before that the progress line is indeterminate. */
function hasCount(p: RunProgress | null | undefined): boolean {
  return !!(p && p.total > 0 && (p.phase === 'building' || p.phase === 'assembling'))
}

/** What the fetch is doing right now, in words — the viewer's second line while a job runs. */
function phaseLabel(p: RunProgress | null | undefined): string {
  if (!p) return 'Starting…'
  if (p.phase === 'building' || p.phase === 'assembling') {
    if (p.total > 0) return `${p.done} of ${p.total} tickets${p.current ? ` · ${p.current}` : ''}`
    return 'Building tickets…'
  }
  const words: Record<string, string> = {
    starting: 'Starting…',
    searching: 'Searching Jira…',
    subtasks: 'Loading sub-tasks…',
    parents: 'Loading parent tickets…',
    devinfo: 'Reading pull requests & branches…',
    writing: 'Writing data…',
    done: 'Finishing…',
  }
  return words[p.phase || ''] ?? 'Working…'
}

/** "Updated 3:53 PM" while fresh; once the dump is hours old its age is the more useful fact. */
function updatedLabel(generatedAt: string | null | undefined, fr: Freshness): string {
  if (fr.level === 'unknown' || !generatedAt) return 'No data yet'
  const h = fr.ageHours
  if (h >= 3) return h < 48 ? `Updated ${Math.floor(h)}h ago` : `Updated ${Math.round(h / 24)}d ago`
  return `Updated ${new Date(generatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

// ── Activity viewer ─────────────────────────────────────────────────────────

/** One line of the viewer: a truncating lead and an optional right-aligned fact. */
function Line({ lead, trail, strong }: { lead: ReactNode; trail?: ReactNode; strong?: boolean }) {
  return (
    <span className={`flex items-center justify-between gap-3 ${strong ? 'text-[11px] leading-[13px]' : 'text-[10.5px] leading-[12px]'}`}>
      <span className="min-w-0 truncate">{lead}</span>
      {trail && <span className="shrink-0 whitespace-nowrap">{trail}</span>}
    </span>
  )
}

/**
 * The centre of the toolbar, in the manner of Xcode's activity viewer: the sprint and the data's
 * freshness at rest; the job's name, count and percentage while a fetch runs. One 2px line along
 * the bottom edge is the sprint's progress at rest and the fetch's progress in flight — so the
 * viewer is the single place the board reports on itself.
 */
function ActivityViewer({
  sprint,
  sp,
  fr,
  updated,
  job,
  progress,
  title,
}: {
  sprint: SprintInfo | null
  sp: SprintStatus | null
  fr: Freshness
  updated: string
  job: Job
  progress: RunProgress | null | undefined
  title: string
}) {
  const busy = job != null
  const pct = busy ? Math.round(Math.max(3, Math.min(100, displayPct(progress)))) : 0
  const sprintPct = sp?.pct != null ? Math.round(sp.pct * 100) : null
  const showLine = busy || sprintPct != null
  const fill = busy ? ACCENT : sp ? hexToRgba(sp.color, 0.75) : 'transparent'
  const track = busy ? 'color-mix(in oklab, var(--link) 18%, transparent)' : sp ? hexToRgba(sp.color, 0.16) : 'transparent'
  const swap = {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -6 },
    transition: { duration: 0.18, ease: 'easeOut' as const },
  }

  return (
    <div title={title} className="relative hidden h-8 w-[300px] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface-2)] md:block lg:w-[340px]">
      <AnimatePresence initial={false}>
        {busy ? (
          <motion.div key="busy" {...swap} className="absolute inset-0 flex flex-col justify-center px-2.5 pb-[2px]">
            <Line
              strong
              lead={<span className="font-semibold text-[var(--ink)]">{job === 'archive' ? 'Rebuilding Completed archive' : 'Refreshing board'}</span>}
              trail={
                <span className="font-semibold tabular-nums" style={{ color: ACCENT }}>
                  {pct}%
                </span>
              }
            />
            <Line lead={<span className="text-[var(--muted)]">{phaseLabel(progress)}</span>} />
          </motion.div>
        ) : (
          <motion.div key="idle" {...swap} className="absolute inset-0 flex flex-col justify-center px-2.5 pb-[2px]">
            <Line
              strong
              lead={<span className="font-semibold text-[var(--ink)]">{sprint ? sprint.name : 'No active sprint'}</span>}
              trail={
                sp && (
                  <span className="font-semibold" style={{ color: sp.color }}>
                    {sp.label}
                  </span>
                )
              }
            />
            <Line
              lead={
                <span className="tabular-nums text-[var(--muted)]">
                  {sprint?.start && sprint?.end ? `${fmtDateShort(sprint.start)} → ${fmtDateShort(sprint.end)}` : sprint?.state || ''}
                </span>
              }
              trail={
                <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
                  <span className="h-[5px] w-[5px] rounded-full" style={{ background: fr.color }} />
                  {updated}
                </span>
              }
            />
          </motion.div>
        )}
      </AnimatePresence>

      {showLine && (
        <div className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: track }}>
          <motion.div
            className="h-full rounded-r-full"
            initial={false}
            animate={{ width: `${busy ? pct : sprintPct}%` }}
            transition={{ type: 'spring', stiffness: 140, damping: 26, mass: 0.6 }}
            style={{ background: fill }}
          />
          {/* Indeterminate: a highlight travels the line until the fetch knows how many tickets. */}
          {busy && !hasCount(progress) && (
            <motion.span
              aria-hidden
              className="absolute inset-y-0 w-1/3"
              animate={{ left: ['-33%', '100%'] }}
              transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
              style={{ background: 'linear-gradient(90deg, transparent, color-mix(in oklab, var(--link) 55%, white), transparent)' }}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Controls ────────────────────────────────────────────────────────────────

function SearchField({ query, setQuery }: { query: string; setQuery: (v: string) => void }) {
  return (
    <label className={`jb-field group relative flex h-8 w-[150px] shrink-0 items-center gap-2 rounded-lg pl-2.5 pr-1.5 ${SURFACE} sm:w-[190px] lg:w-[230px]`}>
      <span className="shrink-0 text-[var(--muted)]">
        <SearchIcon size={11} />
      </span>
      <input
        id="jb-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        type="search"
        placeholder="Search"
        aria-label="Search tickets"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
      />
      {query ? (
        <button
          type="button"
          onClick={() => setQuery('')}
          aria-label="Clear search"
          className="grid h-5 w-5 shrink-0 place-items-center text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
        >
          <ClearIcon size={11} />
        </button>
      ) : (
        <span className="shrink-0 group-focus-within:hidden">
          <Kbd>/</Kbd>
        </span>
      )}
    </label>
  )
}

/**
 * Refresh is the board's one primary action, so its glyph alone carries the accent. Served, it
 * is a pull-down: the button is the everyday quick refresh; the deep archive rebuild — minutes,
 * not seconds — lives in the menu, where a rare and heavy action belongs.
 */
function RefreshControl({
  served,
  refreshing,
  archiveRefreshing,
  onRefresh,
  onArchiveRefresh,
}: {
  served: boolean
  refreshing: boolean
  archiveRefreshing: boolean
  onRefresh: () => void
  onArchiveRefresh: () => void
}) {
  const busy = refreshing || archiveRefreshing
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  // The accent rides on `color` and the glyph uses currentColor: a var() inside an SVG fill
  // attribute is not honoured everywhere, but inherited colour is.
  const glyph = (
    <motion.span
      className="inline-flex"
      style={{ color: ACCENT }}
      animate={busy ? { rotate: 360 } : { rotate: 0 }}
      transition={busy ? { repeat: Infinity, duration: 0.9, ease: 'linear' } : { duration: 0.2 }}
    >
      <RefreshIcon size={12} color="currentColor" />
    </motion.span>
  )

  if (!served) {
    return (
      <ToolButton label="Reload the latest data dump from disk  (r)" onClick={onRefresh} disabled={busy} busy={busy}>
        {glyph}
      </ToolButton>
    )
  }

  return (
    <div ref={ref} className="relative">
      <ControlGroup>
        <ToolButton
          bare
          label="Refresh board"
          title="Refresh board — re-fetches only your active tickets (seconds). The Completed archive is untouched.  (r)"
          onClick={onRefresh}
          disabled={busy}
          busy={refreshing}
        >
          {glyph}
        </ToolButton>
        <ToolButton
          bare
          narrow
          label="More refresh options"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          pressed={open}
        >
          <ChevronDownIcon size={9} />
        </ToolButton>
      </ControlGroup>

      <Menu open={open} width={288}>
        <MenuItem
          icon={
            <span className="inline-flex" style={{ color: ACCENT }}>
              <RefreshIcon size={11} color="currentColor" />
            </span>
          }
          label="Refresh board"
          hint="Active tickets only · seconds"
          kbd="r"
          disabled={busy}
          onClick={() => {
            close()
            onRefresh()
          }}
        />
        <MenuItem
          icon={<TrophyIcon size={11} />}
          label="Rebuild Completed archive"
          hint="Every closed ticket, its pull requests and branches · minutes"
          disabled={busy}
          onClick={() => {
            close()
            onArchiveRefresh()
          }}
        />
      </Menu>
    </div>
  )
}

/** Sun ↔ moon cross-fade with a small turn — the one flourish the utility group allows itself. */
function ThemeGlyph({ dark }: { dark: boolean }) {
  return (
    <span className="relative grid h-5 w-5 place-items-center">
      <AnimatePresence initial={false}>
        <motion.span
          key={dark ? 'moon' : 'sun'}
          className="absolute inset-0 grid place-items-center"
          initial={{ opacity: 0, rotate: -45, scale: 0.7 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 45, scale: 0.7 }}
          transition={{ duration: 0.18 }}
        >
          {dark ? <MoonIcon size={12} color="currentColor" /> : <SunIcon size={12} color="currentColor" />}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

// ── Header ──────────────────────────────────────────────────────────────────

/**
 * One 52px toolbar in three regions: identity on the left, the activity viewer in the centre,
 * actions on the right. Everything is 32px tall on an 8px grid; nothing wraps to a second line.
 */
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
  reports,
  onOpenSettings,
}: {
  data: JiraData
  now: number
  query: string
  setQuery: (v: string) => void
  dark: boolean
  toggleTheme: () => void
  refreshing: boolean
  archiveRefreshing: boolean
  /** Live done/total from the running fetch — drives the activity viewer. */
  runProgress?: RunProgress | null
  served: boolean
  onRefresh: () => void
  onArchiveRefresh: () => void
  /** Bulk PR Readiness Report controls — grouped so the header keeps one prop, not five. */
  reports?: ReportsMenuProps
  onOpenSettings?: () => void
}) {
  const fr = freshness(data.generatedAt, now)
  const name = data.user?.name?.split(',')[1]?.trim() || data.user?.name || ''
  // Headline sprint: the active one on the board's tickets (else the next future one).
  const sprint = currentSprint(data.tickets)
  const sp = sprint ? sprintStatus(sprint, now) : null
  const job: Job = refreshing ? 'daily' : archiveRefreshing ? 'archive' : null
  const updated = updatedLabel(data.generatedAt, fr)

  const sprintTitle = sprint
    ? sprint.start && sprint.end
      ? `Sprint ${sprint.name}: ${fmtDate(sprint.start)} → ${fmtDate(sprint.end)} — ${sp?.label ?? ''} (working days, Mon–Fri).`
      : `Sprint ${sprint.name}${sp ? ` — ${sp.label}` : ''}.`
    : 'No active or upcoming sprint on the board.'
  const dataTitle = data.generatedAt ? `Board data as of ${fr.full} (last intern run) — ${fr.label}.` : 'The intern has not produced a dump yet.'

  return (
    <header className="sticky top-0 z-30 -mx-4 mb-3 border-b border-[var(--line)] bg-[var(--bg)]/80 px-4 py-2.5 backdrop-blur-xl md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        {/* Identity — the one brand mark, then the name in solid ink. */}
        <div className="flex min-w-0 items-center gap-2.5 justify-self-start">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
            style={{ background: 'linear-gradient(135deg, #6d5bd0, #3b82f6)', boxShadow: '0 1px 2px rgba(16,24,40,0.14)' }}
          >
            <TicketGlyph size={13} />
          </span>
          <h1
            className="hidden truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)] sm:block"
            title={`${name ? `${name}’s board` : 'Your board'} · ${dataTitle}`}
          >
            My Jira Board
          </h1>
        </div>

        <ActivityViewer sprint={sprint} sp={sp} fr={fr} updated={updated} job={job} progress={runProgress} title={`${sprintTitle}\n${dataTitle}`} />

        {/* Actions — search, the primary action, reports, then the utility group. */}
        <div className="flex items-center gap-2 justify-self-end">
          <SearchField query={query} setQuery={setQuery} />

          <RefreshControl served={served} refreshing={refreshing} archiveRefreshing={archiveRefreshing} onRefresh={onRefresh} onArchiveRefresh={onArchiveRefresh} />

          {reports && <ReportsMenu {...reports} />}

          <ControlGroup>
            {onOpenSettings && (
              <ToolButton bare label="Settings — appearance, features, AI usage" onClick={onOpenSettings}>
                <GearIcon size={12} />
              </ToolButton>
            )}
            {/* An <a>, not a fetch/route, so it still works when the server is down (file:// falls
                back to the sibling docs/ folder). */}
            <ToolLink bare href={guideUrl()} label="Setup & deployment guide — requirements, install steps for Windows/macOS/Linux, git & Docker commands, troubleshooting">
              <QuestionIcon size={12} />
            </ToolLink>
            <ToolButton bare label={dark ? 'Switch to light appearance' : 'Switch to dark appearance'} onClick={toggleTheme}>
              <ThemeGlyph dark={dark} />
            </ToolButton>
          </ControlGroup>
        </div>
      </div>
    </header>
  )
}
