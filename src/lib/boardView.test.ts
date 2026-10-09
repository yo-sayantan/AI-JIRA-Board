import { describe, expect, it } from 'vitest'
import type { Ticket } from '../types'
import { hasActiveWork, splitBoard } from './boardView'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const held: Ticket = { key: 'H-1', title: 'Parked', status: 'On Hold', column: 'hold' }
const prog: Ticket = { key: 'P-1', title: 'Busy', status: 'In Progress', column: 'prog' }

describe('board view', () => {
  it('puts held tickets in the On Hold space when it is on', () => {
    const v = splitBoard([held, prog], [], NOW, true)
    expect(v.hold.map((t) => t.key)).toEqual(['H-1'])
    expect(v.board.map((t) => t.key)).toEqual(['P-1'])
  })
  it('puts held tickets back in To Do when On Hold is off', () => {
    const v = splitBoard([held], [], NOW, false)
    expect(v.hold).toEqual([])
    expect(v.board.map((t) => [t.key, t.column])).toEqual([['H-1', 'todo']])
  })
  it('a board holding only parked work is not an empty board', () => {
    // On Hold lives on the board now; counting it out would show the empty-board celebration
    // and hide the held tickets with it.
    expect(hasActiveWork([held], NOW)).toBe(true)
    expect(hasActiveWork([], NOW)).toBe(false)
  })
})
