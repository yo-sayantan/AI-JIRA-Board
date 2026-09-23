import type { PrReport, ReportBlock, ReportStat, ReportTab } from '../lib/reportTypes'
import { toneColor } from '../lib/reportTypes'
import { fmtDate, fmtDateTime, fmtReportMetadata } from '../lib/format'
import { APP_CONFIG } from '../lib/appConfig'
import { hrefForKey, shareableLinks } from '../lib/reportLinks'
import { ReportHtml } from './ReportHtml'

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
  const { lead, next } = splitHeadline(v?.headline, v?.label)
  const extras = shareableLinks(report)
  const ticketHref = hrefForKey(report, report.key)

  return (
    <div className="jb-pdf">
      {/* ── Cover ── fills its own page: masthead at the top, verdict through the middle,
          figures and colophon anchored to the foot. */}
      <section className="jb-pdf-cover">
        <header className="jb-pdf-mast">
          <div className="jb-pdf-eyebrow">
            <span>PR Readiness Report</span>
            <span className="jb-pdf-eyebrow-right">{fmtDate(report.generatedAt, report.timeZone ?? APP_CONFIG.timeZone)}</span>
          </div>
          {ticketHref ? (
            <a href={ticketHref} className="jb-pdf-key">
              {report.key}
            </a>
          ) : (
            <div className="jb-pdf-key">{report.key}</div>
          )}
          <h1 className="jb-pdf-title">{report.title}</h1>
        </header>

        <div className="jb-pdf-verdict">
          <div className="jb-pdf-verdict-main" style={{ borderLeftColor: vc }}>
            <div className="jb-pdf-verdict-label" style={{ color: vc }}>
              {v?.label ?? 'No verdict'}
            </div>
            {lead && (
              <p className="jb-pdf-lead">
                <ReportHtml html={lead} report={report} inline />
              </p>
            )}
            {next && (
              <p className="jb-pdf-next">
                <span className="jb-pdf-next-label">Next</span>
                <ReportHtml html={next} report={report} inline />
              </p>
            )}
          </div>
          {typeof v?.score === 'number' && (
            <div className="jb-pdf-scorebox">
              <span className="jb-pdf-foot-label">Readiness</span>
              <span className="jb-pdf-score" style={{ color: vc }}>
                {v.score}
              </span>
              <span className="jb-pdf-score-of">out of 100</span>
            </div>
          )}
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
              Generated {fmtDateTime(report.generatedAt, report.timeZone ?? APP_CONFIG.timeZone)}
              {report.enriched && report.enrichedAt ? ` · enriched ${fmtDateTime(report.enrichedAt, report.timeZone ?? APP_CONFIG.timeZone)}` : ''}
              {report.generator ? ` · ${report.generator}` : ''}
            </p>
            {extras.length > 0 && (
              <p className="jb-pdf-colophon-meta jb-pdf-cover-links">
                {extras.map((l, i) => (
                  <span key={l.href}>
                    {i > 0 ? ' · ' : ''}
                    <a href={l.href}>{l.label}</a>
                  </span>
                ))}
              </p>
            )}
            {report.sources && <p className="jb-pdf-colophon-meta">Sources: {report.sources}</p>}
            {report.warnings && report.warnings.length > 0 && (
              <p className="jb-pdf-warn">
                <span className="jb-pdf-warn-label">Not covered</span>
                {report.warnings.join(' · ')}
              </p>
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
            {t.summary && (
              <p className="jb-pdf-part-summary">
                <ReportHtml html={t.summary} report={report} inline />
              </p>
            )}
            <div className="jb-pdf-blocks">
              {blocks.map((b, i) => (
                <PrintBlock key={`${t.id}:${i}`} block={b} report={report} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/**
 * The generator packs three different things into one headline string: the verdict label, the
 * evidence behind it, and the action that follows. Printed as a single paragraph under a heading
 * that repeats its own opening clause, they all read as equally (un)important. Splitting them lets
 * the cover rank them — the label is already the headline, the evidence is supporting, and the
 * action is the one line a reader has to act on.
 */
function splitHeadline(headline?: string | null, label?: string | null): { lead: string; next: string | null } {
  let rest = (headline ?? '').trim()
  if (label) {
    for (const sep of [' — ', ' – ', ' - ', ': ']) {
      if (rest.startsWith(label + sep)) {
        rest = rest.slice(label.length + sep.length)
        break
      }
    }
  }
  let next: string | null = null
  const at = rest.lastIndexOf('Next:')
  if (at > 0) {
    next = rest.slice(at + 'Next:'.length).trim()
    rest = rest.slice(0, at).trim()
  }
  return { lead: sentenceCase(rest), next }
}

/** The cover repeats the header strip's figures, so an identical stats block is dropped. */
function visibleBlocks(all: ReportBlock[], headerStats: ReportStat[]): ReportBlock[] {
  const digest = (items: ReportStat[]) => items.map((s) => `${s.label}=${s.value}`).join('|')
  const head = digest(headerStats)
  if (!head) return all
  return all.filter((b) => !(b.kind === 'stats' && digest(b.items) === head))
}

/**
 * Label first, value under it. With the label below, a value long enough to wrap (a pull-request
 * tally, say) pushed its own label down a line and knocked it out of alignment with every other
 * label in the row. Leading with the label puts them all on one baseline and lets values wrap
 * freely underneath.
 */
function Figure({ stat }: { stat: ReportStat }) {
  const c = toneColor(stat.tone)
  const toned = stat.tone && stat.tone !== 'neutral'
  return (
    <div className="jb-pdf-fig">
      <div className="jb-pdf-fig-label">{stat.label}</div>
      <div className="jb-pdf-fig-value" style={toned ? { color: c } : undefined}>
        <StatValue text={sentenceCase(String(stat.value ?? ''))} />
      </div>
      {stat.hint && <div className="jb-pdf-fig-hint">{stat.hint}</div>}
    </div>
  )
}

/**
 * A composite figure ("1 merged · 0 open · 1 declined") is several facts in one string. Left to
 * wrap on its own it broke wherever the line ran out — "…0 open · 1" then "declined" — which reads
 * as a sentence cut in half. Each fact is kept whole and the separator travels with the fact it
 * follows, so a break can only ever land between facts.
 */
function StatValue({ text }: { text: string }) {
  const parts = text.split(' · ')
  if (parts.length < 2) return <>{text}</>
  const last = parts.length - 1
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {/* The separator rides inside the no-wrap run so it can never start a line, but the
              space AFTER it stays outside — keep it in and there is no break opportunity left
              between facts at all, and the value overflows its column instead of wrapping. */}
          <span className="jb-pdf-seg">{i < last ? `${p} ·` : p}</span>
          {i < last ? ' ' : ''}
        </span>
      ))}
    </>
  )
}

/** Values like "merged" arrive lower-case from the generator and read as a dropped word under a
 *  capitalised label. Only the first letter is touched; numbers and keys are left alone. */
function sentenceCase(s: string): string {
  return /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s
}

/** Blocks that stay narrow enough to sit two-up; everything else takes the full measure. */
const NARROW = new Set<ReportBlock['kind']>(['kv', 'list', 'links'])

function PrintBlock({ block, report }: { block: ReportBlock; report: PrReport }) {
  const c = toneColor(block.tone)
  const wide = !NARROW.has(block.kind)
  return (
    <section className={`jb-pdf-block${wide ? ' jb-pdf-wide' : ''}`} style={{ borderLeftColor: c }}>
      {block.title && (
        <h3 className="jb-pdf-block-title" style={{ color: c }}>
          {block.title}
        </h3>
      )}
      {/* block.note is dropped on paper. It explains how to read the block ("rows are in
          verdict-rule order…") — scaffolding for someone exploring the app, and just noise in a
          document handed to a reader who wants the answer. The screen view still shows it. */}
      <BlockBody block={block} report={report} />
    </section>
  )
}

function BlockBody({ block, report }: { block: ReportBlock; report: PrReport }) {
  switch (block.kind) {
    case 'callout':
      return <ReportHtml html={block.body} report={report} className="jb-pdf-prose" />

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
                    <ReportHtml html={cell} report={report} inline />
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
          {block.items.map((card, i) => {
            const inner = (
              <>
                <div className="jb-pdf-card-head">
                  <span className="jb-pdf-card-title">
                    <ReportHtml html={card.title} report={report} inline />
                  </span>
                  {card.badge && (
                    <span className="jb-pdf-card-badge" style={{ color: toneColor(card.badgeTone) }}>
                      {card.badge}
                    </span>
                  )}
                </div>
                <ReportHtml html={card.body} report={report} className="jb-pdf-prose" />
                {card.detail && (
                  <p className="jb-pdf-card-detail">
                    <ReportHtml html={card.detail} report={report} inline />
                  </p>
                )}
              </>
            )
            return card.href ? (
              <a key={i} href={card.href} className="jb-pdf-card" style={{ borderLeftColor: toneColor(card.badgeTone) }}>
                {inner}
              </a>
            ) : (
              <div key={i} className="jb-pdf-card" style={{ borderLeftColor: toneColor(card.badgeTone) }}>
                {inner}
              </div>
            )
          })}
        </div>
      )

    case 'list':
      return (
        <ul className="jb-pdf-list">
          {block.items.map((it, i) => (
            <li key={i}>
              <span className="jb-pdf-dot jb-pdf-dot-sm" style={{ background: toneColor(it.tone) }} />
              <ReportHtml html={it.text} report={report} inline />
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
                <b>
                  <ReportHtml html={e.label} report={report} inline />
                </b>
                {e.detail ? (
                  <>
                    {' '}
                    — <ReportHtml html={e.detail} report={report} inline />
                  </>
                ) : null}
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
              <a href={l.href}>
                <b>{l.label}</b>
                <span className="jb-pdf-url">{l.href}</span>
              </a>
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
              <dd style={kv.tone && kv.tone !== 'neutral' ? { color: toneColor(kv.tone) } : undefined}>
                {kv.href ? (
                  <a href={kv.href}>{kv.value}</a>
                ) : (
                  <ReportHtml html={fmtReportMetadata(kv.label, kv.value, report.timeZone ?? APP_CONFIG.timeZone)} report={report} inline />
                )}
              </dd>
            </div>
          ))}
        </dl>
      )

    default:
      return null
  }
}
