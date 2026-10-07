import { completedToTicket, type JiraData, type Ticket } from '../types'
import { isNextSprint, prListOf } from './format'
import { matches, type Term } from './search'

export interface BoardView {
  /** Every active ticket the search matched, wherever it renders. */
  matched: Ticket[]
  /** The kanban columns. With the On Hold section off, held tickets sit in To Do instead. */
  board: Ticket[]
  hold: Ticket[]
  /** To Do tickets whose sprint has not started. */
  nextSprint: Ticket[]
}

export function splitBoard(tickets: Ticket[], terms: Term[], now: number, onHoldSection: boolean): BoardView {
  const view: BoardView = { matched: [], board: [], hold: [], nextSprint: [] }
  for (const t of tickets) {
    if (!matches(t, terms)) continue
    view.matched.push(t)
    if (isNextSprint(t, now)) view.nextSprint.push(t)
    else if (t.column !== 'hold') view.board.push(t)
    else if (onHoldSection) view.hold.push(t)
    else view.board.push({ ...t, column: 'todo' })
  }
  return view
}

/** Ignores next sprint's queue, or finishing a sprint would never earn the empty-board celebration. */
export function hasActiveWork(tickets: Ticket[], now: number, onHoldSection: boolean): boolean {
  return tickets.some((t) => !isNextSprint(t, now) && (t.column !== 'hold' || !onHoldSection))
}

/**
 * Every ticket by key: board tickets, archive rows, and all nested sub-tasks. Standalone rows win
 * over nested copies, because the archive holds a sub-ticket both as its own row and under its master.
 */
export function indexByKey(data: JiraData): Map<string, Ticket> {
  const index = new Map<string, Ticket>()
  const nested: Ticket[] = []
  for (const t of [...data.tickets, ...data.completed.map(completedToTicket)]) {
    if (!index.has(t.key)) index.set(t.key, t)
    if (t.subtasks?.length) nested.push(...t.subtasks)
  }
  const addNested = (list: Ticket[]) => {
    for (const t of list) {
      if (!index.has(t.key)) index.set(t.key, t)
      if (t.subtasks?.length) addNested(t.subtasks)
    }
  }
  addNested(nested)
  return index
}

/** Mirrors pr_report.py's iter_tickets, so the menu's count matches what a bulk run produces. */
export function countTicketsWithPr(data: JiraData): number {
  const keys = new Set<string>()
  for (const t of data.tickets) {
    if (prListOf(t).length > 0) keys.add(t.key)
    for (const s of t.subtasks ?? []) if (s.key && prListOf(s).length > 0) keys.add(s.key)
  }
  for (const c of data.completed) if (prListOf(c).length > 0) keys.add(c.key)
  return keys.size
}

/**
 * The dashboard's own cards with a pull request: open work (On Hold and Next Sprint included) plus
 * the Done column's recently completed tickets. The Completed archive and nested sub-tasks of
 * other people are not on the dashboard, so they are left out.
 */
export function dashboardPrTickets(tickets: Ticket[]): { keys: string[]; open: number; done: number } {
  const keys: string[] = []
  let done = 0
  for (const t of tickets) {
    if (prListOf(t).length === 0 || keys.includes(t.key)) continue
    keys.push(t.key)
    if (t.column === 'done') done++
  }
  return { keys, open: keys.length - done, done }
}

export function countMyCompleted(data: JiraData): number {
  return data.completed.filter((c) => c.mine !== false && !c.parentKey).length
}
