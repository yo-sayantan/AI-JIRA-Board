import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

const focusablesIn = (node: HTMLElement) =>
  [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)

/** Open dialogs, newest last; only the top one owns Tab. */
const stack: RefObject<HTMLElement | null>[] = []

/**
 * While `active`, keep keyboard focus inside a modal panel (which needs tabIndex={-1}): focus the
 * panel when it opens, wrap Tab at its edges, and give focus back to the opener once it closes.
 */
export function useDialogFocus(active: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return
    const opener = document.activeElement as HTMLElement | null
    stack.push(ref)
    const frame = requestAnimationFrame(() => {
      const node = ref.current
      if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true })
    })
    const onKey = (e: KeyboardEvent) => {
      const node = ref.current
      if (e.key !== 'Tab' || !node || stack[stack.length - 1] !== ref) return
      const items = focusablesIn(node)
      const at = document.activeElement as HTMLElement | null
      if (!items.length) {
        e.preventDefault()
        node.focus()
        return
      }
      const outside = !at || at === node || !node.contains(at)
      if (e.shiftKey && (outside || at === items[0])) {
        e.preventDefault()
        items[items.length - 1].focus()
      } else if (!e.shiftKey && (outside || at === items[items.length - 1])) {
        e.preventDefault()
        items[0].focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
      stack.splice(stack.indexOf(ref), 1)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [active, ref])
}
