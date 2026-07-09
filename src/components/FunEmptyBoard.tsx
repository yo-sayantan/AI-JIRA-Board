import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CopyButton } from './ui'
import { RefreshIcon } from './Icons'
import { RUN_COMMAND } from '../lib/runner'

const QUIPS = [
  "No tickets assigned. Either you shipped everything or JIRA is bluffing. 🃏",
  'Inbox zero, sprint hero. Go enjoy a coffee. ☕',
  'The board is empty. This is either a miracle or a misconfiguration. ✨',
  'Zero tickets. Somewhere a project manager just felt a disturbance in the Force. 🌌',
  'Nothing assigned to you. Quick, look busy. 👀',
  'All clear, captain. Nothing on the radar. 🛰️',
  'You reached the end of the backlog. There is nothing here. Touch grass. 🌱',
  'No work? Bold of JIRA to assume that survives till lunch. 🍔',
  'Board: 0. You: 1. Enjoy the W. 🏆',
  'It’s quiet… too quiet. 🤠',
]

const FLOATERS = ['🎫', '✅', '🚀', '🍃', '✨', '☕']

export function FunEmptyBoard({
  served,
  refreshing,
  onRefresh,
}: {
  served: boolean
  refreshing: boolean
  onRefresh: () => void
}) {
  const [i, setI] = useState(() => Math.floor(Math.random() * QUIPS.length))

  useEffect(() => {
    const id = setInterval(() => setI((p) => (p + 1) % QUIPS.length), 4500)
    return () => clearInterval(id)
  }, [])

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative grid min-h-[46vh] place-items-center overflow-hidden rounded-2xl border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)]"
    >
      {/* floating ambient emojis */}
      {FLOATERS.map((e, idx) => (
        <motion.span
          key={idx}
          aria-hidden
          className="pointer-events-none absolute select-none text-2xl opacity-20"
          style={{ left: `${8 + idx * 15}%`, top: `${15 + ((idx * 37) % 60)}%` }}
          animate={{ y: [0, -16, 0], rotate: [0, 8, -6, 0] }}
          transition={{ duration: 5 + idx, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.4 }}
        >
          {e}
        </motion.span>
      ))}

      <div className="relative z-10 max-w-lg px-6 text-center">
        <motion.div
          initial={{ scale: 0.6, rotate: -10 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 14 }}
          className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl text-[34px]"
          style={{ background: 'linear-gradient(135deg, #6d5bd0, #3b82f6)' }}
        >
          🎉
        </motion.div>

        <h2 className="mb-1 text-[15px] font-bold uppercase tracking-wider text-[var(--muted)]">An empty board</h2>

        <div className="flex min-h-[58px] items-center justify-center">
          <AnimatePresence mode="wait">
            <motion.p
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.4 }}
              className="text-[17px] font-semibold leading-snug text-[var(--ink)]"
            >
              {QUIPS[i]}
            </motion.p>
          </AnimatePresence>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #6d5bd0, #3b82f6)' }}
          >
            <span className={`inline-flex ${refreshing ? 'animate-spin' : ''}`}>
              <RefreshIcon size={15} color="#fff" />
            </span>
            {refreshing ? 'Checking…' : served ? 'Run the intern' : 'Reload'}
          </motion.button>
          {!served && <CopyButton text={RUN_COMMAND} label="Copy run command" />}
        </div>

        {!served && (
          <p className="mt-3 text-[11.5px] text-[var(--muted)]">
            Tip: run the intern in a terminal (or <code className="rounded bg-[var(--surface-solid)] px-1 py-0.5 font-mono">npm run serve</code> for a live button), then Reload.
          </p>
        )}
      </div>
    </motion.div>
  )
}
