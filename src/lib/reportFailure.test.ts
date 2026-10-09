import { describe, expect, it } from 'vitest'
import { REPORT_EXIT_NOT_IN_DATA, REPORT_EXIT_NO_PR, reportFailureReason, reportFailureSummary } from './reportFailure'

describe('why a report was not generated', () => {
  it('says there is no pull request, and what to do about it', () => {
    const msg = reportFailureReason('ABC-123', REPORT_EXIT_NO_PR)
    expect(msg).toContain('ABC-123')
    expect(msg).toMatch(/no pull request/i)
    expect(msg).toMatch(/link a PR/i)
  })

  it('distinguishes a ticket the board has not fetched', () => {
    expect(reportFailureReason('A-1', REPORT_EXIT_NOT_IN_DATA)).toMatch(/not in the board's data/)
  })

  it('names a stopped run, an internal error and an unknown exit', () => {
    expect(reportFailureReason('A-1', 143)).toMatch(/stopped/)
    expect(reportFailureReason('A-1', 1)).toMatch(/consistency check/)
    expect(reportFailureReason('A-1', 9)).toContain('(exit 9)')
    expect(reportFailureReason('A-1', undefined)).not.toContain('exit')
  })

  it('gives a single ticket its own reason and groups a batch', () => {
    expect(reportFailureSummary(['A-1'], { 'A-1': REPORT_EXIT_NO_PR })).toBe(reportFailureReason('A-1', REPORT_EXIT_NO_PR))
    const many = reportFailureSummary(['A-1', 'A-2', 'A-3', 'A-4', 'B-1'], { 'A-1': 4, 'A-2': 4, 'A-3': 4, 'A-4': 4, 'B-1': 1 })
    expect(many).toMatch(/^5 reports were not generated/)
    expect(many).toContain('4 have no pull request in Jira (A-1, A-2, A-3…)')
    expect(many).toContain('1 failed for another reason')
  })
})
