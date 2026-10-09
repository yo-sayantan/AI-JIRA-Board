import { describe, expect, it } from 'vitest'
import type { Ticket } from '../types'
import { ALL_SECTIONS, hasActiveWork, inHiddenSection, splitBoard } from './boardView'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const held: Ticket = { key: 'H-1', title: 'Parked', status: 'On Hold', column: 'hold' }
const blocked: Ticket = { key: 'B-1', title: 'Stuck', status: 'Blocked', column: 'blocked' }
const prog: Ticket = { key: 'P-1', title: 'Busy', status: 'In Progress', column: 'prog' }
const qaWaiting: Ticket = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' }
const qaTesting: Ticket = { key: 'Q-2', title: 'Testing', status: 'QA In Progress', column: 'qa' }
const all = [held, blocked, prog, qaWaiting, qaTesting]
const keys = (ts: Ticket[]) => ts.map((t) => t.key)

describe('board sections (Settings → Board sections)', () => {
  it('with everything on, each ticket goes where it lives', () => {
    const v = splitBoard(all, [], NOW, ALL_SECTIONS)
    expect(keys(v.hold)).toEqual(['H-1'])
    expect(keys(v.board)).toEqual(['B-1', 'P-1', 'Q-1', 'Q-2'])
  })

  it('Blocked off: Blocked tickets are not on the board and not counted', () => {
    const v = splitBoard(all, [], NOW, { ...ALL_SECTIONS, blocked: false })
    expect(keys(v.board)).not.toContain('B-1')
    expect(keys(v.matched)).not.toContain('B-1')
    expect(keys(v.hold)).toEqual(['H-1']) // On Hold is its own switch
  })

  it('On Hold off: held tickets are hidden — they no longer fold into To Do', () => {
    const v = splitBoard(all, [], NOW, { ...ALL_SECTIONS, onHold: false })
    expect(v.hold).toEqual([])
    expect(keys(v.board)).not.toContain('H-1')
    expect(v.board.every((t) => t.column !== 'todo')).toBe(true)
  })

  it('QA In Progress off hides only the tickets QA picked up; QA still lists what is waiting', () => {
    const v = splitBoard(all, [], NOW, { ...ALL_SECTIONS, qaInProgress: false })
    expect(keys(v.board)).toContain('Q-1')
    expect(keys(v.board)).not.toContain('Q-2')
  })

  it('a hidden ticket is never a search match', () => {
    const v = splitBoard(all, [], NOW, { ...ALL_SECTIONS, blocked: false })
    expect(inHiddenSection(blocked, { ...ALL_SECTIONS, blocked: false })).toBe(true)
    expect(inHiddenSection(prog, { blocked: false, onHold: false, qaInProgress: false })).toBe(false)
    expect(v.matched).toHaveLength(4)
  })

  it('switching sections off never makes the board look finished', () => {
    // Hidden work is still work: the empty-board celebration must not fire over it.
    expect(hasActiveWork([blocked], NOW)).toBe(true)
    expect(hasActiveWork([held], NOW)).toBe(true)
    expect(hasActiveWork([], NOW)).toBe(false)
  })
})
