import { describe, expect, it } from 'vitest'
import { dtf, isAssignedToMe, primaryPrOf, releaseEnvOf } from './format'

describe('dtf', () => {
  it('does not throw for an invalid zone and still formats', () => {
    expect(() => dtf('en-US', { year: 'numeric' }, 'Not/AZone')).not.toThrow()
    expect(dtf('en-US', { year: 'numeric' }, 'Not/AZone').format(new Date(2026, 0, 15))).toBe('2026')
  })
})

describe('isAssignedToMe', () => {
  it('requires an exact match, not a substring', () => {
    expect(isAssignedToMe('sayan', { name: 'sayantan' })).toBe(false)
    expect(isAssignedToMe('Sayantan', { name: 'sayantan' })).toBe(true)
    expect(isAssignedToMe('a@b.c', { email: 'a@b.c' })).toBe(true)
    expect(isAssignedToMe('', { name: 'x' })).toBe(false)
  })
})

describe('releaseEnvOf', () => {
  it('does not read SG as Stage', () => {
    expect(releaseEnvOf({ title: 'Deploy to SG' })).toBeNull()
  })
  it('recognises staging and prod', () => {
    expect(releaseEnvOf({ title: 'Deploy to staging' })?.label).toBe('Stage')
    expect(releaseEnvOf({ title: 'Release to production' })?.label).toBe('Prod')
  })
})

describe('primaryPrOf', () => {
  const pr61 = { state: 'approved' as const, id: 61, sourceBranch: 'feature/PROJ-1' }
  const pr62 = { state: 'comments' as const, id: 62, sourceBranch: 'feature/PROJ-1_next' }

  it('returns the pipeline-chosen primary PR, not just the first listed one', () => {
    expect(primaryPrOf({ pr: pr62, prs: [pr61, pr62] })).toBe(pr62)
  })

  it('is null when the primary branch has no PR of its own, even if another branch has one', () => {
    expect(primaryPrOf({ pr: { state: 'none' }, prs: [pr61] })).toBeNull()
  })

  it('falls back to the first listed PR for dumps without a primary pr', () => {
    expect(primaryPrOf({ prs: [pr61, pr62] })).toBe(pr61)
    expect(primaryPrOf({ pr: null, prs: [pr62] })).toBe(pr62)
  })

  it('is null for a ticket with nothing', () => {
    expect(primaryPrOf({})).toBeNull()
    expect(primaryPrOf({ pr: { state: 'none' }, prs: [] })).toBeNull()
  })

  it('treats a linked PR whose state is "none" but has an id as a PR', () => {
    expect(primaryPrOf({ pr: { state: 'none', id: 5 } })?.id).toBe(5)
  })
})
