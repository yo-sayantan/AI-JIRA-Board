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
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('can only be moved to'), 'error')
  })
})

describe('gates, force and undo', () => {
  const dev: Ticket = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' }
  type Opts = { action?: { label: string; run: () => void }; seconds?: number }
  const last = (toast: ReturnType<typeof vi.fn>) => toast.mock.calls[toast.mock.calls.length - 1]
  const lastOpts = (toast: ReturnType<typeof vi.fn>) => last(toast)[2] as Opts | undefined

  it('a gate refuses before Jira is asked, offering "Move anyway" — which forces it', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'rev'))
    expect(last(toast)[0]).toContain('no pull request raised')
    expect(moves().applyOverrides([dev])[0].column).toBe('prog') // nothing moved yet
    const opts = lastOpts(toast)!
    expect(opts.action!.label).toBe('Move anyway')
    await act(async () => opts.action!.run())
    expect(moves().applyOverrides([dev])[0].column).toBe('rev')
    expect(last(toast)[0]).toContain('(forced)')
  })

  it('⌥ on drop asks to force rather than reporting a refusal', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'done', { forceAsk: true }))
    expect(last(toast)[0]).toMatch(/^Force D-1 to Done\?/)
    expect(lastOpts(toast)!.action!.label).toBe('Force move')
  })

  it('a lane refusal can never be forced', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'qa', { forceAsk: true }))
    expect(lastOpts(toast)).toBeUndefined()
  })

  it('every finished move offers Undo, which puts the card back', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'blocked'))
    expect(moves().applyOverrides([dev])[0].column).toBe('blocked')
    const opts = lastOpts(toast)!
    expect(opts.action!.label).toBe('Undo')
    expect(opts.seconds).toBeGreaterThan(0)
    await act(async () => opts.action!.run())
    expect(moves().applyOverrides([dev])[0].column).toBe('prog')
    expect(lastOpts(toast)).toBeUndefined() // an undo is not itself undoable
  })
})
