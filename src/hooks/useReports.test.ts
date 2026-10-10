// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InternStatus } from '../lib/runner'
import { useReports } from './useReports'

vi.mock('../lib/statusPoller', () => ({ pollNow: vi.fn() }))
vi.mock('../lib/runner', async (orig) => ({ ...(await orig<typeof import('../lib/runner')>()), getReportsIndex: async () => ({ reports: {}, generating: [] }), getReport: async () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

type Reports = ReturnType<typeof useReports>
function mount(initial: Partial<InternStatus>) {
  const ref: { current: Reports | null } = { current: null }
  let status = initial as InternStatus
  function Probe({ s }: { s: InternStatus }) {
    ref.current = useReports({ served: true, enabled: true, status: s, toast: () => 0 })
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = () => act(() => root!.render(createElement(Probe, { s: status })))
  render()
  return { reports: () => ref.current!, set: (next: Partial<InternStatus>) => ((status = next as InternStatus), render()) }
}

describe('report progress covers the AI pass, not just the base report', () => {
  it('keeps a key in "working" after its base report is done, while the AI pass is still queued or running', () => {
    const m = mount({ reportsGenerating: ['A-1', 'A-2'], reportsEnriching: [] })
    expect([...m.reports().working].sort()).toEqual(['A-1', 'A-2'])
    // Base reports finished fast; the AI intern is still working through them.
    m.set({ reportsGenerating: [], reportsEnriching: ['A-1', 'A-2'] })
    expect([...m.reports().generating]).toEqual([])
    expect([...m.reports().working].sort()).toEqual(['A-1', 'A-2'])
    m.set({ reportsGenerating: [], reportsEnriching: ['A-2'] })
    expect([...m.reports().working]).toEqual(['A-2'])
    m.set({ reportsGenerating: [], reportsEnriching: [] })
    expect(m.reports().working.size).toBe(0)
  })

  it('counts a key once while it is both being built and queued for AI', () => {
    const m = mount({ reportsGenerating: ['A-1'], reportsEnriching: ['A-1', 'A-3'] })
    expect([...m.reports().working].sort()).toEqual(['A-1', 'A-3'])
  })

  it('ignores queued AI passes while the AI intern is down — nothing will run them', () => {
    const m = mount({ reportsGenerating: [], reportsEnriching: ['A-1'], ai: { down: true } as InternStatus['ai'] })
    expect(m.reports().working.size).toBe(0)
  })
})
