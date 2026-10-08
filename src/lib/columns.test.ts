import { describe, expect, it } from 'vitest'
import { BOARD_COLUMNS, PIPELINE_COLUMNS, isQaInProgress, mapStatusToColumn, qaStage } from './columns'

describe('board columns', () => {
  it('runs To Do · Blocked · In Progress · In Review · QA · Done', () => {
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual(['todo', 'blocked', 'prog', 'rev', 'qa', 'done'])
  })
  it('keeps Blocked out of the lifecycle pipeline', () => {
    expect(PIPELINE_COLUMNS.map((c) => c.key)).toEqual(['todo', 'prog', 'rev', 'qa', 'done'])
  })
})

describe('mapStatusToColumn', () => {
  it('files Blocked and Impeded in the Blocked column, not On Hold', () => {
    expect(mapStatusToColumn('Blocked')).toBe('blocked')
    expect(mapStatusToColumn('Impeded')).toBe('blocked')
    expect(mapStatusToColumn('Blocked by vendor')).toBe('blocked')
  })
  it('still parks paused work on hold', () => {
    expect(mapStatusToColumn('On Hold')).toBe('hold')
    expect(mapStatusToColumn('Waiting')).toBe('hold')
  })
  it('does not mistake Awaiting Deployment for waiting', () => {
    expect(mapStatusToColumn('Awaiting Deployment')).not.toBe('hold')
  })
})

describe('QA shelves', () => {
  it('ready-for-QA statuses sit on the top shelf', () => {
    for (const s of ['QA', 'Ready for QA', 'Ready4QA', 'Awaiting QA', 'Ready for Testing']) expect(isQaInProgress(s)).toBe(false)
  })
  it('statuses the QA team sets sit on QA In Progress', () => {
    for (const s of ['In QA', 'Under QA', 'QA In Progress', 'In Testing', 'Testing', 'Verification']) expect(isQaInProgress(s)).toBe(true)
  })
  it('qaStage is null outside the QA column', () => {
    expect(qaStage({ column: 'prog', status: 'In Testing' })).toBeNull()
    expect(qaStage({ column: 'qa', status: 'In Testing' })).toBe('inprogress')
    expect(qaStage({ column: 'qa', status: 'QA' })).toBe('ready')
  })
})
