import { describe, expect, it } from 'vitest'
import type { Ticket } from '../types'
import { demoDump } from './index'
import { demoMoveVerdict, evaluateMove, qaIssuesOf } from './gates'

const base: Ticket = { key: 'T-1', title: 'A ticket', status: 'In Progress', column: 'prog' }
const withPr = (merged: boolean): Ticket => ({ ...base, pr: { state: merged ? 'merged' : 'comments', id: 7, merged } })
const qaSub = (status: string): Ticket => ({ key: 'T-1-1', title: 'QA: verify the flow', type: 'QA Task', status, column: 'prog' })

describe('demo move gates', () => {
  it('warns when In Review has no pull request, but allows the move', () => {
    const { blocker, warnings } = evaluateMove('rev', base)
    expect(blocker).toBeNull()
    expect(warnings.join(' ')).toContain('No pull request')
  })

  it('warns when QA has no QA ticket, but allows the move', () => {
    const { blocker, warnings } = evaluateMove('qa', withPr(false))
    expect(blocker).toBeNull()
    expect(warnings.join(' ')).toContain('No QA ticket')
  })

  it('is silent for To Do, Blocked and In Progress', () => {
    for (const to of ['todo', 'blocked', 'prog'] as const) {
      expect(evaluateMove(to, base)).toEqual({ blocker: null, warnings: [] })
    }
  })

  it('blocks Done when the pull request is not merged', () => {
    expect(evaluateMove('done', { ...withPr(false), subtasks: [qaSub('Done')] }).blocker).toContain('#7 not merged yet')
  })

  it('blocks Done when there is no pull request at all', () => {
    expect(evaluateMove('done', { ...base, subtasks: [qaSub('Done')] }).blocker).toContain('no merged pull request')
  })

  it('blocks Done when the QA ticket is still open', () => {
    expect(evaluateMove('done', { ...withPr(true), subtasks: [qaSub('In Progress')] }).blocker).toContain('QA not done')
  })

  it('blocks Done when no QA ticket exists', () => {
    expect(evaluateMove('done', withPr(true)).blocker).toContain('no QA ticket')
  })

  it('allows Done once the PR is merged and QA is done', () => {
    expect(evaluateMove('done', { ...withPr(true), subtasks: [qaSub('Done')] })).toEqual({ blocker: null, warnings: [] })
  })

  it('ignores a declined PR when judging Done', () => {
    const t: Ticket = { ...base, prs: [{ state: 'declined', id: 4 }, { state: 'merged', id: 9, merged: true }], subtasks: [qaSub('Done')] }
    expect(evaluateMove('done', t).blocker).toBeNull()
  })

  it('finds QA tickets among sub-tasks and linked issues', () => {
    const t: Ticket = { ...base, subtasks: [qaSub('Done')], related: [{ key: 'T-9', title: 'Test the importer', status: 'Open' }, { key: 'T-8', title: 'Refactor the writer', status: 'Open' }] }
    expect(qaIssuesOf(t).map((q) => q.key)).toEqual(['T-1-1', 'T-9'])
  })
})

describe('demo dump', () => {
  const d = demoDump()
  const byKey = (k: string) => d.tickets.find((t) => t.key === k)!
  const prStates = new Set(d.tickets.flatMap((t) => (t.prs ?? (t.pr ? [t.pr] : [])).map((p) => p.state)))

  it('fills every board column, both QA shelves and the side sections', () => {
    const cols = new Set(d.tickets.map((t) => t.column))
    for (const c of ['todo', 'blocked', 'prog', 'rev', 'qa', 'done', 'hold']) expect(cols).toContain(c)
    expect(d.tickets.some((t) => t.column === 'qa' && /^(QA|Ready for QA)$/.test(t.status))).toBe(true)
    expect(d.tickets.some((t) => t.column === 'qa' && /^(In QA|In Testing|Under QA)$/.test(t.status))).toBe(true)
    expect(d.tickets.some((t) => t.sprint?.includes('future'))).toBe(true)
  })

  it('covers every pull-request state', () => {
    for (const s of ['merged', 'approved', 'comments', 'changes', 'declined']) expect(prStates).toContain(s)
    expect(d.tickets.some((t) => !t.pr && !t.prs?.length)).toBe(true) // and tickets with none
  })

  it('covers the review edge cases', () => {
    expect(byKey('DEMO-233').pr).toMatchObject({ approvals: 1, openComments: 0 }) // one approval short
    expect(byKey('DEMO-234').pr).toMatchObject({ approvals: 2 }) // approved, comments still open
    expect(byKey('DEMO-234').pr!.openComments).toBeGreaterThan(0)
    expect(byKey('DEMO-232').pr).toMatchObject({ approvals: 0, openComments: 0 }) // nobody looked yet
    expect(byKey('DEMO-235').prs!.every((p) => p.state === 'declined')).toBe(true) // every attempt rejected
    expect(byKey('DEMO-253').pr!.merged).toBeFalsy() // closed in Jira, code never merged
    expect(byKey('DEMO-212').pr!.merged).toBe(true) // merged, yet still blocked
  })

  it('gives one ticket that passes the Done gate, and one for each refusal', () => {
    expect(evaluateMove('done', byKey('DEMO-242')).blocker).toBeNull() // merged + QA done
    expect(evaluateMove('done', byKey('DEMO-240')).blocker).toContain('QA not done') // QA not started
    expect(evaluateMove('done', byKey('DEMO-241')).blocker).toContain('no QA ticket')
    expect(evaluateMove('done', byKey('DEMO-244')).blocker).toContain('not merged yet') // QA failed, fix open
    expect(evaluateMove('done', byKey('DEMO-201')).blocker).toContain('no merged pull request')
  })

  it('mixes ownership and nests sub-tasks', () => {
    expect(d.tickets.some((t) => t.mine === false)).toBe(true) // someone else's ticket
    expect(d.tickets.some((t) => t.assignee == null)).toBe(true) // unassigned
    expect(byKey('DEMO-220').subtasks!.some((s) => s.mine === false)).toBe(true) // sub-task owned by QA
    expect(byKey('DEMO-220').subtasks!.some((s) => (s.subtasks ?? []).length > 0)).toBe(true) // nested child
    expect(byKey('DEMO-223').mine).toBe(false) // their parent…
    expect(byKey('DEMO-223').subtasks![0].mine).not.toBe(false) // …carrying my sub-task
  })

  it('covers the card edges', () => {
    expect(d.tickets.some((t) => t.storyPoints == null)).toBe(true)
    expect(d.tickets.some((t) => (t.storyPoints ?? 0) >= 21)).toBe(true)
    expect(d.tickets.some((t) => !t.description)).toBe(true)
    expect(d.tickets.some((t) => t.title.length > 90)).toBe(true)
    expect(d.tickets.some((t) => t.sprintOverflow)).toBe(true)
    expect(d.tickets.some((t) => (t.branches ?? []).length > 1)).toBe(true)
  })

  it('has history and raised rows worth browsing', () => {
    expect(d.completed.length).toBeGreaterThan(10)
    expect(d.completed.some((c) => c.mine === false)).toBe(true)
    expect((d.raised ?? []).some((r) => (r.assigneeLog ?? []).length >= 4)).toBe(true)
    expect((d.raised ?? []).some((r) => r.assignee == null)).toBe(true)
  })

  it('never points at a real host', () => {
    const json = JSON.stringify(d)
    for (const url of json.match(/https?:\/\/[^"\\\s]+/g) ?? []) expect(url).toMatch(/\/\/[a-z.]*example\.com(\/|$)/)
  })
})

describe('demo move gates — sub-tickets', () => {
  const sub: Ticket = { ...base, key: 'T-1-2', parentKey: 'T-1' }

  it('lets a sub-ticket reach Done with no PR and no QA ticket of its own', () => {
    expect(evaluateMove('done', sub)).toEqual({ blocker: null, warnings: [] })
  })

  it('still blocks a sub-ticket whose own PR is not merged', () => {
    const t: Ticket = { ...sub, pr: { state: 'comments', id: 9, merged: false } }
    expect(evaluateMove('done', t).blocker).toContain('#9 not merged yet')
  })

  it('allows it once that PR is merged', () => {
    const t: Ticket = { ...sub, pr: { state: 'merged', id: 9, merged: true } }
    expect(evaluateMove('done', t).blocker).toBeNull()
  })

  it('still blocks a sub-ticket with an open QA ticket', () => {
    expect(evaluateMove('done', { ...sub, subtasks: [qaSub('In Progress')] }).blocker).toContain('QA not done')
  })

  it('does not warn a sub-ticket about a missing PR when it moves to review', () => {
    expect(evaluateMove('rev', sub).warnings).toEqual([])
  })
})

describe('demo move gates — On Hold', () => {
  it('parks any card, warning when its pull request is still open', () => {
    const { blocker, warnings } = evaluateMove('hold', withPr(false))
    expect(blocker).toBeNull()
    expect(warnings.join(' ')).toContain('#7 is still open')
  })
  it('says nothing when the PR is merged, declined, or there is none', () => {
    expect(evaluateMove('hold', withPr(true))).toEqual({ blocker: null, warnings: [] })
    expect(evaluateMove('hold', { ...base, prs: [{ state: 'declined', id: 4 }] })).toEqual({ blocker: null, warnings: [] })
    expect(evaluateMove('hold', base)).toEqual({ blocker: null, warnings: [] })
  })
  it('moves the card on the demo board', () => {
    const v = demoMoveVerdict(withPr(false), 'hold')
    expect(v.ok).toBe(true)
    expect(v.status).toBe('On Hold')
  })
})
