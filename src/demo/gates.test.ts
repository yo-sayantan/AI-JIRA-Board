import { describe, expect, it } from 'vitest'
import type { Ticket } from '../types'
import { demoDump } from './index'
import { evaluateMove, qaIssuesOf } from './gates'

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
    const t = { ...withPr(false), subtasks: [qaSub('Done')] }
    expect(evaluateMove('done', t).blocker).toContain('#7 not merged yet')
  })

  it('blocks Done when there is no pull request at all', () => {
    expect(evaluateMove('done', { ...base, subtasks: [qaSub('Done')] }).blocker).toContain('no merged pull request')
  })

  it('blocks Done when the QA ticket is still open', () => {
    const t = { ...withPr(true), subtasks: [qaSub('In Progress')] }
    expect(evaluateMove('done', t).blocker).toContain('QA not done')
  })

  it('blocks Done when no QA ticket exists', () => {
    expect(evaluateMove('done', withPr(true)).blocker).toContain('no QA ticket')
  })

  it('allows Done once the PR is merged and QA is done', () => {
    const t = { ...withPr(true), subtasks: [qaSub('Done')] }
    expect(evaluateMove('done', t)).toEqual({ blocker: null, warnings: [] })
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
  it('fills every board column, both QA shelves and the side sections', () => {
    const d = demoDump()
    const cols = new Set(d.tickets.map((t) => t.column))
    for (const c of ['todo', 'blocked', 'prog', 'rev', 'qa', 'done', 'hold']) expect(cols).toContain(c)
    expect(d.tickets.some((t) => t.column === 'qa' && /^(QA|Ready for QA)$/.test(t.status))).toBe(true)
    expect(d.tickets.some((t) => t.column === 'qa' && /^(In QA|In Testing)$/.test(t.status))).toBe(true)
    expect(d.completed.length).toBeGreaterThan(5)
    expect((d.raised ?? []).length).toBeGreaterThan(3)
  })

  it('never points at a real host', () => {
    const json = JSON.stringify(demoDump())
    for (const url of json.match(/https?:\/\/[^"\\\s]+/g) ?? []) expect(url).toMatch(/\/\/[a-z.]*example\.com(\/|$)/)
  })

  it('has a Done ticket that is still inside the board window, and one that can be dropped on Done', () => {
    const d = demoDump()
    expect(d.tickets.some((t) => t.column === 'done')).toBe(true)
    // DEMO-230 is merged with a QA sub-task that is NOT done — the Done gate must refuse it.
    const qaTicket = d.tickets.find((t) => t.key === 'DEMO-230')!
    expect(evaluateMove('done', qaTicket).blocker).toContain('QA not done')
  })
})
