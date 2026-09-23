/** Turn ticket keys and PR numbers in a PR readiness report into real https links.

The generator stores those URLs on `report.links` (Jira browse, Bitbucket PRs, Confluence).
The body still mentions FRAUDBUSTE-326 / PR #80 as plain text, and the print document used
to dump the URL as a <span>, so a senior opening the PDF could not click through.
*/
import type { PrReport, ReportLink } from './reportTypes'

const KEY_RE = /\b([A-Z][A-Z0-9]{1,15}-\d+)\b/g
const PR_RE = /\bPR\s*#(\d+)\b/gi
const URL_RE = /\bhttps?:\/\/[^\s<>"'\)\]]+/gi

export function jiraBrowsePrefix(report: PrReport): string | null {
  for (const l of report.links || []) {
    const m = (l.href || '').match(/^(https?:\/\/[^?\s#]+?)\/browse\/[A-Z][A-Z0-9]+-\d+/i)
    if (m) return `${m[1]}/browse`
  }
  return null
}

export function hrefForKey(report: PrReport, key: string): string | null {
  const exact = (report.links || []).find((l) => l.href?.includes(`/browse/${key}`))
  if (exact?.href) return exact.href
  const prefix = jiraBrowsePrefix(report)
  return prefix ? `${prefix}/${key}` : null
}

export function hrefForPr(report: PrReport, id: string): string | null {
  const hit = (report.links || []).find((l) => (l.href || '').includes(`/pull-requests/${id}`))
  return hit?.href || null
}

function inTag(html: string, i: number): boolean {
  const lt = html.lastIndexOf('<', i)
  const gt = html.lastIndexOf('>', i)
  return lt > gt
}

function inAnchor(html: string, i: number): boolean {
  const before = html.slice(0, i).toLowerCase()
  return before.lastIndexOf('<a') > before.lastIndexOf('</a')
}

function inMarkdownLink(html: string, i: number): boolean {
  const before = html.slice(Math.max(0, i - 80), i)
  const after = html.slice(i, i + 120)
  return /\[[^\]]*$/.test(before) && /\]\(https?:/.test(after)
}

function skip(html: string, i: number): boolean {
  return inTag(html, i) || inAnchor(html, i) || inMarkdownLink(html, i)
}

function trimUrl(raw: string): { href: string; tail: string } {
  const m = raw.match(/^(.*?)([.,;:]+)$/)
  return m ? { href: m[1], tail: m[2] } : { href: raw, tail: '' }
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Insert <a href> around ticket keys and PR #n in already-built HTML (skips existing anchors). */
export function linkifyReportHtml(html: string, report: PrReport): string {
  if (!html) return html
  KEY_RE.lastIndex = 0
  PR_RE.lastIndex = 0
  URL_RE.lastIndex = 0
  let out = html.replace(KEY_RE, (key, _g, offset: number) => {
    if (skip(html, offset)) return key
    const href = hrefForKey(report, key)
    return href ? `<a href="${escAttr(href)}">${key}</a>` : key
  })
  out = out.replace(PR_RE, (full, id: string, offset: number) => {
    if (skip(out, offset)) return full
    const href = hrefForPr(report, id)
    return href ? `<a href="${escAttr(href)}">${full}</a>` : full
  })
  out = out.replace(URL_RE, (raw, offset: number) => {
    if (skip(out, offset)) return raw
    const { href, tail } = trimUrl(raw)
    if (!/^https?:\/\//i.test(href)) return raw
    return `<a href="${escAttr(href)}">${href}</a>${tail}`
  })
  return out
}

export function shareableLinks(report: PrReport): ReportLink[] {
  return (report.links || []).filter((l) => /^https?:\/\//i.test(l.href || ''))
}
