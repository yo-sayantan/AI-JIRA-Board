// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../types'
import { Stats } from './Stats'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const t = (key: string, column: Ticket['column']): Ticket => ({ key, title: key, status: column, column })

function mount(active: Parameters<typeof Stats>[0]['active'], onSelect = vi.fn()) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const tickets = [t('A-1', 'todo'), t('A-2', 'todo'), t('A-3', 'prog'), t('A-4', 'hold')]
  act(() => root!.render(createElement(Stats, { tickets, completedCount: null, raisedCount: null, active, onSelect })))
  return { chips: [...host.querySelectorAll('button')], onSelect }
}

describe('the chip row', () => {
  it('starts with All, selected by default (nothing filtered), counting every ticket', () => {
    const { chips } = mount(null)
    expect(chips[0].textContent).toMatch(/^\s*All\s*4$/)
    expect(chips[0].getAttribute('aria-pressed')).toBe('true')
    expect(chips.some((c) => /next sprint/i.test(c.textContent ?? ''))).toBe(false) // it is a space in To Do now
  })

  it('a column chip filters; picking it again returns to All', () => {
    const picked = mount('todo')
    expect(picked.chips[0].getAttribute('aria-pressed')).toBe('false')
    const todo = picked.chips.find((c) => /^To Do/.test(c.textContent ?? ''))!
    act(() => todo.click())
    expect(picked.onSelect).toHaveBeenLastCalledWith(null)
  })
})
