import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { loadData, loadArchivedKeys, persistArchivedKeys } from './data'
import { completedToTicket, type ColumnKey, type Ticket } from './types'
import { isServed, getInternStatus, startInternRun, startTicketRefresh, RUN_COMMAND } from './lib/runner'
import { Header } from './components/Header'
import { Stats } from './components/Stats'
import { Board } from './components/Board'
import { OnHold } from './components/OnHold'
import { CompletedOverlay } from './components/Completed'
import { TicketDetail } from './components/TicketDetail'
import { EmptyState } from './components/EmptyState'
import { FunEmptyBoard } from './components/FunEmptyBoard'
import { Toasts, type ToastItem } from './components/Toast'
import { NoticesDock } from './components/NoticesDock'
import { StaleBanner } from './components/StaleBanner'
import { Footer } from './components/Footer'
import { EyeOffIcon } from './components/Icons'
import { freshness } from './lib/format'

/** Flatten tickets + their nested sub-tasks into a key→ticket map (recursive). */
function indexTickets(list: Ticket[] | undefined, map: Map<string, Ticket>) {
  for (const t of list ?? []) {
    if (!map.has(t.key)) map.set(t.key, t)
    if (t.subtasks?.length) indexTickets(t.subtasks, map)
  }
}

function matches(t: Ticket, term: string): boolean {
  if (!term) return true
  const hay = [
    t.key, t.title, t.type, t.priority, t.status, t.branch,
    t.assignee, t.reporter, t.sprint, t.epic?.key,
    ...(t.labels ?? []), ...(t.components ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(term)
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
  const [focus, setFocus] = useState<ColumnKey | null>(null)
  // Navigation stack of ticket keys. Opening from the board resets it; opening a
  // sub-task pushes another drawer on top (each level is its own stacked drawer).
  const [stack, setStack] = useState<string[]>([])
  const anyDrawer = stack.length > 0
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [refreshing, setRefreshing] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [refreshingKeys, setRefreshingKeys] = useState<Set<string>>(new Set())
  const [completedOpen, setCompletedOpen] = useState(false)

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

  const toggleTheme = () => {
    const el = document.documentElement
    const next = !el.classList.contains('dark')
    el.classList.toggle('dark', next)
    try {
      localStorage.setItem('jb-theme', next ? 'dark' : 'light')
    } catch {
      /* file:// localStorage may be blocked */
    }
    setDark(next)
  }

  // Poll the server until the in-flight intern run finishes, then reload to show fresh data.
  const watchRun = useCallback(
    (before: number | null, loadingId: number) => {
      const startTs = Date.now()
      const poll = async () => {
        const s = await getInternStatus()
        // Ceiling must exceed the runner's own 30-min timeout, or the board gives up on a
        // still-legitimately-running intern and reloads stale/partial data.
        const timedOut = Date.now() - startTs > 32 * 60 * 1000
        const done = s && !s.running && (s.dataModified !== before || s.lastExit != null)
        if (!s || done || timedOut) {
          dismiss(loadingId)
          // On a non-zero exit, DON'T reload — nothing fresh landed and the reload would wipe
          // this error toast before it can be read. Let the user see it and check logs/.
          if (s?.lastExit != null && s.lastExit !== 0) {
            toast('Intern finished with errors — check logs/.', 'error', 6000)
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
        setTimeout(poll, 2000)
      }
      setTimeout(poll, 2000)
    },
    [toast, dismiss],
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
    const loading = toast('Running the JIRA intern agent… will take a few minutes.', 'loading', 0)
    const before = (await getInternStatus())?.dataModified ?? null
    const ok = await startInternRun()
    if (!ok) {
      // 409 = already running (maybe started in a terminal). Attach to that run instead of erroring.
      const s = await getInternStatus()
      if (s?.running) {
        toast('Intern already running — watching it.', 'info')
        watchRun(before, loading)
        return
      }
      dismiss(loading)
      setRefreshing(false)
      toast('Could not start the intern run.', 'error')
      return
    }
    watchRun(before, loading)
  }, [toast, dismiss, watchRun])

  // Per-ticket background refresh — fetch the latest status of ONE in-flight ticket (served mode).
  const handleRefreshTicket = useCallback(
    async (key: string) => {
      if (!isServed()) {
        toast('Single-ticket refresh needs the local server — run `npm run serve`.', 'info', 4500)
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
        if (reload) setTimeout(() => location.reload(), 500)
      }

      const before = (await getInternStatus())?.dataModified ?? null
      const ok = await startTicketRefresh(key)
      if (!ok) {
        // 409 (already running) → attach & watch; otherwise it genuinely failed to start.
        const s = await getInternStatus()
        if (!s?.refreshingKeys?.includes(key)) {
          clear(`Couldn't start refresh for ${key}.`, 'error')
          return
        }
        toast(`Already refreshing ${key} — watching it.`, 'info', 2500)
      }

      // serve.mjs adds the key to its in-flight set synchronously on POST, so a successful start
      // means it WAS running as of now. Seeding sawRunning=true lets a fast no-op refresh (that
      // finishes before the first poll) terminate as "up to date" instead of polling to timeout.
      let sawRunning = ok
      let nullStreak = 0
      const startTs = Date.now()
      const poll = async () => {
        const s = await getInternStatus()
        if (!s) {
          // transient server hiccup — tolerate a few, then give up cleanly (not "up to date").
          if (++nullStreak >= 4) {
            clear('Lost contact with the local server.', 'error')
            return
          }
          setTimeout(poll, 1500)
          return
        }
        nullStreak = 0
        const stillRunning = !!s.refreshingKeys?.includes(key)
        if (stillRunning) sawRunning = true
        const changed = s.dataModified !== before
        // Ceiling must exceed refresh-ticket.sh's own 10-min timeout to avoid a false "timed out".
        const timedOut = Date.now() - startTs > 11 * 60 * 1000
        // Done = data changed, OR the run we observed has finished, OR we hit the ceiling.
        if (changed || (sawRunning && !stillRunning) || timedOut) {
          if (changed) clear(`${key} updated — reloading.`, 'success', true)
          else if (timedOut) clear(`${key} refresh timed out.`, 'error')
          else clear(`${key} is already up to date.`, 'info')
          return
        }
        setTimeout(poll, 1500)
      }
      setTimeout(poll, 1500)
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
        watchRun(s.dataModified ?? null, id)
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
      if (anyDrawer || completedOpen) return
      if (e.key === '/' && !typing) {
        e.preventDefault()
        document.getElementById('jb-search')?.focus()
      } else if ((e.key === 'r' || e.key === 'R') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        handleRefresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleRefresh, anyDrawer, completedOpen])

  const term = query.trim().toLowerCase()
  const filtered = useMemo(() => data.tickets.filter((t) => matches(t, term)), [data.tickets, term])
  // User-archived tickets were already retired to completed[] inside loadData.
  const boardTickets = filtered.filter((t) => t.column !== 'hold')
  const holdTickets = filtered.filter((t) => t.column === 'hold')
  const hasAnyActive = useMemo(() => data.tickets.some((t) => t.column !== 'hold'), [data.tickets])
  const fr = freshness(data.generatedAt, now)

  // Index every ticket — top-level, completed parents, and all nested sub-tasks — so clicking
  // any sub-task opens its own detail page.
  const byKey = useMemo(() => {
    const m = new Map<string, Ticket>()
    indexTickets(data.tickets, m)
    for (const c of data.completed) {
      const t = completedToTicket(c)
      if (!m.has(t.key)) m.set(t.key, t)
      indexTickets(t.subtasks, m)
    }
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
        served={served}
        onRefresh={handleRefresh}
      />

      {fr.stale && <StaleBanner label={fr.label} served={served} refreshing={refreshing} onRefresh={handleRefresh} />}

      {/* Counts follow the current search so the chips always agree with what's on the board. */}
      <Stats tickets={filtered} completedCount={data.completed.length} active={focus} onSelect={setFocus} onOpenCompleted={() => setCompletedOpen(true)} />

      {!hasAnyActive ? (
        <FunEmptyBoard served={served} refreshing={refreshing} onRefresh={handleRefresh} />
      ) : boardTickets.length === 0 ? (
        <div className="grid min-h-[34vh] place-items-center rounded-2xl border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] text-center">
          <div>
            <div className="mb-2 text-3xl">🔍</div>
            <p className="text-[14px] font-semibold text-[var(--ink)]">No tickets match “{query}”.</p>
            <button onClick={() => { setQuery(''); setFocus(null) }} className="mt-2 text-[12.5px] text-[#8b9cff] hover:underline">
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
            />
          ) : null
        })}
      </AnimatePresence>

      <CompletedOverlay open={completedOpen} onClose={closeCompleted} items={data.completed} onOpen={openTicket} pauseEsc={anyDrawer} />

      <NoticesDock notes={data.notes ?? []} />
      <Toasts toasts={toasts} />
    </div>
  )
}
