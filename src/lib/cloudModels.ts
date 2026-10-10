import type { CloudModelChoice } from './runner'

/**
 * Costly = the worker's verdict (output price at or above cloud-models.json's `costlyOutputUsd`, or the entry's own
 * `costly`). A payload without the flag falls back to the default $10 line.
 */
export const DEFAULT_COSTLY_USD = 10

export function isPricey(m: { costly?: boolean; price?: { output: number | null } | null } | null | undefined): boolean {
  if (typeof m?.costly === 'boolean') return m.costly
  const out = m?.price?.output
  return out != null && out >= DEFAULT_COSTLY_USD
}

export type EffortId = 'low' | 'medium' | 'high' | 'auto'
const ALL_EFFORTS: readonly EffortId[] = ['low', 'medium', 'high', 'auto']

/**
 * The efforts the Settings dropdown offers for a model: exactly the ones cloud-models.json lists for it (the worker
 * already empties the list for a costly model, unless the file says `costlyShowEffort`). None listed = no dropdown.
 */
export function effortChoicesFor(m: { efforts?: string[] } | null | undefined): EffortId[] {
  return ALL_EFFORTS.filter((e) => m?.efforts?.includes(e))
}

/** "$0.20", "$1.20", "$0.125", "$10": whole dollars bare, otherwise two decimals or three where needed. */
export function usd(n: number | null | undefined): string {
  if (n == null) return '—'
  if (Number.isInteger(n)) return `$${n}`
  return `$${n.toFixed(3).replace(/0$/, '')}`
}

/** Dropdown groups: one per provider, in the order the server sent them (it sorts by provider, then price). */
export function groupByProvider(models: CloudModelChoice[]): [string, CloudModelChoice[]][] {
  const groups = new Map<string, CloudModelChoice[]>()
  for (const m of models) {
    const g = m.provider ?? ''
    groups.set(g, [...(groups.get(g) ?? []), m])
  }
  return [...groups]
}
