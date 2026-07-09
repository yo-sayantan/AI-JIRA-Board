// ─────────────────────────────────────────────────────────────────────────
// THE CONTRACT.
// This file is the single source of truth for the shape of the data that
// `jira-intern` dumps into  jira-intern/data.json  (+ data.js).
// intern-prompt.md documents the exact same schema in prose — keep them in sync.
// ─────────────────────────────────────────────────────────────────────────

/** Board columns. The intern maps every raw Jira status onto one of these. */
export type ColumnKey = 'todo' | 'prog' | 'rev' | 'qa' | 'done' | 'hold'

export type PrState = 'approved' | 'comments' | 'changes' | 'merged' | 'declined' | 'none'

export interface PullRequest {
  state: PrState
  url?: string | null
  id?: string | number | null
  title?: string | null
  approvals?: number | null
  /** Unresolved (open) review comments. A mergeable PR has 0 of these. */
  openComments?: number | null
  /** Total review comments ever added on the PR. */
  commentsTotal?: number | null
  /** How many of those comments are resolved. */
  commentsResolved?: number | null
  reviewers?: string[]
  sourceBranch?: string | null
  destinationBranch?: string | null
  merged?: boolean
  mergedAt?: string | null
}

export interface Comment {
  author?: string | null
  when?: string | null
  body?: string | null // light HTML allowed
}

export interface LinkRef {
  key?: string | null
  url?: string | null
  title?: string | null
  summary?: string | null
  excerpt?: string | null
  status?: string | null
  relation?: string | null // epic / parent / blocks / relates to ...
  reachable?: boolean | null
}

export interface UpdateLogEntry {
  when?: string | null
  text?: string | null
}

/** A fully-briefed, actively-tracked ticket (rich detail). */
export interface Ticket {
  key: string
  title: string
  /** Raw Jira status text, e.g. "Ready4Review". */
  status: string
  /** Mapped board column. The intern decides this; the app trusts it. */
  column: ColumnKey
  type?: string | null
  priority?: string | null
  storyPoints?: number | null
  /** Primary REAL branch (from Bitbucket), not a predicted name. */
  branch?: string | null
  /** All real branches associated with the ticket (a ticket may have several). */
  branches?: string[]
  estDays?: string | null
  /** Primary pull request (for the at-a-glance badge). */
  pr?: PullRequest | null
  /** All pull requests for the ticket (merged / declined / open …). */
  prs?: PullRequest[]
  comments?: Comment[]
  commentCount?: number | null
  latestComment?: string | null
  lastUpdate?: string | null
  created?: string | null
  done?: boolean
  onHold?: boolean
  /** Resolution / close date (mainly for completed tickets). */
  resolved?: string | null
  /** Parent issue key, if this ticket is itself a sub-task. */
  parentKey?: string | null
  /** Child sub-tasks — each a full ticket, openable as its own detail page. */
  subtasks?: Ticket[]
  subtaskCount?: number | null
  url?: string | null
  sprint?: string | null
  reporter?: string | null
  assignee?: string | null
  epic?: LinkRef | null
  labels?: string[]
  components?: string[]
  fixVersions?: string[]
  /** HTML allowed. */
  description?: string | null
  /**
   * AI-generated briefing (active tickets only; written by the summarize-active pass).
   * To Do / In-Progress tickets get a DEEP brief in light HTML — enriched from linked Confluence
   * docs, related tickets, Bitbucket PRs/diffs, attachments and external links.
   * In-Review / QA tickets and sub-tasks get a short plain-text summary. Rendered via SafeHtml.
   */
  aiSummary?: string | null
  /** When aiSummary was generated (ISO) — the pass regenerates a brief once lastUpdate outruns it. */
  aiSummaryAt?: string | null
  acceptanceCriteria?: string[]
  related?: LinkRef[]
  confluence?: LinkRef[]
  externalLinks?: LinkRef[]
  /** HTML allowed. */
  proposedSolution?: string | null
  /** HTML allowed. */
  effortEstimate?: string | null
  openQuestions?: string[]
  sources?: LinkRef[]
  updateLog?: UpdateLogEntry[]
}

/**
 * A row in the full historical "Completed" archive.
 * The base fields (key/title/status) drive the compact list; the rest power the
 * per-row inline "peek" (opened/closed/branch/PR) and, on click, the full detail
 * page. Old tickets may only have the lighter fields — the UI degrades cleanly.
 */
export interface CompletedTicket {
  key: string
  title: string
  type?: string | null
  priority?: string | null
  /** Project key prefix, e.g. "FIDM". Derived from key if absent. */
  project?: string | null
  status?: string | null // current status: Done / Closed / Resolved
  /** Set when this row is actually a sub-task — used to keep it out of the archive. */
  parentKey?: string | null
  /** When it was opened. */
  created?: string | null
  /** When it was closed / resolved (ISO). */
  resolved?: string | null
  storyPoints?: number | null
  branch?: string | null
  branches?: string[]
  pr?: PullRequest | null
  prs?: PullRequest[]
  url?: string | null
  /** How many sub-tasks this parent spawned (shown in the archive peek). */
  subtaskCount?: number | null
  /** The parent's sub-tasks, openable from its detail page. */
  subtasks?: Ticket[]
  // ── optional richer detail for the full detail page (may be sparse) ──
  lastUpdate?: string | null
  sprint?: string | null
  reporter?: string | null
  assignee?: string | null
  epic?: LinkRef | null
  labels?: string[]
  components?: string[]
  fixVersions?: string[]
  description?: string | null
  acceptanceCriteria?: string[]
  comments?: Comment[]
  commentCount?: number | null
  related?: LinkRef[]
  confluence?: LinkRef[]
  externalLinks?: LinkRef[]
  proposedSolution?: string | null
  effortEstimate?: string | null
  openQuestions?: string[]
  sources?: LinkRef[]
  updateLog?: UpdateLogEntry[]
}

/** Adapt an archive row to the rich Ticket shape so the detail view can render it. */
export function completedToTicket(c: CompletedTicket): Ticket {
  return {
    ...c,
    column: 'done',
    status: c.status ?? 'Done',
    done: true,
    onHold: false,
    lastUpdate: c.lastUpdate ?? c.resolved ?? null,
  }
}

export interface JiraData {
  generatedAt?: string | null
  user?: {
    name?: string | null
    accountId?: string | null
    jiraBase?: string | null
  } | null
  /** Actively tracked tickets (rich). Includes recently-done ones (column "done"). */
  tickets: Ticket[]
  /** Every Done ticket ever assigned to me (compact, full history). */
  completed: CompletedTicket[]
  /** Optional run notices (e.g. "Jira MCP unavailable"). */
  notes?: string[]
}
