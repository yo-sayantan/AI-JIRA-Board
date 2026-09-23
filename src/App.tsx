import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { loadData, loadArchivedKeys, persistArchivedKeys } from './data'
import { completedToTicket, type ColumnKey, type Ticket } from './types'
import { isServed, getInternStatus, getServerSettings, startInternRun, startArchiveRun, startTicketRefresh, RUN_COMMAND, getReportsIndex, getReport, startReportGeneration, startBulkReportGeneration, saveServerSettings, type PrReportsIndex, type ReportScope, type AiInternStatus } from './lib/runner'
import type { PrReport } from './lib/reportTypes'
import { PrReportOverlay } from './components/PrReport'
import { Header } from './components/Header'
import { Stats, type StatSelection } from './components/Stats'
import { Board } from './components/Board'
import { OnHold } from './components/OnHold'
import { NextSprint } from './components/NextSprint'
import { CompletedOverlay } from './components/Completed'
import { TicketDetail } from './components/TicketDetail'
import { EmptyState } from './components/EmptyState'
import { FunEmptyBoard } from './components/FunEmptyBoard'
import { Toasts, type ToastItem } from './components/Toast'
import { NoticesDock } from './components/NoticesDock'
import { StaleBanner } from './components/StaleBanner'
import { Footer } from './components/Footer'
import { EyeOffIcon } from './components/Icons'
import { freshness, isNextSprint, prListOf } from './lib/format'
import { applySettings, loadSettings, resolveDark, saveSettings, type Settings } from './lib/settings'
import { SettingsPanel } from './components/Settings'
import { matches, parseQuery } from './lib/search'

/** Flatten tickets + their nested sub-tasks into a key→ticket map (recursive). */
function indexTickets(list: Ticket[] | undefined, map: Map<string, Ticket>) {
  for (const t of list ?? []) {
    if (!map.has(t.key)) map.set(t.key, t)
    if (t.subtasks?.length) indexTickets(t.subtasks, map)
  }
}

export default function App() {
  // Keys the user manually moved to Completed (trophy button). Persisted; feeding the set
  // into loadData means archiving re-prepares the data instantly — the card leaves the
  // board and appears in the archive in the same render.
  const [archived, setArchived] = useState<Set<string>>(() => loadArchivedKeys())
  const { data, source, userArchived } = useMemo(() => loadData(archived), [archived])
  const [now] = useState(() => Date.now())
  const [served] = useState(() => isServed())
  const [query, setQuery] = useState('')
  // One selection drives the whole top chip row (see StatSelection). A column key filters the
  // board; 'next' reveals the Next Sprint bar; 'all' reveals everything expanded; null is the
  // default. Because it's a single value, choosing any chip clears the rest — which is exactly
  // what hides the Next Sprint bar the moment another tab is picked.
  const [sel, setSel] = useState<StatSelection>(null)
  const focus: ColumnKey | null = sel === 'next' || sel === 'all' ? null : sel
  const nextSprintVisible = sel === 'next' || sel === 'all'
  // Picking the Next Sprint chip reveals its icon at the very bottom; nudge it into view so the
  // click has a visible result on a tall board. 'nearest' won't yank the page if it's already shown.
  useEffect(() => {
    if (sel !== 'next') return
    const id = requestAnimationFrame(() =>
      document.getElementById('jb-next-sprint')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    )
    return () => cancelAnimationFrame(id)
  }, [sel])
  // Navigation stack of ticket keys. Opening from the board resets it; opening a
  // sub-task pushes another drawer on top (each level is its own stacked drawer).
  const [stack, setStack] = useState<string[]>([])
  const anyDrawer = stack.length > 0
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [serverSettingsReady, setServerSettingsReady] = useState(!served)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [archiveRefreshing, setArchiveRefreshing] = useState(false)
  const [runProgress, setRunProgress] = useState<{ done: number; total: number; pct: number; current?: string | null; phase?: string } | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [refreshingKeys, setRefreshingKeys] = useState<Set<string>>(new Set())
  const [completedOpen, setCompletedOpen] = useState(false)
  // PR Readiness Reports: header index (served: /api/reports; file://: window.__JIRA_PR_REPORTS__),
  // the keys being generated right now (server queue ∪ cron/terminal runs), and the open overlay.
  const [reportsIndex, setReportsIndex] = useState<PrReportsIndex | null>(null)
  const [reportsGenerating, setReportsGenerating] = useState<Set<string>>(new Set())
  const [openReport, setOpenReport] = useState<PrReport | null>(null)
  const [reportLoadingKey, setReportLoadingKey] = useState<string | null>(null)
  const [aiStatus, setAiStatus] = useState<AiInternStatus | null>(null)

  // Stable handlers so the panel/overlay effects mount once (no churn).
  // openTicket = fresh open (from the board/on-hold/completed); pushTicket = drill
  // into a sub-task (keeps history for Back); goBack = pop; closeTicket = clear.
  const openTicket = useCallback((key: string) => setStack([key]), [])
  const pushTicket = useCallback((key: string) => setStack((s) => (s[s.length - 1] === key ? s : [...s, key])), [])
  const goBack = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const closeTicket = useCallback(() => setStack([]), [])
  const closeCompleted = useCallback(() => setCompletedOpen(false), [])

  const refreshingRef = useRef(false)
  refreshingRef.current = refreshing
  const archiveRefreshingRef = useRef(false)
  archiveRefreshingRef.current = archiveRefreshing
  const refreshingKeysRef = useRef(refreshingKeys)
  refreshingKeysRef.current = refreshingKeys
  const toastId = useRef(0)

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (msg: string, kind: ToastItem['kind'] = 'info', ttl = 2800) => {
      const id = ++toastId.current
      setToasts((t) => [...t, { id, msg, kind }])
      if (ttl) setTimeout(() => dismiss(id), ttl)
      return id
    },
    [dismiss],
  )

  // ── PR Readiness Reports ────────────────────────────────────────────────────
  const reportsGeneratingRef = useRef(reportsGenerating)
  reportsGeneratingRef.current = reportsGenerating
  const openReportRef = useRef<PrReport | null>(null)
  openReportRef.current = openReport

  // Re-read the index and announce transitions — including generations started by the cron/auto
  // pass, not just ones clicked here — so "report in progress" is visible however it was triggered.
  const refreshReportsIndex = useCallback(async () => {
    const idx = await getReportsIndex()
    if (!idx) return null
    setReportsIndex(idx)
    const next = new Set(idx.generating ?? [])
    const prev = reportsGeneratingRef.current
    for (const k of prev) {
      if (next.has(k)) continue
      if (idx.reports[k]) {
        toast(`PR readiness report ready for ${k}.`, 'success', 3500)
        // Refresh the overlay if it's showing the report that just got rebuilt.
        if (openReportRef.current?.key === k) void getReport(k).then((r) => r && setOpenReport(r))
      } else {
        toast(`Report generation for ${k} finished without a report — see jira-intern/logs/.`, 'error', 5000)
      }
    }
    for (const k of next) if (!prev.has(k)) toast(`Generating PR readiness report for ${k} in the background…`, 'loading', 3500)
    setReportsGenerating(next)
    return idx
  }, [toast])

  // Heartbeat: load once; in served mode poll (cheap: a directory read) so background/cron
  // generations surface without a reload. Faster while something is in flight.
  useEffect(() => {
    if (!settings.features.prReports) return
    void refreshReportsIndex()
    if (!served || !settings.features.autoRefresh) return
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      await refreshReportsIndex()
      timer = setTimeout(tick, reportsGeneratingRef.current.size > 0 ? 4000 : 15000)
    }
    timer = setTimeout(tick, 4000)
    return () => clearTimeout(timer)
  }, [served, refreshReportsIndex, settings.features.prReports, settings.features.autoRefresh])

  useEffect(() => {
    if (!served) return
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      const s = await getInternStatus()
      if (s?.ai) setAiStatus(s.ai)
      timer = setTimeout(tick, s?.ai?.state === 'working' || s?.ai?.state === 'pulling' ? 3000 : 12000)
    }
    void tick()
    return () => clearTimeout(timer)
  }, [served])

  const handleOpenReport = useCallback(
    async (key: string) => {
      setReportLoadingKey(key)
      const r = await getReport(key)
      setReportLoadingKey(null)
      if (!r) {
        toast(`No PR readiness report for ${key} yet.`, 'info', 2500)
        return
      }
      setOpenReport(r)
    },
    [toast],
  )

  const handleGenerateReport = useCallback(
    async (key: string) => {
      if (!served) {
        toast(`Report generation needs the server or Docker — run: bash jira-intern/local-runner/pr-report.sh ${key}`, 'info', 6000)
        return
      }
      const start = await startReportGeneration(key)
      if (!start?.ok) {
        toast(`Couldn't start the report for ${key} — is the server running?`, 'error', 4000)
        return
      }
      setReportsGenerating((s) => new Set(s).add(key))
      toast(start.already ? `${key} report is already being generated.` : `Generating PR readiness report for ${key} — running in the background.`, 'loading', 3200)
      // The heartbeat picks up completion (and announces it); nothing else to do here.
    },
    [served, toast],
  )

  const handleBulkReports = useCallback(
    async (target: ReportScope, force: boolean) => {
      if (!served) {
        toast('Bulk generation needs the server or Docker — run: bash jira-intern/local-runner/pr-reports-backfill.sh --all-years', 'info', 6000)
        return
      }
      const start = await startBulkReportGeneration(target, force)
      if (!start?.ok) {
        toast("Couldn't start the report run — is the server running?", 'error', 4000)
        return
      }
      if (start.queuedKeys.length === 0) {
        toast(
          start.matched === 0
            ? 'No tickets with a pull request matched that scope.'
            : 'Every matching report is already current or queued — tick "Force rebuild" to redo them.',
          'info',
          5000,
        )
        return
      }
      setReportsGenerating((s) => {
        const next = new Set(s)
        for (const k of start.queuedKeys) next.add(k)
        return next
      })
      toast(
        `Queued ${start.queuedKeys.length} PR readiness report${start.queuedKeys.length === 1 ? '' : 's'} — they generate one at a time in the background.`,
        'loading',
        4500,
      )
    },
    [served, toast],
  )

  // Move a Done ticket to the Completed archive NOW, instead of waiting out the
  // DONE_BOARD_DAYS window. Persisted locally; undoable via the strip under the board.
  const archiveTicket = useCallback(
    (key: string) => {
      setArchived((prev) => {
        const next = new Set(prev)
        next.add(key)
        persistArchivedKeys(next)
        return next
      })
      toast(`${key} moved to Completed`, 'success')
    },
    [toast],
  )
  // From the detail drawer: archive, then close the drawer (the card it belonged to is gone).
  const archiveAndClose = useCallback(
    (key: string) => {
      archiveTicket(key)
      closeTicket()
    },
    [archiveTicket, closeTicket],
  )
  const restoreArchived = useCallback(() => {
    setArchived(() => {
      persistArchivedKeys(new Set())
      return new Set<string>()
    })
  }, [])

  // Settings own the theme now. Applying them is the single place <html> gets its classes, so the
  // header toggle and the settings panel can't disagree about what's on screen.
  useEffect(() => {
    applySettings(settings)
    setDark(resolveDark(settings))
    saveSettings(settings)
  }, [settings])

  // In schedule mode the right theme changes with the clock, so re-evaluate on the minute tick.
  useEffect(() => {
    if (settings.themeMode !== 'schedule') return
    applySettings(settings)
    setDark(resolveDark(settings))
  }, [now, settings])

  // In served mode, machine-wide AI choices survive browser/localStorage changes.
  useEffect(() => {
    if (!served) return
    void getServerSettings().then((saved) => {
      if (saved) {
        setSettings((current) => ({
          ...current,
          aiLevel: (saved.aiLevel as Settings['aiLevel']) ?? current.aiLevel,
          aiBackend: (saved.aiBackend as Settings['aiBackend']) ?? current.aiBackend,
          aiLocalModel: (saved.aiLocalModel as string) ?? current.aiLocalModel,
          aiCloudModel: (saved.aiCloudModel as string) ?? current.aiCloudModel,
          aiCloudProvider: (saved.aiCloudProvider as Settings['aiCloudProvider']) ?? current.aiCloudProvider,
          aiCloudEffort: (saved.aiCloudEffort as Settings['aiCloudEffort']) ?? current.aiCloudEffort,
          aiUseHostOllama: (saved.aiUseHostOllama as boolean) ?? current.aiUseHostOllama,
        }))
      }
      setServerSettingsReady(true)
    })
  }, [served])

  // Mirror saved intern-facing settings to the server so JIRA-AI-Intern jobs honour them.
  useEffect(() => {
    if (!served || !serverSettingsReady) return
    void saveServerSettings({
      aiLevel: settings.aiLevel,
      aiBackend: settings.aiBackend,
      aiLocalModel: settings.aiLocalModel,
      aiCloudModel: settings.aiCloudModel,
      aiCloudProvider: settings.aiCloudProvider,
      aiCloudEffort: settings.aiCloudEffort,
      aiUseHostOllama: settings.aiUseHostOllama,
    })
  }, [served, serverSettingsReady, settings.aiLevel, settings.aiBackend, settings.aiLocalModel, settings.aiCloudModel, settings.aiCloudProvider, settings.aiCloudEffort, settings.aiUseHostOllama])

  // The header's sun/moon flips the theme directly; doing so pins it, since "auto" or a schedule
  // would otherwise override the click on the next evaluation.
  const toggleTheme = () => {
    setSettings((s) => ({ ...s, themeMode: 'fixed', theme: resolveDark(s) ? 'light' : 'dark' }))
  }

  // Poll the server until the in-flight intern run finishes, then reload to show fresh data.
  // `runAtWhenStarted` is lastRunAt captured AFTER a successful start (or when attaching to a
  // 409). Completion requires that stamp to change again via lastExit from THIS run — not a
  // stale lastExit from a previous failure.
  const watchRun = useCallback(
    (
      before: number | null,
      loadingId: number,
      opts?: { ceilingMs?: number; onDone?: () => void; runAtWhenStarted?: string | null },
    ) => {
      const startTs = Date.now()
      const runAtWhenStarted = opts?.runAtWhenStarted ?? null
      // Ceiling must exceed the runner's own timeout, or the board gives up on a
      // still-legitimately-running intern and reloads stale/partial data.
      const ceiling = opts?.ceilingMs ?? 32 * 60 * 1000
      let sawRunning = false
      const poll = async () => {
        const s = await getInternStatus()
        if (s?.running) sawRunning = true
        // Live ticket-count progress → fill the refresh button left→right.
        const p = s?.progress
        if (p && typeof p.total === 'number' && p.total > 0) {
          setRunProgress({
            done: Number(p.done) || 0,
            total: p.total,
            pct: typeof p.pct === 'number' ? p.pct : Math.round((100 * (Number(p.done) || 0)) / p.total),
            current: p.current ?? null,
            phase: p.phase,
          })
        } else if (s?.running) {
          // Early phase (searching / no total yet) — keep a soft indeterminate feel via 0%.
          setRunProgress((prev) => prev ?? { done: 0, total: 0, pct: 0, phase: p?.phase || 'starting' })
        }
        const timedOut = Date.now() - startTs > ceiling
        // Only treat as done once we've observed the run (or waited briefly) and it stopped.
        // Require lastRunAt to match what we started with (same job), so a stale lastExit from
        // an older failure doesn't fire an error toast the moment we attach.
        const sameJob = !runAtWhenStarted || s?.lastRunAt === runAtWhenStarted
        const done =
          s &&
          !s.running &&
          sawRunning &&
          sameJob &&
          (s.dataModified !== before || s.lastExit != null)
        if (done || timedOut) {
          dismiss(loadingId)
          setRunProgress(null)
          opts?.onDone?.()
          // On a non-zero exit, DON'T reload — nothing fresh landed and the reload would wipe
          // this error toast before it can be read. Let the user see it and check logs/.
          if (done && s?.lastExit != null && s.lastExit !== 0) {
            const msg =
              s.lastExit === 3
                ? 'Skipped — another refresh/archive was already running. Try again in a moment.'
                : s.lastExit === 127
                  ? 'Intern finished with errors (tooling missing) — check logs/.'
                  : 'Intern finished with errors — check logs/.'
            toast(msg, 'error', 6000)
            return
          }
          if (timedOut) {
            toast('Intern is taking unusually long — reload manually when it finishes.', 'info', 5000)
            return
          }
          toast('Fresh data in — reloading.', 'success', 1500)
          setTimeout(() => location.reload(), 600)
          return
        }
        // Status blip (null) — keep polling; don't claim success/failure.
        setTimeout(poll, 800)
      }
      setTimeout(poll, 400)
    },
    [toast, dismiss],
  )

  /** Start a job; on 409 attach to the in-flight run; retry once if the lock just cleared. */
  const beginOrWatch = useCallback(
    async (
      start: () => Promise<{ ok: boolean; status: number }>,
      before: number | null,
      loading: number,
      opts: { onDone: () => void; ceilingMs?: number; alreadyMsg: string; failMsg: string },
    ) => {
      let result = await start()
      if (!result.ok && result.status === 409) {
        const s = await getInternStatus()
        if (s?.running) {
          toast(opts.alreadyMsg, 'info')
          watchRun(before, loading, {
            onDone: opts.onDone,
            ceilingMs: opts.ceilingMs,
            runAtWhenStarted: s.lastRunAt,
          })
          return
        }
        // Race: lock released between 409 and status check — retry start once.
        await new Promise((r) => setTimeout(r, 350))
        result = await start()
      }
      if (!result.ok) {
        const s = await getInternStatus()
        if (s?.running) {
          toast(opts.alreadyMsg, 'info')
          watchRun(before, loading, {
            onDone: opts.onDone,
            ceilingMs: opts.ceilingMs,
            runAtWhenStarted: s.lastRunAt,
          })
          return
        }
        dismiss(loading)
        opts.onDone()
        toast(opts.failMsg, 'error')
        return
      }
      const s = await getInternStatus()
      watchRun(before, loading, {
        onDone: opts.onDone,
        ceilingMs: opts.ceilingMs,
        runAtWhenStarted: s?.lastRunAt ?? null,
      })
    },
    [toast, dismiss, watchRun],
  )

  const handleRefresh = useCallback(async () => {
    if (refreshingRef.current) return

    // file:// can't run a shell script — just reload to pick up whatever the intern last dumped.
    if (!isServed()) {
      toast('Reloading the latest dump…', 'loading', 900)
      setTimeout(() => location.reload(), 350)
      return
    }

    // served mode: run the intern live, then reload when fresh data lands.
    setRefreshing(true)
    const loading = toast('Refreshing the board — re-fetching your active tickets…', 'loading', 0)
    const onDone = () => setRefreshing(false)
    const before = (await getInternStatus())?.dataModified ?? null
    await beginOrWatch(startInternRun, before, loading, {
      onDone,
      alreadyMsg: 'Intern already running — watching it.',
      failMsg: 'Could not start the intern run.',
    })
  }, [toast, beginOrWatch])

  // The DEEP job: rebuild the Completed archive (every closed ticket + PRs/branches). Slow by design.
  const handleArchiveRefresh = useCallback(async () => {
    if (refreshingRef.current || archiveRefreshingRef.current) return
    if (!isServed()) {
      toast('The archive rebuild needs the local server — run `npm run serve`.', 'info', 4500)
      return
    }
    setArchiveRefreshing(true)
    const loading = toast('Rebuilding the Completed archive — the deep scan takes a while…', 'loading', 0)
    const onDone = () => setArchiveRefreshing(false)
    const before = (await getInternStatus())?.dataModified ?? null
    await beginOrWatch(startArchiveRun, before, loading, {
      onDone,
      ceilingMs: 130 * 60 * 1000,
      alreadyMsg: 'Another intern job is running — watching it.',
      failMsg: 'Could not start the archive rebuild.',
    })
  }, [toast, beginOrWatch])

  // Per-ticket background refresh — queue-aware. Several clicks enqueue FIFO on the
  // server; each key is watched until IT leaves the pending set (not until data.json
  // mtime bumps — another ticket finishing must not steal this watcher's completion).
  const handleRefreshTicket = useCallback(
    async (key: string) => {
      if (!isServed()) {
        toast('Single-ticket refresh needs the local server — run `npm run serve`.', 'info', 4500)
        return
      }
      // Already watching this key locally — don't stack toasts / pollers.
      if (refreshingKeysRef.current.has(key)) {
        toast(`${key} is already queued.`, 'info', 1800)
        return
      }
      setRefreshingKeys((prev) => new Set(prev).add(key))
      const tid = toast(`Fetching latest status for ${key}…`, 'loading', 0)
      const clear = (msg?: string, kind: ToastItem['kind'] = 'info', reload = false) => {
        dismiss(tid)
        setRefreshingKeys((prev) => {
          const n = new Set(prev)
          n.delete(key)
          return n
        })
        if (msg) toast(msg, kind, kind === 'error' ? 4000 : 1800)
        // Reload only when the whole queue is drained — mid-queue reloads abort other watches.
        if (reload) setTimeout(() => location.reload(), 500)
      }

      const start = await startTicketRefresh(key)
      if (!start?.ok) {
        clear(`Couldn't start refresh for ${key}.`, 'error')
        return
      }
      if (start.already) {
        toast(`${key} is already in the refresh queue.`, 'info', 2000)
      } else if ((start.position ?? 0) > 0) {
        toast(`${key} queued (#${(start.position ?? 0) + 1}) — will run next.`, 'info', 2200)
      }

      let sawPending = true // POST put us on the server pending list synchronously
      let nullStreak = 0
      const startTs = Date.now()
      // Ceiling scales with queue depth so waiting behind others isn't a false timeout.
      const ceilingMs = 11 * 60 * 1000 + Math.max(0, start.position ?? 0) * 5 * 60 * 1000
      const poll = async () => {
        const s = await getInternStatus()
        if (!s) {
          if (++nullStreak >= 4) {
            clear('Lost contact with the local server.', 'error')
            return
          }
          setTimeout(poll, 1500)
          return
        }
        nullStreak = 0
        const pending = s.refreshingKeys ?? []
        const stillPending = pending.includes(key)
        if (stillPending) sawPending = true
        const exitCode = s.refreshExits?.[key]
        const finished = sawPending && !stillPending && typeof exitCode === 'number'
        const timedOut = Date.now() - startTs > ceilingMs
        if (finished || timedOut) {
          const failed = typeof exitCode === 'number' && exitCode !== 0
          const othersLeft = pending.some((k) => k !== key)
          if (failed) clear(`${key} refresh failed (exit ${exitCode}).`, 'error')
          else if (timedOut) clear(`${key} refresh timed out.`, 'error')
          else if (exitCode === 0) {
            // Success: reload only if nothing else is still queued (avoids stomping siblings).
            clear(
              othersLeft ? `${key} updated — more refreshes still running.` : `${key} updated — reloading.`,
              'success',
              !othersLeft,
            )
          } else clear(`${key} is already up to date.`, 'info')
          return
        }
        setTimeout(poll, 1500)
      }
      setTimeout(poll, 1000)
    },
    [toast, dismiss],
  )

  // On load (served mode): if the intern is already running — e.g. you refreshed the page mid-run,
  // or launched it from a terminal — reattach to it instead of looking idle.
  const resumedRef = useRef(false)
  useEffect(() => {
    if (!served || resumedRef.current) return
    resumedRef.current = true
    void (async () => {
      const s = await getInternStatus()
      if (s?.running) {
        setRefreshing(true)
        const id = toast('JIRA Intern Agent is running… the board will reload when it finishes.', 'loading', 0)
        watchRun(s.dataModified ?? null, id, {
          onDone: () => setRefreshing(false),
          runAtWhenStarted: s.lastRunAt,
          ceilingMs: s.job === 'archive' ? 130 * 60 * 1000 : undefined,
        })
      }
    })()
  }, [served, toast, watchRun])

  // keyboard: "/" focus search, "r" refresh
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      // Don't hijack "/" or "r" while a drawer/archive overlay is open — pressing "r"
      // would reload the page (file://) and blow the open drawer stack away.
      if (anyDrawer || completedOpen || !settings.features.shortcuts) return
      if (e.key === '/' && !typing) {
        e.preventDefault()
        document.getElementById('jb-search')?.focus()
      } else if ((e.key === 'r' || e.key === 'R') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        handleRefresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleRefresh, anyDrawer, completedOpen, settings.features.shortcuts])

  const terms = useMemo(() => parseQuery(query), [query])
  const filtered = useMemo(() => data.tickets.filter((t) => matches(t, terms)), [data.tickets, terms])
  // Three destinations, mutually exclusive: the kanban row, the On Hold section, and the
  // Next Sprint section (To Do tickets whose sprint hasn't started — see isNextSprint).
  // User-archived tickets were already retired to completed[] inside loadData.
  const nextSprintTickets = filtered.filter((t) => isNextSprint(t, now))
  const holdTickets = filtered.filter((t) => t.column === 'hold')
  const boardTickets = filtered.filter((t) => t.column !== 'hold' && !isNextSprint(t, now))
  // "Nothing on the board" must ignore next-sprint work too — otherwise finishing the
  // sprint never earns the celebration, because next sprint's queue is always sitting there.
  const hasAnyActive = useMemo(
    () => data.tickets.some((t) => t.column !== 'hold' && !isNextSprint(t, now)),
    [data.tickets, now],
  )
  const myCompletedCount = useMemo(() => data.completed.filter((c) => c.mine !== false).length, [data.completed])

  // Tickets a report can be built for. Mirrors pr_report.py's iter_tickets — active tickets,
  // their sub-tasks that carry their own PR, and the completed archive — so the count the menu
  // shows matches the number of reports a bulk run would actually produce.
  const ticketsWithPrCount = useMemo(() => {
    const keys = new Set<string>()
    for (const t of data.tickets) {
      if (prListOf(t).length > 0) keys.add(t.key)
      for (const s of t.subtasks ?? []) if (s.key && prListOf(s).length > 0) keys.add(s.key)
    }
    for (const c of data.completed) if (prListOf(c).length > 0) keys.add(c.key)
    return keys.size
  }, [data.tickets, data.completed])
  const fr = freshness(data.generatedAt, now)

  // Index every ticket — top-level, completed parents, and all nested sub-tasks — so clicking
  // any sub-task opens its own detail page. Standalone rows are indexed BEFORE nested ones:
  // the archive holds a sub-ticket twice (its own full row, and a compact copy under its
  // master), and opening it must land on the full row.
  const byKey = useMemo(() => {
    const m = new Map<string, Ticket>()
    const nested: Ticket[] = []
    const top = [...data.tickets, ...data.completed.map(completedToTicket)]
    for (const t of top) {
      if (!m.has(t.key)) m.set(t.key, t)
      if (t.subtasks?.length) nested.push(...t.subtasks)
    }
    indexTickets(nested, m)
    return m
  }, [data])

  // Self-heal: drop any stack entry whose ticket can't be resolved (stale key after a
  // data swap) so a drawer never gets stuck and the stack never renders a gap.
  useEffect(() => {
    setStack((s) => {
      const next = s.filter((k) => byKey.has(k))
      return next.length === s.length ? s : next
    })
  }, [byKey])

  // (Archived-key pruning happens once in loadArchivedKeys(), against the raw dump.)

  // Esc pops the top drawer (only while a drawer is open).
  useEffect(() => {
    if (!anyDrawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStack((s) => s.slice(0, -1))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [anyDrawer])

  // SINGLE owner of the body scroll-lock across every overlay (drawer stack + archive),
  // so two effects never fight over document.body.style.overflow (last-writer-wins bug).
  const lockScroll = anyDrawer || completedOpen
  useEffect(() => {
    if (!lockScroll) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [lockScroll])

  if (source === 'empty') {
    return (
      <div className="w-full px-4 pb-24 md:px-6 lg:px-8">
        <EmptyState served={served} refreshing={refreshing} onRefresh={handleRefresh} runCommand={RUN_COMMAND} />
        <Footer />
        <Toasts toasts={toasts} />
      </div>
    )
  }

  return (
    <div className="w-full px-4 pb-24 md:px-6 lg:px-8">
      <Header
        data={data}
        now={now}
        query={query}
        setQuery={setQuery}
        dark={dark}
        toggleTheme={toggleTheme}
        refreshing={refreshing}
        archiveRefreshing={archiveRefreshing}
        runProgress={runProgress}
        served={served}
        onRefresh={handleRefresh}
        onArchiveRefresh={handleArchiveRefresh}
        onOpenSettings={() => {
          if (serverSettingsReady) setSettingsOpen(true)
          else toast('Loading saved settings…', 'loading', 1200)
        }}
        reports={
          settings.features.prReports
            ? {
                served,
                generating: reportsGenerating,
                withPrCount: ticketsWithPrCount,
                reportCount: Object.keys(reportsIndex?.reports ?? {}).length,
                onBulk: handleBulkReports,
                onOne: handleGenerateReport,
              }
            : undefined
        }
      />

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
        aiLevelSynced={served}
        aiStatus={aiStatus}
      />

      {fr.stale && <StaleBanner label={fr.label} served={served} refreshing={refreshing} onRefresh={handleRefresh} />}

      {/* Counts follow the current search so the chips always agree with what's on the board.
          The Completed chip counts MY tickets only — the archive also carries team-mates'
          sub-tickets for context, and it opens on the same "Mine" scope. */}
      <Stats
        tickets={filtered.filter((t) => !isNextSprint(t, now))}
        completedCount={settings.features.completedArchive ? myCompletedCount : null}
        nextSprintCount={settings.features.nextSprint ? nextSprintTickets.length : 0}
        active={sel}
        onSelect={setSel}
        onOpenCompleted={settings.features.completedArchive ? () => setCompletedOpen(true) : undefined}
      />

      {!hasAnyActive ? (
        <FunEmptyBoard served={served} refreshing={refreshing} onRefresh={handleRefresh} />
      ) : filtered.length === 0 ? (
        // Gate on `filtered`, not `boardTickets`: a search that only hits On Hold / Next Sprint
        // DID match something, and those sections render it right below — claiming "no tickets
        // match" there would contradict the screen.
        <div className="grid min-h-[34vh] place-items-center rounded-2xl border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] text-center">
          <div>
            <div className="mb-2 text-3xl">🔍</div>
            <p className="text-[14px] font-semibold text-[var(--ink)]">No tickets match “{query}”.</p>
            <button onClick={() => { setQuery(''); setSel(null) }} className="mt-2 text-[12.5px] text-[#8b9cff] hover:underline">
              Clear search
            </button>
          </div>
        </div>
      ) : (
        <Board tickets={boardTickets} now={now} onOpen={openTicket} focus={focus} onArchive={archiveTicket} onRefreshTicket={handleRefreshTicket} refreshingKeys={refreshingKeys} />
      )}

      {userArchived.length > 0 && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={restoreArchived}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-1 text-[11.5px] text-[var(--muted)] hover:text-[var(--ink)]"
            title={`You moved ${userArchived.join(', ')} to Completed — undo to bring ${userArchived.length === 1 ? 'it' : 'them'} back onto the board`}
          >
            <EyeOffIcon size={13} /> {userArchived.length} moved to Completed · Undo
          </button>
        </div>
      )}

      <OnHold tickets={holdTickets} now={now} onOpen={openTicket} />

      {/* Next sprint's queue — hidden until its top chip (or "All") is picked. 'all' opens it
          fully; 'next' reveals the minimal corner icon to expand on demand. */}
      {settings.features.nextSprint && (
        <NextSprint
          tickets={nextSprintTickets}
          now={now}
          onOpen={openTicket}
          visible={nextSprintVisible}
          forceOpen={sel === 'all'}
        />
      )}

      <Footer />

      {/* Shared backdrop behind the whole drawer stack; click it to dismiss everything. */}
      <AnimatePresence>
        {anyDrawer && (
          <motion.div
            key="jb-scrim"
            className="fixed inset-0 z-[46] bg-black/55 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeTicket}
          />
        )}
      </AnimatePresence>

      {/* One drawer per stack level — opening a sub-task layers a new drawer on top;
          closing (✕/Esc) reveals the one beneath. Works to any depth. */}
      <AnimatePresence>
        {stack.map((key, i) => {
          const t = byKey.get(key)
          return t ? (
            <TicketDetail
              key={`${i}:${key}`}
              ticket={t}
              now={now}
              depth={i}
              topDepth={stack.length - 1}
              onClose={goBack}
              onJumpTo={() => setStack((s) => s.slice(0, i + 1))}
              onOpen={pushTicket}
              // Offer "Move to Completed" only for a Done ticket that is still ON the board —
              // one opened from the archive is already there (and sub-tasks aren't archivable).
              onArchive={data.tickets.some((bt) => bt.key === key && bt.column === 'done') ? archiveAndClose : undefined}
              onRefreshTicket={handleRefreshTicket}
              refreshing={refreshingKeys.has(t.key)}
              user={data.user}
              report={settings.features.prReports ? (reportsIndex?.reports[t.key] ?? null) : null}
              reportsEnabled={settings.features.prReports}
              reportGenerating={reportsGenerating.has(t.key)}
              reportLoading={reportLoadingKey === t.key}
              onOpenReport={handleOpenReport}
              onGenerateReport={handleGenerateReport}
              served={served}
            />
          ) : null
        })}
      </AnimatePresence>

      <CompletedOverlay open={completedOpen} onClose={closeCompleted} items={data.completed} onOpen={openTicket} pauseEsc={anyDrawer} />

      {/* PR Readiness Report — sits above the drawer stack; Esc closes it first (capture listener). */}
      <PrReportOverlay
        report={openReport}
        onClose={() => setOpenReport(null)}
        onRegenerate={served ? handleGenerateReport : undefined}
        generating={openReport ? reportsGenerating.has(openReport.key) : false}
        internStatus={aiStatus}
      />

      <NoticesDock notes={data.notes ?? []} />
      <Toasts toasts={toasts} />
    </div>
  )
}
