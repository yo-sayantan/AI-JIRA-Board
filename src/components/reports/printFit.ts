// The last step of laying out the PDF deck: scale each slide's content to its slide.
//
// Pagination (printPlan) decides WHAT goes on a slide from measured heights; this decides HOW BIG
// it is drawn. Content that would overflow is shrunk until it fits; content that leaves the slide
// mostly empty is enlarged, which reads better when the deck is cast to a screen. Both directions
// re-measure after every step, because text reflows at a new scale (a wider effective line wraps
// less), so a single proportional guess would be wrong. Bounded both ways so text never becomes
// unreadably small or comically large.

/** Smallest scale before content is clipped instead (only an atom taller than a slide gets here). */
export const FIT_MIN = 0.62
/** Largest scale for a sparse slide. */
export const FIT_MAX = 1.3
/** Share of the slide an enlarged slide may fill — leaves breathing room at the foot. */
export const FILL_TARGET = 0.92
/** Slides fuller than this are left at their natural size. */
export const GROW_BELOW = 0.78

const STEPS = 7

/**
 * Fit `content` into `avail` pixels of height by setting its CSS zoom. Returns the scale used.
 * Marks the element `data-overflow` when even FIT_MIN cannot make it fit (the slide clips it).
 */
export function fitToHeight(content: HTMLElement, avail: number, opts: { grow?: boolean } = {}): number {
  const grow = opts.grow ?? true
  const set = (z: number) => {
    content.style.zoom = z === 1 ? '' : String(z)
  }
  const height = () => content.getBoundingClientRect().height
  set(1)
  delete content.dataset.overflow
  const natural = height()
  if (!avail || !natural) return 1

  if (natural > avail) {
    // Largest scale in [FIT_MIN, 1) that fits.
    let lo = FIT_MIN
    let hi = 1
    set(lo)
    if (height() > avail) {
      content.dataset.overflow = '1'
      return lo
    }
    for (let k = 0; k < STEPS; k++) {
      const mid = (lo + hi) / 2
      set(mid)
      if (height() <= avail) lo = mid
      else hi = mid
    }
    set(lo)
    return lo
  }

  if (grow && natural < avail * GROW_BELOW) {
    // Largest scale in (1, FIT_MAX] that still leaves the foot free.
    const target = avail * FILL_TARGET
    let lo = 1
    let hi = Math.min(FIT_MAX, target / natural)
    if (hi <= 1.02) return 1
    for (let k = 0; k < STEPS; k++) {
      const mid = (lo + hi) / 2
      set(mid)
      if (height() <= target) lo = mid
      else hi = mid
    }
    const z = Math.floor(lo * 100) / 100
    set(z)
    return z
  }
  return 1
}
