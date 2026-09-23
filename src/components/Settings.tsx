import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AI_LEVELS, FEATURES, type FeatureKey, type Settings } from '../lib/settings'
import { getAiModels, pullAiModel, guideUrl, type AiCatalogModel, type AiInternStatus } from '../lib/runner'
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

export function SettingsPanel({
  open,
  settings,
  onChange,
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
            className="flex max-h-[calc(100dvh-24px)] w-full max-w-[960px] flex-col overflow-visible rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            initial={{ y: 20, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-2.5">
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

            <div className="grid min-h-0 grid-cols-1 gap-x-6 gap-y-3 px-4 py-3 md:grid-cols-2">
              <div className="flex flex-col gap-3">
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
                </Section>
              </div>

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
                {aiLevelSynced && (
                  <AiInternControls settings={settings} onChange={onChange} aiStatus={aiStatus} />
                )}
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
    <section className="min-w-0">
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
  const { color, icon } = FEATURE_STYLE[feature.key]
  const tint = on ? color : 'var(--muted)'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${feature.label}, ${on ? 'on' : 'off'}. ${feature.hint}`}
      onClick={() => onToggle(!on)}
      className="flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-all"
      style={{
        borderColor: on ? hexToRgba(color, 0.5) : 'var(--line)',
        background: on ? hexToRgba(color, 0.1) : 'var(--surface-2)',
        opacity: on ? 1 : 0.6,
      }}
    >
      <span
        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md"
        style={{ background: hexToRgba(on ? color : '#94a3b8', 0.16), filter: on ? undefined : 'grayscale(1)' }}
      >
        {icon(tint)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] font-bold leading-tight" style={{ color: on ? color : 'var(--muted)' }}>
            {feature.label}
          </span>
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: on ? color : 'transparent', border: on ? 'none' : '1.5px solid var(--muted)' }}
          />
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug" style={{ color: on ? 'var(--ink-soft)' : 'var(--muted)' }}>
          {feature.hint}
        </span>
      </span>
    </button>
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
  if (ai.state === 'pulling') return `Downloading ${ai.pulling || ai.current?.model || 'model'}…`
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
}: {
  settings: Settings
  onChange: (next: Settings) => void
  aiStatus?: AiInternStatus | null
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

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })

  return (
    <div className="mt-2 flex flex-col gap-2">
      <p
        className="truncate rounded-lg border px-2.5 py-1 text-[11px] leading-snug"
        title={internLine(aiStatus)}
        style={{
          borderColor: aiStatus?.down ? 'rgba(220,38,38,0.45)' : hexToRgba(AI, 0.35),
          color: aiStatus?.down ? '#dc2626' : 'var(--ink-soft)',
          background: aiStatus?.down ? 'rgba(220,38,38,0.08)' : hexToRgba(AI, 0.06),
        }}
      >
        {internLine(aiStatus)}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Choice
          active={settings.aiBackend === 'local'}
          label="Local AI"
          hint="Ollama in Docker (CPU) or on this Mac (Metal). Slow, no tokens."
          onClick={() => set('aiBackend', 'local')}
        />
        <Choice
          active={settings.aiBackend === 'cloud'}
          label="Cloud AI"
          hint="OpenAI / Anthropic / compatible API. Faster; burns tokens."
          onClick={() => set('aiBackend', 'cloud')}
        />
        {settings.aiBackend === 'local' && (
          <label
            className="flex items-center gap-1.5 text-[12px] text-[var(--ink-soft)]"
            title="Talk to Ollama.app on this Mac (Metal) instead of the Linux Docker VM"
          >
            <input
              type="checkbox"
              checked={settings.aiUseHostOllama}
              onChange={(e) => set('aiUseHostOllama', e.target.checked)}
            />
            Host Ollama
          </label>
        )}
      </div>

      {settings.aiBackend === 'cloud' ? (
        <p className="text-[11px] leading-snug text-[var(--muted)]">
          <code className="font-mono">models.report</code> in <code className="font-mono">~/.ai/config.json</code> plus
          API keys in <code className="font-mono">~/.cursor/mcp-secrets.env</code>.
        </p>
      ) : (
        <LocalModelPicker
          catalog={catalog}
          installed={installed}
          pulling={pulling}
          settings={settings}
          onSelect={(id) => set('aiLocalModel', id)}
          onDownload={async (m) => {
            setPulling(m.id)
            const ok = await pullAiModel(m.pull, settings.aiUseHostOllama || m.fits === 'host')
            if (!ok) setPulling(null)
          }}
        />
      )}
    </div>
  )
}

function LocalModelPicker({
  catalog,
  installed,
  pulling,
  settings,
  onSelect,
  onDownload,
}: {
  catalog: AiCatalogModel[]
  installed: string[]
  pulling: string | null
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
      {selected?.why && (
        <p className="truncate text-[11px] leading-snug text-[var(--muted)]" title={selected.why}>
          {selected.why}
        </p>
      )}
    </div>
  )
}
