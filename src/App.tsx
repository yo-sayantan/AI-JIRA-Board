import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ColumnKey } from './types'
import { RUN_COMMAND, aiModelLabel, enrichJobsRunning, isServed } from './lib/runner'
import { countMyCompleted, countRaised, countTicketsWithPr, hasActiveWork, indexByKey, splitBoard } from './lib/boardView'
import { parseQuery } from './lib/search'
import { useBoardData } from './hooks/useBoardData'
import { useBoardSettings } from './hooks/useBoardSettings'
import { useClock } from './hooks/useClock'
import { useDrawerStack } from './hooks/useDrawerStack'
import { useInternJobs } from './hooks/useInternJobs'
import { useInternStatus } from './hooks/useInternStatus'
import { useScrollLock, useShortcuts } from './hooks/usePageEffects'
import { useReports } from './hooks/useReports'
import { useToasts } from './hooks/useToasts'
import { Header } from './components/header/Header'
import type { ReportsMenuProps } from './components/header/ReportsMenu'
import { Stats, type StatSelection } from './components/board/Stats'
import { Board } from './components/board/Board'
import { ArchivedUndo, NoMatches } from './components/board/BoardNotices'
import { OnHold } from './components/board/OnHold'
import { NextSprint } from './components/board/NextSprint'
import { EmptyState } from './components/board/EmptyState'
import { FunEmptyBoard } from './components/board/FunEmptyBoard'
import { CompletedOverlay } from './components/completed/Completed'
import { RaisedOverlay } from './components/raised/Raised'
import { TicketDetail } from './components/ticket/TicketDetail'
import { PrReportOverlay } from './components/reports/PrReport'
import { SettingsPanel } from './components/settings/Settings'
import { Toasts } from './components/common/Toast'
import { NoticesDock } from './components/common/NoticesDock'
import { Footer } from './components/common/Footer'

const served = isServed()

export default function App() {
  const now = useClock()
  const { settings, setSettings, ready: settingsReady, dark, toggleTheme } = useBoardSettings(served, now)
  const { features } = settings
  const { toasts, toast, dismiss } = useToasts(settings.toastSeconds, settings.toastMax)
  const { data, source, userArchived, reload, archive, restoreArchived } = useBoardData(served)
  const jobs = useInternJobs({ served, toast, dismiss, reload })

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(false)
  const [raisedOpen, setRaisedOpen] = useState(false)
  const [query, setQuery] = useState('')
  // One selection drives the chip row: a column filters the board, 'next' reveals the Next Sprint
  // bar, 'all' reveals everything expanded. Picking any chip clears the others.
  const [sel, setSel] = useState<StatSelection>(null)
  const focus: ColumnKey | null = sel === 'next' || sel === 'all' ? null : sel

  const status = useInternStatus(served, features.autoRefresh || settingsOpen || jobs.running != null)
  const ai = status?.ai ?? null
  const reports = useReports({ served, enabled: features.prReports, status, toast })

  const byKey = useMemo(() => indexByKey(data), [data])
  const drawers = useDrawerStack(byKey)
  useScrollLock(drawers.open || completedOpen || raisedOpen)
  useShortcuts(features.shortcuts && !drawers.open && !completedOpen && !raisedOpen, jobs.refreshBoard)

  const terms = useMemo(() => parseQuery(query), [query])
  const view = useMemo(() => splitBoard(data.tickets, terms, now, features.onHold), [data.tickets, terms, now, features.onHold])
  const hasAnyActive = useMemo(() => hasActiveWork(data.tickets, now, features.onHold), [data.tickets, now, features.onHold])
  const myCompletedCount = useMemo(() => countMyCompleted(data), [data])
  const raisedCount = useMemo(() => countRaised(data), [data])
  const ticketsWithPr = useMemo(() => countTicketsWithPr(data), [data])
  const doneOnBoard = useMemo(() => new Set(data.tickets.filter((t) => t.column === 'done').map((t) => t.key)), [data.tickets])
  const refreshing = jobs.running === 'daily'
  const archiveRefreshing = jobs.running === 'archive'

  // Picking the Next Sprint chip reveals its bar at the very bottom; bring it into view.
  useEffect(() => {
    if (sel !== 'next') return
    const id = requestAnimationFrame(() => document.getElementById('jb-next-sprint')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
    return () => cancelAnimationFrame(id)
  }, [sel])

  const refreshedOnOpen = useRef(false)
  useEffect(() => {
    if (!served || !features.reloadActive || refreshedOnOpen.current) return
    refreshedOnOpen.current = true
    void jobs.refreshBoard()
  }, [features.reloadActive, jobs.refreshBoard])

  const archiveTicket = useCallback(
    (key: string) => {
      archive(key)
      toast(`${key} moved to Completed`, 'success')
    },
    [archive, toast],
  )
  const archiveAndClose = useCallback(
    (key: string) => {
      archiveTicket(key)
      drawers.closeAll()
    },
    [archiveTicket, drawers.closeAll],
  )
  const openSettings = useCallback(() => {
    if (settingsReady) setSettingsOpen(true)
    else toast('Loading saved settings…', 'loading')
  }, [settingsReady, toast])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const openCompleted = useCallback(() => setCompletedOpen(true), [])
  const closeCompleted = useCallback(() => setCompletedOpen(false), [])
  const openRaised = useCallback(() => setRaisedOpen(true), [])
  const closeRaised = useCallback(() => setRaisedOpen(false), [])
  const clearSearch = useCallback(() => {
    setQuery('')
    setSel(null)
  }, [])

  const reportsMenu = useMemo<ReportsMenuProps | undefined>(
    () =>
      features.prReports
        ? {
            served,
            generating: reports.generating,
            withPrCount: ticketsWithPr,
            reportCount: Object.keys(reports.index?.reports ?? {}).length,
            onBulk: reports.generateBulk,
            onOne: reports.generateOne,
            onStop: reports.stopAll,
            runningCount: enrichJobsRunning(ai),
            modelLabel: aiModelLabel(ai),
          }
        : undefined,
    [features.prReports, reports.generating, reports.index, reports.generateBulk, reports.generateOne, reports.stopAll, ticketsWithPr, ai],
  )

  if (source === 'empty') {
    return (
      <div className="w-full px-4 pb-24 md:px-6 lg:px-8">
        <EmptyState served={served} refreshing={refreshing} onRefresh={jobs.refreshBoard} runCommand={RUN_COMMAND} />
        <Footer />
        <Toasts toasts={toasts} onDismiss={dismiss} />
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
        archiveParallel={settings.archiveParallel}
        runProgress={jobs.progress}
        served={served}
        onRefresh={jobs.refreshBoard}
        shortcuts={features.shortcuts}
        onArchiveRefresh={jobs.rebuildArchive}
        onStopArchive={jobs.stopArchive}
        onOpenSettings={openSettings}
        reports={reportsMenu}
      />

      <SettingsPanel open={settingsOpen} settings={settings} onChange={setSettings} onClose={closeSettings} aiLevelSynced={served} aiStatus={ai} />

      {/* Counts follow the search. The Completed chip counts MY tickets only, like the archive's default scope. */}
      <Stats
        tickets={view.board}
        completedCount={features.completedArchive ? myCompletedCount : null}
        raisedCount={features.raisedTickets && raisedCount.total > 0 ? raisedCount : null}
        nextSprintCount={features.nextSprint ? view.nextSprint.length : 0}
        active={sel}
        onSelect={setSel}
        onOpenCompleted={features.completedArchive ? openCompleted : undefined}
        onOpenRaised={features.raisedTickets ? openRaised : undefined}
      />

      {!hasAnyActive ? (
        <FunEmptyBoard
          served={served}
          refreshing={refreshing}
          onRefresh={jobs.refreshBoard}
          archivedCount={userArchived.length}
          archivedKeys={userArchived}
          onUndo={restoreArchived}
        />
      ) : view.matched.length === 0 ? (
        // A search that only hits On Hold or Next Sprint still matched something shown below.
        <NoMatches query={query} onClear={clearSearch} />
      ) : (
        <Board
          tickets={view.board}
          now={now}
          onOpen={drawers.openTicket}
          focus={focus}
          onArchive={archiveTicket}
          onRefreshTicket={jobs.refreshTicket}
          refreshingKeys={jobs.refreshingKeys}
        />
      )}

      {hasAnyActive && userArchived.length > 0 && <ArchivedUndo keys={userArchived} onUndo={restoreArchived} />}

      {features.onHold && <OnHold tickets={view.hold} now={now} onOpen={drawers.openTicket} />}

      {features.nextSprint && (
        <NextSprint tickets={view.nextSprint} now={now} onOpen={drawers.openTicket} visible={sel === 'next' || sel === 'all'} forceOpen={sel === 'all'} />
      )}

      <Footer />

      {/* Shared backdrop behind the whole drawer stack; click it to dismiss everything. */}
      <AnimatePresence>
        {drawers.open && (
          <motion.div
            key="jb-scrim"
            className="fixed inset-0 z-[46] bg-black/55 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={drawers.closeAll}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {drawers.stack.map((key, i) => {
          const t = byKey.get(key)
          return t ? (
            <TicketDetail
              key={`${i}:${key}`}
              ticket={t}
              now={now}
              depth={i}
              topDepth={drawers.stack.length - 1}
              onClose={drawers.goBack}
              onJumpTo={() => drawers.jumpTo(i)}
              onOpen={drawers.pushTicket}
              // Only a Done ticket still on the board can move to Completed; archive rows already live there.
              onArchive={doneOnBoard.has(key) ? archiveAndClose : undefined}
              onRefreshTicket={jobs.refreshTicket}
              refreshing={jobs.refreshingKeys.has(t.key)}
              user={data.user}
              report={features.prReports ? (reports.index?.reports[t.key] ?? null) : null}
              reportsEnabled={features.prReports}
              briefsEnabled={features.aiBriefs}
              reportGenerating={reports.generating.has(t.key)}
              reportLoading={reports.loadingKey === t.key}
              onOpenReport={reports.openReportFor}
              onGenerateReport={reports.generateOne}
              served={served}
            />
          ) : null
        })}
      </AnimatePresence>

      <CompletedOverlay open={completedOpen} onClose={closeCompleted} items={data.completed} onOpen={drawers.openTicket} pauseEsc={drawers.open} />

      <RaisedOverlay
        open={raisedOpen}
        onClose={closeRaised}
        items={data.raised ?? []}
        onOpen={drawers.openTicket}
        user={data.user}
        onRefresh={served ? jobs.refreshRaised : undefined}
        refreshing={jobs.running === 'raised'}
        pauseEsc={drawers.open}
      />

      <PrReportOverlay
        report={reports.openReport}
        onClose={reports.closeReport}
        onRegenerate={served ? reports.generateOne : undefined}
        generating={reports.openReport ? reports.generating.has(reports.openReport.key) : false}
        internStatus={ai}
      />

      <NoticesDock notes={data.notes ?? []} seconds={settings.toastSeconds} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
