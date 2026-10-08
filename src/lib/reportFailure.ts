// Why a PR readiness report was not produced, in words. The exit code is the one
// `jira-intern/pr_report.py base` returns (kept per ticket by the server's report queue and sent
// as `exits` by GET /api/reports) — keep the codes in sync with EXIT_* there.

export const REPORT_EXIT_INTERNAL = 1
export const REPORT_EXIT_NOT_IN_DATA = 3
export const REPORT_EXIT_NO_PR = 4

/** One sentence the board shows when generating the report for `key` finished without a report. */
export function reportFailureReason(key: string, exit?: number | null): string {
  switch (exit) {
    case REPORT_EXIT_NO_PR:
      return `No report for ${key}: Jira shows no pull request for it, so there is nothing to assess. Link a PR (its title or branch must name ${key}), refresh the ticket, then try again.`
    case REPORT_EXIT_NOT_IN_DATA:
      return `No report for ${key}: it is not in the board's data yet. Refresh the ticket first, then try again.`
    case REPORT_EXIT_INTERNAL:
      return `No report for ${key}: the generated report failed its own consistency check — see jira-intern/logs/ for the reason.`
    case 130:
    case 143:
      return `Report generation for ${key} was stopped before it finished.`
    default:
      return `No report for ${key}: generation ended without one${typeof exit === 'number' ? ` (exit ${exit})` : ''} — see jira-intern/logs/.`
  }
}

/** The toast for a batch: the single reason when one ticket failed, a short grouped summary otherwise. */
export function reportFailureSummary(keys: string[], exits: Record<string, number> | undefined): string {
  if (keys.length === 1) return reportFailureReason(keys[0], exits?.[keys[0]])
  const noPr = keys.filter((k) => exits?.[k] === REPORT_EXIT_NO_PR)
  const other = keys.filter((k) => exits?.[k] !== REPORT_EXIT_NO_PR)
  const parts: string[] = []
  if (noPr.length) parts.push(`${noPr.length} have no pull request in Jira (${noPr.slice(0, 3).join(', ')}${noPr.length > 3 ? '…' : ''})`)
  if (other.length) parts.push(`${other.length} failed for another reason — see jira-intern/logs/`)
  return `${keys.length} reports were not generated: ${parts.join('; ')}.`
}
