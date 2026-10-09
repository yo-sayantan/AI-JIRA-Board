// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../types'
import { DRAG_GHOST_OPACITY, DRAG_MIME, TicketCard } from './TicketCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
  vi.useRealTimers()
})

const ticket: Ticket = { key: 'ABC-1', title: 'A card', status: 'In Progress', column: 'prog' }

describe('dragging a card', () => {
  it('carries a translucent clone, so the drop zone stays visible through it', () => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(TicketCard, { ticket, now: Date.now(), onOpen: () => {}, draggable: true })))

    const setDragImage = vi.fn()
    const data: Record<string, string> = {}
    const ev = new Event('dragstart', { bubbles: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { setData: (k: string, v: string) => (data[k] = v), setDragImage, effectAllowed: '' } })
    Object.defineProperty(ev, 'clientX', { value: 30 })
    Object.defineProperty(ev, 'clientY', { value: 20 })
    act(() => { host!.querySelector('.ticket-card')!.dispatchEvent(ev) })

    expect(data[DRAG_MIME]).toBe('ABC-1')
    expect(setDragImage).toHaveBeenCalledTimes(1)
    const [ghost] = setDragImage.mock.calls[0] as [HTMLElement]
    expect(Number(ghost.style.opacity)).toBe(DRAG_GHOST_OPACITY)
    expect(DRAG_GHOST_OPACITY).toBeLessThan(0.8) // visibly see-through…
    expect(DRAG_GHOST_OPACITY).toBeGreaterThan(0.3) // …but still a card you can read
    expect(ghost.isConnected).toBe(true) // the browser reads it right now
    act(() => { vi.runAllTimers() })
    expect(ghost.isConnected).toBe(false) // and it never lingers in the page
  })
})
