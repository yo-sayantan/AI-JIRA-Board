import { useEffect, type AriaAttributes, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion } from 'motion/react'

/**
 * Toolbar primitives — the vocabulary the top of the board is built from.
 *
 * The rules, in the spirit of a macOS unified toolbar:
 *   • every control is exactly 32px tall and sits on an 8px grid;
 *   • one surface (hairline border, solid fill, a whisper of shadow) and one radius (8px);
 *   • glyphs are monochrome — colour is reserved for state: the one primary action, a job in
 *     flight, a freshness dot;
 *   • hover tints, press scales down a hair. Nothing lifts, bounces or grows.
 */

/** The single accent: the primary action, the focus ring, progress in flight. Theme-aware. */
export const ACCENT = 'var(--link)'

/** The bordered surface every standalone toolbar control shares. */
export const SURFACE = 'border border-[var(--line)] bg-[var(--surface-solid)] shadow-[0_1px_2px_rgba(16,24,40,0.06)]'

const BASE =
  'relative inline-flex h-8 shrink-0 items-center justify-center text-[var(--ink-soft)] outline-none transition-colors duration-150 hover:bg-[var(--surface-2)] hover:text-[var(--ink)] disabled:pointer-events-none disabled:opacity-45'

const TAP = { type: 'spring', stiffness: 600, damping: 30 } as const

type ToolButtonProps = {
  /** Accessible name; doubles as the tooltip unless `title` is given. */
  label: string
  title?: string
  onClick?: () => void
  disabled?: boolean
  /** Inside a ControlGroup — the group draws the border, so the button draws none. */
  bare?: boolean
  /** A 20px segment: the pull-down chevron beside a main action. */
  narrow?: boolean
  pressed?: boolean
  busy?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
} & Pick<AriaAttributes, 'aria-haspopup' | 'aria-expanded'>

export function ToolButton({ label, title, onClick, disabled, bare, narrow, pressed, busy, className = '', style, children, ...aria }: ToolButtonProps) {
  return (
    <motion.button
      type="button"
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={TAP}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      title={title ?? label}
      className={`${BASE} ${narrow ? 'w-5' : 'w-8'} ${bare ? '' : `rounded-lg ${SURFACE}`} ${
        pressed ? 'bg-[var(--surface-2)] text-[var(--ink)]' : ''
      } ${className}`}
      style={style}
      {...aria}
    >
      {children}
    </motion.button>
  )
}

/** The anchor twin of ToolButton — for destinations that must work with no server (the guide). */
export function ToolLink({ label, href, bare, className = '', children }: { label: string; href: string; bare?: boolean; className?: string; children: ReactNode }) {
  return (
    <motion.a
      whileTap={{ scale: 0.96 }}
      transition={TAP}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className={`${BASE} w-8 ${bare ? '' : `rounded-lg ${SURFACE}`} ${className}`}
    >
      {children}
    </motion.a>
  )
}

/** Several controls in one bordered container, split by hairlines — a segmented toolbar item. */
export function ControlGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-lg ${SURFACE} divide-x divide-[var(--line)] ${className}`}>{children}</div>
}

/** A key cap — the shortcut hint inside the search field and on menu rows. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-[5px] border border-[var(--line)] bg-[var(--surface-2)] px-1 font-sans text-[10px] font-semibold text-[var(--muted)]">
      {children}
    </kbd>
  )
}

/** Pull-down menu anchored under its control's right edge. The parent must be `relative`. */
export function Menu({ open, width = 260, children }: { open: boolean; width?: number; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="menu"
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          className="absolute right-0 top-[calc(100%+6px)] z-50 origin-top-right overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] p-1 shadow-2xl"
          style={{ width }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function MenuItem({
  icon,
  label,
  hint,
  kbd,
  disabled,
  onClick,
}: {
  icon?: ReactNode
  label: string
  hint?: string
  kbd?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-2)] disabled:pointer-events-none disabled:opacity-45"
    >
      {icon && <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--surface-2)]">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold text-[var(--ink)]">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-[var(--muted)]">{hint}</span>}
      </span>
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
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
