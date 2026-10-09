import { describe, expect, it } from 'vitest'
import { LIGHT_PAGE, MERGE_FILL, columnWidths, paginate, paginateSection, type MeasuredBlock, type MeasuredSection, type Page } from './printPlan'

const G = { budget: 500, gap: 20, subhead: 30 }

const rows = (id: string, head: number, items: number[]): MeasuredBlock => ({
  id,
  head,
  items,
  whole: head + items.reduce((a, b) => a + b, 0),
  atom: false,
})
const atom = (id: string, whole: number, fallback?: MeasuredBlock[]): MeasuredBlock => ({ id, head: 0, items: [], whole, atom: true, fallback })
const section = (id: string, blocks: MeasuredBlock[], mergeable = true): MeasuredSection => ({ id, blocks, mergeable })

/** Every item of every block appears exactly once, in order, across the pages. */
function coverage(pages: Page[]) {
  const seen = new Map<string, number[]>()
  for (const p of pages) for (const s of p.sections) for (const piece of s.pieces) {
    const list = seen.get(piece.blockId) ?? []
    for (let i = piece.from; i < piece.to; i++) list.push(i)
    seen.set(piece.blockId, list)
  }
  return seen
}

describe('print deck pagination', () => {
  it('keeps a section that fits on one slide', () => {
    const pages = paginate([section('a', [atom('a1', 120), rows('a2', 40, [30, 30, 30])])], G)
    expect(pages).toHaveLength(1)
    expect(pages[0].sections[0].pieces.map((p) => [p.blockId, p.from, p.to])).toEqual([
      ['a1', 0, 0],
      ['a2', 0, 3],
    ])
  })

  it('splits a long table between rows only, repeating its head on every slide', () => {
    const table = rows('t', 50, Array(30).fill(40))
    const pages = paginate([section('s', [table])], G)
    expect(pages.length).toBeGreaterThan(1)
    expect(coverage(pages).get('t')).toEqual([...Array(30).keys()])
    for (const p of pages) expect(p.height).toBeLessThanOrEqual(G.budget)
    // every slide after the first continues the table
    expect(pages.slice(1).every((p) => p.sections[0].pieces[0].continued && p.sections[0].continued)).toBe(true)
  })

  it('never leaves a block heading alone at the foot of a slide', () => {
    // 400 of 500 used; the next table's head (60) + first row (60) does not fit → it starts fresh.
    const pages = paginateSection(section('s', [atom('big', 400), rows('t', 60, [60, 60])]), G)
    expect(pages).toHaveLength(2)
    expect(pages[0].pieces.map((p) => p.blockId)).toEqual(['big'])
    expect(pages[1].pieces[0]).toMatchObject({ blockId: 't', from: 0, to: 2 })
  })

  it('rebalances a nearly empty last slide instead of stranding one row', () => {
    // 12 rows of 40 + head 40: the first slide takes 11 rows (480), greedy would leave 1 row alone.
    const pages = paginateSection(section('s', [rows('t', 40, Array(12).fill(40))]), G)
    expect(pages).toHaveLength(2)
    const [a, b] = pages.map((p) => p.pieces[0].to - p.pieces[0].from)
    expect(a + b).toBe(12)
    expect(b).toBeGreaterThan(1)
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1)
    expect(pages[1].height).toBeGreaterThanOrEqual(G.budget * LIGHT_PAGE - 40)
  })

  it('moves a big row back when that evens the slides out, even if the last becomes the heavier one', () => {
    // Cards paginate a row at a time: two full rows (200) and a short last row with one card (120).
    // Greedy leaves the lone card on its own slide; one full row each side is far more even.
    const pages = paginateSection(section('s', [rows('cards', 30, [200, 200, 120])]), { budget: 450, gap: 20, subhead: 30 })
    expect(pages.map((p) => [p.pieces[0].from, p.pieces[0].to])).toEqual([
      [0, 1],
      [1, 3],
    ])
  })

  it('does not rebalance a last slide that is already well filled', () => {
    const pages = paginateSection(section('s', [rows('t', 40, Array(20).fill(40))]), G)
    expect(pages.map((p) => p.pieces[0].to - p.pieces[0].from)).toEqual([11, 9])
  })

  it('lays a two-column composite out as its parts when it is taller than a slide', () => {
    const left = rows('l', 40, Array(10).fill(40))
    const right = rows('r', 40, Array(10).fill(40))
    const pages = paginate([section('s', [atom('split', 900, [left, right])])], G)
    const ids = coverage(pages)
    expect(ids.has('split')).toBe(false)
    expect(ids.get('l')).toHaveLength(10)
    expect(ids.get('r')).toHaveLength(10)
  })

  it('keeps a composite whole when it fits', () => {
    const pages = paginate([section('s', [atom('split', 300, [rows('l', 10, [10]), rows('r', 10, [10])])])], G)
    expect(pages[0].sections[0].pieces.map((p) => p.blockId)).toEqual(['split'])
  })

  it('gives an atom taller than a slide a slide of its own (the fit pass shrinks it)', () => {
    const pages = paginate([section('s', [atom('a', 100), atom('huge', 900), atom('b', 100)])], G)
    expect(pages.map((p) => p.sections[0].pieces.map((x) => x.blockId))).toEqual([['a'], ['huge'], ['b']])
  })

  it('merges short sections onto one slide while they fit', () => {
    const pages = paginate([section('a', [atom('a1', 120)]), section('b', [atom('b1', 120)]), section('c', [atom('c1', 120)])], G)
    // 120 + (20 + 30 + 120) = 290; + another 170 = 460 > 450 (90%) → the third gets its own slide.
    expect(pages.map((p) => p.sections.map((s) => s.sectionId))).toEqual([['a', 'b'], ['c']])
    expect(pages[0].height).toBeLessThanOrEqual(G.budget * MERGE_FILL)
  })

  it('never merges a section that spans several slides, or one that is not mergeable', () => {
    const long = section('long', [rows('t', 40, Array(20).fill(40))])
    const pages = paginate([section('a', [atom('a1', 80)]), long, section('b', [atom('b1', 80)], false), section('c', [atom('c1', 80)])], G)
    expect(pages.map((p) => p.sections.map((s) => s.sectionId))).toEqual([['a'], ['long'], ['long'], ['b'], ['c']])
  })

  it('handles an empty section list and a section with nothing measurable', () => {
    expect(paginate([], G)).toEqual([])
    expect(paginate([section('z', [atom('z1', 0)])], G)).toHaveLength(1)
  })
})

describe('table column widths', () => {
  it('sums to 100 and lets the long column breathe without starving the others', () => {
    const w = columnWidths(['Gate', 'State', 'Evidence'], [
      ['Approvals', 'pass', 'Two approvals from code owners, including the security reviewer on the auth change'],
      ['Build', 'pass', 'Jenkins build #412 green on the merge commit'],
    ])
    expect(Math.round(w.reduce((a, b) => a + b, 0))).toBe(100)
    expect(w[2]).toBeGreaterThan(w[0])
    expect(Math.min(...w)).toBeGreaterThan(8)
  })

  it('copes with a table that has no rows', () => {
    const w = columnWidths(['A', 'B'], [])
    expect(w).toEqual([50, 50])
  })
})
