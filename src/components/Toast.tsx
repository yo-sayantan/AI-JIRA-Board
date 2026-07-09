import { AnimatePresence, motion } from 'motion/react'

export type ToastKind = 'info' | 'success' | 'error' | 'loading'
export interface ToastItem {
  id: number
  msg: string
  kind?: ToastKind
}

const ICON: Record<ToastKind, string> = { info: 'ⓘ', success: '✓', error: '⚠️', loading: '◌' }
const COLOR: Record<ToastKind, string> = { info: '#8b9cff', success: '#22c55e', error: '#ef4444', loading: '#8b9cff' }

export function Toasts({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-[60] flex flex-col items-end gap-2">
      <AnimatePresence>
        {toasts.map((t) => {
          const kind = t.kind ?? 'info'
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 24, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-4 py-2.5 text-[12.5px] font-medium text-[var(--ink)] card-shadow"
            >
              <span className={kind === 'loading' ? 'animate-spin' : ''} style={{ color: COLOR[kind] }}>
                {ICON[kind]}
              </span>
              {t.msg}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
