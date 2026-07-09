import { useMemo, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { ColumnKey, PrState } from '../types'
import { COLUMN_META } from '../lib/columns'
import { priorityMeta, typeMeta, prMeta, hexToRgba, branchStatusMeta } from '../lib/format'
import { APP_CONFIG } from '../lib/appConfig'
import { PriorityIcon, TypeIcon, PrStateIcon, CopyIcon, CheckIcon, ICON_SCALE } from './Icons'

export function Pill({
  children,
  color,
  filled,
  title,
  className = '',
}: {
  children: ReactNode
  color?: string
  filled?: boolean
  title?: string
  className?: string
}) {
  const c = color ?? 'var(--muted)'
  const style = filled
    ? { background: c, color: '#fff', borderColor: 'transparent' }
    : { color: c, borderColor: hexToRgba(c.startsWith('#') ? c : '#94a3b8', 0.4), background: hexToRgba(c.startsWith('#') ? c : '#bac2cd', 0.12) }
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10.5px] font-semibold leading-none whitespace-nowrap ${className}`}
      style={style}
    >
      {children}
    </span>
  )
}

export function StatusBadge({ column, label }: { column: ColumnKey; label: string }) {
  const accent = COLUMN_META[column]?.accent ?? '#64748b'
  return (
    <Pill color={accent} filled title={`Status: ${label}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/85" />
      {label}
    </Pill>
  )
}

/** Compact story-points tag shown right next to the ticket id. "NA" when unset. */
export function PointsTag({ points }: { points?: number | null }) {
  const has = typeof points === 'number'
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-1.5 py-[1px] text-[10px] font-bold tabular-nums ${
        has ? 'text-[var(--ink-soft)]' : 'text-[var(--muted)]'
      }`}
      title={has ? `${points} story point${points === 1 ? '' : 's'}` : 'No story points set'}
    >
      {has ? `${points} pt${points === 1 ? '' : 's'}` : 'NA'}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority?: string | null }) {
  const m = priorityMeta(priority)
  return (
    <Pill color={m.color} title={`Priority: ${m.label}`}>
      <PriorityIcon rank={m.rank} color={m.color} size={13} />
      {m.label}
    </Pill>
  )
}

export function TypeBadge({ type }: { type?: string | null }) {
  if (!type) return null
  const m = typeMeta(type)
  return (
    <Pill color={m.color} title={`Type: ${type}`}>
      <TypeIcon type={type} color={m.color} size={12} />
      {type}
    </Pill>
  )
}

export function PrBadge({ state }: { state?: PrState | null; compact?: boolean }) {
  // No PR → render nothing (the "Pull request" UI is hidden entirely when absent).
  if (!state || state === 'none') return null
  const m = prMeta(state)
  return (
    <Pill color={m.color} filled title={m.label}>
      <PrStateIcon state={state} color="#fff" size={12} />
      {m.label}
    </Pill>
  )
}

/** Whether a branch's PR merged / declined / is still open — shown next to the branch name. */
export function BranchStatusPill({ state }: { state?: PrState | null }) {
  if (!state || state === 'none') return null
  const m = branchStatusMeta(state)
  const filled = state === 'merged' || state === 'declined'
  return (
    <Pill color={m.color} filled={filled} title={`Branch ${m.label}`} className="shrink-0">
      {m.label}
    </Pill>
  )
}

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1300)
          },
          () => {},
        )
      }}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--ink-soft)] transition-colors hover:border-[var(--muted)] hover:text-[var(--ink)] ${className}`}
    >
      {done ? <CheckIcon size={12} color="#22c55e" /> : <CopyIcon size={12} />}
      {done ? 'Copied' : label}
    </motion.button>
  )
}

/** A PR counts as truly approved only when at least this many reviewers have approved (config.json → app.requiredApprovals). */
export const REQUIRED_APPROVALS = APP_CONFIG.requiredApprovals

function ApprovalDot({ filled }: { filled: boolean }) {
  const s = Math.round(11 * ICON_SCALE) // follow the global +40% icon scale
  return filled ? (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="#22c55e" />
      <path d="M8 12.5l2.5 2.5L16 9.3" stroke="#fff" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="#94a3b8" strokeWidth="2.2" />
    </svg>
  )
}

/** At-a-glance approval progress: ●●=approved (≥2), ●○=1 of 2, ○○=none yet. */
export function Approvals({ approvals }: { approvals?: number | null }) {
  const n = Math.max(0, approvals ?? 0)
  const full = n >= REQUIRED_APPROVALS
  const color = full ? '#22c55e' : '#94a3b8'
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-[2px] leading-none"
      title={`${n} of ${REQUIRED_APPROVALS} approvals${full ? ' — approved ✓' : ' — needs ' + (REQUIRED_APPROVALS - n) + ' more'}`}
      style={{ borderColor: hexToRgba(color, 0.45), background: hexToRgba(color, 0.12) }}
    >
      <span className="inline-flex items-center gap-0.5">
        {Array.from({ length: REQUIRED_APPROVALS }).map((_, i) => (
          <ApprovalDot key={i} filled={i < n} />
        ))}
      </span>
      <span className="text-[9.5px] font-bold tabular-nums" style={{ color: full ? '#22c55e' : 'var(--muted)' }}>
        {n}/{REQUIRED_APPROVALS}
        {n > REQUIRED_APPROVALS ? `+${n - REQUIRED_APPROVALS}` : ''}
      </span>
    </span>
  )
}

// ── HTML sanitization ───────────────────────────────────────────────────────
// The HTML rendered here comes from Jira ticket descriptions, proposed-solution
// fields and COMMENT BODIES — authored by many colleagues, not just the user.
// Treat it as UNTRUSTED. We parse it into an inert <template> (whose content is a
// detached fragment: <img onerror>/<iframe>/resource loads do NOT fire there) and
// walk the tree with a strict ALLOWLIST, dropping every unknown tag/attribute and
// neutralising javascript:/data: URLs. This also keeps the layout clean (no pasted
// inline styles / class names) so our .prose-mini rules fully control rendering.

// Formatting tags we keep. Everything else (script/style/iframe/object/embed/form/
// input/img/svg/…) is removed; a removed element's safe children are preserved.
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'SPAN', 'DIV',
  'UL', 'OL', 'LI', 'CODE', 'PRE', 'BLOCKQUOTE', 'A',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
])
// Tags whose text content is also unsafe/noise — drop them AND their subtree.
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE'])
const ALLOWED_ATTRS = new Set(['href', 'title', 'colspan', 'rowspan'])
const SAFE_URL = /^(https?:|mailto:|#|\/)/i

function isSafeUrl(v: string): boolean {
  // Strip control chars/whitespace that hide "java\tscript:" and decode nothing.
  return SAFE_URL.test(v.replace(/[\u0000-\u0020]+/g, '').trim())
}

function cleanElement(el: Element) {
  // Remove every attribute not explicitly allowed (kills on*=, style, class,
  // data-*, srcdoc, formaction, …). Neutralise unsafe href values.
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase()
    if (!ALLOWED_ATTRS.has(name)) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name === 'href' && !isSafeUrl(attr.value)) el.removeAttribute(attr.name)
  }
  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank')
    el.setAttribute('rel', 'noopener noreferrer')
  }
}

function sanitizeNode(node: Node) {
  // Iterate over a static copy — we mutate children as we go.
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8 /* comment */) {
      child.parentNode?.removeChild(child)
      continue
    }
    if (child.nodeType !== 1 /* element */) continue // keep text nodes as-is
    const el = child as Element
    const tag = el.tagName
    if (DROP_WITH_CONTENT.has(tag)) {
      el.parentNode?.removeChild(el)
      continue
    }
    sanitizeNode(el) // clean descendants first
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown but harmless wrapper: unwrap it, keeping its (already-cleaned) kids.
      const parent = el.parentNode
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
      }
      continue
    }
    cleanElement(el)
  }
}

/** Convert markdown / Jira-wiki link syntax to real anchors BEFORE parsing to DOM. */
function linkifyRaw(html: string): string {
  return html
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[([^\]|]+)\|(https?:\/\/[^\]\s]+)\]/g, '<a href="$2">$1</a>')
}

/** Sanitize untrusted HTML to a safe subset. Dependency-free; uses an inert <template>. */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  const linkified = linkifyRaw(html)
  if (typeof document === 'undefined') return '' // no DOM (SSR) → render nothing rather than raw HTML
  const tpl = document.createElement('template')
  tpl.innerHTML = linkified // inert: no scripts run, no resources load
  sanitizeNode(tpl.content)
  return tpl.innerHTML
}

/** Renders colleague-authored Jira HTML after allowlist sanitization; opens links in a new tab. */
export function SafeHtml({ html, className = '' }: { html?: string | null; className?: string }) {
  const processed = useMemo(() => sanitizeHtml(html ?? ''), [html])
  if (!html) return null
  return <div className={`prose-mini ${className}`} dangerouslySetInnerHTML={{ __html: processed }} />
}

export function ExternalLink({ href, children }: { href?: string | null; children: ReactNode }) {
  if (!href) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline" style={{ color: 'var(--link)' }}>
      {children}
      <span className="opacity-60"> ↗</span>
    </a>
  )
}
