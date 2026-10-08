import type { CloudModelChoice } from './runner'

/** "$0.20", "$1.20", "$0.125", "$10": whole dollars bare, otherwise two decimals or three where needed. */
/** Output price (USD per 1M tokens) at which a model gets a cost warning. */
export const PRICEY_OUTPUT_USD = 10

/** True when the model's output price is at or above the warning line. */
export function isPricey(m: { price?: { output: number | null } | null } | null | undefined): boolean {
  const out = m?.price?.output
  return out != null && out >= PRICEY_OUTPUT_USD
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
