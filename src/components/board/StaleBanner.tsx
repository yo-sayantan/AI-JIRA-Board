import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { WarningIcon, RefreshIcon } from './Icons'

const RED = '#ef4444'

/** Red, attention-grabbing banner shown when the dump is more than 12h old. */
export function StaleBanner({
  label,
  served,
  refreshing,
  onRefresh,
}: {
  label: string
  served: boolean
  refreshing: boolean
  onRefresh: () => void
}) {
  const [dismissed, setDismissed] = useState(false)

  return (
    <AnimatePresence initial={false}>
      {!dismissed && (
        <motion.div
          initial={{ opacity: 0, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="overflow-hidden"
        >
          <div
            className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5"
            style={{ borderColor: 'rgba(239,68,68,0.5)', background: 'linear-gradient(90deg, rgba(239,68,68,0.16), rgba(239,68,68,0.06))' }}
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg pulse-attention" style={{ background: 'rgba(239,68,68,0.18)', ['--ring' as string]: RED }}>
              <WarningIcon size={15} color={RED} />
            </span>
            <span className="text-[12.5px] font-semibold" style={{ color: RED }}>
              This board is stale — {label}.
              <span className="ml-1 font-medium text-[var(--ink-soft)]">
                {served ? 'Run the JIRA intern agent to pull the latest.' : 'Run the intern, then reload, to pull the latest.'}
              </span>
            </span>

            <div className="ml-auto flex items-center gap-2">
              <motion.button
                whileHover={{ scale: 1.04, y: -1 }}
                whileTap={{ scale: 0.96 }}
                onClick={onRefresh}
                disabled={refreshing}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white shadow-md disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg, #ef4444, #f97316)' }}
              >
                <span className={`inline-flex ${refreshing ? 'animate-spin' : ''}`}>
                  <RefreshIcon size={14} color="#fff" />
                </span>
                {refreshing ? 'Refreshing…' : served ? 'Refresh now' : 'Reload'}
              </motion.button>
              <button onClick={() => setDismissed(true)} className="grid h-7 w-7 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" title="Dismiss" aria-label="Dismiss">
                ✕
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
