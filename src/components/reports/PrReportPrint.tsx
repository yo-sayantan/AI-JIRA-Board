import type { ReactNode } from 'react'
import type {
  PrReport,
  ReportBlock,
  ReportCard,
  ReportCardsBlock,
  ReportKvBlock,
  ReportListBlock,
  ReportStat,
  ReportTab,
  ReportTableBlock,
  ReportTableRow,
  ReportTimelineBlock,
  ReportTone,
} from '../../lib/reportTypes'
import { toneColor } from '../../lib/reportTypes'
import { fmtDate, fmtDateTime, fmtReportMetadata } from '../../lib/format'
import { APP_CONFIG } from '../../lib/appConfig'
import { hrefForKey, shareableLinks } from '../../lib/reportLinks'
import { ReportHtml } from './ReportHtml'

/**
 * The report as a widescreen slide deck — a separate render from the on-screen overlay.
 *
 * Each page is one 16:9 slide, so the exported PDF can be cast or dropped straight into a
 * presentation. Slides are ordered for the audience: the first two answer "is it done, and what
 * happens next" for leadership; the middle carries the evidence a PM, Scrum Master or architect
 * wants; the appendix keeps sources for anyone auditing it. Every block in the report lands on
 * some slide — anything the planner does not place on purpose goes to "Additional detail".
 *
 * Hidden on screen and shown only in @media print.
 */

type Audience = 'Leadership' | 'PM / Scrum Master' | 'Architect / Tech lead' | 'Everyone'

interface Slide {
  id: string
  section: string
  title: string
  audience: Audience[]
  body: ReactNode
  /** The cover is drawn full-bleed and carries no running header or footer. */
  cover?: boolean
}

const RAG: Record<ReportTone, string> = {
  success: 'Green',
  warning: 'Amber',
  danger: 'Red',
  info: 'Blue',
  violet: 'Blue',
  neutral: 'Grey',
}

export function PrReportPrintDoc({ report, tabs }: { report: PrReport; tabs: ReportTab[] }) {
  const slides = planSlides(report, tabs)
  const total = slides.length
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  return (
    <div className="jb-pdf">
      {slides.map((s, i) =>
        s.cover ? (
          <section key={s.id} className="jb-slide jb-slide-cover">
            {s.body}
          </section>
        ) : (
          <section key={s.id} className="jb-slide">
            <header className="jb-slide-head">
              <div>
                <div className="jb-slide-eyebrow">{s.section}</div>
                <h2 className="jb-slide-title">{s.title}</h2>
              </div>
              <div className="jb-slide-aud">
                {s.audience.map((a) => (
                  <span key={a} className="jb-chip jb-chip-quiet">
                    {a}
                  </span>
                ))}
              </div>
            </header>
            <div className="jb-slide-body">{s.body}</div>
            <footer className="jb-slide-foot">
              <span className="jb-slide-foot-key">{report.key}</span>
              <span className="jb-slide-foot-title">{report.title}</span>
              <span>{fmtDate(report.generatedAt, zone)}</span>
              <span className="jb-slide-num">
                {i + 1} / {total}
              </span>
            </footer>
          </section>
        ),
      )}
    </div>
  )
}

// ── Planning ────────────────────────────────────────────────────────────────

function planSlides(report: PrReport, tabs: ReportTab[]): Slide[] {
  const used = new Set<ReportBlock>()
  const take = <T extends ReportBlock>(match: (b: ReportBlock, tab: ReportTab) => boolean): T | null => {
    for (const tab of tabs) {
      for (const b of tab.blocks) {
        if (!used.has(b) && match(b, tab)) {
          used.add(b)
          return b as T
        }
      }
    }
    return null
  }
  const titled = (re: RegExp, kind?: ReportBlock['kind']) => (b: ReportBlock) =>
    (!kind || b.kind === kind) && re.test(b.title ?? '')

  const decision = take(titled(/^decision$/i, 'callout'))
  take((b) => b.kind === 'stats' && sameStats(b.items, report.stats))
  const gates = take<ReportTableBlock>(titled(/gate checklist/i, 'table'))
  const releaseGate = take(titled(/^release gate$/i, 'callout'))
  const evidence = take<ReportTableBlock>(titled(/evidence/i, 'table'))
  const prCards = take<ReportCardsBlock>(titled(/pull request/i, 'cards'))
  const timeline = take<ReportTimelineBlock>((b) => b.kind === 'timeline')
  const proofs: ReportTableBlock[] = []
  for (let p = take<ReportTableBlock>(titled(/^proof/i, 'table')); p; p = take<ReportTableBlock>(titled(/^proof/i, 'table'))) proofs.push(p)
  const blocking = take<ReportTableBlock>(titled(/still blocks|blocks closure|open scope/i, 'table'))
  const nextActions = take<ReportListBlock>(titled(/next action/i, 'list'))
  const consistency = take(titled(/consistency/i, 'callout'))
  const changeShape = take(titled(/change shape/i, 'stats'))
  const perFile = take<ReportCardsBlock>(titled(/per-file|files?/i, 'cards'))
  const reviewFocus = take<ReportListBlock>(titled(/review focus/i, 'list'))
  const prodProof = take(titled(/production proof/i, 'callout'))
  const deployment = take<ReportKvBlock>(titled(/deploy/i, 'kv'))
  const risks = take<ReportTableBlock>(titled(/risk/i, 'table'))
  const links = take((b) => b.kind === 'links')
  const runMeta = take<ReportKvBlock>(titled(/run metadata|metadata/i, 'kv'))

  const facts = deliveryFacts(report, evidence, prCards)
  const gateTally = tallyGates(gates)
  const riskCount = risks?.rows.filter((r) => !/none inferred/i.test(plain(r.cells[0] ?? ''))).length ?? 0

  const slides: Slide[] = []
  const add = (s: Omit<Slide, 'id'> & { id?: string }) => slides.push({ ...s, id: s.id ?? `s${slides.length}` })

  add({
    id: 'cover',
    section: '',
    title: '',
    audience: ['Everyone'],
    cover: true,
    body: <CoverSlide report={report} />,
  })

  add({
    id: 'summary',
    section: 'Executive summary',
    title: 'Where this ticket stands',
    audience: ['Leadership', 'PM / Scrum Master'],
    body: (
      <SummarySlide
        report={report}
        decision={decision}
        facts={facts}
        gateTally={gateTally}
        riskCount={risks ? riskCount : null}
        fileCount={perFile?.items.length ?? null}
      />
    ),
  })

  if (gates) {
    for (const [i, rows] of chunk(gates.rows, 11).entries()) {
      add({
        section: 'Delivery gates',
        title: i === 0 ? 'Is it ready to close?' : 'Delivery gates (continued)',
        audience: ['PM / Scrum Master', 'Leadership'],
        body: (
          <>
            {i === 0 && gateTally && <GateBar tally={gateTally} />}
            <StatusTable block={{ ...gates, rows }} report={report} />
            {i === 0 && releaseGate && releaseGate.kind === 'callout' && (
              <Callout title="Release gate" tone={releaseGate.tone} html={releaseGate.body} report={report} />
            )}
          </>
        ),
      })
    }
  } else if (releaseGate && releaseGate.kind === 'callout') {
    add({
      section: 'Delivery gates',
      title: 'Release gate',
      audience: ['PM / Scrum Master', 'Leadership'],
      body: <Callout title="Release gate" tone={releaseGate.tone} html={releaseGate.body} report={report} />,
    })
  }

  if (blocking || nextActions || consistency) {
    add({
      section: 'Open items',
      title: blocking && blocking.rows.length ? 'What still needs to happen' : 'Nothing is blocking closure',
      audience: ['PM / Scrum Master', 'Leadership'],
      body: (
        <div className="jb-grid-2">
          <div className="jb-col-span">
            {blocking && blocking.rows.length > 0 ? (
              <StatusTable block={blocking} report={report} />
            ) : (
              <Callout title="Open scope" tone="success" html="<p>No open item blocks closure.</p>" report={report} />
            )}
          </div>
          {nextActions && <ActionList block={nextActions} report={report} />}
          {consistency && consistency.kind === 'callout' && (
            <Callout title={consistency.title ?? 'Status consistency'} tone={consistency.tone} html={consistency.body} report={report} />
          )}
        </div>
      ),
    })
  }

  if (prCards || timeline) {
    const cardChunks = prCards ? chunk(prCards.items, 4) : [[]]
    cardChunks.forEach((cards, i) => {
      add({
        section: 'Code review',
        title: i === 0 ? 'Pull requests and delivery timeline' : 'Pull requests (continued)',
        audience: ['Architect / Tech lead', 'PM / Scrum Master'],
        body: (
          <div className={timeline && i === 0 ? 'jb-split' : ''}>
            <div>
              {cards.length > 0 && <h3 className="jb-h3">Pull requests</h3>}
              <div className="jb-cards jb-cards-2">
                {cards.map((c, j) => (
                  <Card key={j} card={c} report={report} />
                ))}
              </div>
            </div>
            {timeline && i === 0 && <Timeline block={timeline} report={report} />}
          </div>
        ),
      })
    })
  }

  if (evidence) {
    for (const [i, rows] of chunk(evidence.rows, 9).entries()) {
      add({
        section: 'Evidence',
        title: i === 0 ? 'What the systems show' : 'Evidence (continued)',
        audience: ['Architect / Tech lead', 'PM / Scrum Master'],
        body: <PlainTable block={{ ...evidence, rows }} report={report} />,
      })
    }
  }

  if (proofs.length) {
    add({
      section: 'Quality and security',
      title: 'Build, scan and runtime proof',
      audience: ['Architect / Tech lead'],
      body: (
        <div className="jb-stack">
          {proofs.map((p, i) => (
            <div key={i}>
              <h3 className="jb-h3">{p.title?.replace(/^proof\s*·?\s*/i, '') || 'Proof'}</h3>
              <StatusTable block={p} report={report} />
            </div>
          ))}
        </div>
      ),
    })
  }

  if (changeShape || reviewFocus || deployment || prodProof) {
    add({
      section: 'Technical assessment',
      title: 'Change overview and release readiness',
      audience: ['Architect / Tech lead'],
      body: (
        <div className="jb-grid-2">
          {changeShape && changeShape.kind === 'stats' && (
            <div className="jb-col-span">
              <Kpis stats={changeShape.items} />
            </div>
          )}
          {reviewFocus && <ActionList block={reviewFocus} report={report} title="Review focus" />}
          <div className="jb-stack">
            {deployment && <KvCard block={deployment} report={report} />}
            {prodProof && prodProof.kind === 'callout' && (
              <Callout title="Production proof" tone={prodProof.tone} html={prodProof.body} report={report} />
            )}
          </div>
        </div>
      ),
    })
  }

  if (risks) {
    add({
      section: 'Risk',
      title: riskCount ? `${riskCount} risk${riskCount === 1 ? '' : 's'} and how to handle ${riskCount === 1 ? 'it' : 'them'}` : 'No risks found',
      audience: ['Architect / Tech lead', 'Leadership'],
      body: <PlainTable block={risks} report={report} />,
    })
  }

  if (perFile && perFile.items.length) {
    for (const [i, cards] of chunk(perFile.items, 6).entries()) {
      add({
        section: 'Technical assessment',
        title: i === 0 ? `What changed, file by file (${perFile.items.length})` : 'What changed (continued)',
        audience: ['Architect / Tech lead'],
        body: (
          <div className="jb-cards jb-cards-3">
            {cards.map((c, j) => (
              <Card key={j} card={c} report={report} compact />
            ))}
          </div>
        ),
      })
    }
  }

  const leftovers = tabs.flatMap((t) => t.blocks.filter((b) => !used.has(b)).map((b) => ({ tab: t, block: b })))
  for (const group of chunk(leftovers, 2)) {
    add({
      section: 'Additional detail',
      title: group.map((g) => g.block.title || g.tab.title).join(' · '),
      audience: ['Everyone'],
      body: (
        <div className="jb-stack">
          {group.map((g, i) => (
            <GenericBlock key={i} block={g.block} report={report} />
          ))}
        </div>
      ),
    })
  }

  add({
    id: 'appendix',
    section: 'Appendix',
    title: 'Sources and how this report was made',
    audience: ['Everyone'],
    body: <AppendixSlide report={report} links={links} runMeta={runMeta} />,
  })

  const cover = slides[0]
  cover.body = <CoverSlide report={report} agenda={slides.slice(1)} />
  return slides
}

// ── Slides ──────────────────────────────────────────────────────────────────

function CoverSlide({ report, agenda = [] }: { report: PrReport; agenda?: Slide[] }) {
  const v = report.verdict
  const tone = v?.tone ?? 'neutral'
  const c = toneColor(tone)
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  const ticketHref = hrefForKey(report, report.key)
  const sections = dedupeSections(agenda)
  return (
    <div className="jb-cover">
      <div className="jb-cover-band" style={{ background: c }} />
      <div className="jb-cover-top">
        <span>PR readiness report</span>
        <span>{fmtDate(report.generatedAt, zone)}</span>
      </div>
      <div className="jb-cover-main">
        <div className="jb-cover-left">
          {ticketHref ? (
            <a href={ticketHref} className="jb-cover-key">
              {report.key}
            </a>
          ) : (
            <div className="jb-cover-key">{report.key}</div>
          )}
          <h1 className="jb-cover-title">{report.title}</h1>
          <div className="jb-cover-verdict">
            <span className="jb-rag" style={{ background: c }}>
              {RAG[tone]}
            </span>
            <span className="jb-cover-label">{v?.label ?? 'No verdict'}</span>
          </div>
          {(v?.summary || v?.reason) && (
            <p className="jb-cover-lead">
              <ReportHtml html={v?.summary || v?.reason || ''} report={report} inline />
            </p>
          )}
        </div>
        {typeof v?.score === 'number' && (
          <div className="jb-cover-score">
            <ScoreRing score={v.score} color={c} size={150} dark />
            <span>Readiness score</span>
          </div>
        )}
      </div>
      <div className="jb-cover-foot">
        <div>
          <div className="jb-cover-foot-label">In this deck</div>
          <ol className="jb-cover-agenda">
            {sections.map((s) => (
              <li key={s.section}>
                <span className="jb-cover-agenda-n">{s.first}</span>
                {s.section}
              </li>
            ))}
          </ol>
        </div>
        <div className="jb-cover-meta">
          <div className="jb-cover-foot-label">Prepared</div>
          <div>{fmtDateTime(report.enrichedAt || report.generatedAt, zone)}</div>
          <div>{report.enriched ? 'Measured from Jira and Bitbucket, reviewed by AI' : 'Measured from Jira and Bitbucket'}</div>
        </div>
      </div>
    </div>
  )
}

function SummarySlide({
  report,
  decision,
  facts,
  gateTally,
  riskCount,
  fileCount,
}: {
  report: PrReport
  decision: ReportBlock | null
  facts: { label: string; value: string; href?: string | null }[]
  gateTally: GateTally | null
  riskCount: number | null
  fileCount: number | null
}) {
  const v = report.verdict
  const tone = v?.tone ?? 'neutral'
  const c = toneColor(tone)
  const next = v?.next
  const impact = decision && decision.kind === 'callout' ? italicLine(decision.body) : null
  const kpis: ReportStat[] = [
    ...(typeof v?.score === 'number' ? [{ label: 'Readiness', value: `${v.score} / 100`, tone }] : []),
    ...(gateTally ? [{ label: 'Gates passed', value: `${gateTally.pass} of ${gateTally.total}`, tone: gateTally.fail ? 'danger' : gateTally.warn ? 'warning' : 'success' } as ReportStat] : []),
    ...report.stats.filter((s) => !/^last pr activity$/i.test(s.label)),
    ...(riskCount != null ? [{ label: 'Risks', value: String(riskCount), tone: riskCount ? 'warning' : 'success' } as ReportStat] : []),
    ...(fileCount != null ? [{ label: 'Files reviewed', value: String(fileCount), tone: 'neutral' } as ReportStat] : []),
  ].slice(0, 8)

  return (
    <div className="jb-summary">
      <div className="jb-summary-status" style={{ borderColor: c }}>
        <div className="jb-summary-row">
          <span className="jb-rag" style={{ background: c }}>
            {RAG[tone]}
          </span>
          <span className="jb-summary-label" style={{ color: c }}>
            {v?.label ?? 'No verdict'}
          </span>
        </div>
        {v?.summary && (
          <p className="jb-summary-lead">
            <ReportHtml html={v.summary} report={report} inline />
          </p>
        )}
        {v?.reason && (
          <p className="jb-summary-why">
            <span className="jb-tag">Why</span>
            <ReportHtml html={v.reason} report={report} inline />
          </p>
        )}
        {impact && (
          <p className="jb-summary-why">
            <span className="jb-tag">Business impact</span>
            <ReportHtml html={impact} report={report} inline />
          </p>
        )}
      </div>

      <div className="jb-summary-side">
        <div className="jb-next" style={{ borderColor: next ? c : toneColor('success') }}>
          <div className="jb-next-label">Next step</div>
          {next?.action ? (
            <>
              <div className="jb-next-action">
                <ReportHtml html={sentenceCase(next.action)} report={report} inline />
              </div>
              <div className="jb-next-meta">
                {next.owner && (
                  <span>
                    <b>Owner</b> {next.owner}
                  </span>
                )}
                {next.due && (
                  <span>
                    <b>Due</b> {next.due}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="jb-next-action">Nothing outstanding. No action needed.</div>
          )}
        </div>
        {facts.length > 0 && (
          <dl className="jb-facts">
            {facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.href ? <a href={f.href}>{f.value}</a> : <ReportHtml html={f.value} report={report} inline />}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="jb-summary-kpis">
        <Kpis stats={kpis} />
      </div>
    </div>
  )
}

function AppendixSlide({ report, links, runMeta }: { report: PrReport; links: ReportBlock | null; runMeta: ReportKvBlock | null }) {
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  const all = [...(links && links.kind === 'links' ? links.items : []), ...shareableLinks(report)]
  const seen = new Set<string>()
  const uniq = all.filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true)))
  return (
    <div className="jb-split">
      <div>
        <h3 className="jb-h3">Links</h3>
        <ul className="jb-links">
          {uniq.map((l) => (
            <li key={l.href}>
              <a href={l.href}>
                <b>{l.label}</b>
                <span>{l.href}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <div className="jb-stack">
        <div>
          <h3 className="jb-h3">How this report was made</h3>
          <p className="jb-prose">
            {report.enriched
              ? 'Status, reviews and gates are measured directly from Jira and Bitbucket. An AI pass then read the ticket, the pull requests and linked specs to add business impact, per-file notes and risks. AI findings are marked as such in the app.'
              : 'Status, reviews and gates are measured directly from Jira and Bitbucket. No AI interpretation was applied.'}
          </p>
          {report.sources && <p className="jb-prose jb-muted">Sources: {report.sources}</p>}
        </div>
        {report.warnings && report.warnings.length > 0 && (
          <Callout title="Not covered" tone="warning" html={`<p>${report.warnings.map(esc).join(' · ')}</p>`} report={report} />
        )}
        <dl className="jb-facts">
          <div>
            <dt>Generated</dt>
            <dd>{fmtDateTime(report.generatedAt, zone)}</dd>
          </div>
          {report.enriched && report.enrichedAt && (
            <div>
              <dt>AI reviewed</dt>
              <dd>{fmtDateTime(report.enrichedAt, zone)}</dd>
            </div>
          )}
          {report.generator && (
            <div>
              <dt>Generator</dt>
              <dd>{report.generator}</dd>
            </div>
          )}
          {runMeta?.items
            .filter((kv) => !/^generated$/i.test(kv.label))
            .map((kv) => (
              <div key={kv.label}>
                <dt>{kv.label}</dt>
                <dd>
                  <ReportHtml html={fmtReportMetadata(kv.label, kv.value, zone)} report={report} inline />
                </dd>
              </div>
            ))}
        </dl>
      </div>
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Kpis({ stats }: { stats: ReportStat[] }) {
  return (
    <div className="jb-kpis" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(stats.length, 8))}, minmax(0, 1fr))` }}>
      {stats.map((s, i) => {
        const toned = s.tone && s.tone !== 'neutral'
        const c = toneColor(s.tone)
        return (
          <div key={i} className="jb-kpi" style={{ borderTopColor: toned ? c : '#cbd2de' }}>
            <div className="jb-kpi-label">{s.label}</div>
            <div className="jb-kpi-value" style={toned ? { color: c } : undefined}>
              <Segments text={sentenceCase(String(s.value ?? ''))} />
            </div>
            {s.hint && <div className="jb-kpi-hint">{s.hint}</div>}
          </div>
        )
      })}
    </div>
  )
}

interface GateTally {
  pass: number
  fail: number
  warn: number
  total: number
}

function GateBar({ tally }: { tally: GateTally }) {
  const pct = (n: number) => `${tally.total ? (100 * n) / tally.total : 0}%`
  return (
    <div className="jb-gatebar">
      <div className="jb-gatebar-track">
        <span style={{ width: pct(tally.pass), background: toneColor('success') }} />
        <span style={{ width: pct(tally.warn), background: toneColor('warning') }} />
        <span style={{ width: pct(tally.fail), background: toneColor('danger') }} />
      </div>
      <div className="jb-gatebar-legend">
        <span>
          <i style={{ background: toneColor('success') }} /> {tally.pass} passed
        </span>
        <span>
          <i style={{ background: toneColor('warning') }} /> {tally.warn} not verified
        </span>
        <span>
          <i style={{ background: toneColor('danger') }} /> {tally.fail} failing
        </span>
      </div>
    </div>
  )
}

/** A table whose state-like column is drawn as a coloured chip, so pass/fail reads from across a room. */
function StatusTable({ block, report }: { block: ReportTableBlock; report: PrReport }) {
  const stateCol = block.headers.findIndex((h) => /^(state|status|result)$/i.test(h.trim()))
  const blockCol = block.headers.findIndex((h) => /blocks closure/i.test(h))
  return (
    <table className="jb-table">
      <thead>
        <tr>
          {block.headers.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((r, i) => {
          const t = rowTone(r, stateCol)
          return (
            <tr key={i} style={{ boxShadow: `inset 3px 0 0 ${toneColor(t)}` }}>
              {r.cells.map((cell, j) => (
                <td key={j} className={j === 0 ? 'jb-td-lead' : undefined}>
                  {j === stateCol ? (
                    <span className="jb-chip" style={{ color: toneColor(t), borderColor: toneColor(t), background: `${toneColor(t)}14` }}>
                      {plain(cell)}
                    </span>
                  ) : j === blockCol ? (
                    <span className={/^yes/i.test(plain(cell)) ? 'jb-strong' : 'jb-muted'}>{plain(cell)}</span>
                  ) : (
                    <ReportHtml html={cell} report={report} inline />
                  )}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function PlainTable({ block, report }: { block: ReportTableBlock; report: PrReport }) {
  return (
    <table className="jb-table">
      <thead>
        <tr>
          {block.headers.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((r, i) => (
          <tr key={i} style={r.tone && r.tone !== 'neutral' ? { boxShadow: `inset 3px 0 0 ${toneColor(r.tone)}` } : undefined}>
            {r.cells.map((cell, j) => (
              <td key={j} className={j === 0 ? 'jb-td-lead' : undefined}>
                <ReportHtml html={cell} report={report} inline />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Callout({ title, tone, html, report }: { title: string; tone?: ReportTone; html: string; report: PrReport }) {
  const c = toneColor(tone)
  return (
    <section className="jb-callout" style={{ borderLeftColor: c, background: `${c}0f` }}>
      <div className="jb-callout-title" style={{ color: c }}>
        {title}
      </div>
      <ReportHtml html={html} report={report} className="jb-prose" />
    </section>
  )
}

function ActionList({ block, report, title }: { block: ReportListBlock; report: PrReport; title?: string }) {
  return (
    <section>
      <h3 className="jb-h3">{title ?? block.title ?? 'Next actions'}</h3>
      <ol className="jb-actions">
        {block.items.map((it, i) => (
          <li key={i}>
            <span className="jb-action-n" style={{ background: toneColor(it.tone) }}>
              {i + 1}
            </span>
            <span>
              <ReportHtml html={it.text} report={report} inline />
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function KvCard({ block, report }: { block: ReportKvBlock; report: PrReport }) {
  const zone = report.timeZone ?? APP_CONFIG.timeZone
  return (
    <section>
      <h3 className="jb-h3">{block.title ?? 'Details'}</h3>
      <dl className="jb-facts">
        {block.items.map((kv, i) => (
          <div key={i}>
            <dt>{kv.label}</dt>
            <dd style={kv.tone && kv.tone !== 'neutral' ? { color: toneColor(kv.tone) } : undefined}>
              {kv.href ? <a href={kv.href}>{kv.value}</a> : <ReportHtml html={fmtReportMetadata(kv.label, kv.value, zone)} report={report} inline />}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Card({ card, report, compact }: { card: ReportCard; report: PrReport; compact?: boolean }) {
  const c = toneColor(card.badgeTone)
  const inner = (
    <>
      <div className="jb-card-head">
        <span className="jb-card-title">
          <ReportHtml html={card.title} report={report} inline />
        </span>
        {card.badge && (
          <span className="jb-chip" style={{ color: c, borderColor: c, background: `${c}14` }}>
            {card.badge}
          </span>
        )}
      </div>
      <ReportHtml html={card.body} report={report} className={`jb-prose${compact ? ' jb-prose-sm' : ''}`} />
      {card.detail && (
        <p className="jb-card-detail">
          <ReportHtml html={card.detail} report={report} inline />
        </p>
      )}
    </>
  )
  return card.href ? (
    <a href={card.href} className="jb-card" style={{ borderTopColor: c }}>
      {inner}
    </a>
  ) : (
    <div className="jb-card" style={{ borderTopColor: c }}>
      {inner}
    </div>
  )
}

function Timeline({ block, report }: { block: ReportTimelineBlock; report: PrReport }) {
  const items = block.items.slice(0, 12)
  return (
    <section>
      <h3 className="jb-h3">{block.title ?? 'Timeline'}</h3>
      <ol className="jb-timeline">
        {items.map((e, i) => (
          <li key={i}>
            <span className="jb-tl-dot" style={{ background: toneColor(e.tone) }} />
            <span className="jb-tl-when">{e.when ?? '—'}</span>
            <span className="jb-tl-what">
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
      {block.items.length > items.length && <p className="jb-muted jb-small">+{block.items.length - items.length} earlier events in the app</p>}
    </section>
  )
}

function GenericBlock({ block, report }: { block: ReportBlock; report: PrReport }) {
  switch (block.kind) {
    case 'callout':
      return <Callout title={block.title ?? ''} tone={block.tone} html={block.body} report={report} />
    case 'stats':
      return (
        <section>
          {block.title && <h3 className="jb-h3">{block.title}</h3>}
          <Kpis stats={block.items} />
        </section>
      )
    case 'table':
      return (
        <section>
          {block.title && <h3 className="jb-h3">{block.title}</h3>}
          <StatusTable block={block} report={report} />
        </section>
      )
    case 'cards':
      return (
        <section>
          {block.title && <h3 className="jb-h3">{block.title}</h3>}
          <div className="jb-cards jb-cards-3">
            {block.items.map((c, i) => (
              <Card key={i} card={c} report={report} compact />
            ))}
          </div>
        </section>
      )
    case 'list':
      return <ActionList block={block} report={report} />
    case 'timeline':
      return <Timeline block={block} report={report} />
    case 'kv':
      return <KvCard block={block} report={report} />
    case 'links':
      return (
        <section>
          <h3 className="jb-h3">{block.title ?? 'Links'}</h3>
          <ul className="jb-links">
            {block.items.map((l) => (
              <li key={l.href}>
                <a href={l.href}>
                  <b>{l.label}</b>
                  <span>{l.href}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )
    default:
      return null
  }
}

function ScoreRing({ score, color, size, dark }: { score: number; color: string; size: number; dark?: boolean }) {
  const pct = Math.max(0, Math.min(100, score))
  const stroke = size * 0.09
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="jb-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={dark ? 'rgba(255,255,255,0.14)' : '#e6e9ef'} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * circ} ${circ}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize={size * 0.3} fontWeight={800} fill={dark ? '#fff' : '#10151f'}>
        {pct}
      </text>
    </svg>
  )
}

/** Keep each fact of "1 merged · 0 open · 1 declined" whole so a wrap only lands between facts. */
function Segments({ text }: { text: string }) {
  const parts = text.split(' · ')
  if (parts.length < 2) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          <span className="jb-nowrap">{i < parts.length - 1 ? `${p} ·` : p}</span>
          {i < parts.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function deliveryFacts(report: PrReport, evidence: ReportTableBlock | null, prCards: ReportCardsBlock | null) {
  const facts: { label: string; value: string; href?: string | null }[] = []
  const epic = report.links?.find((l) => /^epic\b/i.test(l.label))
  if (epic) facts.push({ label: 'Epic', value: epic.label.replace(/^epic\s*/i, ''), href: epic.href })
  const fix = evidence?.rows.find((r) => /fixversion/i.test(plain(r.cells[0] ?? '')))
  if (fix) facts.push({ label: 'Fix version', value: plain(fix.cells[1] ?? '') })
  if (report.verdict?.next?.due) facts.push({ label: 'Sprint', value: report.verdict.next.due })
  const repos = [...new Set((prCards?.items ?? []).map((c) => plain(c.title).split(' · ')[1]).filter(Boolean))]
  if (repos.length) facts.push({ label: repos.length === 1 ? 'Repository' : 'Repositories', value: repos.join(', ') })
  const prs = prCards?.items.length
  if (prs) facts.push({ label: 'Pull requests', value: `${prs} (${prCards!.items.map((c) => c.badge).filter(Boolean).join(', ')})` })
  const subs = report.links?.filter((l) => /^sub-?task\b/i.test(l.label)).length
  if (subs) facts.push({ label: 'Sub-tasks', value: String(subs) })
  return facts
}

function tallyGates(gates: ReportTableBlock | null): GateTally | null {
  if (!gates || !gates.rows.length) return null
  const col = gates.headers.findIndex((h) => /^(state|status|result)$/i.test(h.trim()))
  const tally = { pass: 0, fail: 0, warn: 0, total: gates.rows.length }
  for (const r of gates.rows) {
    const t = rowTone(r, col)
    if (t === 'success') tally.pass++
    else if (t === 'danger') tally.fail++
    else tally.warn++
  }
  return tally
}

function rowTone(r: ReportTableRow, stateCol: number): ReportTone {
  const s = stateCol >= 0 ? plain(r.cells[stateCol] ?? '').toLowerCase() : ''
  if (s) {
    if (/^(pass|passed|done|merged|approved|ok|green|scan read|success)/.test(s)) return 'success'
    if (/(not verified|unknown|pending|n\/a|skipped|not run)/.test(s)) return 'warning'
    if (/(fail|block|still open|declined|changes|missing|open)/.test(s)) return 'danger'
  }
  return r.tone && r.tone !== 'neutral' ? r.tone : 'neutral'
}

function sameStats(a: ReportStat[], b: ReportStat[]) {
  const d = (x: ReportStat[]) => x.map((s) => `${s.label}=${s.value}`).join('|')
  return !!d(b) && d(a) === d(b)
}

/** The AI business-impact line is appended to the Decision callout as a trailing italic paragraph. */
function italicLine(html: string): string | null {
  const m = html.match(/<p><i>([\s\S]*?)<\/i><\/p>\s*$/)
  if (!m) return null
  const text = m[1].trim()
  return /^(task|bug|story|sub-task|epic|dev task|security)\s·/i.test(plain(text)) ? null : text
}

function dedupeSections(slides: Slide[]) {
  const out: { section: string; first: number }[] = []
  slides.forEach((s, i) => {
    if (!out.some((o) => o.section === s.section)) out.push({ section: s.section, first: i + 2 })
  })
  return out
}

function chunk<T>(items: T[], size: number): T[][] {
  if (!items.length) return []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sentenceCase(s: string): string {
  return /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s
}
