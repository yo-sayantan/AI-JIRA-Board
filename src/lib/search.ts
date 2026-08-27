import type { CompletedTicket, PullRequest, Ticket } from '../types'

/**
 * Ticket search shared by the board and the Completed archive.
 *
 * The rule that matters: a bare number is an IDENTIFIER, not free text. Typing `6115`
 * means "ticket 6115", so it is matched only against ticket numbers (the row's own, its
 * parent's, its sub-tickets') and pull-request numbers — never against titles, branch
 * names or descriptions that merely happen to contain those digits.
 *
 * Everything else is ordinary token-AND substring matching, and `FIDM-6115` / `fidm6115`
 * additionally count as an exact key match so the ticket you named ranks first.
 */

type Row = Ticket | CompletedTicket

/**
 * Two or more leading letters then digits: FIDM-6115, fidm6115, ACKYARISK-190.
 * The project group is LAZY on purpose. Project keys may contain digits, so `fidm6115`
 * is ambiguous; greedy matching would read it as project `fidm611` + ticket `5`. Taking
 * the shortest project leaves the longest number, which is the reading people mean.
 */
const KEYISH = /^([a-z][a-z0-9]{1,14}?)[-_]?(\d{1,7})$/i
const DIGITS = /^\d{1,7}$/

export interface Term {
  raw: string
  /** Set when the token is a ticket number (bare or as part of a key). */
  num?: string
  /** Set when the token also named a project, e.g. the `fidm` of `fidm-6115`. */
  project?: string
}

export function parseQuery(q: string): Term[] {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      if (DIGITS.test(raw)) return { raw, num: raw }
      const m = KEYISH.exec(raw)
      return m ? { raw, project: m[1], num: m[2] } : { raw }
    })
}

/** Numeric part of an issue key: FIDM-6115 → "6115". */
export function keyNum(key?: string | null): string {
  if (!key) return ''
  const i = key.lastIndexOf('-')
  return i === -1 ? '' : key.slice(i + 1)
}

function keyProject(key?: string | null): string {
  if (!key) return ''
  const i = key.lastIndexOf('-')
  return (i === -1 ? key : key.slice(0, i)).toLowerCase()
}

/**
 * Exact, or a prefix so results narrow as you keep typing (`611` still finds `6115`).
 * A single digit only ever matches exactly — `6` should not light up every ticket in the 6000s.
 */
function numHit(candidate: string, term: string): 'exact' | 'prefix' | null {
  if (!candidate) return null
  if (candidate === term) return 'exact'
  return term.length >= 2 && candidate.startsWith(term) ? 'prefix' : null
}

function prsOf(t: Row): PullRequest[] {
  const list = t.prs?.length ? t.prs : t.pr ? [t.pr] : []
  return list.filter(Boolean)
}

/** Every identifier the row can legitimately answer to, and where each came from. */
function identifiers(t: Row) {
  const subs = t.subtasks ?? []
  return {
    self: t.key,
    parent: t.parentKey ?? null,
    subKeys: subs.map((s) => s.key),
    prIds: [...prsOf(t), ...subs.flatMap(prsOf)].map((p) => String(p.id ?? '')).filter(Boolean),
  }
}

function haystack(t: Row): string {
  const subs = t.subtasks ?? []
  return [
    t.key,
    t.title,
    t.type,
    t.status,
    t.priority,
    t.assignee,
    t.reporter,
    t.sprint,
    t.branch,
    t.epic?.key,
    t.parentKey,
    (t as CompletedTicket).parentTitle,
    (t as CompletedTicket).project,
    ...(t.branches ?? []),
    ...(t.labels ?? []),
    ...(t.components ?? []),
    ...(t.fixVersions ?? []),
    ...prsOf(t).flatMap((p) => [p.title, p.repo, p.sourceBranch, ...(p.reviewers ?? [])]),
    ...subs.flatMap((s) => [s.key, s.title, s.assignee, s.status, s.branch, ...(s.branches ?? [])]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** Lower is better. Exact hit on the row itself beats a hit on one of its sub-tickets. */
const SCORE = { selfExact: 0, subExact: 1, selfPrefix: 2, subPrefix: 3, pr: 4, text: 5 } as const

export interface Hit {
  score: number
  /** Sub-ticket keys that made this row match, so the UI can explain the result. */
  viaSubtasks: string[]
}

/** null when the row does not match. Every term must match (AND), as before. */
export function matchRow(t: Row, terms: Term[]): Hit | null {
  if (!terms.length) return { score: SCORE.text, viaSubtasks: [] }

  const ids = identifiers(t)
  const hay = haystack(t)
  let best: number = SCORE.text
  const via = new Set<string>()

  for (const term of terms) {
    let score: number | null = null

    if (term.num) {
      const projectOk = !term.project || keyProject(ids.self) === term.project
      const self = projectOk ? numHit(keyNum(ids.self), term.num) : null
      if (self) score = self === 'exact' ? SCORE.selfExact : SCORE.selfPrefix

      // Naming a master ticket also pulls up the sub-tickets hanging off it. Exact only —
      // prefix-matching a parent number would drag in whole unrelated families.
      const parentOk = ids.parent && (!term.project || keyProject(ids.parent) === term.project)
      if (score === null && parentOk && keyNum(ids.parent) === term.num) {
        score = SCORE.subPrefix
      }
      if (score === null) {
        for (const sk of ids.subKeys) {
          if (term.project && keyProject(sk) !== term.project) continue
          const hit = numHit(keyNum(sk), term.num)
          if (hit) {
            via.add(sk)
            score = Math.min(score ?? Infinity, hit === 'exact' ? SCORE.subExact : SCORE.subPrefix)
          }
        }
      }
      // PR numbers answer only to a bare number, and only exactly: `ACKYARISK-190` must not
      // match a ticket whose PR happens to be #1903.
      if (score === null && !term.project && ids.prIds.includes(term.num)) score = SCORE.pr
    }

    // A bare number is only ever an identifier. A qualified key (`fidm-6115`) may also
    // appear verbatim in text — a branch name or a PR title — so it keeps the text path.
    if (score === null && (term.project || !term.num) && hay.includes(term.raw)) {
      score = SCORE.text
    }
    // `fidm-6115` typed as `fidm6115` still has to find the hyphenated form in text.
    if (score === null && term.project && term.num && hay.includes(`${term.project}-${term.num}`)) {
      score = SCORE.text
    }

    if (score === null) return null
    best = Math.min(best, score)
  }

  return { score: best, viaSubtasks: [...via] }
}

export function matches(t: Row, terms: Term[]): boolean {
  return matchRow(t, terms) !== null
}
