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

describe('the QA lane in the move hook', () => {
  const qaTicket: Ticket = { key: 'Q-1', title: 'QA: verify', type: 'QA Task', status: 'Ready for QA', column: 'qa' }
  const dev: Ticket = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' }

  it('QA → QA In Progress changes what is shown although both are the same column', async () => {
    const { moves } = mountMoves()
    await act(async () => moves().moveTicket(qaTicket, 'qaip'))
    const shown = moves().applyOverrides([qaTicket])[0]
    expect(shown.column).toBe('qa')
    expect(shown.status).toBe('QA In Progress') // the board reads this as the in-progress space
    await act(async () => moves().moveTicket(shown, 'qa')) // and straight back
    expect(moves().applyOverrides([qaTicket])[0].status).toBe('Ready for QA') // back to what the dump shows
  })

  it('refuses a dev ticket to QA before Jira is asked, and says why', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'qa'))
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Only QA tickets'), 'error')
    expect(moves().applyOverrides([dev])[0].column).toBe('prog') // nothing pinned
  })

  it('refuses a QA ticket to leave the lane', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(qaTicket, 'prog'))
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('only be moved between'), 'error')
  })
})

