import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type {
  PrReport,
  ReportBlock,
  ReportProvenance,
  ReportStat,
  ReportTab,
  ReportTone,
} from '../lib/reportTypes'
import { toneColor, worstTone } from '../lib/reportTypes'
import { fmtDateTime, hexToRgba } from '../lib/format'
import { SafeHtml } from './ui'
import { RefreshIcon, SparkleIcon } from './Icons'

/**
 * PR Readiness Report overlay — renders a report GENERICALLY from its block kinds, so the
 * deterministic base and the AI-enriched version use the very same component. Tabs are
 * colour-coded by tone (worst block wins) so a reader can skip the green ones.
 */
export function PrReportOverlay({
  report,
  onClose,
  onRegenerate,
  generating,
}: {
  report: PrReport | null
  onClose: () => void
  /** Served mode only — kicks off a background regeneration. */
  onRegenerate?: (key: string) => void
  generating?: boolean
}) {
  const [tabId, setTabId] = useState<string | null>(null)
  // Reset to the first tab whenever a different report opens.
  useEffect(() => {
    setTabId(report?.tabs?.[0]?.id ?? null)
  }, [report?.key])

  // Esc closes the report BEFORE the drawer beneath gets to pop (capture + stopImmediatePropagation).
  useEffect(() => {
    if (!report) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [report, onClose])

  const tabs: ReportTab[] = useMemo(
    () =>
      (report?.tabs ?? []).map((t) => ({
        ...t,
        tone: t.tone ?? worstTone(t.blocks.map((b) => b.tone)),
      })),
    [report],
  )
  const active = tabs.find((t) => t.id === tabId) ?? tabs[0]
  const v = report?.verdict
  const vc = toneColor(v?.tone)

  return (
    <AnimatePresence>
      {report && (
        <motion.div
          key="jb-report"
          className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm md:p-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          role="dialog"
          aria-modal
          aria-label={`PR readiness report for ${report.key}`}
        >
          <motion.section
            className="w-full max-w-6xl overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 24, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Verdict-coloured top bar */}
            <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${vc}, ${hexToRgba(vc, 0.2)})` }} />

            {/* Header */}
            <header className="flex flex-wrap items-start gap-3 border-b border-[var(--line)] px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">
                  <span>PR readiness report</span>
                  <span className="font-mono normal-case tracking-normal text-[var(--ink-soft)]">{report.key}</span>
                  <ProvenanceChip provenance={report.enriched ? 'ai' : 'derived'} big />
                </div>
                <h2 className="mt-1 text-[17px] font-extrabold leading-snug text-[var(--ink)]">{report.title}</h2>
                {v && (
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--ink-soft)]">
                    {v.headline}
                    {v.summary ? <span className="text-[var(--muted)]"> {v.summary}</span> : null}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <div className="flex items-center gap-2">
                  {v && (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-extrabold"
                      style={{ color: vc, borderColor: hexToRgba(vc, 0.5), background: hexToRgba(vc, 0.14) }}
                    >
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: vc }} />
                      {v.label}
                    </span>
                  )}
                  {typeof v?.score === 'number' && <ScoreRing score={v.score} color={vc} />}
                </div>
                <div className="flex items-center gap-1.5">
                  {onRegenerate && (
                    <button
                      type="button"
                      onClick={() => !generating && onRegenerate(report.key)}
                      disabled={!!generating}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-solid)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ink-soft)] hover:border-[var(--muted)] disabled:opacity-60"
                      title="Rebuild this report in the background (deterministic base + AI enrichment)"
                    >
                      <motion.span className="inline-flex" animate={generating ? { rotate: 360 } : { rotate: 0 }} transition={generating ? { repeat: Infinity, duration: 0.9, ease: 'linear' } : { duration: 0.2 }}>
                        <RefreshIcon size={12} color="currentColor" />
                      </motion.span>
                      {generating ? 'Regenerating…' : 'Regenerate'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
                    aria-label="Close report"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </header>

            {/* At-a-glance stats */}
            {report.stats?.length > 0 && (
              <div className="grid grid-cols-2 gap-px border-b border-[var(--line)] bg-[var(--line)] sm:grid-cols-3 lg:grid-cols-6">
                {report.stats.map((s, i) => (
                  <StatCell key={i} stat={s} />
                ))}
              </div>
            )}

            {/* Coloured tabs */}
            <nav className="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-3 pt-2" role="tablist">
              {tabs.map((t) => {
                const c = toneColor(t.tone)
                const on = t.id === active?.id
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setTabId(t.id)}
                    className="relative flex shrink-0 items-center gap-2 rounded-t-lg px-3.5 py-2 text-[12.5px] font-semibold transition-colors"
                    style={{
                      color: on ? c : 'var(--ink-soft)',
                      background: on ? hexToRgba(c, 0.12) : 'transparent',
                      boxShadow: on ? `inset 0 -2px 0 ${c}` : 'none',
                    }}
                  >
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />
                    {t.title}
                    {t.badge != null && t.badge !== '' && (
                      <span className="rounded-full px-1.5 text-[10px] font-bold tabular-nums" style={{ color: c, background: hexToRgba(c, 0.16) }}>
                        {t.badge}
                      </span>
                    )}
                  </button>
                )
              })}
            </nav>

            {/* Tab body */}
            <div className="px-5 py-4" role="tabpanel">
              {active?.summary && <p className="mb-3 text-[13px] text-[var(--ink-soft)]">{active.summary}</p>}
              <div className="grid gap-4">
                {active?.blocks.map((b, i) => (
                  <Block key={`${active.id}:${i}`} block={b} />
                ))}
              </div>
            </div>

            {/* Footer */}
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--line)] px-5 py-3 text-[11px] text-[var(--muted)]">
              <span>
                Generated {fmtDateTime(report.generatedAt)}
                {report.enriched && report.enrichedAt ? ` · AI-enriched ${fmtDateTime(report.enrichedAt)}` : ' · deterministic only'}
                {report.generator ? ` · ${report.generator}` : ''}
              </span>
              {report.sources && <span className="min-w-0 truncate">Sources: {report.sources}</span>}
              {report.warnings && report.warnings.length > 0 && (
                <span className="basis-full text-[#b45309]">⚠ {report.warnings.join(' · ')}</span>
              )}
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── pieces ────────────────────────────────────────────────────────────────────

function ScoreRing({ score, color }: { score: number; color: string }) {
  const r = 15
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  return (
    <span className="relative grid h-10 w-10 place-items-center" title={`Readiness score ${pct}/100`}>
      <svg width="40" height="40" viewBox="0 0 40 40" className="-rotate-90">
        <circle cx="20" cy="20" r={r} stroke={hexToRgba(color, 0.18)} strokeWidth="4" fill="none" />
        <circle cx="20" cy="20" r={r} stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} />
      </svg>
      <span className="absolute text-[11px] font-extrabold tabular-nums" style={{ color }}>
        {pct}
      </span>
    </span>
  )
}

function StatCell({ stat }: { stat: ReportStat }) {
  const c = toneColor(stat.tone)
  return (
    <div className="bg-[var(--bg)] px-4 py-3" title={stat.hint ?? undefined}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--muted)]">{stat.label}</div>
      <div className="mt-0.5 truncate text-[15px] font-extrabold tabular-nums" style={{ color: stat.tone && stat.tone !== 'neutral' ? c : 'var(--ink)' }}>
        {stat.value}
      </div>
      {stat.hint && <div className="truncate text-[10.5px] text-[var(--muted)]">{stat.hint}</div>}
    </div>
  )
}

function ProvenanceChip({ provenance, big }: { provenance?: ReportProvenance | null; big?: boolean }) {
  const p = provenance ?? 'derived'
  const meta =
    p === 'ai'
      ? { label: 'AI-enriched', color: '#a855f7', title: 'Concluded by the AI pass from Jira / Bitbucket / Confluence evidence' }
      : p === 'unknown'
        ? { label: 'not verified', color: '#b45309', title: 'Could not be verified — treat as a gap, not a fact' }
        : { label: 'measured', color: '#64748b', title: 'Computed directly from Jira / Bitbucket data' }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 font-semibold normal-case tracking-normal ${big ? 'py-[2px] text-[10.5px]' : 'py-px text-[9.5px]'}`}
      style={{ color: meta.color, borderColor: hexToRgba(meta.color, 0.4), background: hexToRgba(meta.color, 0.1) }}
      title={meta.title}
    >
      {p === 'ai' && <SparkleIcon size={9} color={meta.color} />}
      {meta.label}
    </span>
  )
}

function BlockShell({ block, children }: { block: ReportBlock; children: ReactNode }) {
  const c = toneColor(block.tone)
  return (
    <section className="overflow-hidden rounded-xl border" style={{ borderColor: hexToRgba(c, 0.35) }}>
      {(block.title || block.provenance) && (
        <div className="flex items-center gap-2 border-b px-3.5 py-2" style={{ borderColor: hexToRgba(c, 0.25), background: hexToRgba(c, 0.07) }}>
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />
          <span className="text-[12px] font-bold" style={{ color: c }}>
            {block.title}
          </span>
          <span className="ml-auto">
            <ProvenanceChip provenance={block.provenance} />
          </span>
        </div>
      )}
      <div className="bg-[var(--surface-solid)]">{children}</div>
      {block.note && <div className="border-t px-3.5 py-1.5 text-[10.5px] text-[var(--muted)]" style={{ borderColor: hexToRgba(c, 0.2) }}>{block.note}</div>}
    </section>
  )
}

const toneText = (t?: ReportTone | null) => (t && t !== 'neutral' ? toneColor(t) : 'var(--ink)')

function Block({ block }: { block: ReportBlock }) {
  switch (block.kind) {
    case 'callout':
      return (
        <BlockShell block={block}>
          <SafeHtml html={block.body} className="px-3.5 py-3 text-[13.5px] leading-relaxed text-[var(--ink-soft)]" />
        </BlockShell>
      )
    case 'stats':
      return (
        <BlockShell block={block}>
          <div className="grid grid-cols-2 gap-px bg-[var(--line)] sm:grid-cols-3 lg:grid-cols-4">
            {block.items.map((s, i) => (
              <StatCell key={i} stat={s} />
            ))}
          </div>
        </BlockShell>
      )
    case 'table':
      return (
        <BlockShell block={block}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-[10.5px] font-bold uppercase tracking-wide text-[var(--muted)]">
                  {block.headers.map((h, i) => (
                    <th key={i} className="border-b border-[var(--line)] px-3.5 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((r, i) => {
                  const c = toneColor(r.tone)
                  return (
                    <tr key={i} className="align-top" style={{ background: r.tone && r.tone !== 'neutral' ? hexToRgba(c, 0.06) : undefined, boxShadow: `inset 3px 0 0 ${r.tone ? c : 'transparent'}` }}>
                      {r.cells.map((cell, j) => (
                        <td key={j} className="border-b border-[var(--line)] px-3.5 py-2 text-[var(--ink-soft)]" style={j === 0 ? { fontWeight: 600, color: 'var(--ink)' } : undefined}>
                          <SafeHtml html={cell} />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </BlockShell>
      )
    case 'cards':
      return (
        <BlockShell block={block}>
          <div className="grid gap-3 p-3 sm:grid-cols-2">
            {block.items.map((card, i) => {
              const c = toneColor(card.badgeTone)
              const body = (
                <>
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-[13px] font-bold leading-snug text-[var(--ink)]">{card.title}</span>
                    {card.badge && (
                      <span className="shrink-0 rounded-full px-2 py-[2px] text-[10px] font-bold" style={{ color: c, background: hexToRgba(c, 0.16) }}>
                        {card.badge}
                      </span>
                    )}
                  </div>
                  <SafeHtml html={card.body} className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--ink-soft)]" />
                  {card.detail && <p className="mt-1.5 text-[11px] text-[var(--muted)]">{card.detail}</p>}
                </>
              )
              const cls = 'block rounded-lg border p-3 transition'
              const style = { borderColor: hexToRgba(c, 0.35), background: hexToRgba(c, 0.05) }
              return card.href ? (
                <a key={i} href={card.href} target="_blank" rel="noopener noreferrer" className={`${cls} hover:-translate-y-px hover:brightness-105`} style={style}>
                  {body}
                </a>
              ) : (
                <div key={i} className={cls} style={style}>
                  {body}
                </div>
              )
            })}
          </div>
        </BlockShell>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <BlockShell block={block}>
          <Tag className={`px-3.5 py-2.5 text-[13px] leading-relaxed ${block.ordered ? 'list-decimal pl-8' : ''}`}>
            {block.items.map((it, i) => (
              <li key={i} className="flex items-start gap-2 py-0.5 text-[var(--ink-soft)]">
                {!block.ordered && <span className="mt-[7px] inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: toneColor(it.tone) }} />}
                <span style={{ color: it.tone === 'danger' ? toneColor('danger') : undefined }}>{it.text}</span>
              </li>
            ))}
          </Tag>
        </BlockShell>
      )
    }
    case 'timeline':
      return (
        <BlockShell block={block}>
          <ol className="px-3.5 py-2.5">
            {block.items.map((e, i) => (
              <li key={i} className="relative flex gap-3 py-1.5 pl-4 text-[12.5px]">
                <span className="absolute left-0 top-[11px] h-2 w-2 rounded-full" style={{ background: toneColor(e.tone) }} />
                {i < block.items.length - 1 && <span className="absolute left-[3px] top-[19px] h-[calc(100%-8px)] w-px bg-[var(--line)]" />}
                <span className="w-24 shrink-0 font-mono text-[11px] text-[var(--muted)]">{e.when ?? '—'}</span>
                <span className="text-[var(--ink-soft)]">
                  <span className="font-semibold text-[var(--ink)]">{e.label}</span>
                  {e.detail && <span className="text-[var(--muted)]"> — {e.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        </BlockShell>
      )
    case 'links':
      return (
        <BlockShell block={block}>
          <div className="flex flex-wrap gap-2 px-3.5 py-3">
            {block.items.map((l, i) => (
              <a key={i} href={l.href} target="_blank" rel="noopener noreferrer" className="rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--link)] hover:border-[var(--muted)]">
                {l.label} ↗
              </a>
            ))}
          </div>
        </BlockShell>
      )
    case 'kv':
      return (
        <BlockShell block={block}>
          <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1.5 px-3.5 py-3 text-[12.5px]">
            {block.items.map((kv, i) => (
              <div key={i} className="contents">
                <dt className="text-[var(--muted)]">{kv.label}</dt>
                <dd className="font-semibold" style={{ color: toneText(kv.tone) }}>
                  {kv.href ? (
                    <a href={kv.href} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--link)' }}>
                      {kv.value} ↗
                    </a>
                  ) : (
                    kv.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </BlockShell>
      )
    default:
      return null
  }
}
