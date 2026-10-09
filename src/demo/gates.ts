// Demo mode runs the drag-and-drop gates locally, so the warnings and the Done refusal behave
// exactly as they do against real Jira — without a server, a token or a transition.
//
// MIRROR OF `jira-intern/transition.py::evaluate` / `lane_blocker` (and `is_qa`). If the rules change there,
// change them here; `gates.test.ts` pins the behaviour both sides agree on.
import { isQaTicket, looksLikeQa, mapStatusToColumn, moveBlockedReason, targetLabel, type MoveTarget } from '../lib/columns'
import { prListOf } from '../lib/format'
import type { MoveVerdict } from '../lib/runner'
import type { LinkRef, Ticket } from '../types'

interface QaIssue {
  key: string
  status?: string | null
}

/** The ticket's QA tickets: QA-ish sub-tasks plus QA-ish linked issues. */
export function qaIssuesOf(t: Ticket): QaIssue[] {
  const found = new Map<string, QaIssue>()
  for (const s of t.subtasks ?? []) {
    if (s.key && looksLikeQa(s.type, s.title)) found.set(s.key, { key: s.key, status: s.status })
  }
  for (const r of (t.related ?? []) as LinkRef[]) {
    if (r.key && !found.has(r.key) && looksLikeQa(null, r.title ?? r.summary)) found.set(r.key, { key: r.key, status: r.status })
  }
  return [...found.values()]
}

/** Gate verdict for a move: a blocking reason (or null) plus soft warnings. */
export function evaluateMove(target: MoveTarget, t: Ticket): { blocker: string | null; warnings: string[] } {
  // The QA lane first: it decides before any PR or QA-ticket gate is looked at.
  const lane = moveBlockedReason(t, target)
  if (lane) return { blocker: lane, warnings: [] }
  const live = prListOf(t).filter((p) => p.state !== 'declined')
  const qa = qaIssuesOf(t)
  // A sub-ticket's work usually rides on its parent's PR, and a QA ticket is someone else's test of
  // it: no PR (or QA ticket) of their own is fine, but a PR of their own that is not merged yet still
  // blocks Done.
  const isSub = !!t.parentKey || t.column === 'qa' || isQaTicket(t)
  const warnings: string[] = []
  if (target === 'rev' && live.length === 0 && !isSub) warnings.push('No pull request found for this ticket — raise one for review.')
  if (target === 'hold') {
    const open = live.filter((p) => !p.merged)
    if (open.length) warnings.push(`${open.map((p) => (p.id ? `#${p.id}` : 'a PR')).join(', ')} is still open — it will wait unreviewed while the ticket is on hold.`)
  }
  if (target !== 'done') return { blocker: null, warnings }

  const problems: string[] = []
  if (live.length === 0) {
    if (!isSub) problems.push('it has no merged pull request')
  } else {
    const unmerged = live.filter((p) => !p.merged)
    if (unmerged.length) problems.push(`${unmerged.map((p) => (p.id ? `#${p.id}` : 'a PR')).join(', ')} not merged yet`)
  }
  if (qa.length === 0) {
    if (!isSub) problems.push('it has no QA ticket')
  } else {
    const open = qa.filter((q) => mapStatusToColumn(q.status) !== 'done')
    if (open.length) problems.push(`QA not done (${open.map((q) => `${q.key} is ${q.status ?? 'open'}`).join(', ')})`)
  }
  return { blocker: problems.length ? `Can't move to Done: ${problems.join('; ')}.` : null, warnings }
}

/** The same verdict shape the server returns, so demo and live moves are handled identically. */
export function demoMoveVerdict(t: Ticket, to: MoveTarget): MoveVerdict {
  const { blocker, warnings } = evaluateMove(to, t)
  if (blocker) return { ok: false, blocked: true, reason: blocker }
  return { ok: true, moved: true, status: targetLabel(to), warnings }
}
