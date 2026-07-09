import { motion } from 'motion/react'
import type { JiraData } from '../types'
import { currentSprint, fmtDate, freshness, hexToRgba, sprintStatus } from '../lib/format'
import { CalendarIcon, RefreshIcon, SearchIcon, SunIcon, MoonIcon, TicketGlyph } from './Icons'

export function Header({
  data,
  now,
  query,
  setQuery,
  dark,
  toggleTheme,
  refreshing,
  served,
  onRefresh,
}: {
  data: JiraData
  now: number
  query: string
  setQuery: (v: string) => void
  dark: boolean
  toggleTheme: () => void
  refreshing: boolean
  served: boolean
  onRefresh: () => void
}) {
  const fr = freshness(data.generatedAt, now)
  const name = data.user?.name?.split(',')[1]?.trim() || data.user?.name || 'you'
  // Headline sprint: the active one on the board's tickets (else the next future one).
  const sprint = currentSprint(data.tickets)
  const sp = sprint ? sprintStatus(sprint, now) : null
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

              {/* Current sprint: name, start → end, days left, elapsed progress. */}
              {sprint && sp && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px]"
                  style={{ borderColor: hexToRgba(sp.color, 0.45), background: hexToRgba(sp.color, 0.1) }}
                  title={
                    sprint.start && sprint.end
                      ? `Sprint ${sprint.name}: ${fmtDate(sprint.start)} → ${fmtDate(sprint.end)} (${sp.label})`
                      : `Sprint ${sprint.name} (${sp.label})`
                  }
                >
                  <CalendarIcon size={11} color={sp.color} />
                  <b className="text-[var(--ink-soft)]">{sprint.name}</b>
                  {sprint.start && sprint.end && (
                    <span className="hidden text-[var(--muted)] sm:inline">
                      {fmtDate(sprint.start)} → {fmtDate(sprint.end)}
                    </span>
                  )}
                  {sp.pct != null && (
                    <span className="relative hidden h-1 w-10 overflow-hidden rounded-full sm:inline-block" style={{ background: hexToRgba(sp.color, 0.2) }}>
                      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(sp.pct * 100)}%`, background: sp.color }} />
                    </span>
                  )}
                  <b style={{ color: sp.color }}>{sp.label}</b>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
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

          <motion.button
            whileHover={{ scale: 1.04, y: -1 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={served ? 'Run the intern and reload' : 'Reload latest data'}
            title={served ? 'Run the intern & reload  (r)' : 'Reload latest data  (r)'}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-bold text-white shadow-[0_6px_18px_-6px_rgba(38,132,255,0.6)] transition-[filter] hover:brightness-110 disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #6d5bd0, #2684ff)' }}
          >
            <motion.span
              className="inline-flex"
              animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
              transition={refreshing ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { type: 'spring', stiffness: 300, damping: 20 }}
            >
              <RefreshIcon size={15} color="#fff" />
            </motion.span>
            <span className="hidden sm:inline">{refreshing ? 'Refreshing…' : served ? 'Refresh' : 'Reload'}</span>
          </motion.button>

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
