// Demo mode runs the drag-and-drop rules locally, so refusals, warnings, ⌥-force and Undo behave
// exactly as they do against real Jira — without a server, a token or a transition. The rules
// themselves are lib/moveRules.ts (mirror of jira-intern/transition.py).
import { targetLabel, type MoveTarget } from '../lib/columns'
import { checkMove, type TicketLookup } from '../lib/moveRules'
import type { MoveMode, MoveVerdict } from '../lib/runner'
import type { Ticket } from '../types'

export { qaIssuesOf } from '../lib/moveRules'

/** Gate verdict for a move: a blocking reason (or null) plus soft warnings. */
export function evaluateMove(target: MoveTarget, t: Ticket, lookup?: TicketLookup): { blocker: string | null; warnings: string[] } {
  const c = checkMove(t, target, lookup)
  return { blocker: c.reason, warnings: c.warnings }
}

/** The same verdict shape the server returns, so demo and live moves are handled identically. */
export function demoMoveVerdict(t: Ticket, to: MoveTarget, mode: MoveMode = 'normal', lookup?: TicketLookup): MoveVerdict {
  const c = checkMove(t, to, lookup)
  // Undo puts a ticket back where it was; force skips the PR / QA gates but never the QA lane.
  const blocked = mode === 'undo' ? null : c.kind === 'lane' || (c.kind === 'gate' && mode !== 'force') ? c : null
  if (blocked) return { ok: false, blocked: true, reason: blocked.reason ?? undefined, forcible: blocked.kind === 'gate' }
  return { ok: true, moved: true, status: targetLabel(to), warnings: mode === 'normal' ? c.warnings : [] }
}
