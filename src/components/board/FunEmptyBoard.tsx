import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CopyButton } from './ui'
import { EyeOffIcon, RefreshIcon } from './Icons'
import { RUN_COMMAND } from '../lib/runner'

const QUIPS = [
  'No tickets assigned. Either you shipped everything or JIRA is bluffing. 🃏',
  'Inbox zero, sprint hero. Go enjoy a coffee. ☕',
  'The board is empty. This is either a miracle or a misconfiguration. ✨',
  'Zero tickets. Somewhere a project manager just felt a disturbance in the Force. 🌌',
  'Nothing assigned to you. Quick, look busy. 👀',
  'All clear, captain. Nothing on the radar. 🛰️',
  'You reached the end of the backlog. There is nothing here. Touch grass. 🌱',
  'No work? Bold of JIRA to assume that survives till lunch. 🍔',
  'Board: 0. You: 1. Enjoy the W. 🏆',
  'It’s quiet… too quiet. 🤠',
  'Story points: zero. That’s not a story. That’s a rumor. 📖',
  'Your burndown burned all the way up. In the good way. 🔥',
  'Status: unassigned. Mood: unbothered. 😎',
  'The backlog looked at you and blinked first. 👁️',
  'No tickets, no stand-up small talk. A rare double win. 🎤',
  'JIRA searched your name and got a 404. 🔍',
  'You closed the loop so hard the board filed for unemployment. 📭',
  'Velocity: infinite. Work: none. Physics has left the chat. 📉',
  'This column is so empty it echoes. 🔊',
  'Your WIP limit is zero, and you are still under it. 🧘',
  'To Do, In Progress, Review: all clear. You speedran the SDLC. ⏱️',
  'The only blocker left is deciding what to do with the afternoon. 🌤️',
  'Sprint goal met by doing nothing. They will want a write-up. 📝',
  'The tickets feared you and transferred themselves. 🏃',
  'An empty board is a kanban that went on holiday. 🏖️',
  'No open PRs. Somehow that still feels like a threat. 🐙',
  'Definition of Done: you. ✅',
  'Blank canvas. Picasso would be jealous. Your PM, less so. 🎨',
  'Nothing to estimate. You can’t point at what isn’t there. 👉',
  'Capacity full. Allocation empty. This is the dream ticket. 🎟️',
  'JIRA tried to assign you something and lost its nerve. 🐔',
  'Your name is on zero issues. HR said congratulations. 🎉',
  'The board is clearer than the requirements ever were. 💎',
  'Zero bugs. Either the code is perfect or the tests gave up. 🐛',
  'Stand-up will be short. “Nothing.” Then sit down. 🪑',
  'You outran the backlog. It is still tying its shoes. 👟',
  'No subtasks, no parents, no drama. A functional family. 👪',
  'So quiet you can hear a story point drop. 🪙',
  'Unassigned and unbothered. A whole personality. 💅',
  'Your queue has one item: you, leaving. 🚪',
  'Epic: none. Story: none. The plot is that you finished. 🎬',
  'JIRA has nothing on you. Literally. 🕵️',
  'The only ticket left is the one to the coffee machine. 🎫',
  'Blocked by: absolutely nothing. A personal first. 🚧',
  'You didn’t clear the board. You ghosted it. 👻',
  'Retrospective item: “No tickets.” Action item: don’t ruin it. 📌',
  'Scope: zero. Creep: also zero. A healthy relationship. 💔',
  'The sprint asked for a status. You sent a postcard. ✉️',
]

/** rx/ry are fractions of the distance from the section center to its edge. */
const ORBITS: { emoji: string; rx: number; ry: number; dur: number; phase: number; spin: 1 | -1 }[] = [
  { emoji: '🎫', rx: 0.34, ry: 0.3, dur: 70, phase: 0.02, spin: 1 },
  { emoji: '✅', rx: 0.52, ry: 0.48, dur: 100, phase: 0.08, spin: -1 },
  { emoji: '🚀', rx: 0.52, ry: 0.48, dur: 100, phase: 0.58, spin: -1 },
  { emoji: '🍃', rx: 0.7, ry: 0.66, dur: 140, phase: 0.2, spin: 1 },
  { emoji: '✨', rx: 0.7, ry: 0.66, dur: 140, phase: 0.68, spin: 1 },
  { emoji: '☕', rx: 0.88, ry: 0.82, dur: 190, phase: 0.12, spin: -1 },
  { emoji: '🏆', rx: 0.88, ry: 0.82, dur: 190, phase: 0.48, spin: -1 },
  { emoji: '👀', rx: 0.88, ry: 0.82, dur: 190, phase: 0.82, spin: -1 },
]

export function FunEmptyBoard({
  served,
  refreshing,
  onRefresh,
  archivedCount = 0,
  archivedKeys = [],
  onUndo,
}: {
  served: boolean
  refreshing: boolean
  onRefresh: () => void
  archivedCount?: number
  archivedKeys?: string[]
  onUndo?: () => void
}) {
  const [i, setI] = useState(() => Math.floor(Math.random() * QUIPS.length))
  const stageRef = useRef<HTMLDivElement>(null)
  const glyphRefs = useRef<(HTMLSpanElement | null)[]>([])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const started = performance.now()
    let raf = 0
    const place = (now: number) => {
      const { width, height } = stage.getBoundingClientRect()
      const t = (now - started) / 1000
      ORBITS.forEach((o, n) => {
        const el = glyphRefs.current[n]
        if (!el) return
        const turns = reduce ? o.phase : o.phase + (o.spin * t) / o.dur
        const a = turns * Math.PI * 2
        const x = Math.cos(a) * o.rx * (width / 2)
        const y = Math.sin(a) * o.ry * (height / 2)
        el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`
      })
      if (!reduce) raf = requestAnimationFrame(place)
    }
    place(started)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      timer = setTimeout(() => {
        setI((p) => (p + 1) % QUIPS.length)
        arm()
      }, 10_000 + Math.random() * 5_000)
    }
    arm()
    return () => clearTimeout(timer)
  }, [])

  return (
    <motion.div
      ref={stageRef}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="jb-empty-stage relative flex h-[calc(100dvh-11.5rem)] flex-col overflow-hidden rounded-2xl border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)]"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {ORBITS.map((o, n) => (
          <span
            key={o.emoji + o.phase}
            ref={(el) => {
              glyphRefs.current[n] = el
            }}
            className="jb-orbit-emoji select-none text-[26px] opacity-40"
          >
            {o.emoji}
          </span>
        ))}
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center px-6">
      <div className="max-w-lg text-center">
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
      </div>

      {archivedCount > 0 && onUndo && (
        <div className="relative z-10 flex justify-end px-4 pb-4">
          <button
            onClick={onUndo}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-1 text-[11.5px] text-[var(--muted)] hover:text-[var(--ink)]"
            title={`You moved ${archivedKeys.join(', ')} to Completed — undo to bring ${archivedCount === 1 ? 'it' : 'them'} back onto the board`}
          >
            <EyeOffIcon size={13} /> {archivedCount} moved to Completed · Undo
          </button>
        </div>
      )}
    </motion.div>
  )
}
