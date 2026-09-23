// ─────────────────────────────────────────────────────────────────────────
// PR READINESS REPORT — the data contract for  jira-intern/reports/<KEY>.json
//
// One report per ticket that has a pull request. Produced in two passes by
// jira-intern/pr_report.py (deterministic base, always) and the AI enrichment
// pass driven by jira-intern/prompts/pr-readiness-prompt.md (optional). Keep the
// three in sync. The app renders a report GENERICALLY from its block kinds — a
// new kind of content is a new block, not a new component per report.
// ─────────────────────────────────────────────────────────────────────────

/** Semantic colour. success=go · warning=needs attention · danger=blocking · info=context · violet=AI-derived. */
export type ReportTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'violet'

/** Where a block's content came from — so a reader can tell measured facts from AI reasoning. */
export type ReportProvenance = 'derived' | 'ai' | 'unknown'

interface BlockBase {
  title?: string | null
  tone?: ReportTone
  provenance?: ReportProvenance
  /** Small caption under the block (e.g. "from Bitbucket PR 80, read 2026-09-18"). */
  note?: string | null
}

export interface ReportCalloutBlock extends BlockBase {
  kind: 'callout'
  /** Light HTML (sanitised by the app). */
  body: string
}
export interface ReportStat {
  label: string
  value: string
  tone?: ReportTone
  hint?: string | null
}
export interface ReportStatsBlock extends BlockBase {
  kind: 'stats'
  items: ReportStat[]
}
export interface ReportTableRow {
  cells: string[]
  tone?: ReportTone
}
export interface ReportTableBlock extends BlockBase {
  kind: 'table'
  headers: string[]
  rows: ReportTableRow[]
}
export interface ReportCard {
  title: string
  badge?: string | null
  badgeTone?: ReportTone
  /** Light HTML. */
  body: string
  detail?: string | null
  href?: string | null
}
export interface ReportCardsBlock extends BlockBase {
  kind: 'cards'
  items: ReportCard[]
}
export interface ReportListItem {
  text: string
  tone?: ReportTone
}
export interface ReportListBlock extends BlockBase {
  kind: 'list'
  items: ReportListItem[]
  ordered?: boolean
}
export interface ReportTimelineItem {
  when?: string | null
  label: string
  detail?: string | null
  tone?: ReportTone
}
export interface ReportTimelineBlock extends BlockBase {
  kind: 'timeline'
  items: ReportTimelineItem[]
}
export interface ReportLink {
  label: string
  href: string
}
export interface ReportLinksBlock extends BlockBase {
  kind: 'links'
  items: ReportLink[]
}
export interface ReportKvItem {
  label: string
  value: string
  tone?: ReportTone
  href?: string | null
}
export interface ReportKvBlock extends BlockBase {
  kind: 'kv'
  items: ReportKvItem[]
}

export type ReportBlock =
  | ReportCalloutBlock
  | ReportStatsBlock
  | ReportTableBlock
  | ReportCardsBlock
  | ReportListBlock
  | ReportTimelineBlock
  | ReportLinksBlock
  | ReportKvBlock

/** A coloured tab. Its tone is the worst tone among its blocks unless set explicitly. */
export interface ReportTab {
  id: string
  title: string
  tone: ReportTone
  /** Optional count/label shown on the tab (e.g. "3 open"). */
  badge?: string | number | null
  /** One line shown under the tab title when the tab is active. */
  summary?: string | null
  blocks: ReportBlock[]
}

export interface ReportVerdict {
  /** Stable id: ready | at-risk | blocked | merged-awaiting-release | shipped | needs-review | … */
  id: string
  label: string
  tone: ReportTone
  /** The 2-second read: one sentence, plain English, no jargon. */
  headline: string
  /** Optional second sentence for the "so what". */
  summary?: string | null
  /** 0–100 readiness score (derived), null when not meaningful. */
  score?: number | null
  provenance?: ReportProvenance
}

export interface PrReport {
  schemaVersion: number
  key: string
  title: string
  /** IANA timezone used to generate and display report timestamps. */
  timeZone?: string | null
  /** ISO-8601 — when the base report was built. */
  generatedAt: string
  /** Hash of the PR set (ids + states + approvals + comments + updatedAt) the report describes. */
  fingerprint: string
  /** True once the AI pass has rewritten the report; false = deterministic base only. */
  enriched: boolean
  enrichedAt?: string | null
  /** e.g. "pr_report.py 1" or "cursor-agent · auto". */
  generator?: string | null
  verdict: ReportVerdict
  /** At-a-glance row shown above the tabs. */
  stats: ReportStat[]
  tabs: ReportTab[]
  links: ReportLink[]
  /** One line: which systems were consulted. */
  sources?: string | null
  /** Things the generator could not verify (shown, never hidden). */
  warnings?: string[]
}

/** Header-only view of a report — what /api/reports and the drawer button need. */
export interface PrReportSummary {
  key: string
  title?: string | null
  timeZone?: string | null
  generatedAt?: string | null
  enrichedAt?: string | null
  enriched: boolean
  fingerprint?: string | null
  verdict?: ReportVerdict | null
}

export function summarizeReport(r: PrReport): PrReportSummary {
  return {
    key: r.key,
    title: r.title ?? null,
    timeZone: r.timeZone ?? null,
    generatedAt: r.generatedAt ?? null,
    enrichedAt: r.enrichedAt ?? null,
    enriched: !!r.enriched,
    fingerprint: r.fingerprint ?? null,
    verdict: r.verdict ?? null,
  }
}

/** The same semantic colours the rest of the board uses (columns, pills, badges). */
export const TONE_COLOR: Record<ReportTone, string> = {
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#3b82f6',
  neutral: '#64748b',
  violet: '#a855f7',
}

export function toneColor(t?: ReportTone | null): string {
  return TONE_COLOR[t ?? 'neutral'] ?? TONE_COLOR.neutral
}

/** Severity order for "worst tone wins" roll-ups (tabs, verdict fallbacks). */
const TONE_RANK: Record<ReportTone, number> = { danger: 4, warning: 3, violet: 2, info: 1, neutral: 0, success: 0 }
export function worstTone(tones: Array<ReportTone | undefined | null>): ReportTone {
  let best: ReportTone = 'neutral'
  for (const t of tones) if (t && TONE_RANK[t] > TONE_RANK[best]) best = t
  return best
}
