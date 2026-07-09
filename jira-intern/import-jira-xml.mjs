#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// import-jira-xml.mjs — reconcile the dashboard from a Jira XML export.
//
// Usage:   node import-jira-xml.mjs [path/to/export.xml]
//   (defaults to the newest of: ./jira-export.xml, ../jira-board/my_dashboard.xml)
//
// What it does:
//   • Accepts EITHER a raw Jira RSS/XML export OR the Word-wrapped variant your
//     browser saves ("This XML file does not appear to have any style…").
//   • Parses every <item> (ticket) and maps issue <type> VERBATIM (Dev Task,
//     Requirements, Security, Task, Support, QA Task, …).
//   • Merges into data.json to FILL GAPS + correct metadata, and regenerates data.js.
//   • NEVER touches branch / branches / pr / prs — Jira XML has no dev-panel data,
//     so those stay owned by the intern's Bitbucket fetch.
//
// It is safe to re-run (idempotent). It prints a summary of what it filled/added.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
// Output dir defaults to the script's dir; override with JIRA_INTERN_DIR (used for testing).
const DATA_DIR = process.env.JIRA_INTERN_DIR ? resolve(process.env.JIRA_INTERN_DIR) : HERE
const DATA_JSON = resolve(DATA_DIR, 'data.json')
const DATA_JS = resolve(DATA_DIR, 'data.js')

// ── locate the export ───────────────────────────────────────────────────────
function pickInput() {
  const arg = process.argv[2]
  if (arg) return resolve(process.cwd(), arg)
  const candidates = [
    resolve(HERE, 'jira-export.xml'),
    resolve(HERE, 'my_dashboard.xml'),
    resolve(HERE, '../my_dashboard.xml'),
  ].filter(existsSync)
  if (!candidates.length) {
    console.error('No XML given and no default export found. Pass a path:\n  node import-jira-xml.mjs path/to/export.xml')
    process.exit(2)
  }
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

// ── entity decode + WordML unwrap ────────────────────────────────────────────
const decode = (s) =>
  (s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

// Unwrap <![CDATA[ … ]]> keeping the inner text. Must run BEFORE any tag-strip,
// otherwise the whole CDATA block looks like one big tag and the value is lost.
const stripCdata = (s) => (s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')

function toRss(raw) {
  // Word-wrapped export: reconstruct the escaped RSS from the <w:t> text runs.
  if (/<w:wordDocument|<w:t[\s>]/.test(raw)) {
    const runs = [...raw.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
    return decode(runs)
  }
  return raw
}

// ── tiny XML helpers (regex-based; no deps) ──────────────────────────────────
const inner = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? stripCdata(m[1]) : null
}
const text = (block, tag) => {
  const v = inner(block, tag)
  if (v == null) return null
  const t = decode(v.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  return t || null
}
const attrOf = (openTag, name) => {
  const m = (openTag || '').match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return m ? decode(m[1]) : null
}
// value(s) of a Jira custom field by (case-insensitive) name
function customField(itemXml, name) {
  const re = /<customfield\b[^>]*>([\s\S]*?)<\/customfield>/gi
  let m
  while ((m = re.exec(itemXml))) {
    const cf = m[1]
    const nm = text(cf, 'customfieldname')
    if (nm && nm.toLowerCase() === name.toLowerCase()) {
      const vals = [...cf.matchAll(/<customfieldvalue\b[^>]*>([\s\S]*?)<\/customfieldvalue>/gi)]
        .map((x) => decode(stripCdata(x[1]).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      if (vals.length) return vals
    }
  }
  return []
}

const rfcToISO = (s) => {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}
// Calendar date in the SAME offset the string carries (not UTC) — otherwise an
// e.g. +0530 timestamp just after midnight would report the previous day.
const isoDate = (s) => {
  if (!s) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  const m = s.match(/([+-])(\d{2})(\d{2})\s*$/)
  if (m) {
    const mins = (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10))
    return new Date(d.getTime() + mins * 60000).toISOString().slice(0, 10)
  }
  return d.toISOString().slice(0, 10)
}

// status → board column (mirrors intern-prompt.md)
function toColumn(status) {
  const s = (status || '').toLowerCase()
  if (/(^|\b)(done|closed|resolved|released|complete)/.test(s)) return 'done'
  if (/hold|blocked|waiting|parked|impeded/.test(s)) return 'hold'
  if (/qa|testing|verification/.test(s)) return 'qa'
  if (/review|ready4review|ready for review/.test(s)) return 'rev'
  if (/progress|in development|in dev/.test(s)) return 'prog'
  return 'todo'
}
const isDoneStatus = (status, resolution) =>
  toColumn(status) === 'done' || (!!resolution && !/unresolved/i.test(resolution))

// light-clean an HTML field: drop comments + hidden je_sep blocks + CDATA artifacts
function cleanHtml(html) {
  if (!html) return null
  let h = stripCdata(html)
  h = decode(h)
  h = h.replace(/<!--[\s\S]*?-->/g, '')
  h = h.replace(/<div[^>]*je_sep[^>]*>[\s\S]*?<\/div>/gi, '')
  h = h.replace(/\]\]>/g, '') // belt-and-braces for a truncated CDATA
  h = h.replace(/\s+/g, ' ').trim()
  return h || null
}

// ── parse one <item> into a normalized record ────────────────────────────────
function parseItem(itemXml, jiraBase) {
  const rawKey = text(itemXml, 'key')
  const rawTitle = text(itemXml, 'title')
  const key = rawKey || (rawTitle && (rawTitle.match(/\[([A-Z][A-Z0-9]*-\d+)\]/) || [])[1]) || null
  if (!key) return null
  const title = (rawTitle || key).replace(/^\[[A-Z][A-Z0-9]*-\d+\]\s*/, '').trim()
  const status = text(itemXml, 'status')
  const resolution = text(itemXml, 'resolution')
  const type = text(itemXml, 'type')
  const priority = text(itemXml, 'priority')
  const assignee = text(itemXml, 'assignee')
  const reporter = text(itemXml, 'reporter')
  const created = isoDate(text(itemXml, 'created'))
  const updated = rfcToISO(text(itemXml, 'updated'))
  const resolved = isDoneStatus(status, resolution) ? isoDate(text(itemXml, 'resolved')) : null
  const spRaw = customField(itemXml, 'Story Points')[0]
  const storyPoints = spRaw != null && spRaw !== '' && !isNaN(parseFloat(spRaw)) ? Math.round(parseFloat(spRaw)) : null
  const epicKey = customField(itemXml, 'Epic Link')[0] || null
  const sprint = customField(itemXml, 'Sprint').filter((v) => !/^\d+$/.test(v)).pop() || null
  const labels = [...itemXml.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean)
  const components = [...itemXml.matchAll(/<component\b[^>]*>([\s\S]*?)<\/component>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean)

  const comments = [...itemXml.matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/gi)].map((m) => ({
    author: attrOf(m[1], 'author'),
    when: rfcToISO(attrOf(m[1], 'created')),
    body: cleanHtml(m[2]),
  }))

  const subtaskKeys = [...itemXml.matchAll(/<subtask\b[^>]*>([A-Z][A-Z0-9]*-\d+)<\/subtask>/gi)].map((m) => m[1])

  // issue links → related[]
  const related = []
  const linksBlock = inner(itemXml, 'issuelinks') || ''
  for (const lt of linksBlock.matchAll(/<issuelinktype\b[^>]*>([\s\S]*?)<\/issuelinktype>/gi)) {
    for (const dir of lt[1].matchAll(/<(inward|outward)links\b([^>]*)>([\s\S]*?)<\/\1links>/gi)) {
      const rel = attrOf(dir[2], 'description') || text(lt[1], 'name')
      for (const lk of dir[3].matchAll(/<issuekey\b[^>]*>([A-Z][A-Z0-9]*-\d+)<\/issuekey>/gi)) {
        related.push({ key: lk[1], relation: rel, url: `${jiraBase}/browse/${lk[1]}` })
      }
    }
  }

  const description = cleanHtml(inner(itemXml, 'description'))

  return {
    key, title, status, column: toColumn(status), type, priority, resolution,
    assignee, reporter, created, updated, resolved, storyPoints, epicKey, sprint,
    labels, components, comments, subtaskKeys, related, description,
    url: `${jiraBase}/browse/${key}`,
    done: isDoneStatus(status, resolution),
  }
}

// ── merge helpers ─────────────────────────────────────────────────────────────
function isMine(assignee, user) {
  if (!assignee) return false
  const a = assignee.toLowerCase()
  const id = user?.accountId?.toLowerCase()
  const name = user?.name?.toLowerCase()
  return (!!id && a.includes(id)) || (!!name && a.includes(name))
}
const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0)

// For tickets the intern already fetched, "fill any gaps" = GAP-FILL only (never
// downgrade fresher/richer intern data). The ONE exception is `type`: the user wants
// the classification corrected, so XML type is authoritative.
function applyRecord(target, r, changed) {
  // type — authoritative (overwrite when XML has one and it differs)
  if (r.type && target.type !== r.type) { target.type = r.type; changed.add('type') }
  // everything else — gap-fill only (set when the target field is empty/missing)
  const gap = (field, val) => {
    if (empty(val)) return
    if (empty(target[field])) { target[field] = val; changed.add(field) }
  }
  gap('title', r.title); gap('status', r.status); gap('column', r.column); gap('priority', r.priority)
  gap('storyPoints', r.storyPoints); gap('assignee', r.assignee); gap('reporter', r.reporter)
  gap('created', r.created); gap('sprint', r.sprint); gap('lastUpdate', r.updated); gap('url', r.url)
  gap('labels', r.labels); gap('components', r.components)
  gap('description', r.description); gap('comments', r.comments); gap('related', r.related)
  // Only fill resolved/done when the target isn't already a live ACTIVE ticket
  // (empty done = a stub/new; true = already done). Never stamp a close-date on
  // a ticket the intern still shows as active/on-hold.
  if (r.done && (target.done === true || empty(target.done))) { gap('resolved', r.resolved); gap('done', true) }
  if (r.epicKey) gap('epic', { key: r.epicKey, url: r.url.replace(/\/[^/]+$/, '/' + r.epicKey), relation: 'epic (parent)' })
  if (r.subtaskKeys.length && empty(target.subtaskCount)) { target.subtaskCount = r.subtaskKeys.length; changed.add('subtaskCount') }
  // branch / branches / pr / prs: intentionally UNTOUCHED (Bitbucket-owned).
}

function newEntry(r) {
  const e = {
    key: r.key, title: r.title, type: r.type, status: r.status, column: r.column,
    priority: r.priority, storyPoints: r.storyPoints, assignee: r.assignee, reporter: r.reporter,
    created: r.created, lastUpdate: r.updated, url: r.url,
    project: (r.key.match(/^([A-Z][A-Z0-9]+)-/) || [])[1] || null,
    labels: r.labels, components: r.components, description: r.description,
    comments: r.comments, related: r.related,
    done: r.done, onHold: r.column === 'hold',
  }
  if (r.done) e.resolved = r.resolved
  if (r.epicKey) e.epic = { key: r.epicKey, url: r.url.replace(/\/[^/]+$/, '/' + r.epicKey), relation: 'epic (parent)' }
  if (r.subtaskKeys.length) e.subtaskCount = r.subtaskKeys.length
  return e
}

// ── main ──────────────────────────────────────────────────────────────────────
const INPUT = pickInput()
const rss = toRss(readFileSync(INPUT, 'utf8'))
const data = JSON.parse(readFileSync(DATA_JSON, 'utf8'))
// Identity/endpoints: data.json's user first, then config.json (the portable source of
// truth) — no hardcoded company values.
let cfg = {}
try {
  cfg = JSON.parse(readFileSync(resolve(HERE, 'config.json'), 'utf8'))
} catch {}
const user = {
  name: data.user?.name || cfg.user?.name || '',
  accountId: data.user?.accountId || cfg.user?.accountId || '',
}
const jiraBase = data.user?.jiraBase || cfg.endpoints?.jiraBase || ''

const allParsed = [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => parseItem(m[1], jiraBase))
const droppedCount = allParsed.filter((x) => !x).length
const items = allParsed.filter(Boolean)
if (!items.length) {
  console.error(`Parsed 0 tickets from ${INPUT}. If this is a single-issue export it may still work; otherwise re-export from the Issue Navigator (Export → XML).`)
  process.exit(1)
}

const byKey = new Map()
for (const t of data.tickets || []) byKey.set(t.key, { arr: 'tickets', obj: t })
for (const c of data.completed || []) if (!byKey.has(c.key)) byKey.set(c.key, { arr: 'completed', obj: c })
// Also index NESTED sub-tasks (they carry their own Bitbucket branch/PR). Matching them
// gap-fills in place; without this a sub-task's XML <item> would be added as a duplicate
// top-level row and orphan that dev-panel data.
for (const arr of [data.tickets, data.completed])
  for (const t of arr || [])
    for (const st of t.subtasks || [])
      if (st && st.key && !byKey.has(st.key)) byKey.set(st.key, { arr: 'subtask', obj: st })

const summary = { parsed: items.length, updated: [], added: [], skipped: [] }

for (const r of items) {
  const mine = isMine(r.assignee, user)
  const hit = byKey.get(r.key)
  if (hit) {
    const changed = new Set()
    applyRecord(hit.obj, r, changed)
    if (changed.size) summary.updated.push(`${r.key} [${hit.arr}] ← ${[...changed].join(', ')}`)
    continue
  }
  if (!mine) { summary.skipped.push(`${r.key} (assignee: ${r.assignee || 'none'} — not you; will surface as a sub-task/related if referenced)`); continue }
  const e = newEntry(r)
  if (r.done) { (data.completed ||= []).push(e); summary.added.push(`${r.key} → completed[]`) }
  else { (data.tickets ||= []).push(e); summary.added.push(`${r.key} → tickets[] (${r.column})`) }
}

// note + persist
data.notes = Array.isArray(data.notes) ? data.notes : []
const stamp = new Date().toISOString().slice(0, 10)
data.notes = data.notes.filter((n) => !/Reconciled from Jira XML/.test(n))
data.notes.push(`Reconciled from Jira XML export (${items.length} ticket${items.length === 1 ? '' : 's'}) on ${stamp}. Branch/PR data untouched (fetched from Bitbucket by the intern).`)

// Safety net: back up the previous data before overwriting (restore with: mv data.json.bak data.json).
if (existsSync(DATA_JSON)) writeFileSync(DATA_JSON + '.bak', readFileSync(DATA_JSON))
if (existsSync(DATA_JS)) writeFileSync(DATA_JS + '.bak', readFileSync(DATA_JS))

const json = JSON.stringify(data, null, 2)
writeFileSync(DATA_JSON, json + '\n')
writeFileSync(DATA_JS, `// AUTO-GENERATED by jira-intern. Do not edit by hand.\nwindow.__JIRA_DATA__ = ${json};\n`)

// report
console.log(`Input: ${INPUT}`)
console.log(`Parsed ${summary.parsed} ticket(s) from the export.\n`)
console.log(`Updated ${summary.updated.length}:`); summary.updated.forEach((s) => console.log('  • ' + s))
console.log(`\nAdded ${summary.added.length}:`); summary.added.forEach((s) => console.log('  • ' + s))
console.log(`\nSkipped (not assigned to you) ${summary.skipped.length}:`); summary.skipped.forEach((s) => console.log('  • ' + s))
if (droppedCount) console.log(`\n⚠️  ${droppedCount} <item>(s) had no recognizable key and were dropped.`)
console.log(`\nWrote data.json + data.js (previous saved to *.bak). Branch/PR fields were left untouched.`)
