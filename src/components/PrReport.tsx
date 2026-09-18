import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
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
import { PrinterIcon, RefreshIcon, SparkleIcon } from './Icons'

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
  // While printing, every tab is rendered at once so the PDF carries the whole report instead of
  // whichever tab happened to be open. Reset by the browser's afterprint event (also fires when
  // the dialog is cancelled), so the on-screen view always returns to a single tab.
  const [printing, setPrinting] = useState(false)
  // Reset to the first tab whenever a different report opens.
  useEffect(() => {
    setTabId(report?.tabs?.[0]?.id ?? null)
  }, [report?.key])

  useEffect(() => {
    const done = () => setPrinting(false)
    window.addEventListener('afterprint', done)
    return () => window.removeEventListener('afterprint', done)
  }, [])

  // Two frames, not one: React must commit the all-tabs render and the browser must lay it out
  // before print() snapshots the page, or the PDF captures the single-tab view.
  const handlePrint = () => {
    setPrinting(true)
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

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

  // The generator emits the same figures as both the header strip and an "At a glance" stats
  // block on the verdict tab. Rendering both puts identical numbers twice within one screen, so
  // the block yields to the strip. Compared by content, not title, so a tab that happens to carry
  // a genuinely different stats block still shows it.
  const blocks = useMemo(() => visibleBlocks(active?.blocks ?? [], report?.stats), [active, report?.stats])
  const blockHalfWidth = useMemo(() => halfWidthFlags(blocks), [blocks])
  const v = report?.verdict
  const vc = toneColor(v?.tone)

  return (
    <AnimatePresence>
      {report && (
        <motion.div
          key="jb-report"
          className="jb-report-overlay fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm md:p-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          role="dialog"
          aria-modal
          aria-label={`PR readiness report for ${report.key}`}
        >
          <motion.section
            className="w-full max-w-[1600px] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 24, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Verdict-coloured top bar */}
            <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${vc}, ${hexToRgba(vc, 0.2)})` }} />

            {/* Header */}
            <header className="flex flex-wrap items-start gap-3 border-b border-[var(--line)] px-5 py-4 lg:px-8">
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
                <div className="flex items-center gap-1.5 jb-no-print">
                  <button
                    type="button"
                    onClick={handlePrint}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] bg-[var(--surface-solid)] text-[var(--ink-soft)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
                    title="Export this report as a PDF — every tab, colour-coded, ready to share (choose “Save as PDF” in the print dialog)"
                    aria-label="Export report as PDF"
                  >
                    <PrinterIcon size={14} color="currentColor" />
                  </button>
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
              <div className="jb-report-stats flex flex-wrap items-center border-b border-[var(--line)] px-3 py-1.5 lg:px-6">
                {report.stats.map((s, i) => (
                  <StatChip key={i} stat={s} first={i === 0} />
                ))}
              </div>
            )}

            {/* Coloured tabs */}
            <nav className="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-3 pt-2 lg:px-6" role="tablist">
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

            {/* Tab body — a 2-column grid on wide screens so the extra width gets used instead of
                turning into scroll. Only blocks that genuinely pair well (kv/list/links) go
                half-width, and only when there's an adjacent partner — everything else (tables,
                card grids, stats, callouts) stays full-width so no block is ever left stranded
                next to blank space. */}
            <div className="px-5 py-5 lg:px-8" role="tabpanel">
              {printing ? (
                tabs.map((t, ti) => {
                  const printBlocks = visibleBlocks(t.blocks, report.stats)
                  const flags = halfWidthFlags(printBlocks)
                  return (
                    <section key={t.id} className={ti > 0 ? 'jb-print-tab mt-6' : 'jb-print-tab'}>
                      <h3 className="mb-3 flex items-center gap-2 text-[14px] font-extrabold" style={{ color: toneColor(t.tone) }}>
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: toneColor(t.tone) }} />
                        {t.title}
                      </h3>
                      {t.summary && <p className="mb-3 text-[13px] text-[var(--ink-soft)]">{t.summary}</p>}
                      <div className="jb-blocks grid gap-4 lg:grid-cols-2 lg:gap-5">
                        {printBlocks.map((b, i) => (
                          <div key={`${t.id}:${i}`} className={flags[i] ? '' : 'jb-block-full lg:col-span-2'}>
                            <Block block={b} />
                          </div>
                        ))}
                      </div>
                    </section>
                  )
                })
              ) : (
                <>
                  {active?.summary && <p className="mb-3 text-[13px] text-[var(--ink-soft)]">{active.summary}</p>}
                  <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
                    {blocks.map((b, i) => (
                      <div key={`${active?.id}:${i}`} className={blockHalfWidth[i] ? '' : 'lg:col-span-2'}>
                        <Block block={b} />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--line)] px-5 py-3 text-[11px] text-[var(--muted)] lg:px-8">
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

/**
 * Elastic tiling for the stat strips and card grids.
 *
 * A fixed column count (`lg:grid-cols-6`) is what makes these sections look broken: six columns
 * holding four stats leave two dead cells, and seven cards become 6 + 1 orphan. Instead we pick
 * the column count that splits `count` items as EVENLY as possible without exceeding `maxCols`
 * (7 → 4+3, not 6+1), then let every tile flex-grow from that basis, so a short last row
 * stretches to fill the width rather than leaving holes. `minWidth` is the only breakpoint we
 * need: once the ideal basis would squeeze a tile below it, the row wraps on its own.
 */
/**
 * The generator emits the same figures as both the header strip and an "At a glance" stats block
 * on the verdict tab. Rendering both puts identical numbers twice within one screen, so the block
 * yields to the strip. Compared by content, not title, so a tab carrying a genuinely different
 * stats block still shows it.
 */
function visibleBlocks(all: ReportBlock[], headerStats?: ReportStat[] | null): ReportBlock[] {
  const digest = (items: ReportStat[]) => items.map((s) => `${s.label}=${s.value}`).join('|')
  const headerDigest = digest(headerStats ?? [])
  if (!headerDigest) return all
  return all.filter((b) => !(b.kind === 'stats' && digest(b.items) === headerDigest))
}

function balancedColumns(count: number, maxCols: number): number {
  if (count <= 1) return 1
  const rows = Math.ceil(count / maxCols)
  return Math.ceil(count / rows)
}

/** Flex sizing for one tile in a `balancedColumns` row. */
function tileStyle(cols: number, minWidth: number, gap = 1): CSSProperties {
  return { flex: `1 1 calc(100% / ${cols} - ${gap}px)`, minWidth: `${minWidth}px` }
}

/** kv/list/links are compact enough to sit two-up; table/cards/stats/callout/timeline keep the
 *  full row (tables need the width, callouts read better unbroken, card grids/timelines already
 *  lay themselves out internally). Adjacent pairable blocks are paired left-to-right so a lone
 *  one never ends up stranded half-width beside empty space. */
const HALF_WIDTH_KINDS = new Set<ReportBlock['kind']>(['kv', 'list', 'links'])

function halfWidthFlags(blocks: ReportBlock[]): boolean[] {
  const half = new Array(blocks.length).fill(false)
  let i = 0
  while (i < blocks.length) {
    if (HALF_WIDTH_KINDS.has(blocks[i].kind) && i + 1 < blocks.length && HALF_WIDTH_KINDS.has(blocks[i + 1].kind)) {
      half[i] = true
      half[i + 1] = true
      i += 2
    } else {
      i += 1
    }
  }
  return half
}

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

/**
 * One stat as an inline `label value` chip. Stacking the label above the value and stretching
 * each tile to an equal share of the width wasted most of the strip — a handful of short values
 * spread across 1600px. Sized to its content instead, the whole set fits on one line, and the
 * hint moves to the tooltip where it isn't competing for space.
 */
function StatChip({ stat, first }: { stat: ReportStat; first?: boolean }) {
  const c = toneColor(stat.tone)
  const active = stat.tone && stat.tone !== 'neutral'
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1 ${first ? '' : 'border-l border-[var(--line)]'}`}
      title={stat.hint ? `${stat.label}: ${stat.value} — ${stat.hint}` : `${stat.label}: ${stat.value}`}
    >
      {active && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c }} />}
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{stat.label}</span>
      <span className="text-[13px] font-extrabold tabular-nums" style={{ color: active ? c : 'var(--ink)' }}>
        {stat.value}
      </span>
    </span>
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
  // Long blocks may split across a printed page; short ones must not. Without this a tall gate
  // checklist that doesn't fit the remaining space jumps to the next page whole, leaving most of
  // the previous one blank.
  const breakable = block.kind === 'table' || block.kind === 'cards'
  return (
    <section
      className={`overflow-hidden rounded-xl border${breakable ? ' jb-breakable' : ''}`}
      style={{ borderColor: hexToRgba(c, 0.35) }}
    >
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
    case 'callout': {
      const c = toneColor(block.tone)
      const tinted = block.tone && block.tone !== 'neutral'
      return (
        <BlockShell block={block}>
          <div style={tinted ? { background: hexToRgba(c, 0.05) } : undefined}>
            <SafeHtml html={block.body} className="px-3.5 py-3 text-[13.5px] leading-relaxed text-[var(--ink-soft)]" />
          </div>
        </BlockShell>
      )
    }
    case 'stats':
      return (
        <BlockShell block={block}>
          <div className="flex flex-wrap items-center px-1 py-1.5">
            {block.items.map((s, i) => (
              <StatChip key={i} stat={s} first={i === 0} />
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
    case 'cards': {
      const cols = balancedColumns(block.items.length, 3)
      return (
        <BlockShell block={block}>
          <div className="flex flex-wrap gap-3 p-3">
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
              const style = { ...tileStyle(cols, 260, 12), borderColor: hexToRgba(c, 0.35), background: hexToRgba(c, 0.05) }
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
    }
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
            {block.items.map((kv, i) => {
              const flagged = kv.tone && kv.tone !== 'neutral'
              return (
                <div key={i} className="contents">
                  <dt className="text-[var(--muted)]">{kv.label}</dt>
                  <dd className="flex items-center gap-1.5 font-semibold" style={{ color: toneText(kv.tone) }}>
                    {flagged && <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: toneColor(kv.tone) }} />}
                    {kv.href ? (
                      <a href={kv.href} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--link)' }}>
                        {kv.value} ↗
                      </a>
                    ) : (
                      kv.value
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        </BlockShell>
      )
    default:
      return null
  }
}
