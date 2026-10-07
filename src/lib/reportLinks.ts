/** Turn ticket keys and PR numbers in a PR readiness report into real https links.

The generator stores those URLs on `report.links` (Jira browse, Bitbucket PRs, Confluence).
The body still mentions PROJ-326 / PR #80 as plain text, and the print document used
to dump the URL as a <span>, so a senior opening the PDF could not click through.
*/
import type { PrReport, ReportLink } from './reportTypes'

const PR_RE = /\bPR\s*#(\d+)\b/gi
const URL_RE = /\bhttps?:\/\/[^\s<>"'\)\]]+/gi
const HTTP_RE = /^https?:\/\//i
const BROWSE_RE = /\/browse\/([A-Z][A-Z0-9]{1,15})-\d+/i

/** Only web URLs may become links; a `javascript:` or relative value in report.links is ignored. */
const webHref = (href?: string | null): string | null => (href && HTTP_RE.test(href) ? href : null)

const projectOfKey = (key: string): string | null => /^([A-Z][A-Z0-9]{1,15})-\d+$/i.exec(key)?.[1]?.toUpperCase() ?? null

/**
 * Project keys this report may link: its own ticket's project plus any project seen in a Jira
 * browse URL on `report.links`. Linkifying every ALLCAPS-dash-number token also turned
 * "CVE-2026-1234", "SHA-256", "UTF-8" and "ISO-8601" into dead Jira links.
 */
export function linkableProjects(report: PrReport): string[] {
  const projects = new Set<string>()
  const own = projectOfKey(report.key ?? '')
  if (own) projects.add(own)
  for (const l of report.links || []) {
    const m = BROWSE_RE.exec(l.href || '')
    if (m) projects.add(m[1].toUpperCase())
  }
  return [...projects]
}

const keyRegexCache = new WeakMap<PrReport, RegExp | null>()

/** `\b(PROJ|OTHER)-\d+\b` for this report, or null when it has no linkable project at all. */
function keyRegexFor(report: PrReport): RegExp | null {
  if (keyRegexCache.has(report)) return keyRegexCache.get(report) ?? null
  const projects = linkableProjects(report)
  const re = projects.length ? new RegExp(`\\b((?:${projects.join('|')})-\\d+)\\b`, 'g') : null
  keyRegexCache.set(report, re)
  return re
}

export function jiraBrowsePrefix(report: PrReport): string | null {
  for (const l of report.links || []) {
    const m = (l.href || '').match(/^(https?:\/\/[^?\s#]+?)\/browse\/[A-Z][A-Z0-9]+-\d+/i)
    if (m) return `${m[1]}/browse`
  }
  return null
}

export function hrefForKey(report: PrReport, key: string): string | null {
  const exact = (report.links || []).find((l) => l.href?.includes(`/browse/${key}`))
  const exactHref = webHref(exact?.href)
  if (exactHref) return exactHref
  const prefix = jiraBrowsePrefix(report)
  return prefix ? `${prefix}/${key}` : null
}

export function hrefForPr(report: PrReport, id: string): string | null {
  const hit = (report.links || []).find((l) => (l.href || '').includes(`/pull-requests/${id}`))
  return webHref(hit?.href)
}

function inTag(html: string, i: number): boolean {
  const lt = html.lastIndexOf('<', i)
  const gt = html.lastIndexOf('>', i)
  return lt > gt
}

/** Index of the last match of `re` in `s`, or -1. */
function lastMatchIndex(s: string, re: RegExp): number {
  let last = -1
  re.lastIndex = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    last = m.index
    if (m[0].length === 0) re.lastIndex++
  }
  return last
}

const ANCHOR_OPEN_RE = /<a[\s>]/gi
const ANCHOR_CLOSE_RE = /<\/a\s*>/gi

/** True when position `i` sits inside an existing <a>…</a>. Matches real anchor tags only — a plain
 *  `lastIndexOf('<a')` also fired on <abbr>, <address> and <aside>. */
function inAnchor(html: string, i: number): boolean {
  const before = html.slice(0, i)
  return lastMatchIndex(before, ANCHOR_OPEN_RE) > lastMatchIndex(before, ANCHOR_CLOSE_RE)
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
  PR_RE.lastIndex = 0
  URL_RE.lastIndex = 0
  const keyRe = keyRegexFor(report)
  let out = html
  if (keyRe) {
    keyRe.lastIndex = 0
    out = html.replace(keyRe, (key: string, _g: string, offset: number) => {
      if (skip(html, offset)) return key
      const href = hrefForKey(report, key)
      return href ? `<a href="${escAttr(href)}">${key}</a>` : key
    })
  }
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
