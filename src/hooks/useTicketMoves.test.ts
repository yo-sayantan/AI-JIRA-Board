// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../types'
import { useTicketMoves } from './useTicketMoves'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Moves = ReturnType<typeof useTicketMoves>
let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

/** Mount the hook in demo mode (local gates, no server) and hand back its latest value. */
function mountMoves() {
  const toast = vi.fn()
  const ref: { current: Moves | null } = { current: null }
  function Probe() {
    ref.current = useTicketMoves({ served: false, demo: true, toast, refreshTicket: async () => {} })
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Probe)))
  return { moves: () => ref.current!, toast }
}

const dump: Ticket = { key: 'ABC-1', title: 'A card', status: 'Blocked', column: 'blocked' }

describe('moving a card and straight back', () => {
  it('Blocked → On Hold → Blocked ends Blocked again (the displayed column decides "from")', async () => {
    const { moves } = mountMoves()
    await act(async () => moves().moveTicket(dump, 'hold'))
    const shown = moves().applyOverrides([dump])[0]
    expect(shown.column).toBe('hold')
    expect(shown.onHold).toBe(true) // the pin carries the On Hold flag too
    // The dump still says Blocked; dragging the DISPLAYED (held) card back must still move it.
    await act(async () => moves().moveTicket(shown, 'blocked'))
    expect(moves().applyOverrides([dump])[0].column).toBe('blocked')
  })

  it('dropping a card where it already shows is a no-op', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dump, 'blocked'))
    expect(toast).not.toHaveBeenCalled()
  })
})
