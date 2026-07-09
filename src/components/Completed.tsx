import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CompletedTicket } from '../types'
import { fmtDate, priorityMeta, projectOf, yearOf, hexToRgba, branchesOf, branchStatusOf, prListOf } from '../lib/format'
import { Pill, PrBadge, BranchStatusPill, PointsTag } from './ui'
import { ChevronIcon, ExpandAllIcon, TrophyIcon, DoneCheckIcon, SearchIcon } from './Icons'

const DONE = '#22c55e'

/** Near-full-screen overlay (slides in from the top) listing every completed ticket. Controlled by App. */
export function CompletedOverlay({
  open,
  onClose,
  items: rawItems,
  onOpen,
  pauseEsc,
}: {
  open: boolean
  onClose: () => void
  items: CompletedTicket[]
  onOpen: (key: string) => void
  /** When a ticket detail is layered on top, ignore Esc here so one keypress closes only the top layer. */
  pauseEsc?: boolean
}) {
  // Archive shows ONLY parent tickets — sub-tasks are reachable from their parent's detail page.
  const items = useMemo(
    () => rawItems.filter((it) => it.parentKey == null && !/sub[\s_-]?task/i.test(it.type ?? '')),
    [rawItems],
  )
  const [q, setQ] = useState('')
  const [proj, setProj] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  // Fresh start each time the archive reopens — don't carry over a prior search / project filter /
  // expanded rows from the last time it was open.
  useEffect(() => {
    if (open) return
    setQ('')
    setProj(null)
    setExpanded(new Set())
  }, [open])

  const pauseRef = useRef(false)
  pauseRef.current = !!pauseEsc
  useEffect(() => {
    if (!open) return
    // Ignore Esc while a ticket detail is layered on top (that drawer handles it first).
    // Body scroll-lock is owned centrally by App (single source of truth).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pauseRef.current) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const projects = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const p = it.project || projectOf(it.key)
      m.set(p, (m.get(p) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const totalPts = useMemo(() => items.reduce((s, it) => s + (it.storyPoints ?? 0), 0), [items])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return items.filter((it) => {
      const p = it.project || projectOf(it.key)
      if (proj && p !== proj) return false
      if (!term) return true
      return `${it.key} ${it.title} ${it.type ?? ''} ${it.status ?? ''} ${p}`.toLowerCase().includes(term)
    })
  }, [items, q, proj])

  const groups = useMemo(() => {
    const m = new Map<string, CompletedTicket[]>()
    for (const it of filtered) {
      const y = yearOf(it.resolved)
      if (!m.has(y)) m.set(y, [])
      m.get(y)!.push(it)
    }
    for (const arr of m.values()) arr.sort((a, b) => (b.resolved ?? '').localeCompare(a.resolved ?? ''))
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [filtered])

  const allExpanded = filtered.length > 0 && filtered.every((it) => expanded.has(it.key))
  const toggleRow = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(filtered.map((it) => it.key)))
  const empty = items.length === 0

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[45] flex justify-center overflow-hidden p-3 sm:p-6">
          <motion.div className="absolute inset-0 bg-black/55 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: -40, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -30, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            className="relative flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            style={{ borderTop: `3px solid ${DONE}` }}
            role="dialog"
            aria-modal="true"
          >
            {/* sticky header */}
            <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--line)] px-4 py-3" style={{ background: hexToRgba(DONE, 0.06) }}>
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: hexToRgba(DONE, 0.16) }}>
                <TrophyIcon size={15} />
              </span>
              <h2 className="text-[17px] font-bold" style={{ color: DONE }}>
                Completed
              </h2>
              <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ color: DONE, background: hexToRgba(DONE, 0.16) }}>
                {items.length}
              </span>
              <span className="hidden text-[11.5px] text-[var(--muted)] sm:inline">
                {empty ? "everything I've shipped" : `${totalPts} pts · ${projects.length} project${projects.length === 1 ? '' : 's'}`}
              </span>
              <button onClick={onClose} className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]" aria-label="Close">
                ✕
              </button>
            </div>

            {/* scroll body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
              {empty ? (
                <div className="py-12 text-center">
                  <div className="mb-2 text-2xl">🗃️</div>
                  <p className="text-[13px] font-semibold text-[var(--ink)]">No completed tickets yet.</p>
                  <p className="mt-1 text-[12px] text-[var(--muted)]">Run the intern (with Jira connected) to pull every Done ticket ever assigned to you.</p>
                </div>
              ) : (
                <>
                  {/* controls */}
                  <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 bg-[var(--bg)] pb-2">
                    <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1.5">
                      <span className="text-[var(--muted)]">
                        <SearchIcon size={13} />
                      </span>
                      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search completed…" className="w-44 bg-transparent text-[12px] outline-none placeholder:text-[var(--muted)]" />
                    </label>
                    <button
                      onClick={() => setProj(null)}
                      className="rounded-full border px-2.5 py-1 text-[11px] font-medium"
                      style={{ borderColor: proj === null ? DONE : 'var(--line)', color: proj === null ? DONE : 'var(--muted)', background: proj === null ? hexToRgba(DONE, 0.12) : 'transparent' }}
                    >
                      All
                    </button>
                    {projects.map(([p, n]) => (
                      <button
                        key={p}
                        onClick={() => setProj(proj === p ? null : p)}
                        className="rounded-full border px-2.5 py-1 text-[11px] font-medium"
                        style={{ borderColor: proj === p ? DONE : 'var(--line)', color: proj === p ? DONE : 'var(--muted)', background: proj === p ? hexToRgba(DONE, 0.12) : 'transparent' }}
                      >
                        {p} <span className="opacity-60">{n}</span>
                      </button>
                    ))}
                    <button
                      onClick={toggleAll}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--ink-soft)] hover:text-[var(--ink)]"
                    >
                      <ExpandAllIcon collapsed={!allExpanded} size={13} />
                      {allExpanded ? 'Collapse all' : 'Expand all'}
                    </button>
                  </div>

                  {/* grouped rows */}
                  <div className="flex flex-col gap-4">
                    {groups.map(([year, rows]) => (
                      <div key={year}>
                        <div className="mb-1.5 flex items-center gap-2 px-1">
                          <span className="text-[12px] font-bold text-[var(--ink-soft)]">{year}</span>
                          <span className="h-px flex-1 bg-[var(--line)]" />
                          <span className="text-[11px] text-[var(--muted)]">{rows.length}</span>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {rows.map((it) => (
                            <CompletedRow key={it.key} it={it} expanded={expanded.has(it.key)} onToggle={() => toggleRow(it.key)} onOpen={() => onOpen(it.key)} />
                          ))}
                        </div>
                      </div>
                    ))}
                    {filtered.length === 0 && <div className="py-6 text-center text-[12px] italic text-[var(--muted)]">No completed tickets match.</div>}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

function CompletedRow({ it, expanded, onToggle, onOpen }: { it: CompletedTicket; expanded: boolean; onToggle: () => void; onOpen: () => void }) {
  const status = it.status || 'Done'
  const branches = branchesOf(it)
  const prs = prListOf(it)

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-2)]">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button onClick={onToggle} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]" aria-label={expanded ? 'Collapse details' : 'Expand details'} title="Quick peek">
          <motion.span animate={{ rotate: expanded ? 90 : 0 }} className="inline-flex">
            <ChevronIcon size={12} />
          </motion.span>
        </button>

        <button onClick={onOpen} className="group flex min-w-0 flex-1 items-center gap-2.5 text-left" title="Open full ticket details">
          <DoneCheckIcon size={14} />
          {/* Fixed-width key + points columns so every title starts at the same x. */}
          <span className="min-w-[86px] shrink-0 whitespace-nowrap font-mono text-[12px] font-extrabold" style={{ color: 'var(--link)' }}>
            {it.key}
          </span>
          <span className="flex w-12 shrink-0 justify-start">
            <PointsTag points={it.storyPoints} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--ink)] group-hover:underline">{it.title}</span>
          {prs[0] && (
            <span className="hidden shrink-0 sm:inline-flex">
              <PrBadge state={prs[0].state} />
            </span>
          )}
          <span className="shrink-0 rounded-full px-2 py-[2px] text-[10px] font-semibold text-white" style={{ background: DONE }}>
            {status}
          </span>
        </button>

        <span className="hidden w-[78px] shrink-0 text-right text-[11px] tabular-nums text-[var(--muted)] sm:inline">{fmtDate(it.resolved)}</span>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="border-t border-[var(--line)] px-3 py-2.5">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <Field label="Opened" value={it.created ? fmtDate(it.created) : '—'} />
                <Field label="Closed" value={it.resolved ? fmtDate(it.resolved) : '—'} />
                <Field label="Current status" value={status} />
                <Field label="Type" value={it.type || '—'} />
                <Field label="Priority" value={priorityMeta(it.priority).label} dot={priorityMeta(it.priority).color} />
                <Field label="Story points" value={typeof it.storyPoints === 'number' ? `${it.storyPoints}` : '—'} />
                <Field label="Sub-tasks created" value={`${it.subtaskCount ?? it.subtasks?.length ?? 0}`} />
                <div className="col-span-2 sm:col-span-3">
                  <FieldLabel>{branches.length > 1 ? 'Branches' : 'Branch'}</FieldLabel>
                  {branches.length ? (
                    <div className="flex flex-col gap-1">
                      {branches.map((b, i) => (
                        <span key={i} className="inline-flex flex-wrap items-center gap-2">
                          <code className="break-all font-mono text-[11.5px] text-[var(--ink-soft)]">{b}</code>
                          <BranchStatusPill state={branchStatusOf(b, it)} />
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[12px] text-[var(--muted)]">—</span>
                  )}
                </div>
                {prs.length > 0 && (
                  <div className="col-span-2 sm:col-span-3">
                    <FieldLabel>{prs.length > 1 ? `Pull requests (${prs.length})` : 'Pull request'}</FieldLabel>
                    <div className="flex flex-col gap-1.5">
                      {prs.map((p, i) => (
                        <span key={i} className="inline-flex flex-wrap items-center gap-2">
                          {p.state && p.state !== 'none' ? <PrBadge state={p.state} /> : <Pill color="#8b5cf6">⬡ PR</Pill>}
                          {p.merged && p.state !== 'merged' && <Pill color="#8b5cf6">merged</Pill>}
                          {typeof p.approvals === 'number' && <span className="text-[11px] text-[var(--muted)]">{p.approvals} approval{p.approvals === 1 ? '' : 's'}</span>}
                          {p.url && (
                            <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-semibold hover:underline" style={{ color: 'var(--pr-link)' }}>
                              {p.id ? `#${p.id}` : 'view'} ↗
                            </a>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {/* <button onClick={onOpen} className="mt-3 inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold" style={{ color: DONE, background: hexToRgba(DONE, 0.12) }}>
                Open full ticket details →
              </button> */}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{children}</div>
}

function Field({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-1.5 text-[12.5px] text-[var(--ink-soft)]">
        {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} />}
        {value}
      </div>
    </div>
  )
}
