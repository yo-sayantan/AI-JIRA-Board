import { describe, expect, it } from 'vitest'
import type { Ticket } from '../types'
import { checkMove, isQaTicket, laneBlocker, looksLikeQa, qaIssuesOf, readinessOf } from './moveRules'

const dev: Ticket = { key: 'T-1', title: 'Build the export', type: 'Story', status: 'In Progress', column: 'prog' }
const qaReady: Ticket = { key: 'Q-1', title: 'QA: verify the export', type: 'QA Task', status: 'Ready for QA', column: 'qa' }
const qaTodo: Ticket = { key: 'Q-2', title: 'Smoke test the nightly job', type: 'Task', labels: ['qa'], status: 'To Do', column: 'todo' }
const qaSub = (status: string): Ticket => ({ key: 'T-1-1', title: 'QA: verify the flow', type: 'QA Task', status, column: 'prog' })
const pr = (state: 'comments' | 'approved' | 'merged' | 'declined', id = 7) => ({ state, id, merged: state === 'merged' })

describe('isQaTicket', () => {
  it('a QA/Test type, a QA label or a QA-led title marks a QA ticket', () => {
    expect(isQaTicket({ type: 'QA Task' })).toBe(true)
    expect(isQaTicket({ type: 'Test' })).toBe(true)
    expect(isQaTicket({ type: 'Task', labels: ['QA'] })).toBe(true)
    expect(isQaTicket({ type: 'Task', labels: ['qa-ticket'] })).toBe(true)
    expect(isQaTicket({ type: 'Task', title: 'QA: smoke test' })).toBe(true)
    expect(isQaTicket({ type: 'Task', title: '[QA] export' })).toBe(true)
  })
  it('never just a word like "verify", "tests" or a label that merely contains the letters', () => {
    expect(isQaTicket({ type: 'Story', title: 'Verify the fix' })).toBe(false)
    expect(isQaTicket({ type: 'Story', title: 'Add unit tests for export' })).toBe(false)
    expect(isQaTicket({ type: 'Story', labels: ['aqua', 'backend'] })).toBe(false)
    // Labels ABOUT a dev ticket's QA are its state, not what it is.
    expect(isQaTicket({ type: 'Bug', labels: ['qa-failed', 'needs-qa', 'qa-passed'] })).toBe(false)
  })
  it('looksLikeQa stays loose for linked issues', () => {
    expect(looksLikeQa('Story', 'Verify the fix')).toBe(true)
    expect(looksLikeQa('Story', 'Build the export')).toBe(false)
  })
})

describe('the QA lane', () => {
  it('only a QA ticket may enter QA or QA In Progress — from To Do or anywhere', () => {
    for (const to of ['qa', 'qaip'] as const) {
      expect(laneBlocker(dev, to)).toMatch(/Only QA tickets/)
      expect(laneBlocker(qaTodo, to)).toBeNull()
    }
  })
  it('a QA ticket moves only to QA, QA In Progress, Blocked, On Hold or Done', () => {
    for (const t of [qaReady, qaTodo]) {
      for (const to of ['qa', 'qaip', 'blocked', 'hold', 'done'] as const) expect(laneBlocker(t, to), `${t.key}→${to}`).toBeNull()
      for (const to of ['todo', 'prog', 'rev'] as const) expect(laneBlocker(t, to), `${t.key}→${to}`).toMatch(/can only be moved to/)
    }
  })
  it('sitting in QA is enough to be the lane’s, whatever the title', () => {
    expect(laneBlocker({ ...dev, column: 'qa' }, 'prog')).toMatch(/can only be moved to/)
  })
  it('every other ticket moves freely outside the lane', () => {
    for (const to of ['todo', 'blocked', 'hold', 'prog'] as const) expect(checkMove(dev, to).kind).toBeNull()
  })
  it('a lane refusal is a lane refusal, never a forcible gate', () => {
    expect(checkMove(dev, 'qa').kind).toBe('lane')
    expect(checkMove(qaReady, 'prog').kind).toBe('lane')
  })
  it('QA tickets close freely — no PR or QA ticket of their own to wait for', () => {
    expect(checkMove(qaReady, 'done').kind).toBeNull()
  })
})

describe('In Review gate', () => {
  it('needs a PR — open or merged; declined does not count', () => {
    expect(checkMove(dev, 'rev')).toMatchObject({ kind: 'gate', reason: expect.stringContaining('no pull request') })
    expect(checkMove({ ...dev, pr: pr('comments') }, 'rev').kind).toBeNull()
    expect(checkMove({ ...dev, pr: pr('merged') }, 'rev').kind).toBeNull()
    expect(checkMove({ ...dev, prs: [pr('declined')] }, 'rev').kind).toBe('gate')
  })
  it('a sub-ticket may ride on an OPEN PR of its parent', () => {
    const sub: Ticket = { ...dev, key: 'T-2', parentKey: 'P-1' }
    const parentOpen = new Map([['P-1', { ...dev, key: 'P-1', pr: pr('approved') } as Ticket]])
    const parentMerged = new Map([['P-1', { ...dev, key: 'P-1', pr: pr('merged') } as Ticket]])
    expect(checkMove(sub, 'rev', parentOpen).kind).toBeNull()
    expect(checkMove(sub, 'rev', parentMerged)).toMatchObject({ kind: 'gate', reason: expect.stringContaining('P-1 has no open one') })
  })
  it('an unknown parent is left to the server, which reads it live', () => {
    expect(checkMove({ ...dev, parentKey: 'P-9' }, 'rev', new Map()).kind).toBeNull()
  })
})

describe('Done gate', () => {
  const qaLinked = { subtasks: [qaSub('To Do')] }
  it('needs every PR merged or declined', () => {
    expect(checkMove({ ...dev, ...qaLinked, pr: pr('approved') }, 'done').reason).toContain('#7 still open')
    expect(checkMove({ ...dev, ...qaLinked, pr: pr('merged') }, 'done').kind).toBeNull()
    expect(checkMove({ ...dev, ...qaLinked, prs: [pr('declined', 4)] }, 'done').kind).toBeNull()
  })
  it('needs a PR at all', () => {
    expect(checkMove({ ...dev, ...qaLinked }, 'done').reason).toContain('no pull request raised')
  })
  it('needs a QA ticket RAISED — not finished', () => {
    expect(checkMove({ ...dev, pr: pr('merged') }, 'done').reason).toContain('no QA ticket raised')
    expect(checkMove({ ...dev, pr: pr('merged'), ...qaLinked }, 'done').kind).toBeNull()
  })
  it('a sub-ticket may close with no PR of its own; its parent’s QA ticket counts', () => {
    const sub: Ticket = { ...dev, key: 'T-2', parentKey: 'P-1' }
    const withQa = new Map([['P-1', { ...dev, key: 'P-1', ...qaLinked } as Ticket]])
    const noQa = new Map([['P-1', { ...dev, key: 'P-1' } as Ticket]])
    expect(checkMove(sub, 'done', withQa).kind).toBeNull()
    expect(checkMove(sub, 'done', noQa).reason).toContain('no QA ticket raised (on it or its parent)')
    expect(checkMove({ ...sub, pr: pr('comments') }, 'done', withQa).reason).toContain('#7 still open')
  })
  it('warns (only) when a ticket with an open PR goes on hold', () => {
    const c = checkMove({ ...dev, pr: pr('comments') }, 'hold')
    expect(c.kind).toBeNull()
    expect(c.warnings.join(' ')).toContain('#7 is still open')
  })
})

describe('qaIssuesOf / readinessOf', () => {
  it('finds QA tickets among sub-tasks and linked issues, never the parent or epic link', () => {
    const t: Ticket = {
      ...dev,
      subtasks: [qaSub('Done')],
      related: [
        { key: 'T-9', title: 'Test the importer', status: 'Open' },
        { key: 'T-8', title: 'Refactor the writer', status: 'Open' },
        { key: 'E-1', title: 'Testing epic', relation: 'epic' },
      ],
    }
    expect(qaIssuesOf(t).map((q) => q.key)).toEqual(['T-1-1', 'T-9'])
  })
  it('readiness covers In Review only before review, and nothing for To Do, Done or QA tickets', () => {
    expect(readinessOf(dev)?.rev?.kind).toBe('gate')
    expect(readinessOf({ ...dev, column: 'todo' })).toBeNull()
    expect(readinessOf({ ...dev, column: 'rev' })?.rev).toBeNull()
    expect(readinessOf({ ...dev, column: 'done' })).toBeNull()
    expect(readinessOf(qaReady)).toBeNull()
  })
})
