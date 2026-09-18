import type { PrReport, ReportBlock, ReportStat, ReportTab } from '../lib/reportTypes'
import { toneColor } from '../lib/reportTypes'
import { fmtDate, fmtDateTime } from '../lib/format'
import { SafeHtml } from './ui'

/**
 * The report as a PRINTED DOCUMENT — a separate render from the on-screen overlay, not the same
 * markup re-coloured.
 *
 * Restyling the screen UI for paper meant fighting a dark, card-based web layout with overrides,
 * and it still read like a screenshot. Paper has different rules: a cover that owns its page,
 * type that carries hierarchy instead of coloured boxes, and content that flows across pages
 * rather than sitting in scroll containers. Those are easier to state directly than to override,
 * so this component says them once and the print stylesheet stays short.
 *
 * Mounted only while printing (see `printing` in PrReportOverlay) and hidden outside @media print.
 */
export function PrReportPrintDoc({ report, tabs }: { report: PrReport; tabs: ReportTab[] }) {
  const v = report.verdict
  const vc = toneColor(v?.tone)
  const stats = report.stats ?? []

  return (
    <div className="jb-pdf">
      {/* ── Cover ── fills its own page: masthead at the top, verdict through the middle,
          figures and colophon anchored to the foot. */}
      <section className="jb-pdf-cover">
        <header className="jb-pdf-mast">
          <div className="jb-pdf-eyebrow">
            <span>PR Readiness Report</span>
            <span className="jb-pdf-eyebrow-right">{fmtDate(report.generatedAt)}</span>
          </div>
          <div className="jb-pdf-key">{report.key}</div>
          <h1 className="jb-pdf-title">{report.title}</h1>
        </header>

        <div className="jb-pdf-verdict" style={{ borderLeftColor: vc }}>
          <div className="jb-pdf-verdict-head">
            <span className="jb-pdf-verdict-label" style={{ color: vc }}>
              {v?.label ?? 'No verdict'}
            </span>
            {typeof v?.score === 'number' && (
              <span className="jb-pdf-score" style={{ color: vc }}>
                {v.score}
                <span className="jb-pdf-score-of">/100</span>
              </span>
            )}
          </div>
          {v?.headline && <p className="jb-pdf-headline">{v.headline}</p>}
          {v?.summary && <p className="jb-pdf-summary">{v.summary}</p>}
        </div>

        {stats.length > 0 && (
          <div className="jb-pdf-figures">
            {stats.map((s, i) => (
              <Figure key={i} stat={s} />
            ))}
          </div>
        )}

        <footer className="jb-pdf-cover-foot">
          <div className="jb-pdf-contents">
            <span className="jb-pdf-foot-label">In this report</span>
            <ol>
              {tabs.map((t) => (
                <li key={t.id}>
                  <span className="jb-pdf-dot" style={{ background: toneColor(t.tone) }} />
                  {t.title}
                  <span className="jb-pdf-contents-count">
                    {visibleBlocks(t.blocks, stats).length} section
                    {visibleBlocks(t.blocks, stats).length === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="jb-pdf-colophon">
            <span className="jb-pdf-foot-label">How this was produced</span>
            <p>
              {report.enriched
                ? 'Measured from Jira and Bitbucket, then reviewed by an AI pass over the ticket, pull requests and linked specs.'
                : 'Measured directly from Jira and Bitbucket. No AI interpretation applied.'}
            </p>
            <p className="jb-pdf-colophon-meta">
              Generated {fmtDateTime(report.generatedAt)}
              {report.enriched && report.enrichedAt ? ` · enriched ${fmtDateTime(report.enrichedAt)}` : ''}
              {report.generator ? ` · ${report.generator}` : ''}
            </p>
            {report.sources && <p className="jb-pdf-colophon-meta">Sources: {report.sources}</p>}
            {report.warnings && report.warnings.length > 0 && (
              <p className="jb-pdf-warn">{report.warnings.join(' · ')}</p>
            )}
          </div>
        </footer>
      </section>

      {/* ── Body ── flows from page two; a section is never split across the fold. */}
      {tabs.map((t) => {
        const blocks = visibleBlocks(t.blocks, stats)
        if (blocks.length === 0) return null
        return (
          <section key={t.id} className="jb-pdf-part">
            <h2 className="jb-pdf-part-title">
              <span className="jb-pdf-dot" style={{ background: toneColor(t.tone) }} />
              {t.title}
            </h2>
            {t.summary && <p className="jb-pdf-part-summary">{t.summary}</p>}
            <div className="jb-pdf-blocks">
              {blocks.map((b, i) => (
                <PrintBlock key={`${t.id}:${i}`} block={b} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** The cover repeats the header strip's figures, so an identical stats block is dropped. */
function visibleBlocks(all: ReportBlock[], headerStats: ReportStat[]): ReportBlock[] {
  const digest = (items: ReportStat[]) => items.map((s) => `${s.label}=${s.value}`).join('|')
  const head = digest(headerStats)
  if (!head) return all
  return all.filter((b) => !(b.kind === 'stats' && digest(b.items) === head))
}

function Figure({ stat }: { stat: ReportStat }) {
  const c = toneColor(stat.tone)
  const toned = stat.tone && stat.tone !== 'neutral'
  return (
    <div className="jb-pdf-fig">
      <div className="jb-pdf-fig-value" style={toned ? { color: c } : undefined}>
        {stat.value}
      </div>
      <div className="jb-pdf-fig-label">{stat.label}</div>
      {stat.hint && <div className="jb-pdf-fig-hint">{stat.hint}</div>}
    </div>
  )
}

/** Blocks that stay narrow enough to sit two-up; everything else takes the full measure. */
const NARROW = new Set<ReportBlock['kind']>(['kv', 'list', 'links'])

function PrintBlock({ block }: { block: ReportBlock }) {
  const c = toneColor(block.tone)
  const wide = !NARROW.has(block.kind)
  return (
    <section className={`jb-pdf-block${wide ? ' jb-pdf-wide' : ''}`} style={{ borderLeftColor: c }}>
      {block.title && (
        <h3 className="jb-pdf-block-title" style={{ color: c }}>
          {block.title}
        </h3>
      )}
      <BlockBody block={block} />
      {block.note && <p className="jb-pdf-note">{block.note}</p>}
    </section>
  )
}

function BlockBody({ block }: { block: ReportBlock }) {
  switch (block.kind) {
    case 'callout':
      return <SafeHtml html={block.body} className="jb-pdf-prose" />

    case 'stats':
      return (
        <div className="jb-pdf-figures jb-pdf-figures-inline">
          {block.items.map((s, i) => (
            <Figure key={i} stat={s} />
          ))}
        </div>
      )

    case 'table':
      return (
        <table className="jb-pdf-table">
          <thead>
            <tr>
              {block.headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={i} style={r.tone && r.tone !== 'neutral' ? { boxShadow: `inset 2px 0 0 ${toneColor(r.tone)}` } : undefined}>
                {r.cells.map((cell, j) => (
                  <td key={j} className={j === 0 ? 'jb-pdf-td-lead' : undefined}>
                    <SafeHtml html={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )

    case 'cards':
      return (
        <div className="jb-pdf-cards">
          {block.items.map((card, i) => (
            <div key={i} className="jb-pdf-card" style={{ borderLeftColor: toneColor(card.badgeTone) }}>
              <div className="jb-pdf-card-head">
                <span className="jb-pdf-card-title">{card.title}</span>
                {card.badge && (
                  <span className="jb-pdf-card-badge" style={{ color: toneColor(card.badgeTone) }}>
                    {card.badge}
                  </span>
                )}
              </div>
              <SafeHtml html={card.body} className="jb-pdf-prose" />
              {card.detail && <p className="jb-pdf-card-detail">{card.detail}</p>}
            </div>
          ))}
        </div>
      )

    case 'list':
      return (
        <ul className="jb-pdf-list">
          {block.items.map((it, i) => (
            <li key={i}>
              <span className="jb-pdf-dot jb-pdf-dot-sm" style={{ background: toneColor(it.tone) }} />
              {it.text}
            </li>
          ))}
        </ul>
      )

    case 'timeline':
      return (
        <ol className="jb-pdf-timeline">
          {block.items.map((e, i) => (
            <li key={i}>
              <span className="jb-pdf-when">{e.when ?? '—'}</span>
              <span>
                <b>{e.label}</b>
                {e.detail ? ` — ${e.detail}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )

    case 'links':
      return (
        <ul className="jb-pdf-links">
          {block.items.map((l, i) => (
            <li key={i}>
              <b>{l.label}</b>
              <span className="jb-pdf-url">{l.href}</span>
            </li>
          ))}
        </ul>
      )

    case 'kv':
      return (
        <dl className="jb-pdf-kv">
          {block.items.map((kv, i) => (
            <div key={i}>
              <dt>{kv.label}</dt>
              <dd style={kv.tone && kv.tone !== 'neutral' ? { color: toneColor(kv.tone) } : undefined}>{kv.value}</dd>
            </div>
          ))}
        </dl>
      )

    default:
      return null
  }
}
