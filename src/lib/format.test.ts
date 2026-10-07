import { describe, expect, it } from 'vitest'
import { dtf, isAssignedToMe, releaseEnvOf } from './format'

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
