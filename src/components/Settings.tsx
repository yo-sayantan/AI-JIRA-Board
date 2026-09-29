import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { AI_LEVELS, FEATURES, LIMITS, clampSetting, type FeatureKey, type Settings } from '../lib/settings'
import { getAiModels, getCloudModels, pullAiModel, guideUrl, type AiCatalogModel, type AiInternStatus, type AiPullProgress, type CloudModelChoice } from '../lib/runner'
import fallbackCatalog from '../../ai-intern/models.json'
import { hexToRgba } from '../lib/format'
import { CalendarIcon, DocIcon, DownloadIcon, MoonIcon, QuestionIcon, RefreshIcon, SearchIcon, SparkleIcon, SunIcon, TrophyIcon } from './Icons'

const AI = '#a855f7'

type AppearanceKey = 'auto' | 'light' | 'dark' | 'schedule'

const APPEARANCE: { key: AppearanceKey; label: string; hint: string }[] = [
  { key: 'auto', label: 'Auto', hint: 'Follow the system appearance' },
  { key: 'light', label: 'Light', hint: 'Stay light all the time' },
  { key: 'dark', label: 'Dark', hint: 'Stay dark all the time' },
  { key: 'schedule', label: 'Time based', hint: 'Light by day, dark at night' },
]

function appearanceKey(s: Settings): AppearanceKey {
  if (s.themeMode === 'auto') return 'auto'
  if (s.themeMode === 'schedule') return 'schedule'
  return s.theme
}

function withAppearance(s: Settings, key: AppearanceKey): Settings {
  if (key === 'auto') return { ...s, themeMode: 'auto' }
  if (key === 'schedule') return { ...s, themeMode: 'schedule' }
  return { ...s, themeMode: 'fixed', theme: key }
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

function Section({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 ${className}`}>
      <h3 className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-[var(--muted)]">{title}</h3>
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

function AiLevelCard({
  level,
  active,
  alignEnd,
  dropUp,
  onClick,
}: {
  level: (typeof AI_LEVELS)[number]
  active: boolean
  alignEnd?: boolean
  dropUp?: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        onClick={onClick}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-pressed={active}
        aria-describedby={hover ? `ai-level-${level.key}-tip` : undefined}
        className="flex w-full flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors"
        style={{
          borderColor: active ? hexToRgba(AI, 0.55) : 'var(--line)',
          background: active ? hexToRgba(AI, 0.12) : 'var(--surface-2)',
        }}
      >
        <span className="flex items-center gap-1.5 text-[12px] font-bold" style={{ color: active ? AI : 'var(--ink)' }}>
          {level.key !== 'none' && <SparkleIcon size={12} color={active ? AI : 'currentColor'} />}
          {level.label}
        </span>
        <span className="text-[10.5px] leading-snug text-[var(--muted)]">{level.hint}</span>
      </button>
      <AnimatePresence>
        {hover && (
          <motion.div
            id={`ai-level-${level.key}-tip`}
            role="tooltip"
            initial={{ opacity: 0, y: dropUp ? -4 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: dropUp ? -4 : 4 }}
            transition={{ duration: 0.14 }}
            className={`pointer-events-none absolute z-30 w-[220px] rounded-lg border px-2.5 py-2 text-[11px] leading-snug shadow-xl ${alignEnd ? 'right-0' : 'left-0'} ${dropUp ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'}`}
            style={{ borderColor: hexToRgba(AI, 0.4), background: 'var(--surface-solid)', color: 'var(--ink-soft)' }}
          >
            <p className="mb-1.5 text-[11px] font-bold" style={{ color: AI }}>
              {level.label}
            </p>
            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-[#16a34a]">Pros</p>
            <ul className="mb-1.5 list-disc pl-3.5">
              {level.plus.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-[#dc2626]">Cons</p>
            <ul className="list-disc pl-3.5">
              {level.cons.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function SettingsPanel({
  open,
  settings: saved,
  onChange: commit,
  onClose,
  aiLevelSynced,
  aiStatus,
}: {
  open: boolean
  settings: Settings
  onChange: (next: Settings) => void
  onClose: () => void
  /** false when the AI level is local-only because there is no server to tell. */
  aiLevelSynced: boolean
  aiStatus?: AiInternStatus | null
}) {
  const [draft, setDraft] = useState(saved)
  const wasOpen = useRef(false)
  const panelRef = useRef<HTMLElement>(null)
  const [pricesOpen, setPricesOpen] = useState(false)
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(saved)
    wasOpen.current = open
  }, [open, saved])

  const settings = draft
  const onChange = setDraft

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
  const save = () => {
    commit(draft)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-center justify-center overflow-hidden bg-black/60 p-3 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          role="dialog"
          aria-modal
          aria-label="Board settings"
        >
          <motion.section
            ref={panelRef}
            className="flex max-h-[calc(100dvh-24px)] w-full max-w-[960px] flex-col overflow-visible rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 20, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
              <h2 className="flex-1 text-[15px] font-extrabold text-[var(--ink)]">Settings</h2>
              <button
                type="button"
                onClick={save}
                className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-white"
                style={{ background: AI }}
              >
                Save
              </button>
              <button
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
                aria-label="Close settings without saving"
                title="Close without saving"
              >
                ✕
              </button>
            </header>

            <div className="grid min-h-0 grid-cols-1 gap-x-6 gap-y-3 px-4 py-3 md:grid-cols-2">
              <div className="flex min-h-0 flex-col gap-3">
                <Section title="Appearance">
                  <div className="flex flex-wrap gap-1.5">
                    {APPEARANCE.map((m) => (
                      <Choice
                        key={m.key}
                        active={appearanceKey(settings) === m.key}
                        label={m.label}
                        hint={m.hint}
                        icon={m.key === 'light' ? <SunIcon size={13} /> : m.key === 'dark' ? <MoonIcon size={13} /> : undefined}
                        onClick={() => onChange(withAppearance(settings, m.key))}
                      />
                    ))}
                  </div>
                  {/* Fixed slot so Light / Time based never shove Features down. */}
                  <div className="relative mt-1.5 h-8">
                    <div
                      className={`absolute inset-0 flex items-center gap-2 text-[12px] text-[var(--ink-soft)] ${settings.themeMode === 'schedule' ? '' : 'invisible'}`}
                      aria-hidden={settings.themeMode !== 'schedule'}
                    >
                      <span>Light from</span>
                      <HourSelect value={settings.dayStart} onChange={(v) => set('dayStart', v)} disabled={settings.themeMode !== 'schedule'} />
                      <span>to</span>
                      <HourSelect value={settings.dayEnd} onChange={(v) => set('dayEnd', v)} disabled={settings.themeMode !== 'schedule'} />
                      <span className="text-[var(--muted)]">· dark outside those hours</span>
                    </div>
                    <p
                      className={`absolute inset-0 flex items-center text-[12px] text-[var(--muted)] ${settings.themeMode === 'schedule' ? 'invisible' : ''}`}
                    >
                      {APPEARANCE.find((m) => m.key === appearanceKey(settings))?.hint}
                    </p>
                  </div>
                </Section>

                <Section title="Features" className="flex min-h-0 flex-1 flex-col">
                  <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-2 gap-2">
                    {FEATURES.map((f) => (
                      <FeatureCard
                        key={f.key}
                        feature={f}
                        on={settings.features[f.key]}
                        onToggle={(v) => setFeature(f.key, v)}
                      />
                    ))}
                  </div>
                </Section>
              </div>

              <div className="flex min-h-0 flex-col gap-3">
                <Section title="AI usage">
                  <div className="grid grid-cols-2 gap-1.5">
                    {AI_LEVELS.map((l, i) => (
                      <AiLevelCard
                        key={l.key}
                        level={l}
                        active={settings.aiLevel === l.key}
                        alignEnd={i % 2 === 1}
                        dropUp={i >= 2}
                        onClick={() => set('aiLevel', l.key)}
                      />
                    ))}
                  </div>
                  <p className="mt-1.5 truncate text-[11px] text-[var(--muted)]" title={aiLevelSynced
                      ? 'Applies to the next Regenerate / bulk / auto report. None writes the deterministic base only.'
                      : 'Saved on this device only — without the local server the intern cannot be told, so it keeps its last saved level.'}>
                    {aiLevelSynced
                      ? 'Next Regenerate / bulk / auto. Hover a card for pros and cons.'
                      : 'Saved on this device only — intern is not reachable, so it keeps its last level.'}
                  </p>
                </Section>

                <Section title="AI intern">
                  {aiLevelSynced ? (
                    <AiInternControls settings={settings} onChange={onChange} aiStatus={aiStatus} pricesOpen={pricesOpen} onTogglePrices={() => setPricesOpen((v) => !v)} panelRef={panelRef} />
                  ) : (
                    <p className="h-8 text-[11px] leading-snug text-[var(--muted)]">
                      Local / Cloud and the model picker need JIRA-AI-Intern running.
                    </p>
                  )}
                </Section>

                <Section title="Jobs & notifications">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <NumberField
                      label="Parallel reports"
                      hint="AI reports built at once when regenerating"
                      unit="at once"
                      limit="reportParallel"
                      value={settings.reportParallel}
                      onChange={(v) => set('reportParallel', v)}
                    />
                    <NumberField
                      label="Parallel archive fetches"
                      hint="Tickets fetched at once when rebuilding the archive"
                      unit="at once"
                      limit="archiveParallel"
                      value={settings.archiveParallel}
                      onChange={(v) => set('archiveParallel', v)}
                    />
                    <NumberField
                      label="Notification time"
                      hint="Seconds a notification stays before it closes itself"
                      unit="sec"
                      limit="toastSeconds"
                      value={settings.toastSeconds}
                      onChange={(v) => set('toastSeconds', v)}
                    />
                    <NumberField
                      label="Notifications on screen"
                      hint="When more arrive, the oldest close first"
                      unit="max"
                      limit="toastMax"
                      value={settings.toastMax}
                      onChange={(v) => set('toastMax', v)}
                    />
                  </div>
                  {!aiLevelSynced && (
                    <p className="mt-1.5 text-[11px] text-[var(--muted)]">Parallel settings reach the intern only when the local server is running.</p>
                  )}
                </Section>
              </div>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Each feature carries its own accent so an enabled board reads as a set of live controls
 *  rather than six identical purple boxes. Off = no accent at all, deliberately inert. */
const FEATURE_STYLE: Record<FeatureKey, { color: string; icon: (c: string) => React.ReactNode }> = {
  prReports: { color: '#a855f7', icon: (c) => <DocIcon size={13} color={c} /> },
  nextSprint: { color: '#2684ff', icon: (c) => <CalendarIcon size={13} color={c} /> },
  completedArchive: { color: '#b45309', icon: () => <TrophyIcon size={13} /> },
  animations: { color: '#ec4899', icon: (c) => <SparkleIcon size={13} color={c} /> },
  shortcuts: { color: '#14b8a6', icon: (c) => <SearchIcon size={13} color={c} /> },
  autoRefresh: { color: '#10b981', icon: (c) => <RefreshIcon size={13} color={c} /> },
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
  const { color, icon } = FEATURE_STYLE[feature.key]
  const tint = on ? color : 'var(--muted)'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${feature.label}, ${on ? 'on' : 'off'}. ${feature.hint}`}
      onClick={() => onToggle(!on)}
      className="flex h-full min-h-0 w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-all"
      style={{
        borderColor: on ? hexToRgba(color, 0.5) : 'var(--line)',
        background: on ? hexToRgba(color, 0.1) : 'var(--surface-2)',
        opacity: on ? 1 : 0.6,
      }}
    >
      <span
        className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-md"
        style={{ background: hexToRgba(on ? color : '#94a3b8', 0.16), filter: on ? undefined : 'grayscale(1)' }}
      >
        {icon(tint)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] font-bold leading-tight" style={{ color: on ? color : 'var(--muted)' }}>
            {feature.label}
          </span>
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: on ? color : 'transparent', border: on ? 'none' : '1.5px solid var(--muted)' }}
          />
        </span>
        <span className="mt-0.5 block text-[10px] leading-snug" style={{ color: on ? 'var(--ink-soft)' : 'var(--muted)' }}>
          {feature.hint}
        </span>
      </span>
    </button>
  )
}

function NumberField({
  label,
  hint,
  unit,
  limit,
  value,
  onChange,
}: {
  label: string
  hint: string
  unit: string
  limit: keyof typeof LIMITS
  value: number
  onChange: (v: number) => void
}) {
  const { min, max } = LIMITS[limit]
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (raw: string) => {
    const v = clampSetting(limit, raw, value)
    setText(String(v))
    if (v !== value) onChange(v)
  }
  return (
    <label className="flex min-w-0 flex-col gap-1" title={`${hint} (${min}–${max})`}>
      <span className="truncate text-[11px] font-semibold text-[var(--ink-soft)]">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            const n = Number(e.target.value)
            if (e.target.value !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n)
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
          }}
          className="h-8 w-16 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[12px] tabular-nums text-[var(--ink)] outline-none focus:border-[var(--muted)]"
          aria-label={`${label}, ${min} to ${max}`}
        />
        <span className="truncate text-[10.5px] text-[var(--muted)]">
          {unit} · {min}–{max}
        </span>
      </span>
    </label>
  )
}

function HourSelect({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-8 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-1.5 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--muted)] disabled:opacity-60"
    >
      {HOURS.map((h) => (
        <option key={h} value={h}>
          {hourLabel(h)}
        </option>
      ))}
    </select>
  )
}

function internLine(ai: AiInternStatus | null | undefined): string {
  if (!ai || ai.down) return 'AI intern is down — reports stay deterministic until JIRA-AI-Intern is running'
  if (ai.state === 'pulling') {
    const name = ai.pulling || ai.current?.model || 'model'
    const pct = ai.pullProgress?.percent
    return typeof pct === 'number' && pct > 0
      ? `Downloading ${name} · ${pct}%`
      : `Downloading ${name}…`
  }
  if (ai.state === 'working' && ai.current?.type === 'enrich-report') return `Enriching ${ai.current.key}`
  if (ai.state === 'working' && ai.current?.type === 'summarize-active') return 'Writing ticket briefs…'
  if (ai.state === 'working') return `Working · ${ai.current?.type || 'job'}`
  if (ai.lastError) return `Last error: ${ai.lastError}`
  const installed = ai.installedModels || []
  if ((ai.backend || 'local') === 'local' && installed.length === 0) return 'No model downloaded — choose one and download it'
  return `Idle · ${ai.backend || 'local'} · ${ai.model || '—'}`
}

function modelInstalled(installed: string[], id: string): boolean {
  return installed.some((n) => n === id || n.startsWith(`${id}`))
}

function AiInternControls({
  settings,
  onChange,
  aiStatus,
  pricesOpen,
  onTogglePrices,
  panelRef,
}: {
  settings: Settings
  onChange: (next: Settings) => void
  aiStatus?: AiInternStatus | null
  pricesOpen: boolean
  onTogglePrices: () => void
  panelRef: RefObject<HTMLElement | null>
}) {
  const fallback = (fallbackCatalog.models ?? []) as AiCatalogModel[]
  const [catalog, setCatalog] = useState<AiCatalogModel[]>(aiStatus?.catalog?.models?.length ? aiStatus.catalog.models : fallback)
  const [installed, setInstalled] = useState<string[]>(aiStatus?.installedModels ?? [])
  const [pulling, setPulling] = useState<string | null>(aiStatus?.pulling ?? null)

  useEffect(() => {
    let cancelled = false
    void getAiModels().then((m) => {
      if (cancelled || !m) return
      if (m.catalog?.models?.length) setCatalog(m.catalog.models)
      else setCatalog(fallback)
      if (m.installed) setInstalled(m.installed)
    })
    return () => {
      cancelled = true
    }
  }, [aiStatus?.state, aiStatus?.installedModels?.length])

  useEffect(() => {
    if (aiStatus?.installedModels) setInstalled(aiStatus.installedModels)
    if (aiStatus?.catalog?.models?.length) setCatalog(aiStatus.catalog.models)
    setPulling(aiStatus?.pulling ?? (aiStatus?.state === 'pulling' ? aiStatus.current?.model ?? null : null))
  }, [aiStatus])

  useEffect(() => {
    if (aiStatus?.lastError) console.error('[jira-ai]', aiStatus.lastError)
  }, [aiStatus?.lastError])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })

  return (
    <div className="flex flex-col gap-2">
      <p
        className="h-8 truncate rounded-lg border px-2.5 py-1 text-[11px] leading-6"
        title={internLine(aiStatus)}
        style={{
          borderColor: aiStatus?.down ? 'rgba(220,38,38,0.45)' : hexToRgba(AI, 0.35),
          color: aiStatus?.down ? '#dc2626' : 'var(--ink-soft)',
          background: aiStatus?.down ? 'rgba(220,38,38,0.08)' : hexToRgba(AI, 0.06),
        }}
      >
        {internLine(aiStatus)}
      </p>

      <div className="flex h-8 flex-wrap items-center gap-x-3">
        <Choice
          active={settings.aiBackend === 'local'}
          label="Local AI"
          hint="Ollama in Docker (CPU) or on this Mac (Metal). Slow, no tokens."
          onClick={() => set('aiBackend', 'local')}
        />
        <Choice
          active={settings.aiBackend === 'cloud'}
          label="Cloud AI"
          hint="Claude, Cursor, or Gemini. Keys stay in ~/.cursor/mcp-secrets.env."
          onClick={() => set('aiBackend', 'cloud')}
        />
        <label
          className={`flex items-center gap-1.5 text-[12px] text-[var(--ink-soft)] ${settings.aiBackend === 'local' ? '' : 'invisible'}`}
          title="Talk to Ollama.app on this Mac (Metal) instead of the Linux Docker VM"
          aria-hidden={settings.aiBackend !== 'local'}
        >
          <input
            type="checkbox"
            checked={settings.aiUseHostOllama}
            onChange={(e) => set('aiUseHostOllama', e.target.checked)}
            disabled={settings.aiBackend !== 'local'}
            tabIndex={settings.aiBackend === 'local' ? 0 : -1}
          />
          Host Ollama
        </label>
      </div>

      <div className="min-h-[9.75rem]">
        {settings.aiBackend === 'cloud' ? (
          <CloudModelPicker settings={settings} onChange={onChange} pricesOpen={pricesOpen} onTogglePrices={onTogglePrices} panelRef={panelRef} />
        ) : (
          <LocalModelPicker
            catalog={catalog}
            installed={installed}
            pulling={pulling}
            pullProgress={aiStatus?.state === 'pulling' ? aiStatus.pullProgress ?? null : null}
            settings={settings}
            onSelect={(id) => set('aiLocalModel', id)}
          onDownload={async (m) => {
            setPulling(m.id)
            const ok = await pullAiModel(m.pull, settings.aiUseHostOllama || m.fits === 'host')
            if (!ok) {
              console.error('[jira-ai] pull enqueue failed', m.pull)
              setPulling(null)
            }
          }}
          />
        )}
      </div>
    </div>
  )
}

const CLOUD_EFFORTS: { id: Settings['aiCloudEffort']; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
]

/** Standard (non-fast) list rates, USD per 1M tokens. Medium bills at these rates.
 *  Source: cursor.com/docs/models-and-pricing. Only models at or under $10 output. */
const CURSOR_RATES: Record<string, { input: string; cache: string; output: string }> = {
  'gpt-5.6-luna': { input: '$0.20', cache: '$0.02', output: '$1.20' },
  'composer-2.5': { input: '$0.50', cache: '$0.20', output: '$2.50' },
  'gemini-3-flash': { input: '$0.50', cache: '$0.05', output: '$3' },
  'kimi-k2.7-code': { input: '$0.95', cache: '$0.19', output: '$4' },
  'glm-5.2': { input: '$1.40', cache: '$0.26', output: '$4.40' },
  'grok-4.7': { input: '$2', cache: '$0.50', output: '$6' },
  'grok-4.6': { input: '$2', cache: '$0.50', output: '$6' },
  'gemini-3.6-flash': { input: '$1.50', cache: '$0.15', output: '$7.50' },
  'claude-sonnet-5': { input: '$2', cache: '$0.20', output: '$10' },
}

function CursorPriceCard({
  anchor,
  models,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>
  models: CloudModelChoice[]
  onClose: () => void
}) {
  const [box, setBox] = useState<{ top: number; left: number; maxH: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const el = anchor.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const width = Math.min(400, window.innerWidth - 16)
      const gap = 12
      const fitsRight = window.innerWidth - r.right - gap >= width
      const left = fitsRight ? r.right + gap : Math.max(8, r.left - gap - width)
      const top = Math.max(8, r.top)
      setBox({ top, left, maxH: Math.max(160, window.innerHeight - top - 8) })
    }
    place()
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [anchor, models])
  if (!box) return null
  return createPortal(
    <div
      className="fixed z-[120] w-[min(92vw,400px)] overflow-auto rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] p-2.5 shadow-2xl"
      style={{ top: box.top, left: box.left, maxHeight: box.maxH }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-[var(--ink)]">Estimate · medium · standard speed</span>
        <button type="button" onClick={onClose} className="text-[12px] text-[var(--muted)] hover:text-[var(--ink)]" aria-label="Close prices">
          ×
        </button>
      </div>
      <table className="w-full border-collapse text-[10.5px]">
        <thead>
          <tr className="text-left text-[var(--muted)]">
            <th className="pb-1 pr-2 font-semibold">Model</th>
            <th className="pb-1 pr-2 font-semibold">Input</th>
            <th className="pb-1 pr-2 font-semibold">Cache read</th>
            <th className="pb-1 font-semibold">Output</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const rate = CURSOR_RATES[m.id]
            return (
              <tr key={m.id} className="border-t border-[var(--line)] text-[var(--ink-soft)]">
                <td className="py-1 pr-2 font-medium text-[var(--ink)]">{m.label}</td>
                <td className="py-1 pr-2 tabular-nums">{rate?.input ?? '—'}</td>
                <td className="py-1 pr-2 tabular-nums">{rate?.cache ?? '—'}</td>
                <td className="py-1 tabular-nums">{rate?.output ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-1.5 text-[10px] leading-snug text-[var(--muted)]">
        USD per 1M tokens. Low uses less tokens than Medium.
      </p>
    </div>,
    document.body,
  )
}

function CloudModelPicker({
  settings,
  onChange,
  pricesOpen,
  onTogglePrices,
  panelRef,
}: {
  settings: Settings
  onChange: (s: Settings) => void
  pricesOpen: boolean
  onTogglePrices: () => void
  panelRef: RefObject<HTMLElement | null>
}) {
  const [claude, setClaude] = useState<CloudModelChoice[]>([])
  const [cursor, setCursor] = useState<CloudModelChoice[]>([])
  const [gemini, setGemini] = useState<CloudModelChoice[]>([])
  const [claudeErr, setClaudeErr] = useState<string | null>(null)
  const [cursorErr, setCursorErr] = useState<string | null>(null)
  const [geminiErr, setGeminiErr] = useState<string | null>(null)
  const [claudeKey, setClaudeKey] = useState(false)
  const [cursorKey, setCursorKey] = useState(false)
  const [geminiKey, setGeminiKey] = useState(false)
  const [loadedFor, setLoadedFor] = useState<'claude' | 'cursor' | 'gemini' | null>(null)

  const provider: 'claude' | 'cursor' | 'gemini' =
    settings.aiCloudProvider === 'claude' || settings.aiCloudProvider === 'gemini' ? settings.aiCloudProvider : 'cursor'

  useEffect(() => {
    const which = provider
    let cancelled = false
    setLoadedFor(null)
    void getCloudModels().then((res) => {
      if (cancelled || !res) return
      setClaude(res.claude?.models ?? [])
      setCursor(res.cursor?.models ?? [])
      setGemini(res.gemini?.models ?? [])
      setClaudeErr(res.claude?.error ?? null)
      setCursorErr(res.cursor?.error ?? null)
      setGeminiErr(res.gemini?.error ?? res.error ?? null)
      setClaudeKey(!!res.claude?.configured)
      setCursorKey(!!res.cursor?.configured)
      setGeminiKey(!!res.gemini?.configured)
      setLoadedFor(which)
    })
    return () => {
      cancelled = true
    }
  }, [provider])

  const models = provider === 'cursor' ? cursor : provider === 'gemini' ? gemini : claude
  const err = provider === 'cursor' ? cursorErr : provider === 'gemini' ? geminiErr : claudeErr
  const hasKey = provider === 'cursor' ? cursorKey : provider === 'gemini' ? geminiKey : claudeKey
  const selected = models.find((m) => m.id === settings.aiCloudModel) ?? null
  const efforts = selected?.efforts ?? []

  useEffect(() => {
    if (loadedFor !== provider || !models.length) return
    if (models.some((m) => m.id === settings.aiCloudModel)) return
    const prefer =
      provider === 'cursor'
        ? models.find((m) => m.id === 'grok-4.7') || models[0]
        : provider === 'claude'
          ? models.find((m) => /haiku/i.test(m.id)) || models[0]
          : models[0]
    onChange({ ...settings, aiCloudModel: prefer.id })
  }, [loadedFor, models, provider, settings, onChange])

  const hint = !hasKey
    ? provider === 'cursor'
      ? 'CURSOR_API_KEY is read from ~/.cursor/mcp-secrets.env (Cursor Dashboard → API Keys).'
      : provider === 'gemini'
        ? 'Add GEMINI_API_KEY to ~/.cursor/mcp-secrets.env (aistudio.google.com → API keys).'
        : 'Add ANTHROPIC_API_KEY to ~/.cursor/mcp-secrets.env (console.anthropic.com → API keys).'
    : err
      ? err
      : provider === 'cursor'
        ? 'Value picks only: capable models at or under $10 output per 1M tokens, standard speed.'
        : provider === 'gemini'
          ? 'Gemini Flash models from your Google API key. Pro and Ultra are left off.'
          : 'Haiku only. Opus and Sonnet are left off this list.'

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-8 items-center gap-1.5">
        <Choice
          active={provider === 'cursor'}
          label="Cursor"
          hint="Cursor Cloud Agents API"
          onClick={() => onChange({ ...settings, aiCloudProvider: 'cursor', aiCloudModel: '' })}
        />
        <Choice
          active={provider === 'gemini'}
          label="Gemini"
          hint="Google Gemini API"
          onClick={() => onChange({ ...settings, aiCloudProvider: 'gemini', aiCloudModel: '' })}
        />
        <Choice
          active={provider === 'claude'}
          label="Claude"
          hint="Anthropic Messages API"
          onClick={() => onChange({ ...settings, aiCloudProvider: 'claude', aiCloudModel: '' })}
        />
      </div>
      <div className="relative flex items-center gap-1.5">
      <select
        value={selected?.id ?? ''}
        onChange={(e) => onChange({ ...settings, aiCloudModel: e.target.value })}
        aria-label={provider === 'cursor' ? 'Cursor model' : provider === 'gemini' ? 'Gemini model' : 'Claude model'}
        disabled={!models.length}
        className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--muted)] disabled:opacity-60"
      >
        {!models.length && (
          <option value="">{loadedFor !== provider ? 'Loading models…' : hasKey ? 'No cheaper models on this key' : 'No key yet'}</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label === m.id ? m.label : `${m.label} · ${m.id}`}
          </option>
        ))}
      </select>
      {provider === 'cursor' && (
        <button
          type="button"
          onClick={onTogglePrices}
          aria-expanded={pricesOpen}
          aria-label="Show Cursor model prices"
          title="Price estimate per model"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[12px] font-bold italic text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
        >
          i
        </button>
      )}
      {provider === 'cursor' && pricesOpen && <CursorPriceCard anchor={panelRef} models={models} onClose={onTogglePrices} />}
      </div>
      {provider === 'cursor' && efforts.length > 0 ? (
        <select
          value={efforts.includes(settings.aiCloudEffort) ? settings.aiCloudEffort : efforts[0]}
          onChange={(e) => onChange({ ...settings, aiCloudEffort: e.target.value as Settings['aiCloudEffort'] })}
          aria-label="Cursor effort"
          className="h-8 min-w-0 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
        >
          {CLOUD_EFFORTS.filter((e) => efforts.includes(e.id)).map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="h-8" />
      )}
      <p className="h-8 line-clamp-2 text-[10px] leading-4 text-[var(--muted)]" title={hint}>
        {hint}
      </p>
    </div>
  )
}

function LocalModelPicker({
  catalog,
  installed,
  pulling,
  pullProgress,
  settings,
  onSelect,
  onDownload,
}: {
  catalog: AiCatalogModel[]
  installed: string[]
  pulling: string | null
  pullProgress: AiPullProgress | null
  settings: Settings
  onSelect: (id: string) => void
  onDownload: (m: AiCatalogModel) => void
}) {
  const options =
    catalog.some((m) => m.id === settings.aiLocalModel) || !settings.aiLocalModel
      ? catalog
      : [{ id: settings.aiLocalModel, label: settings.aiLocalModel, pull: settings.aiLocalModel, params: '', ramGb: 0, level: '', fits: 'container', why: '' }, ...catalog]
  const selected = options.find((m) => m.id === settings.aiLocalModel) ?? options[0]
  const have = selected ? modelInstalled(installed, selected.id) : false
  const downloading = !!(pulling && selected && (pulling === selected.id || pulling === selected.pull))
  const pct = Math.max(0, Math.min(100, Math.round(pullProgress?.percent ?? 0)))
  const known = !!(pullProgress?.total && pullProgress.total > 0)
  const barLabel = downloading
    ? known
      ? `${pct}% · ${pullProgress?.label || ''}`
      : pullProgress?.status || pullProgress?.label || 'Starting download…'
    : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <select
          value={selected?.id ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          aria-label="Local AI model"
          className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1.5 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
        >
          {options.map((m) => {
            const ready = modelInstalled(installed, m.id)
            const host = m.fits === 'host' ? ' · host Metal' : ''
            const size = m.params ? ` · ${m.params} · ~${m.ramGb} GB` : ''
            return (
              <option key={m.id} value={m.id}>
                {m.label}
                {size}
                {host}
                {ready ? ' · ready' : ''}
              </option>
            )
          })}
        </select>
        {!have && selected && (
          <button
            type="button"
            disabled={downloading}
            onClick={() => onDownload(selected)}
            title={downloading ? `Downloading ${selected.label}…` : `Download ${selected.label}`}
            aria-label={downloading ? `Downloading ${selected.label}` : `Download ${selected.label}`}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[var(--ink-soft)] hover:border-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-60"
          >
            {downloading ? (
              <RefreshIcon size={13} color="currentColor" />
            ) : (
              <DownloadIcon size={13} />
            )}
          </button>
        )}
        <a
          href={guideUrl(settings.aiUseHostOllama ? 'ai-ollama' : 'ai-model-files')}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={
            settings.aiUseHostOllama
              ? 'Host Ollama setup — install, pull, and where models live'
              : 'Download a model file, where to place it, and how to register it'
          }
          title={
            settings.aiUseHostOllama
              ? 'Host Ollama setup — install, pull, and where models live'
              : 'Download a model file, where to place it, and how to register it'
          }
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] text-[var(--ink-soft)] hover:border-[var(--muted)] hover:text-[var(--ink)]"
        >
          <QuestionIcon size={14} />
        </a>
      </div>
      <div className="relative h-8">
        <div
          className={`absolute inset-0 flex flex-col justify-center gap-0.5 ${downloading ? '' : 'invisible'}`}
          aria-hidden={!downloading}
        >
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: hexToRgba(AI, 0.18) }}
            role={downloading ? 'progressbar' : undefined}
            aria-valuemin={downloading ? 0 : undefined}
            aria-valuemax={downloading ? 100 : undefined}
            aria-valuenow={downloading && known ? pct : undefined}
            aria-busy={downloading || undefined}
            aria-label={downloading ? barLabel || 'Downloading model' : undefined}
          >
            {downloading && known && (
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(4, pct)}%`, background: AI }}
              />
            )}
            {downloading && !known && (
              <div className="relative h-full w-full overflow-hidden">
                <div className="ai-pull-indet absolute inset-y-0 w-1/3 rounded-full" style={{ background: AI }} />
              </div>
            )}
          </div>
          <p className="truncate text-[10.5px] leading-snug text-[var(--muted)]" title={barLabel || undefined}>
            {barLabel || 'Starting download…'}
          </p>
        </div>
      </div>
      <p
        className="h-8 overflow-hidden text-[11px] leading-4 line-clamp-2 text-[var(--muted)]"
        title={selected?.why || undefined}
      >
        {selected?.why || '\u00a0'}
      </p>
    </div>
  )
}
