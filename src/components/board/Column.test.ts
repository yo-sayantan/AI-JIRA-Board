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

/** jsdom has no DragEvent; a plain event carrying a dataTransfer is what React reads. */
function drop(el: Element, key = 'ABC-1') {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { types: [DRAG_MIME], getData: () => key, dropEffect: '' } })
  act(() => { el.dispatchEvent(ev) })
}

describe('Column — empty columns and the On Hold shelf', () => {
  it('folds an empty column to a rail; with a shelf the rail names both targets', () => {
    expect(render({ meta: COLUMN_META.qa }).getAttribute('aria-label')).toBe('QA — empty')
    act(() => root!.unmount())
    const blocked = render({ meta: COLUMN_META.blocked, held: [], onMove: () => {} })
    expect(blocked.getAttribute('aria-label')).toBe('Blocked and On Hold — empty')
    expect(blocked.className).toContain('jb-col-rail')
  })

  it('opens to a compact drop zone during a drag, not full width', () => {
    const s = render({ meta: COLUMN_META.rev, onMove: () => {}, dragActive: true })
    expect(s.className).toContain('jb-col-drop')
    expect(s.style.flex).toBe('0 0 7rem')
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

  it('without a shelf (Settings → On Hold off) there is no hold target at all', () => {
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
})
