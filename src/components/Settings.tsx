import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AI_LEVELS, FEATURES, type FeatureKey, type Settings, type ThemeMode } from '../lib/settings'
import { hexToRgba } from '../lib/format'
import { CalendarIcon, DocIcon, MoonIcon, RefreshIcon, SearchIcon, SparkleIcon, SunIcon, TrophyIcon } from './Icons'

const AI = '#a855f7'

const THEME_MODES: { key: ThemeMode; label: string; hint: string }[] = [
  { key: 'auto', label: 'Auto', hint: 'Follow the system appearance' },
  { key: 'fixed', label: 'All the time', hint: 'Stay on one theme' },
  { key: 'schedule', label: 'Time based', hint: 'Light by day, dark at night' },
]

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

export function SettingsPanel({
  open,
  settings,
  onChange,
  onClose,
  aiLevelSynced,
}: {
  open: boolean
  settings: Settings
  onChange: (next: Settings) => void
  onClose: () => void
  /** false when the AI level is local-only because there is no server to tell. */
  aiLevelSynced: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })
  const setFeature = (key: keyof Settings['features'], value: boolean) =>
    onChange({ ...settings, features: { ...settings.features, [key]: value } })

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm md:p-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          role="dialog"
          aria-modal
          aria-label="Board settings"
        >
          <motion.section
            className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 20, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3.5">
              <h2 className="flex-1 text-[15px] font-extrabold text-[var(--ink)]">Settings</h2>
              <button
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
                aria-label="Close settings"
              >
                ✕
              </button>
            </header>

            <div className="flex flex-col gap-5 px-5 py-4">
              <Section title="Appearance">
                <div className="flex flex-wrap gap-1.5">
                  {THEME_MODES.map((m) => (
                    <Choice key={m.key} active={settings.themeMode === m.key} label={m.label} hint={m.hint} onClick={() => set('themeMode', m.key)} />
                  ))}
                </div>

                {settings.themeMode === 'fixed' && (
                  <div className="mt-2.5 flex gap-1.5">
                    <Choice
                      active={settings.theme === 'light'}
                      label="Light"
                      icon={<SunIcon size={13} />}
                      onClick={() => set('theme', 'light')}
                    />
                    <Choice active={settings.theme === 'dark'} label="Dark" icon={<MoonIcon size={13} />} onClick={() => set('theme', 'dark')} />
                  </div>
                )}

                {settings.themeMode === 'schedule' && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px] text-[var(--ink-soft)]">
                    <SunIcon size={13} />
                    <span>Light from</span>
                    <HourSelect value={settings.dayStart} onChange={(v) => set('dayStart', v)} />
                    <span>to</span>
                    <HourSelect value={settings.dayEnd} onChange={(v) => set('dayEnd', v)} />
                    <span className="text-[var(--muted)]">· dark outside those hours</span>
                  </div>
                )}
              </Section>

              <Section title="Features">
                <div className="grid grid-cols-2 gap-2">
                  {FEATURES.map((f) => (
                    <FeatureCard
                      key={f.key}
                      feature={f}
                      on={settings.features[f.key]}
                      onToggle={(v) => setFeature(f.key, v)}
                    />
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-[var(--muted)]">Hover a card for what it does. Click to turn it on or off.</p>
              </Section>

              <Section title="AI usage">
                <div className="flex flex-col gap-1.5">
                  {AI_LEVELS.map((l) => (
                    <AiChoice key={l.key} level={l} active={settings.aiLevel === l.key} onClick={() => set('aiLevel', l.key)} />
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-[var(--muted)]">
                  {aiLevelSynced
                    ? 'Applies to PR Readiness Report generation on the next run.'
                    : 'Saved on this device only — without the local server the fetch scripts cannot be told, so they keep their configured level.'}
                </p>
              </Section>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-[var(--muted)]">{title}</h3>
      {children}
    </section>
  )
}

function Choice({
  active,
  label,
  hint,
  icon,
  onClick,
}: {
  active: boolean
  label: string
  hint?: string
  icon?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-pressed={active}
      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors"
      style={{
        borderColor: active ? hexToRgba(AI, 0.55) : 'var(--line)',
        background: active ? hexToRgba(AI, 0.12) : 'transparent',
        color: active ? AI : 'var(--ink-soft)',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function AiChoice({ level, active, onClick }: { level: (typeof AI_LEVELS)[number]; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors"
      style={{
        borderColor: active ? hexToRgba(AI, 0.55) : 'var(--line)',
        background: active ? hexToRgba(AI, 0.1) : 'transparent',
      }}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border" style={{ borderColor: active ? AI : 'var(--line)' }}>
        {active && <span className="h-2.5 w-2.5 rounded-full" style={{ background: AI }} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] font-bold" style={{ color: active ? AI : 'var(--ink)' }}>
          {level.key !== 'none' && <SparkleIcon size={11} color={active ? AI : 'currentColor'} />}
          {level.label}
        </span>
        <span className="block text-[11px] text-[var(--muted)]">{level.hint}</span>
      </span>
    </button>
  )
}

/** Each feature carries its own accent so an enabled board reads as a set of live controls
 *  rather than six identical purple boxes. Off = no accent at all, deliberately inert. */
const FEATURE_STYLE: Record<FeatureKey, { color: string; icon: (c: string) => React.ReactNode }> = {
  prReports: { color: '#a855f7', icon: (c) => <DocIcon size={15} color={c} /> },
  nextSprint: { color: '#2684ff', icon: (c) => <CalendarIcon size={15} color={c} /> },
  completedArchive: { color: '#b45309', icon: () => <TrophyIcon size={15} /> },
  animations: { color: '#ec4899', icon: (c) => <SparkleIcon size={15} color={c} /> },
  shortcuts: { color: '#14b8a6', icon: (c) => <SearchIcon size={15} color={c} /> },
  autoRefresh: { color: '#10b981', icon: (c) => <RefreshIcon size={15} color={c} /> },
}

function FeatureCard({
  feature,
  on,
  onToggle,
}: {
  feature: (typeof FEATURES)[number]
  on: boolean
  onToggle: (v: boolean) => void
}) {
  const [hover, setHover] = useState(false)
  const { color, icon } = FEATURE_STYLE[feature.key]
  const tint = on ? color : 'var(--muted)'

  return (
    <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={feature.label}
        onClick={() => onToggle(!on)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className="flex w-full flex-col gap-1.5 rounded-xl border p-2.5 text-left transition-all"
        style={{
          borderColor: on ? hexToRgba(color, 0.5) : 'var(--line)',
          background: on ? hexToRgba(color, 0.1) : 'var(--surface-2)',
          opacity: on ? 1 : 0.6,
        }}
      >
        <span className="flex items-center gap-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg" style={{ background: hexToRgba(on ? color : '#94a3b8', 0.16), filter: on ? undefined : 'grayscale(1)' }}>
            {icon(tint)}
          </span>
          <span className="min-w-0 flex-1 text-[12px] font-bold leading-tight" style={{ color: on ? color : 'var(--muted)' }}>
            {feature.label}
          </span>
          {/* Status dot doubles as the on/off affordance — the whole card is the switch. */}
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: on ? color : 'transparent', border: on ? 'none' : '1.5px solid var(--muted)' }}
          />
        </span>
        <span className="text-[10.5px] leading-snug" style={{ color: on ? 'var(--ink-soft)' : 'var(--muted)' }}>
          {feature.hint}
        </span>
        <span className="text-[9.5px] font-bold uppercase tracking-wider" style={{ color: on ? hexToRgba(color, 0.9) : 'var(--muted)' }}>
          {on ? 'On' : 'Off'}
        </span>
      </button>

      <AnimatePresence>
        {hover && (
          <motion.span
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.14 }}
            role="tooltip"
            className="pointer-events-none absolute bottom-[calc(100%+6px)] left-0 z-20 block w-[250px] rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed shadow-xl"
            style={{ borderColor: hexToRgba(color, 0.45), background: 'var(--surface-solid)', color: 'var(--ink-soft)' }}
          >
            <span className="mb-0.5 block text-[11px] font-bold" style={{ color }}>
              {feature.label}
            </span>
            {feature.detail}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )
}

function HourSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg border border-[var(--line)] bg-[var(--bg)] px-1.5 py-1 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
    >
      {HOURS.map((h) => (
        <option key={h} value={h}>
          {hourLabel(h)}
        </option>
      ))}
    </select>
  )
}
