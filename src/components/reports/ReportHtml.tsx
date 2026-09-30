import type { PrReport } from '../lib/reportTypes'
import { linkifyReportHtml } from '../lib/reportLinks'
import { SafeHtml } from './ui'

/** Ticket keys, PR #n and https URLs in report prose become real <a href> (Jira / Bitbucket / Confluence). */
export function ReportHtml({
  html,
  report,
  className,
  inline,
}: {
  html?: string | null
  report: PrReport
  className?: string
  inline?: boolean
}) {
  return <SafeHtml html={linkifyReportHtml(html ?? '', report)} className={className} inline={inline} />
}
