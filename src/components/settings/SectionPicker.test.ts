// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { SectionPicker, type PickerOption } from './SectionPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: PickerOption[] = ['Alpha', 'Beta', 'Gamma'].map((label, i) => ({
  key: label.toLowerCase(),
  label,
  hint: `${label} hint`,
  color: ['#2684ff', '#f97316', '#6366f1'][i],
  icon: () => null,
}))

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
let dialogEsc = 0
const onDialogKey = (e: KeyboardEvent) => e.key === 'Escape' && dialogEsc++

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.removeEventListener('keydown', onDialogKey, true)
  host = root = null
})

function Harness({ initial }: { initial: string[] }) {
  const [sel, setSel] = useState(new Set(initial))
  return createElement(SectionPicker, {
    label: 'Board sections',
    options: OPTIONS,
    selected: sel,
    emptyText: 'Nothing chosen.',
    onToggle: (k: string, on: boolean) => setSel((s) => { const n = new Set(s); on ? n.add(k) : n.delete(k); return n }),
    onSetAll: (on: boolean) => setSel(new Set(on ? OPTIONS.map((o) => o.key) : [])),
  })
}

function mount(initial: string[]) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Harness, { initial })))
  return host
}
const field = () => host!.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!
const options = () => [...host!.querySelectorAll<HTMLElement>('[role=option]')]
const chips = () => [...host!.querySelectorAll('button[aria-haspopup] span.rounded-full')].map((e) => e.textContent)
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })

describe('SectionPicker', () => {
  it('shows the chosen sections as chips, or the empty text', () => {
    mount(['alpha', 'gamma'])
    expect(chips()).toEqual(['Alpha', 'Gamma'])
    act(() => root!.unmount())
    mount([])
    expect(field().textContent).toContain('Nothing chosen.')
  })

  it('opens a multi-select listbox with every option and its state', () => {
    mount(['beta'])
    expect(field().getAttribute('aria-expanded')).toBe('false')
    act(() => field().click())
    expect(field().getAttribute('aria-expanded')).toBe('true')
    expect(host!.querySelector('[role=listbox]')!.getAttribute('aria-multiselectable')).toBe('true')
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Beta'), expect.stringContaining('Gamma')])
  })

  it('toggles an option with a click and keeps the list open for the next one', () => {
    mount([])
    act(() => field().click())
    act(() => options()[1].click())
    act(() => options()[2].click())
    expect(chips()).toEqual(['Beta', 'Gamma'])
    expect(field().getAttribute('aria-expanded')).toBe('true')
    act(() => options()[1].click())
    expect(chips()).toEqual(['Gamma'])
  })

  it('is fully keyboard operable: arrows move, Space and Enter toggle', () => {
    mount([])
    act(() => field().click())
    const list = host!.querySelector('[role=listbox]')!
    key(list, ' ') // highlighted: Alpha
    key(list, 'ArrowDown')
    key(list, 'Enter') // Beta
    key(list, 'End')
    key(list, ' ') // Gamma
    expect(chips()).toEqual(['Alpha', 'Beta', 'Gamma'])
    key(list, 'Home')
    key(list, ' ')
    expect(chips()).toEqual(['Beta', 'Gamma'])
  })

  it('Esc closes only the list — the dialog\'s own Escape handler never sees it', () => {
    mount([])
    document.addEventListener('keydown', onDialogKey, true) // what Settings registers (document, capture)
    act(() => field().click())
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(host!.querySelector('[role=listbox]')).toBeNull()
    expect(dialogEsc).toBe(0)
    // with the list closed, Esc reaches the dialog as usual
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(dialogEsc).toBe(1)
  })

  it('closes on an outside click and on Tab', () => {
    mount([])
    act(() => field().click())
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(host!.querySelector('[role=listbox]')).toBeNull()
    act(() => field().click())
    key(host!.querySelector('[role=listbox]')!, 'Tab')
    expect(host!.querySelector('[role=listbox]')).toBeNull()
  })

  it('Select all and Clear, each disabled when it would change nothing', () => {
    mount(['alpha'])
    act(() => field().click())
    const btn = (t: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === t)!
    expect(btn('Select all').disabled).toBe(false)
    act(() => btn('Select all').click())
    expect(chips()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(btn('Select all').disabled).toBe(true)
    act(() => btn('Clear').click())
    expect(chips()).toEqual([])
    expect(btn('Clear').disabled).toBe(true)
  })

  it('opens from the keyboard with the arrow keys and summarises itself for screen readers', () => {
    mount(['alpha'])
    key(field(), 'ArrowDown')
    expect(host!.querySelector('[role=listbox]')).not.toBeNull()
    expect(field().getAttribute('aria-label')).toContain('Board sections: Alpha')
  })
})
