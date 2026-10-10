import type { CloudModelChoice } from './runner'

/** "$0.20", "$1.20", "$0.125", "$10": whole dollars bare, otherwise two decimals or three where needed. */
/** Output price (USD per 1M tokens) ABOVE which a model gets a cost warning; $10 itself does not. */
export const WARN_ABOVE_OUTPUT_USD = 10

/** True when the model's output price is above the warning line. */
export function isPricey(m: { price?: { output: number | null } | null } | null | undefined): boolean {
  const out = m?.price?.output
  return out != null && out > WARN_ABOVE_OUTPUT_USD
}

export type EffortId = 'low' | 'medium' | 'high'
const ALL_EFFORTS: readonly EffortId[] = ['low', 'medium', 'high']

/**
 * The efforts the Settings dropdown offers for a model. Every model has one — except a pricey one (output above
 * $10 per 1M tokens, the ⚠ ones), whose cost note says to pick a cheaper model instead. A model that advertises
 * the efforts it supports offers just those; one that advertises none (no effort parameter) gets all three, which
 * the worker then applies as guidance in the prompt.
 */
export function effortChoicesFor(m: { efforts?: string[]; price?: { output: number | null } | null } | null | undefined): EffortId[] {
  if (!m || isPricey(m)) return []
  const advertised = ALL_EFFORTS.filter((e) => m.efforts?.includes(e))
  return advertised.length ? advertised : [...ALL_EFFORTS]
}

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
