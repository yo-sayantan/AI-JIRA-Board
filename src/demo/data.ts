// The Demo-mode dataset: a believable board that exercises every feature at once.
//
// Everything here is invented. Keys use a DEMO-/SAMPLE- style prefix and every URL points at
// example.com, so a demo ticket can never be mistaken for a real one or opened against a real
// Jira. Dates are built RELATIVE TO NOW at first use, so the board always looks freshly fetched
// (Done cards inside the archive window, an active sprint, a future sprint for Next Sprint).
import type { CompletedTicket, JiraData, PullRequest, RaisedTicket, Ticket } from '../types'

const DAY = 86_400_000
const HOUR = 3_600_000

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const dayOf = (ms: number) => iso(ms).slice(0, 10)

const JIRA = 'https://jira.example.com'
const BB = 'https://bitbucket.example.com'
const CONF = 'https://confluence.example.com'
const ME = 'Demo User (DEMO)'

/** A pull request, short-hand. */
function pr(id: number, state: PullRequest['state'], extra: Partial<PullRequest> = {}): PullRequest {
  const merged = state === 'merged'
  return {
    state,
    id,
    url: `${BB}/projects/DEMO/repos/demo-service/pull-requests/${id}`,
    title: extra.title ?? `${extra.sourceBranch ?? 'feature/demo'} → main`,
    approvals: merged ? 2 : state === 'approved' ? 2 : state === 'comments' ? 1 : 0,
    openComments: state === 'comments' ? 3 : state === 'changes' ? 5 : 0,
    commentsTotal: state === 'comments' ? 7 : state === 'changes' ? 9 : 2,
    commentsResolved: state === 'comments' ? 4 : state === 'changes' ? 4 : 2,
    reviewers: ['r.okafor', 'm.lindqvist'],
    repo: 'demo-service',
    author: 'demo.user',
    merged,
    ...extra,
  }
}

export function buildDemoDump(now: number = Date.now()): JiraData {
  const ago = (days: number, hours = 0) => iso(now - days * DAY - hours * HOUR)
  const ahead = (days: number) => dayOf(now + days * DAY)
  const back = (days: number) => dayOf(now - days * DAY)

  // One active sprint (most tickets) and one that has not started (the Next Sprint section).
  const SPRINT = `Demo Platform Sprint 24 (active · ${back(5)} → ${ahead(9)})`
  const NEXT_SPRINT = `Demo Platform Sprint 25 (future · ${ahead(10)} → ${ahead(24)})`
  const OLD_SPRINT = `Demo Platform Sprint 23 (closed · ${back(19)} → ${back(6)})`

  /** Fills the fields every card reads, so each ticket below only states what makes it different. */
  const t = (key: string, title: string, over: Partial<Ticket> = {}): Ticket => ({
    key,
    title,
    status: 'To Do',
    column: 'todo',
    type: 'Story',
    priority: 'Medium',
    storyPoints: 3,
    commentCount: 0,
    lastUpdate: ago(1),
    created: ago(12),
    url: `${JIRA}/browse/${key}`,
    sprint: SPRINT,
    reporter: 'Priya Raman',
    assignee: ME,
    labels: ['demo'],
    components: ['demo-service'],
    ...over,
  })

  const EPIC = { key: 'DEMO-100', url: `${JIRA}/browse/DEMO-100`, title: 'Self-serve reporting platform', summary: 'Self-serve reporting platform', relation: 'epic' }

  const tickets: Ticket[] = [
    // ── To Do ───────────────────────────────────────────────────────────────
    t('DEMO-201', 'Design the scheduled-export settings screen', {
      type: 'Story',
      priority: 'High',
      storyPoints: 5,
      epic: EPIC,
      labels: ['demo', 'design', 'reporting'],
      created: ago(9),
      lastUpdate: ago(0, 5),
      description:
        '<p>Users can export a report once, but not <b>on a schedule</b>. Add a settings screen where a saved report can be given a cadence (daily / weekly / monthly), a delivery channel and a recipient list.</p><p>Out of scope: the delivery worker itself — that is <code>DEMO-204</code>.</p>',
      acceptanceCriteria: [
        'A saved report can be given a daily, weekly or monthly cadence',
        'Recipients are validated against the directory before the schedule saves',
        'Turning a schedule off keeps its history and does not delete the saved report',
        'Screen passes the WCAG 2.2 AA contrast and keyboard checks',
      ],
      aiSummary:
        '<p>Build the <b>settings surface</b> for scheduled exports — cadence, channel and recipients for an already-saved report. The delivery mechanism is a separate ticket, so this is UI plus validation and persistence, not plumbing.</p>' +
        '<b>From linked docs</b><ul>' +
        '<li><a href="https://confluence.example.com/x/reporting-rfc">Reporting RFC §4</a> — schedules are stored against the saved report, not the user, so a shared report keeps one schedule.</li>' +
        '<li>The RFC fixes the cadence set at three values; anything finer needs a capacity review first.</li></ul>' +
        '<b>Related tickets</b><ul><li><a href="https://jira.example.com/browse/DEMO-204">DEMO-204</a> (In Progress) — the delivery worker that will read these rows.</li></ul>' +
        '<b>Watch out for</b><ul><li>Recipient validation hits the directory API, which rate-limits at 10 req/s — batch the check.</li></ul>',
      aiSummaryAt: ago(0, 6),
      proposedSolution:
        '<ul><li>Add a <code>report_schedules</code> table keyed by saved-report id.</li><li>New settings panel reusing the existing form primitives.</li><li>Batch the directory lookup behind one validate endpoint.</li></ul>',
      effortEstimate: '<p><b>4–5 days</b> — the form is routine; recipient validation and the shared-report edge case carry the risk.</p>',
      openQuestions: ['Does a shared report let every viewer edit the schedule, or only the owner?', 'Do we need a per-tenant cap on scheduled exports?'],
      confluence: [{ title: 'Reporting RFC', url: `${CONF}/x/reporting-rfc`, excerpt: 'Schedules belong to the saved report. Cadence is limited to daily / weekly / monthly in v1.' }],
      externalLinks: [{ title: 'Figma — export settings', url: 'https://figma.example.com/file/demo-export-settings', excerpt: 'Three states: no schedule, active schedule, paused schedule.' }],
      related: [{ key: 'DEMO-204', url: `${JIRA}/browse/DEMO-204`, summary: 'Delivery worker for scheduled exports', status: 'In Progress', relation: 'blocks' }],
      sources: [{ title: `Jira DEMO-201`, url: `${JIRA}/browse/DEMO-201` }],
      updateLog: [
        { when: back(0), text: 'To Do' },
        { when: back(9), text: 'Opened' },
      ],
    }),
    t('DEMO-202', 'Retire the v1 export endpoint', {
      type: 'Task',
      priority: 'Low',
      storyPoints: 2,
      created: ago(21),
      lastUpdate: ago(4),
      labels: ['demo', 'cleanup', 'tech-debt'],
      description: '<p>The v1 <code>/export</code> endpoint has had no traffic for 60 days. Remove the route, its handler and the two feature flags that guarded it.</p>',
      acceptanceCriteria: ['Route removed', 'Flags deleted from config', 'Changelog entry added'],
      updateLog: [{ when: back(4), text: 'To Do' }, { when: back(21), text: 'Opened' }],
    }),
    t('DEMO-203', 'Spike: can we stream exports straight to object storage?', {
      type: 'Spike',
      priority: 'Medium',
      storyPoints: 2,
      created: ago(6),
      lastUpdate: ago(2),
      labels: ['demo', 'spike'],
      description: '<p>Large exports buffer in memory before upload. Time-boxed spike: can the writer stream directly to object storage and halve peak memory?</p>',
      openQuestions: ['Does the storage SDK support chunked upload without a known length?'],
      updateLog: [{ when: back(2), text: 'To Do' }, { when: back(6), text: 'Opened' }],
    }),

    // ── Blocked ─────────────────────────────────────────────────────────────
    t('DEMO-210', 'Nightly export job times out on the largest tenant', {
      status: 'Blocked',
      column: 'blocked',
      type: 'Bug',
      priority: 'Critical',
      storyPoints: 3,
      created: ago(8),
      lastUpdate: ago(0, 3),
      branch: 'bugfix/DEMO-210_export_timeout',
      pr: pr(412, 'changes', { sourceBranch: 'bugfix/DEMO-210_export_timeout', destinationBranch: 'main', updatedAt: ago(1) }),
      labels: ['demo', 'bug', 'blocked'],
      commentCount: 6,
      latestComment: ago(0, 3),
      description: '<p>The nightly export for the largest tenant exceeds the 30-minute job budget roughly one night in three. <b>Blocked</b>: we need the capacity numbers from the platform team before choosing between sharding and a longer budget.</p>',
      acceptanceCriteria: ['Nightly export completes inside the job budget for every tenant', 'A run that does exceed it alerts instead of failing silently'],
      openQuestions: ['When can platform give us the per-node capacity figures?', 'Is a 60-minute budget acceptable to operations?'],
      comments: [
        { author: 'Priya Raman', when: ago(0, 3), body: '<p>Still waiting on the capacity numbers — chased again this morning.</p>' },
        { author: 'Demo User', when: ago(2), body: '<p>Reproduced on the staging copy: the job spends 70% of its time in the serialiser, not the query.</p>' },
      ],
      updateLog: [
        { when: back(0), text: 'Blocked' },
        { when: back(3), text: 'In Progress' },
        { when: back(8), text: 'Opened' },
      ],
    }),
    t('DEMO-211', 'Add per-tenant export quotas', {
      status: 'Blocked',
      column: 'blocked',
      type: 'Story',
      priority: 'Medium',
      storyPoints: 5,
      created: ago(14),
      lastUpdate: ago(3),
      labels: ['demo', 'blocked'],
      description: '<p>Blocked on the pricing decision — quotas cannot ship before the tiers are agreed.</p>',
      related: [{ key: 'DEMO-210', url: `${JIRA}/browse/DEMO-210`, summary: 'Nightly export job times out on the largest tenant', status: 'Blocked', relation: 'relates to' }],
      updateLog: [{ when: back(3), text: 'Blocked' }, { when: back(14), text: 'Opened' }],
    }),

    // ── In Progress ─────────────────────────────────────────────────────────
    t('DEMO-204', 'Delivery worker for scheduled exports', {
      status: 'In Progress',
      column: 'prog',
      type: 'Story',
      priority: 'High',
      storyPoints: 8,
      epic: EPIC,
      created: ago(11),
      lastUpdate: ago(0, 2),
      branch: 'feature/DEMO-204_delivery_worker',
      branches: ['feature/DEMO-204_delivery_worker', 'feature/DEMO-204_delivery_worker_infra'],
      prs: [
        pr(430, 'comments', { sourceBranch: 'feature/DEMO-204_delivery_worker', destinationBranch: 'main', updatedAt: ago(0, 4) }),
        pr(431, 'merged', { sourceBranch: 'feature/DEMO-204_delivery_worker_infra', destinationBranch: 'main', repo: 'demo-infra', mergedAt: ago(2), updatedAt: ago(2) }),
      ],
      commentCount: 3,
      labels: ['demo', 'reporting'],
      components: ['demo-service', 'demo-infra'],
      fixVersions: ['2026.11'],
      description: '<p>Reads due schedules and delivers the rendered export to its channel. Retries with backoff; a permanently failing schedule pauses itself and notifies the owner.</p>',
      acceptanceCriteria: ['Due schedules are picked up within one minute', 'Transient failures retry three times with backoff', 'A schedule that fails three runs in a row pauses and notifies its owner'],
      aiSummary:
        '<p>The <b>engine</b> behind scheduled exports: poll for due schedules, render, deliver, retry. Infrastructure is already merged (<code>#431</code>); the worker itself is in review with open comments.</p>' +
        '<b>Code / PRs</b><ul><li><code>#430</code> — worker loop and retry policy. Three unresolved comments, all on the backoff maths.</li><li><code>#431</code> — queue and IAM, merged two days ago.</li></ul>' +
        '<b>Watch out for</b><ul><li>The pause-and-notify path has no test yet; it is the acceptance criterion most likely to be missed.</li></ul>',
      aiSummaryAt: ago(0, 3),
      subtasks: [
        t('DEMO-204-1', 'Queue plumbing and IAM', { parentKey: 'DEMO-204', parentTitle: 'Delivery worker for scheduled exports', type: 'Sub-task', status: 'Done', column: 'done', storyPoints: null, resolved: ago(2), lastUpdate: ago(2), done: true }),
        t('DEMO-204-2', 'Retry and backoff policy', { parentKey: 'DEMO-204', parentTitle: 'Delivery worker for scheduled exports', type: 'Sub-task', status: 'In Progress', column: 'prog', storyPoints: null, lastUpdate: ago(0, 2) }),
        t('DEMO-204-3', 'QA: verify delivery and retry behaviour', { parentKey: 'DEMO-204', parentTitle: 'Delivery worker for scheduled exports', type: 'QA Task', status: 'To Do', column: 'todo', storyPoints: null, assignee: 'Rahul Okafor', mine: false, lastUpdate: ago(1) }),
      ],
      subtaskCount: 3,
      comments: [{ author: 'Rahul Okafor', when: ago(0, 4), body: '<p>Backoff looks like it can exceed the job budget on the third retry — worth a cap.</p>' }],
      updateLog: [{ when: back(0), text: 'In Progress' }, { when: back(11), text: 'Opened' }],
    }),
    t('DEMO-205', 'Cache warm-up for the report renderer', {
      status: 'Dev in Progress',
      column: 'prog',
      type: 'Story',
      priority: 'Medium',
      storyPoints: 5,
      created: ago(26),
      lastUpdate: ago(1, 4),
      branch: 'feature/DEMO-205_cache_warmup',
      sprint: SPRINT,
      sprintOverflow: true,
      sprintCount: 3,
      labels: ['demo', 'performance'],
      description: '<p>Cold renders take 9s at p95. Warm the template and schema caches on deploy so the first render of the day is not the slowest.</p>',
      updateLog: [{ when: back(1), text: 'Dev in Progress' }, { when: back(26), text: 'Opened' }],
    }),
    t('DEMO-206', 'Fix column alignment in the CSV writer', {
      status: 'In Progress',
      column: 'prog',
      type: 'Bug',
      priority: 'Low',
      storyPoints: 1,
      created: ago(3),
      lastUpdate: ago(0, 8),
      branch: 'bugfix/DEMO-206_csv_alignment',
      labels: ['demo', 'bug'],
      description: '<p>A trailing empty column appears when the last field is null.</p>',
      updateLog: [{ when: back(0), text: 'In Progress' }, { when: back(3), text: 'Opened' }],
    }),

    // ── In Review ───────────────────────────────────────────────────────────
    t('DEMO-220', 'Signed download links for exported files', {
      status: 'Ready4Review',
      column: 'rev',
      type: 'Story',
      priority: 'High',
      storyPoints: 5,
      epic: EPIC,
      created: ago(16),
      lastUpdate: ago(0, 6),
      branch: 'feature/DEMO-220_signed_links',
      pr: pr(425, 'approved', { sourceBranch: 'feature/DEMO-220_signed_links', destinationBranch: 'main', updatedAt: ago(0, 6) }),
      labels: ['demo', 'security'],
      commentCount: 4,
      fixVersions: ['2026.11'],
      description: '<p>Export downloads are currently unauthenticated URLs with a guessable path. Replace them with short-lived signed links scoped to the requesting user.</p>',
      acceptanceCriteria: ['Links expire after 15 minutes', 'A link issued for one user cannot be used by another', 'Expired links return 403, never the file'],
      aiSummary: '<p>Replaces guessable export URLs with <b>15-minute signed links</b> scoped to the requesting user. PR is approved with two approvals and no open comments — this is ready to merge.</p>',
      aiSummaryAt: ago(0, 7),
      confluence: [{ title: 'Link signing standard', url: `${CONF}/x/link-signing`, excerpt: 'HMAC-SHA256 over path + user id + expiry. 15 minutes is the platform default.' }],
      updateLog: [{ when: back(0), text: 'Ready4Review' }, { when: back(4), text: 'In Progress' }, { when: back(16), text: 'Opened' }],
    }),
    t('DEMO-221', 'Paginate the saved-reports list', {
      status: 'In Review',
      column: 'rev',
      type: 'Task',
      priority: 'Medium',
      storyPoints: 3,
      created: ago(10),
      lastUpdate: ago(1, 2),
      branch: 'feature/DEMO-221_paginate_saved_reports',
      prs: [
        pr(418, 'declined', { sourceBranch: 'feature/DEMO-221_paginate_v1', destinationBranch: 'main', updatedAt: ago(6), title: 'Offset pagination (superseded)' }),
        pr(426, 'comments', { sourceBranch: 'feature/DEMO-221_paginate_saved_reports', destinationBranch: 'main', updatedAt: ago(1, 2) }),
      ],
      labels: ['demo'],
      commentCount: 2,
      description: '<p>The list loads every saved report. Switch to keyset pagination. The first attempt (offset) was declined for the usual skew problems.</p>',
      updateLog: [{ when: back(1), text: 'In Review' }, { when: back(10), text: 'Opened' }],
    }),
    t('DEMO-222', 'Rotate the export signing key', {
      status: 'Code Review',
      column: 'rev',
      type: 'Security',
      priority: 'Highest',
      storyPoints: 2,
      created: ago(5),
      lastUpdate: ago(0, 1),
      branch: 'chore/DEMO-222_rotate_signing_key',
      pr: pr(432, 'comments', { sourceBranch: 'chore/DEMO-222_rotate_signing_key', destinationBranch: 'main', approvals: 0, updatedAt: ago(0, 1) }),
      labels: ['demo', 'security'],
      description: '<p>Quarterly rotation. Dual-key window so links issued under the old key stay valid until they expire.</p>',
      updateLog: [{ when: back(0), text: 'Code Review' }, { when: back(5), text: 'Opened' }],
    }),

    // ── QA — the top shelf (handed over, not yet picked up) ─────────────────
    t('DEMO-230', 'Weekly digest email template', {
      status: 'QA',
      column: 'qa',
      type: 'Story',
      priority: 'Medium',
      storyPoints: 3,
      created: ago(18),
      lastUpdate: ago(1),
      branch: 'feature/DEMO-230_digest_template',
      pr: pr(420, 'merged', { sourceBranch: 'feature/DEMO-230_digest_template', destinationBranch: 'main', mergedAt: ago(1, 6), updatedAt: ago(1, 6) }),
      labels: ['demo', 'email'],
      description: '<p>Responsive digest template with a plain-text fallback. Merged and handed to QA.</p>',
      acceptanceCriteria: ['Renders in Outlook, Gmail and Apple Mail', 'Plain-text fallback carries every link'],
      subtasks: [t('DEMO-230-1', 'QA: cross-client render check', { parentKey: 'DEMO-230', parentTitle: 'Weekly digest email template', type: 'QA Task', status: 'In Progress', column: 'prog', storyPoints: null, assignee: 'Rahul Okafor', mine: false, lastUpdate: ago(1) })],
      subtaskCount: 1,
      updateLog: [{ when: back(1), text: 'QA' }, { when: back(18), text: 'Opened' }],
    }),
    t('DEMO-231', 'Export audit trail', {
      status: 'Ready for QA',
      column: 'qa',
      type: 'Task',
      priority: 'Low',
      storyPoints: 2,
      created: ago(13),
      lastUpdate: ago(2, 3),
      branch: 'feature/DEMO-231_audit_trail',
      pr: pr(421, 'merged', { sourceBranch: 'feature/DEMO-231_audit_trail', destinationBranch: 'main', mergedAt: ago(2, 4), updatedAt: ago(2, 4) }),
      labels: ['demo', 'audit'],
      description: '<p>Every export records who asked for it, when, and which filters were applied.</p>',
      updateLog: [{ when: back(2), text: 'Ready for QA' }, { when: back(13), text: 'Opened' }],
    }),

    // ── QA — the QA In Progress shelf (QA has picked these up) ──────────────
    t('DEMO-232', 'Tenant-scoped report permissions', {
      status: 'In QA',
      column: 'qa',
      type: 'Story',
      priority: 'High',
      storyPoints: 8,
      epic: EPIC,
      created: ago(24),
      lastUpdate: ago(0, 9),
      branch: 'feature/DEMO-232_report_permissions',
      pr: pr(415, 'merged', { sourceBranch: 'feature/DEMO-232_report_permissions', destinationBranch: 'main', mergedAt: ago(3), updatedAt: ago(3) }),
      labels: ['demo', 'security', 'reporting'],
      commentCount: 5,
      fixVersions: ['2026.11'],
      description: '<p>A report is visible only to members of the tenant that owns it, with an explicit share list for exceptions.</p>',
      acceptanceCriteria: ['Cross-tenant access returns 404, not 403', 'Share list survives an owner change', 'Audit entry on every permission change'],
      aiSummary: '<p>Scopes report visibility to the owning tenant with an explicit share list. Code merged three days ago; <b>QA has it now</b> — the cross-tenant 404 behaviour is the case most worth watching.</p>',
      aiSummaryAt: ago(0, 10),
      subtasks: [t('DEMO-232-1', 'QA: permission matrix verification', { parentKey: 'DEMO-232', parentTitle: 'Tenant-scoped report permissions', type: 'QA Task', status: 'In Progress', column: 'prog', storyPoints: null, assignee: 'Rahul Okafor', mine: false, lastUpdate: ago(0, 9) })],
      subtaskCount: 1,
      updateLog: [{ when: back(0), text: 'In QA' }, { when: back(3), text: 'QA' }, { when: back(24), text: 'Opened' }],
    }),
    t('DEMO-233', 'Dedupe rows in the match export', {
      status: 'In Testing',
      column: 'qa',
      type: 'Bug',
      priority: 'Medium',
      storyPoints: 2,
      created: ago(15),
      lastUpdate: ago(1, 7),
      branch: 'bugfix/DEMO-233_dedupe_rows',
      pr: pr(422, 'merged', { sourceBranch: 'bugfix/DEMO-233_dedupe_rows', destinationBranch: 'main', mergedAt: ago(2), updatedAt: ago(2) }),
      labels: ['demo', 'bug'],
      description: '<p>Duplicate rows appeared when a candidate matched on two rules. Dedupe at the writer.</p>',
      updateLog: [{ when: back(1), text: 'In Testing' }, { when: back(15), text: 'Opened' }],
    }),

    // ── Done (recent wins — these age into Completed on their own) ──────────
    t('DEMO-240', 'Add structured logging to the export API', {
      status: 'Done',
      column: 'done',
      type: 'Story',
      priority: 'Medium',
      storyPoints: 5,
      done: true,
      resolved: ago(1, 5),
      created: ago(20),
      lastUpdate: ago(1, 5),
      branch: 'feature/DEMO-240_structured_logging',
      pr: pr(409, 'merged', { sourceBranch: 'feature/DEMO-240_structured_logging', destinationBranch: 'main', mergedAt: ago(1, 6), updatedAt: ago(1, 6) }),
      labels: ['demo', 'observability'],
      description: '<p>Every export request now logs a structured line with tenant, duration and row count.</p>',
      updateLog: [{ when: back(1), text: 'Marked DONE' }, { when: back(20), text: 'Opened' }],
    }),
    t('DEMO-241', 'Upgrade the PDF renderer to 4.2', {
      status: 'Done',
      column: 'done',
      type: 'Task',
      priority: 'Low',
      storyPoints: 2,
      done: true,
      resolved: ago(3, 2),
      created: ago(17),
      lastUpdate: ago(3, 2),
      branch: 'chore/DEMO-241_pdf_renderer_42',
      pr: pr(405, 'merged', { sourceBranch: 'chore/DEMO-241_pdf_renderer_42', destinationBranch: 'main', mergedAt: ago(3, 3), updatedAt: ago(3, 3) }),
      labels: ['demo', 'dependencies'],
      description: '<p>Picks up the CJK font fix and drops two transitive dependencies.</p>',
      updateLog: [{ when: back(3), text: 'Marked DONE' }, { when: back(17), text: 'Opened' }],
    }),
    t('DEMO-242', 'Alert when a scheduled export misses its window', {
      status: 'Closed',
      column: 'done',
      type: 'Task',
      priority: 'High',
      storyPoints: 3,
      done: true,
      resolved: ago(4, 6),
      created: ago(22),
      lastUpdate: ago(4, 6),
      pr: pr(402, 'merged', { sourceBranch: 'feature/DEMO-242_missed_window_alert', destinationBranch: 'main', mergedAt: ago(4, 8), updatedAt: ago(4, 8) }),
      labels: ['demo', 'observability'],
      description: '<p>Pages the on-call rota when a schedule misses its window by more than ten minutes.</p>',
      updateLog: [{ when: back(4), text: 'Marked DONE' }, { when: back(22), text: 'Opened' }],
    }),

    // ── On Hold ─────────────────────────────────────────────────────────────
    t('DEMO-250', 'Migrate exports to the new object-storage account', {
      status: 'On Hold',
      column: 'hold',
      onHold: true,
      type: 'Task',
      priority: 'Medium',
      storyPoints: 5,
      created: ago(30),
      lastUpdate: ago(7),
      labels: ['demo', 'infrastructure'],
      description: '<p>Parked until the storage migration window in the next quarter.</p>',
      updateLog: [{ when: back(7), text: 'On Hold' }, { when: back(30), text: 'Opened' }],
    }),
    t('DEMO-251', 'Localise the digest email', {
      status: 'Waiting',
      column: 'hold',
      onHold: true,
      type: 'Story',
      priority: 'Low',
      storyPoints: 3,
      created: ago(28),
      lastUpdate: ago(9),
      labels: ['demo', 'i18n'],
      description: '<p>Waiting on translated copy from the content team.</p>',
      updateLog: [{ when: back(9), text: 'Waiting' }, { when: back(28), text: 'Opened' }],
    }),

    // ── Next Sprint (To Do in a sprint that has not started) ────────────────
    t('DEMO-260', 'Report templates gallery', {
      type: 'Story',
      priority: 'Medium',
      storyPoints: 8,
      sprint: NEXT_SPRINT,
      created: ago(4),
      lastUpdate: ago(4),
      epic: EPIC,
      labels: ['demo', 'reporting'],
      description: '<p>A starter gallery so a new tenant has something useful on day one.</p>',
      updateLog: [{ when: back(4), text: 'Opened' }],
    }),
    t('DEMO-261', 'Export usage dashboard for admins', {
      type: 'Story',
      priority: 'Low',
      storyPoints: 5,
      sprint: NEXT_SPRINT,
      created: ago(2),
      lastUpdate: ago(2),
      labels: ['demo', 'reporting'],
      description: '<p>Who exports what, how often, and how much it costs to serve.</p>',
      updateLog: [{ when: back(2), text: 'Opened' }],
    }),
  ]

  // ── Completed archive (history, oldest work summarised) ───────────────────
  const done = (key: string, title: string, daysAgo: number, over: Partial<CompletedTicket> = {}): CompletedTicket => ({
    key,
    title,
    project: key.split('-')[0],
    status: 'Done',
    type: 'Story',
    priority: 'Medium',
    storyPoints: 3,
    created: ago(daysAgo + 14),
    resolved: ago(daysAgo),
    lastUpdate: ago(daysAgo),
    url: `${JIRA}/browse/${key}`,
    assignee: ME,
    reporter: 'Priya Raman',
    sprint: OLD_SPRINT,
    labels: ['demo'],
    components: ['demo-service'],
    mine: true,
    ...over,
  })

  const completed: CompletedTicket[] = [
    done('DEMO-190', 'Saved reports: create, rename, delete', 12, { storyPoints: 8, pr: pr(398, 'merged', { mergedAt: ago(12) }), branch: 'feature/DEMO-190_saved_reports', subtaskCount: 4 }),
    done('DEMO-188', 'CSV and XLSX writers', 19, { storyPoints: 5, type: 'Task', pr: pr(392, 'merged', { mergedAt: ago(19) }) }),
    done('DEMO-186', 'Report scheduling data model', 27, { storyPoints: 3, pr: pr(388, 'merged', { mergedAt: ago(27) }) }),
    done('DEMO-184', 'Fix off-by-one in the date-range filter', 34, { storyPoints: 1, type: 'Bug', priority: 'High', pr: pr(381, 'merged', { mergedAt: ago(34) }) }),
    done('DEMO-180', 'Report renderer service skeleton', 48, { storyPoints: 8, pr: pr(370, 'merged', { mergedAt: ago(48) }), fixVersions: ['2026.09'] }),
    done('DEMO-176', 'Pick the templating engine', 61, { storyPoints: 2, type: 'Spike' }),
    done('SAMPLE-92', 'Rate-limit the public search endpoint', 83, { project: 'SAMPLE', storyPoints: 5, type: 'Task', pr: pr(344, 'merged', { mergedAt: ago(83), repo: 'sample-gateway' }), components: ['sample-gateway'] }),
    done('SAMPLE-88', 'Session cookie hardening', 104, { project: 'SAMPLE', storyPoints: 3, type: 'Security', priority: 'High', pr: pr(331, 'merged', { mergedAt: ago(104), repo: 'sample-gateway' }) }),
    done('SAMPLE-80', 'Retire the legacy auth shim', 139, { project: 'SAMPLE', storyPoints: 5, type: 'Task' }),
    done('SAMPLE-71', 'Onboarding: first week setup', 215, { project: 'SAMPLE', storyPoints: 1, type: 'Task', labels: ['demo', 'onboarding'] }),
    // A team-mate's parent, kept for context because a sub-task under it was mine.
    done('DEMO-170', 'Reporting platform foundations', 70, { mine: false, assignee: 'Rahul Okafor', storyPoints: 13, subtaskCount: 6 }),
  ]

  // ── Raised by me ──────────────────────────────────────────────────────────
  const raised: RaisedTicket[] = [
    {
      key: 'SAMPLE-301',
      title: 'Search returns archived tenants',
      project: 'SAMPLE',
      status: 'In Progress',
      column: 'prog',
      type: 'Bug',
      priority: 'High',
      storyPoints: 3,
      created: ago(11),
      lastUpdate: ago(1),
      url: `${JIRA}/browse/SAMPLE-301`,
      reporter: ME,
      assignee: 'Marta Lindqvist',
      labels: ['demo'],
      description: '<p>Archived tenants still appear in the admin search results.</p>',
      assigneeLog: [
        { when: ago(11), from: null, to: 'Unassigned' },
        { when: ago(7), from: 'Unassigned', to: 'Rahul Okafor' },
        { when: ago(2), from: 'Rahul Okafor', to: 'Marta Lindqvist' },
      ],
      updateLog: [{ when: back(1), text: 'In Progress' }, { when: back(11), text: 'Opened' }],
    },
    {
      key: 'SAMPLE-298',
      title: 'Timezone shown in UTC on the audit page',
      project: 'SAMPLE',
      status: 'To Do',
      column: 'todo',
      type: 'Bug',
      priority: 'Low',
      created: ago(18),
      lastUpdate: ago(18),
      url: `${JIRA}/browse/SAMPLE-298`,
      reporter: ME,
      assignee: null,
      labels: ['demo'],
      description: '<p>Audit timestamps ignore the viewer’s timezone.</p>',
      assigneeLog: [{ when: ago(18), from: null, to: 'Unassigned' }],
    },
    {
      key: 'SAMPLE-290',
      title: 'Export button enabled while a render is in flight',
      project: 'SAMPLE',
      status: 'Done',
      column: 'done',
      type: 'Bug',
      priority: 'Medium',
      done: true,
      created: ago(40),
      resolved: ago(21),
      lastUpdate: ago(21),
      url: `${JIRA}/browse/SAMPLE-290`,
      reporter: ME,
      assignee: 'Rahul Okafor',
      labels: ['demo'],
      assigneeLog: [{ when: ago(40), from: null, to: 'Rahul Okafor' }],
    },
    {
      key: 'DEMO-280',
      title: 'Flaky test: scheduled-export integration suite',
      project: 'DEMO',
      status: 'Blocked',
      column: 'blocked',
      type: 'Bug',
      priority: 'Medium',
      created: ago(9),
      lastUpdate: ago(4),
      url: `${JIRA}/browse/DEMO-280`,
      reporter: ME,
      assignee: 'Demo User',
      labels: ['demo', 'flaky'],
      description: '<p>Fails roughly one run in five on CI, never locally.</p>',
      assigneeLog: [{ when: ago(9), from: null, to: 'Demo User' }],
    },
    {
      key: 'SAMPLE-275',
      title: 'Add a changelog link to the release email',
      project: 'SAMPLE',
      status: 'QA',
      column: 'qa',
      type: 'Task',
      priority: 'Low',
      created: ago(23),
      lastUpdate: ago(3),
      url: `${JIRA}/browse/SAMPLE-275`,
      reporter: ME,
      assignee: 'Marta Lindqvist',
      labels: ['demo'],
      assigneeLog: [{ when: ago(23), from: null, to: 'Marta Lindqvist' }],
    },
  ]

  return {
    generatedAt: iso(now - 7 * HOUR),
    user: { name: 'Demo User', accountId: 'DEMO', jiraBase: JIRA },
    tickets,
    completed,
    raised,
    raisedAt: iso(now - 7 * HOUR),
    notes: ['Demo mode is on — these tickets are invented. Nothing here is fetched from or written to Jira.'],
  }
}
