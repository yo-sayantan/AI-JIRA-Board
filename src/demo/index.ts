// Demo mode: a full sample board for trying the UI out — drag-and-drop, the gates, the drawer,
// the archive, Raised by me and two PR Readiness Reports — with every server call switched off.
//
// Nothing here reaches Jira, Bitbucket or the AI intern: `runner.ts` refuses the ticket-pipeline
// calls outright while demo mode is on (see `setDemoMode`), and moves are judged locally by
// `gates.ts`, which mirrors `jira-intern/transition.py`.
import type { JiraData } from '../types'
import { buildDemoDump } from './data'

export { demoMoveVerdict, evaluateMove, qaIssuesOf } from './gates'
export { demoReports } from './reports'

/** Shown whenever an action that would hit Jira or the AI intern is refused. */
export const DEMO_REFUSED = 'Demo mode — nothing is sent to Jira or the AI intern.'

let dump: JiraData | null = null

/** The sample board. Built once per session so dates (and object identity) stay stable. */
export function demoDump(): JiraData {
  if (!dump) dump = buildDemoDump()
  return dump
}
