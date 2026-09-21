import { useEffect, type AriaAttributes, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { motion } from 'motion/react'

/**
 * Toolbar primitives — the vocabulary the top of the board is built from.
 *
 * Every control is exactly 36px tall so the row lines up with no stragglers, and every square
 * icon control shares one surface (hairline border, solid fill, card shadow) and one radius.
 * Hover grows the control a touch and a press squeezes it — the same spring everywhere.
 */

/** The bordered surface every standalone toolbar control shares. */
export const SURFACE = 'border border-[var(--line)] bg-[var(--surface-solid)] card-shadow'

const SQUARE = `grid h-9 w-9 shrink-0 place-items-center rounded-xl ${SURFACE} text-[var(--ink-soft)] transition-colors hover:border-[var(--muted)] hover:text-[var(--ink)] disabled:pointer-events-none disabled:opacity-45`

const SPRING = { type: 'spring', stiffness: 400, damping: 18 } as const

type ToolButtonProps = {
  /** Accessible name; doubles as the tooltip unless `title` is given. */
  label: string
  title?: string
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
  busy?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
} & Pick<AriaAttributes, 'aria-haspopup' | 'aria-expanded'>

export function ToolButton({ label, title, onClick, disabled, pressed, busy, className = '', style, children, ...aria }: ToolButtonProps) {
  return (
    <motion.button
      type="button"
      whileHover={disabled ? undefined : { scale: 1.08 }}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      transition={SPRING}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      title={title ?? label}
      className={`${SQUARE} ${pressed ? 'border-[var(--muted)] text-[var(--ink)]' : ''} ${className}`}
      style={style}
      {...aria}
    >
      {children}
    </motion.button>
  )
}

/** The anchor twin of ToolButton — for destinations that must work with no server (the guide). */
export function ToolLink({ label, href, className = '', children }: { label: string; href: string; className?: string; children: ReactNode }) {
  return (
    <motion.a
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.9 }}
      transition={SPRING}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className={`${SQUARE} ${className}`}
    >
      {children}
    </motion.a>
  )
}

/** A key cap — the shortcut hint inside the search field. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-[5px] border border-[var(--line)] bg-[var(--surface-2)] px-1 font-sans text-[10px] font-semibold text-[var(--muted)]">
      {children}
    </kbd>
  )
}

/**
 * Close a popover on an outside pointer-down or Escape. Escape is handled in the capture phase and
 * stopped, so the board's own Escape handlers (the drawer stack) don't fire for the same key.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [ref, open, onClose])
}
