import type { PrState, PullRequest } from '../types'

// ── Priority ────────────────────────────────────────────────────────────
// 7 distinct tiers, each its own rank + colour + icon (see PriorityIcon in Icons.tsx).
// Critical/Blocker gets its OWN rank above Highest — previously it was silently merged into
// Highest (same colour, same icon), so a Blocker ticket looked no more urgent than a Highest one.
export interface PriorityMeta {
  label: string
  color: string
  rank: number
  glyph: string
}

export function priorityMeta(p?: string | null): PriorityMeta {
  const s = (p ?? '').trim().toLowerCase()
  if (/(critical|blocker)/.test(s)) return { label: p || 'Critical', color: '#dc2626', rank: 6, glyph: '⛔' }
  if (/(highest|p1)/.test(s)) return { label: p || 'Highest', color: '#ef4444', rank: 5, glyph: '⏫' }
  if (/(high|major|p2)/.test(s)) return { label: p || 'High', color: '#f97316', rank: 4, glyph: '🔼' }
  if (/(medium|normal|p3)/.test(s) || s === '') return { label: p || 'Medium', color: '#eab308', rank: 3, glyph: '➖' }
  // "lowest" must be tested BEFORE "low" (it contains it) — same reason highest precedes high.
  if (/(lowest|trivial|p5)/.test(s)) return { label: p || 'Lowest', color: '#38bdf8', rank: 1, glyph: '⏬' }
  if (/(low|minor|p4)/.test(s)) return { label: p || 'Low', color: '#22c55e', rank: 2, glyph: '🔽' }
  return { label: p || 'None', color: '#94a3b8', rank: 0, glyph: '•' }
}

// ── Issue type ──────────────────────────────────────────────────────────
export function typeMeta(t?: string | null): { color: string; glyph: string } {
  const s = (t ?? '').trim().toLowerCase()
  // Order matters: match the specific multi-word types BEFORE the generic "task".
  if (/bug|defect/.test(s)) return { color: '#ef4444', glyph: '🐞' }
  if (/security|vuln|cve/.test(s)) return { color: '#e11d48', glyph: '🛡️' }
  if (/requirement/.test(s)) return { color: '#a855f7', glyph: '📋' }
  if (/dev[\s-]?task|development/.test(s)) return { color: '#6366f1', glyph: '💻' }
  if (/qa[\s-]?task|\bqa\b|test/.test(s)) return { color: '#06b6d4', glyph: '🧪' }
  if (/support|service[\s-]?desk|incident|helpdesk/.test(s)) return { color: '#0d9488', glyph: '🎧' }
  if (/story/.test(s)) return { color: '#22c55e', glyph: '📗' }
  if (/epic/.test(s)) return { color: '#8b5cf6', glyph: '🗂️' }
  if (/sub-?task/.test(s)) return { color: '#0ea5e9', glyph: '↳' }
  if (/spike|research/.test(s)) return { color: '#f59e0b', glyph: '🔬' }
  if (/improvement|enhancement/.test(s)) return { color: '#14b8a6', glyph: '✨' }
  if (/tech[\s-]?debt|refactor/.test(s)) return { color: '#f97316', glyph: '🔧' }
  if (/release|deploy/.test(s)) return { color: '#ec4899', glyph: '🚀' }
  if (/onboard/.test(s)) return { color: '#84cc16', glyph: '🎓' }
  if (/task/.test(s)) return { color: '#3b82f6', glyph: '☑️' }
  return { color: '#64748b', glyph: '🎫' }
}

// ── Derived types ─────────────────────────────────────────────────────────
// Deployment / release-coordination and onboarding work arrives from Jira typed as
// plain "Task" — derive first-class types from the title so every UI can surface
// them. Keyword pairing avoids false hits like "spring-beans-3.2.11.RELEASE.jar".
const RELEASE_RE = /\brelease\s+(?:management|coordination|mgmt)\b|\bdeploy(?:ing|ment|s)?\b/i
const ONBOARDING_RE = /\bon-?boarding\b/i

/** Display type: derived "Release" / "Onboarding" when the title says so, else the Jira type. */
export function effectiveType(t: { type?: string | null; title?: string | null }): string | null {
  const title = t.title ?? ''
  if (RELEASE_RE.test(title)) return 'Release'
  if (ONBOARDING_RE.test(title)) return 'Onboarding'
  return t.type ?? null
}

/** Target environment of a release ticket, parsed from its title. */
export function releaseEnvOf(t: { title?: string | null }): { label: string; color: string } | null {
  const s = t.title ?? ''
  if (/\bprod(?:uction)?\b/i.test(s)) return { label: 'Prod', color: '#ef4444' }
  if (/\bdemo\b/i.test(s)) return { label: 'Demo', color: '#f59e0b' }
  // "Stage", not "Staging" — the label sits in a fixed-width column next to Prod and Demo.
  if (/\bsta?g(?:e|ing)?\b/i.test(s)) return { label: 'Stage', color: '#0ea5e9' }
  return null
}

// ── Pull request ──────────────────────────────────────────────────────────
/** A PR is worth showing if it has a real review state OR a link/id, even if state came through as "none". */
export function hasPr(pr?: { state?: PrState | null; url?: string | null; id?: string | number | null } | null): boolean {
  if (!pr) return false
  return (pr.state != null && pr.state !== 'none') || pr.url != null || pr.id != null
}

/** Merged can be encoded either as state:"merged" OR an orthogonal merged:true flag. */
export function isMergedPr(pr?: { state?: PrState | null; merged?: boolean | null } | null): boolean {
  return !!pr && (pr.state === 'merged' || pr.merged === true)
}

/** Closed PR = merged or declined (no longer awaiting review, so approval progress is moot). */
export function isClosedPr(pr?: { state?: PrState | null; merged?: boolean | null } | null): boolean {
  return !!pr && (isMergedPr(pr) || pr.state === 'declined')
}

/**
 * Review-comment stats for a PR, or null when the PR has NO comments (so the UI
 * can hide the block). "Open comments: 0" is meaningless — a PR can only merge
 * once all comments are resolved — so we show total added + how many are resolved.
 */
export function prCommentStats(pr?: PullRequest | null): { total: number; resolved: number } | null {
  if (!pr) return null
  const total = pr.commentsTotal
  if (total != null) {
    if (total <= 0) return null
    const resolved = pr.commentsResolved ?? Math.max(0, total - (pr.openComments ?? 0))
    return { total, resolved: Math.min(resolved, total) }
  }
  // Legacy data (only openComments known): if some are open there ARE comments;
  // if none are open we can't tell total from resolved, so hide rather than show "0".
  const open = pr.openComments ?? 0
  if (open > 0) return { total: open + (pr.commentsResolved ?? 0), resolved: pr.commentsResolved ?? 0 }
  return null
}

export function prMeta(state?: PrState | null): { label: string; color: string; glyph: string } {
  switch (state) {
    case 'merged':
      return { label: 'PR merged', color: '#8b5cf6', glyph: '⬡' }
    case 'approved':
      return { label: 'PR approved', color: '#22c55e', glyph: '✓' }
    case 'comments':
      return { label: 'PR open', color: '#f59e0b', glyph: '💬' }
    case 'changes':
      return { label: 'Changes requested', color: '#ef4444', glyph: '✗' }
    case 'declined':
      return { label: 'PR declined', color: '#dc2626', glyph: '⦸' }
    default:
      return { label: 'No PR', color: '#94a3b8', glyph: '○' }
  }
}

/** All PRs for a ticket, falling back to the single `pr`. */
export function prListOf(t: { prs?: PullRequest[] | null; pr?: PullRequest | null }): PullRequest[] {
  if (t.prs && t.prs.length) return t.prs
  return hasPr(t.pr) ? [t.pr as PullRequest] : []
}

/** All real branches for a ticket, falling back to the single `branch`. */
export function branchesOf(t: { branches?: string[] | null; branch?: string | null }): string[] {
  if (t.branches && t.branches.length) return t.branches
  return t.branch ? [t.branch] : []
}

/**
 * Merge / review status of a branch, derived from the PR whose source branch matches it.
 * Returns the matched PR's state ('merged' | 'declined' | 'approved' | 'comments' | 'changes')
 * or null when no PR is associated with the branch (so the UI can stay quiet).
 */
export function branchStatusOf(
  branch: string,
  t: { prs?: PullRequest[] | null; pr?: PullRequest | null },
): PrState | null {
  const norm = (s?: string | null) => (s ?? '').trim().toLowerCase()
  const b = norm(branch)
  if (!b) return null
  // Match on exact source-branch equality only. Branches are derived from PR
  // sourceBranches, so an exact match is reliable; a fuzzy suffix match would paint
  // a status onto an unrelated branch that merely shares a tail (e.g. "app-service"
  // vs "my-app-service"). No match → null (the UI stays quiet).
  const matches = prListOf(t).filter((p) => norm(p.sourceBranch) === b)
  if (!matches.length) return null
  // A branch that ever merged reads as "merged" regardless of PR array order.
  if (matches.some((p) => isMergedPr(p))) return 'merged'
  return matches.find((p) => p.state && p.state !== 'none')?.state ?? null
}

/** Compact label + color for a branch's derived merge/review status. */
export function branchStatusMeta(state: PrState): { label: string; color: string } {
  switch (state) {
    case 'merged':
      return { label: 'merged', color: '#8b5cf6' }
    case 'declined':
      return { label: 'declined', color: '#dc2626' }
    case 'approved':
      return { label: 'approved', color: '#22c55e' }
    case 'changes':
      return { label: 'changes req', color: '#ef4444' }
    case 'comments':
      return { label: 'open PR', color: '#f59e0b' }
    default:
      return { label: state, color: '#94a3b8' }
  }
}

// ── Dates / relative time ──────────────────────────────────────────────────
/** Is `assignee` me? Matches the dump's user by accountId (preferred) or name. */
export function isAssignedToMe(
  assignee?: string | null,
  user?: { name?: string | null; accountId?: string | null } | null,
): boolean {
  if (!assignee) return false
  const a = assignee.toLowerCase()
  const id = user?.accountId?.toLowerCase()
  const name = user?.name?.toLowerCase()
  return (!!id && a.includes(id)) || (!!name && a.includes(name))
}

export function projectOf(key?: string | null): string {
  if (!key) return '—'
  const m = key.match(/^([A-Z][A-Z0-9]+)-\d+/i)
  return m ? m[1].toUpperCase() : key
}

function parseDate(v?: string | null): Date | null {
  if (!v) return null
  // A pure date "YYYY-MM-DD" is parsed by `new Date()` as UTC midnight, which renders as the
  // PREVIOUS day for anyone west of UTC (e.g. the US). Parse it as LOCAL midnight instead so
  // update-log / resolved dates show the intended day everywhere. Datetime strings (with a time
  // or Z/offset) keep their normal parsing.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    const dt = new Date(Number(y), Number(m) - 1, Number(d))
    return isNaN(dt.getTime()) ? null : dt
  }
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

export function fmtDate(v?: string | null): string {
  const d = parseDate(v)
  if (!d) return v ?? '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function fmtDateTime(v?: string | null): string {
  const d = parseDate(v)
  if (!d) return v ?? '—'
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "3d ago", "2h ago", "just now". `now` is injected so it stays deterministic per render. */
export function relTime(v?: string | null, now: number = Date.now()): string {
  const d = parseDate(v)
  if (!d) return ''
  const diff = now - d.getTime()
  const abs = Math.abs(diff)
  const min = 60_000
  const hr = 60 * min
  const day = 24 * hr
  const suffix = diff >= 0 ? ' ago' : ' from now'
  if (abs < min) return 'just now'
  if (abs < hr) return `${Math.round(abs / min)}m${suffix}`
  if (abs < day) return `${Math.round(abs / hr)}h${suffix}`
  if (abs < 30 * day) return `${Math.round(abs / day)}d${suffix}`
  if (abs < 365 * day) return `${Math.round(abs / (30 * day))}mo${suffix}`
  return `${Math.round(abs / (365 * day))}y${suffix}`
}

export function yearOf(v?: string | null): string {
  const d = parseDate(v)
  return d ? String(d.getFullYear()) : 'Undated'
}

/**
 * How stale the dump is. Buckets requested by the user:
 *   < 3h   → "fresh"            (green)
 *   3–12h  → "fetched Xh ago"   (amber)
 *   > 12h  → "fetched Xh/Xd ago" (RED, stale → show the refresh banner)
 */
export function freshness(
  v?: string | null,
  now: number = Date.now(),
): { label: string; color: string; level: 'fresh' | 'aging' | 'stale' | 'unknown'; full: string; stale: boolean; ageHours: number } {
  const d = parseDate(v)
  if (!d) return { label: 'no run yet', color: '#94a3b8', level: 'unknown', full: '—', stale: false, ageHours: 0 }
  const full = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const h = (now - d.getTime()) / 3_600_000
  if (h < 3) return { label: 'fresh', color: '#22c55e', level: 'fresh', full, stale: false, ageHours: h }
  const ago = h < 48 ? `fetched ${Math.floor(h)}h ago` : `fetched ${Math.round(h / 24)}d ago`
  if (h < 12) return { label: ago, color: '#f59e0b', level: 'aging', full, stale: false, ageHours: h }
  return { label: ago, color: '#ef4444', level: 'stale', full, stale: true, ageHours: h }
}

// ── Sprint ────────────────────────────────────────────────────────────────
export interface SprintInfo {
  name: string
  state: 'active' | 'future' | 'closed' | ''
  start: string | null
  end: string | null
}

/** Parse the intern's canonical sprint string: "Name (state · YYYY-MM-DD → YYYY-MM-DD)".
 *  Degrades gracefully: bare names, missing dates and missing state all still parse. */
export function parseSprint(s?: string | null): SprintInfo | null {
  if (!s || !s.trim()) return null
  const m = s.match(/^(.*?)\s*\((active|future|closed)\b[^)]*\)\s*$/i)
  const name = (m ? m[1] : s.replace(/\s*\([^)]*\)\s*$/, '')).trim() || s.trim()
  const state = (m?.[2]?.toLowerCase() ?? '') as SprintInfo['state']
  const dates = s.match(/(\d{4}-\d{2}-\d{2})\s*(?:→|->|to)\s*(\d{4}-\d{2}-\d{2})/)
  return { name, state, start: dates?.[1] ?? null, end: dates?.[2] ?? null }
}

/** The sprint to headline: the ACTIVE sprint mentioned by the most board tickets,
 *  else the next FUTURE one — never a closed one (the header shouldn't dwell on the past). */
export function currentSprint(tickets: { sprint?: string | null }[]): SprintInfo | null {
  const counts = new Map<string, { info: SprintInfo; n: number }>()
  for (const t of tickets) {
    const info = parseSprint(t.sprint)
    if (!info) continue
    const k = `${info.state}|${info.name}`
    const e = counts.get(k)
    if (e) e.n++
    else counts.set(k, { info, n: 1 })
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n)
  return (
    ranked.find((e) => e.info.state === 'active')?.info ??
    ranked.find((e) => e.info.state === 'future')?.info ??
    null
  )
}

/** Working days (Mon–Fri) in the INCLUSIVE calendar range [from, to]; 0 when to < from.
 *  Sprints run ~2–3 weeks, so a simple day walk is plenty. */
export function workdaysBetween(fromTs: number, toTs: number): number {
  if (isNaN(fromTs) || isNaN(toTs) || toTs < fromTs) return 0
  const d = new Date(fromTs)
  d.setHours(0, 0, 0, 0)
  const end = new Date(toTs)
  end.setHours(0, 0, 0, 0)
  let n = 0
  while (d <= end) {
    const wd = d.getDay()
    if (wd !== 0 && wd !== 6) n++
    d.setDate(d.getDate() + 1)
  }
  return n
}

/** Where the sprint stands relative to `now` — drives the header chip's label + colour.
 *  Forward-looking counts ("left" / "starts in") are WORKING days (Mon–Fri), matching a
 *  5-day sprint week; "ended ago" stays calendar days (how long it's actually been). */
export function sprintStatus(
  sp: SprintInfo,
  now: number,
): { label: string; color: string; pct: number | null } {
  const DAY = 86_400_000
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`
  const startTs = sp.start ? Date.parse(`${sp.start}T00:00:00`) : NaN
  const endTs = sp.end ? Date.parse(`${sp.end}T23:59:59`) : NaN
  if (!isNaN(startTs) && now < startTs) {
    return { label: `starts in ${days(workdaysBetween(now + DAY, startTs))}`, color: '#64748b', pct: 0 }
  }
  if (!isNaN(endTs)) {
    if (now > endTs) return { label: `ended ${days(Math.ceil((now - endTs) / DAY))} ago`, color: '#ef4444', pct: 1 }
    const left = workdaysBetween(now, endTs) // includes today when it's a weekday
    const pct =
      !isNaN(startTs) && endTs > startTs
        ? Math.min(1, Math.max(0, workdaysBetween(startTs, now) / Math.max(1, workdaysBetween(startTs, endTs))))
        : null
    return { label: `${days(left)} left`, color: left <= 3 ? '#f59e0b' : '#3b82f6', pct }
  }
  return { label: sp.state || 'sprint', color: '#64748b', pct: null }
}

/**
 * The ticket's sprint IF that sprint hasn't started yet — work that is *queued* (next
 * sprint, or a grooming bucket like "FraudBus READY"), not committed to the current one.
 *
 * Jira's own `state` is authoritative: a sprint nobody has clicked "Start" on stays
 * `future` even once its planned start date has slipped by, and a READY bucket carries
 * no dates at all. Dates are only consulted for dumps that carry no state.
 */
export function futureSprintOf(sprint?: string | null, now: number = Date.now()): SprintInfo | null {
  const sp = parseSprint(sprint)
  if (!sp) return null
  if (sp.state === 'future') return sp
  if (sp.state) return null // active / closed → live work, belongs on the board
  const startTs = sp.start ? Date.parse(`${sp.start}T00:00:00`) : NaN
  return !Number.isNaN(startTs) && now < startTs ? sp : null
}

/**
 * Board rule: a To Do ticket parked in a not-yet-started sprint is NOT this sprint's
 * work — it gets its own "Next Sprint" section instead of padding the To Do column
 * (otherwise a fully-cleared To Do still looks like you have work outstanding).
 *
 * Deliberately scoped to `todo`: the moment you actually pick a next-sprint ticket up,
 * it shows in In Progress / Review / QA / On Hold where the real work state is.
 */
export function isNextSprint(t: { column: string; sprint?: string | null }, now: number): boolean {
  return t.column === 'todo' && futureSprintOf(t.sprint, now) != null
}

/** Compact "Jul 9" style date (no year) — for tight UI like the header sprint chip. */
export function fmtDateShort(v?: string | null): string {
  const d = parseDate(v)
  if (!d) return v ?? '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── misc ──────────────────────────────────────────────────────────────────
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function shortBranch(b?: string | null, max = 30): string {
  if (!b) return ''
  return b.length > max ? b.slice(0, max - 1) + '…' : b
}
