// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_COLUMNS, COLUMN_META } from '../../lib/columns'
import { Column } from './Column'
import { DRAG_MIME } from './TicketCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

function render(props: Partial<Parameters<typeof Column>[0]> & { meta: (typeof BOARD_COLUMNS)[number] }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Column, { tickets: [], now: Date.now(), onOpen: () => {}, ...props })))
  return host.querySelector('section')!
}

/** jsdom has no DragEvent; a plain event carrying a dataTransfer (and a pointer y) is what React reads. */
function drop(el: Element, key = 'ABC-1', clientY?: number) {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { types: [DRAG_MIME], getData: () => key, dropEffect: '' } })
  if (clientY !== undefined) Object.defineProperty(ev, 'clientY', { value: clientY })
  act(() => { el.dispatchEvent(ev) })
}

describe('Column — empty columns and the On Hold space', () => {
  it('folds an empty column to a rail; with On Hold the rail names both targets', () => {
    expect(render({ meta: COLUMN_META.rev }).getAttribute('aria-label')).toBe('In Review — empty')
    act(() => root!.unmount())
    const blocked = render({ meta: COLUMN_META.blocked, held: [], onMove: () => {} })
    expect(blocked.getAttribute('aria-label')).toBe('Blocked and On Hold — empty')
    expect(blocked.className).toContain('jb-col-rail')
  })

  it('opens to a compact drop zone during a drag, not full width', () => {
    const s = render({ meta: COLUMN_META.rev, onMove: () => {}, dragActive: true })
    expect(s.className).toContain('jb-col-drop')
    expect(s.style.flex).toBe('0 0 7.75rem')
  })

  it('a drop on the On Hold zone moves the ticket to On Hold; anywhere else in Blocked marks it Blocked', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove, dragActive: true })
    drop(s.querySelector('[data-drop="hold"]')!)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold')
    drop(s)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'blocked')
  })

  it('the folded rail is droppable too — its Hold segment parks the card', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove })
    drop(s.querySelector('[data-drop="hold"]')!)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold')
  })

  it('without an On Hold space (Settings → On Hold off) there is no hold target at all', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, onMove, dragActive: true })
    expect(s.querySelector('[data-drop="hold"]')).toBeNull()
    expect(s.getAttribute('aria-label')).toBe('Blocked — empty, drop a card here')
    drop(s)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'blocked')
  })

  it('other columns never offer On Hold', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.prog, onMove, dragActive: true })
    expect(s.querySelector('[data-drop="hold"]')).toBeNull()
    drop(s)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'prog')
  })

  it('a drop in the blank part of the column BELOW Blocked lands On Hold, not Blocked', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove, dragActive: true })
    // Blocked's box ends at y=200 (jsdom has no layout, so give it one).
    const ownBox = s.querySelector('[data-drop="hold"]')!.previousElementSibling as HTMLElement
    ownBox.getBoundingClientRect = () => ({ top: 60, bottom: 200, height: 140, left: 0, right: 112, width: 112, x: 0, y: 60, toJSON: () => ({}) })
    drop(s, 'ABC-1', 640) // the empty space far below both boxes
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold')
    drop(s, 'ABC-1', 120) // inside Blocked's box
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'blocked')
  })

  it('QA gets a second, separate space for tickets being tested — its own drop target', () => {
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const testing = { key: 'Q-2', title: 'Testing', status: 'QA In Progress', column: 'qa' as const }
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting, testing], onMove })
    expect(s.getAttribute('aria-label')).toBe('QA · 1 · QA In Progress · 1')
    const groups = [...s.querySelectorAll('[role=group]')]
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('aria-label')).toBe('QA In Progress · 1')
    drop(s.querySelector('[data-drop="qaip"]')!)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'qaip')
    drop(s, 'ABC-1', 0) // inside QA's own box
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'qa')
  })

  it('an empty QA folds to a rail that names both spaces; with only picked-up cards it stays open', () => {
    expect(render({ meta: COLUMN_META.qa }).getAttribute('aria-label')).toBe('QA and QA In Progress — empty')
    act(() => root!.unmount())
    const testing = { key: 'Q-2', title: 'Testing', status: 'QA In Progress', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [testing] })
    expect(s.className).toContain('jb-col-full')
  })

  it('a zone arms on dragenter alone — no waiting for the next dragover', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove, dragActive: true })
    const enter = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(enter, 'dataTransfer', { value: { types: [DRAG_MIME], dropEffect: '' } })
    Object.defineProperty(enter, 'clientY', { value: 0 })
    const hold = s.querySelector('[data-drop="hold"]')!
    act(() => { hold.dispatchEvent(enter) })
    expect(enter.defaultPrevented).toBe(true)
    expect(hold.textContent).toContain('Release') // lit up on arrival
  })

  it('QA In Progress switched off: no second space, and no QA In Progress in its name', () => {
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting], showQaInProgress: false })
    expect(s.querySelector('[role=group]')).toBeNull()
    expect(s.getAttribute('aria-label')).toBe('QA · 1')
    act(() => root!.unmount())
    expect(render({ meta: COLUMN_META.qa, showQaInProgress: false }).getAttribute('aria-label')).toBe('QA — empty')
  })

  it('Blocked off but On Hold on: the column is just On Hold — its name, its target, no Blocked box', () => {
    const onMove = vi.fn()
    const parked = { key: 'H-1', title: 'Parked', status: 'On Hold', column: 'hold' as const }
    const s = render({ meta: COLUMN_META.blocked, held: [parked], hideOwn: true, onMove })
    expect(s.getAttribute('aria-label')).toBe('On Hold · 1')
    expect(s.textContent).not.toMatch(/Blocked/i)
    drop(s, 'ABC-1', 5) // anywhere in the column means On Hold
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold')
    act(() => root!.unmount())
    expect(render({ meta: COLUMN_META.blocked, held: [], hideOwn: true }).getAttribute('aria-label')).toBe('On Hold — empty')
  })

  it('a ticket that may not go to a zone cannot be dropped there: no drop is armed and nothing moves', () => {
    const onMove = vi.fn()
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting], onMove, dragActive: true, dragged: dev })
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: { types: [DRAG_MIME], dropEffect: '' } })
    act(() => { s.dispatchEvent(over) })
    expect(over.defaultPrevented).toBe(false) // the browser shows "no drop"
    drop(s, 'D-1')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('an empty column the dragged ticket cannot use stays folded instead of opening a drop zone', () => {
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    expect(render({ meta: COLUMN_META.qa, onMove: () => {}, dragActive: true, dragged: dev }).className).toContain('jb-col-rail')
    act(() => root!.unmount())
    const qaTicket = { key: 'Q-2', title: 'QA: check', type: 'QA Task', status: 'To Do', column: 'todo' as const }
    expect(render({ meta: COLUMN_META.qa, onMove: () => {}, dragActive: true, dragged: qaTicket }).className).toContain('jb-col-drop')
  })
})
