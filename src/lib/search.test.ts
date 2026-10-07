import { describe, expect, it } from 'vitest'
import { matchRow, matches, parseQuery } from './search'
import type { Ticket } from '../types'

const row = { key: 'PROJ-12', title: 'Fix (regression) in [auth] module', column: 'todo' } as unknown as Ticket

describe('search', () => {
  it('treats regex metacharacters literally and never throws', () => {
    expect(() => parseQuery('(regression)')).not.toThrow()
    expect(matches(row, parseQuery('(regression)'))).toBe(true)
    expect(matches(row, parseQuery('[auth]'))).toBe(true)
    expect(matches(row, parseQuery('[nothing]'))).toBe(false)
    expect(() => matchRow(row, parseQuery('a+*?^$.|\\'))).not.toThrow()
  })
  it('matches everything for an empty query', () => {
    expect(parseQuery('   ')).toEqual([])
    expect(matchRow(row, parseQuery(''))).not.toBeNull()
  })
  it('matches its own key', () => {
    expect(matches(row, parseQuery('PROJ-12'))).toBe(true)
    expect(matches(row, parseQuery('12'))).toBe(true)
  })
})
