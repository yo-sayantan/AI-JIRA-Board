import { describe, expect, it } from 'vitest'
import type { CloudModelChoice } from './runner'
import { effortChoicesFor, groupByProvider, isPricey, usd } from './cloudModels'

describe('usd', () => {
  it('writes whole dollars bare and fractions to the precision Cursor quotes', () => {
    expect(usd(2)).toBe('$2')
    expect(usd(10)).toBe('$10')
    expect(usd(0.5)).toBe('$0.50')
    expect(usd(1.2)).toBe('$1.20')
    expect(usd(4.25)).toBe('$4.25')
    expect(usd(0.125)).toBe('$0.125')
    expect(usd(0.029)).toBe('$0.029')
  })
  it('shows a dash where Cursor lists no charge', () => {
    expect(usd(null)).toBe('—')
    expect(usd(undefined)).toBe('—')
  })
})

describe('groupByProvider', () => {
  const m = (id: string, provider?: string): CloudModelChoice => ({ id, label: id, provider })
  it('keeps the server order, one group per maker', () => {
    const groups = groupByProvider([m('a', 'Cursor'), m('b', 'Anthropic'), m('c', 'Anthropic'), m('d', 'OpenAI')])
    expect(groups.map(([g, rows]) => [g, rows.map((r) => r.id)])).toEqual([
      ['Cursor', ['a']],
      ['Anthropic', ['b', 'c']],
      ['OpenAI', ['d']],
    ])
  })
  it('puts models without a maker in one ungrouped list (Claude and Gemini providers)', () => {
    expect(groupByProvider([m('x'), m('y')])).toEqual([['', [m('x'), m('y')]]])
  })
})

describe('isPricey', () => {
  const at = (output: number | null) => ({ price: { output } })
  it('warns only above $10 — $10 itself is the top of the value range, not a warning', () => {
    expect(isPricey(at(12))).toBe(true)
    expect(isPricey(at(10.01))).toBe(true)
    expect(isPricey(at(10))).toBe(false)
    expect(isPricey(at(9.99))).toBe(false)
    expect(isPricey(at(1.2))).toBe(false)
  })
  it('stays quiet when there is no price to judge', () => {
    expect(isPricey(at(null))).toBe(false)
    expect(isPricey({})).toBe(false)
    expect(isPricey(null)).toBe(false)
    expect(isPricey(undefined)).toBe(false)
  })
})

describe('effortChoicesFor', () => {
  it('offers Low / Medium / High for a model that advertises none (it has no effort parameter)', () => {
    expect(effortChoicesFor({ efforts: [], price: { output: 2 } })).toEqual(['low', 'medium', 'high'])
    expect(effortChoicesFor({ price: null })).toEqual(['low', 'medium', 'high'])
  })
  it('offers just the efforts a model advertises', () => {
    expect(effortChoicesFor({ efforts: ['low', 'high'] })).toEqual(['low', 'high'])
  })
  it('offers none for a pricey model — above $10 output — and for no model', () => {
    expect(effortChoicesFor({ efforts: ['low', 'medium'], price: { output: 15 } })).toEqual([])
    expect(effortChoicesFor(null)).toEqual([])
  })
  it('$10 exactly is not pricey (the ⚠ starts above it), so it still has the dropdown', () => {
    expect(effortChoicesFor({ price: { output: 10 } })).toEqual(['low', 'medium', 'high'])
  })
})
