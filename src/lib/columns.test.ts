import { describe, expect, it } from 'vitest'
import { mapStatusToColumn } from './columns'

describe('mapStatusToColumn', () => {
  it('maps closed-without-work statuses to done', () => {
    expect(mapStatusToColumn("won't fix")).toBe('done')
    expect(mapStatusToColumn('Cancelled')).toBe('done')
    expect(mapStatusToColumn('Rejected')).toBe('done')
  })
  it('prefers QA over "in progress" for "QA In Progress"', () => {
    expect(mapStatusToColumn('QA In Progress')).toBe('qa')
  })
  it('maps Ready4Review to review', () => {
    expect(mapStatusToColumn('Ready4Review')).toBe('rev')
  })
  it('falls back to todo for unknown or empty statuses', () => {
    expect(mapStatusToColumn('Something Odd')).toBe('todo')
    expect(mapStatusToColumn(null)).toBe('todo')
  })
})
