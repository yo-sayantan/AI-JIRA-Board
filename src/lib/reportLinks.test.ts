import { describe, expect, it } from 'vitest'
import { hrefForPr, linkifyReportHtml } from './reportLinks'
import type { PrReport } from './reportTypes'

const report = {
  key: 'PROJ-7',
  links: [
    { label: 'Jira', href: 'https://jira.example.com/browse/PROJ-1' },
    { label: 'PR', href: 'javascript:alert(1)/pull-requests/9' },
  ],
} as unknown as PrReport

describe('linkifyReportHtml', () => {
  it('does not turn CVE or SHA tokens into Jira links', () => {
    expect(linkifyReportHtml('see CVE-2026-1234', report)).toBe('see CVE-2026-1234')
    expect(linkifyReportHtml('uses SHA-256', report)).toBe('uses SHA-256')
  })
  it('links keys of a project seen in report.links', () => {
    const out = linkifyReportHtml('blocked by PROJ-42', report)
    expect(out).toContain('<a href="https://jira.example.com/browse/PROJ-42">PROJ-42</a>')
  })
})

describe('hrefForPr', () => {
  it('ignores a javascript: href', () => {
    expect(hrefForPr(report, '9')).toBeNull()
  })
})
