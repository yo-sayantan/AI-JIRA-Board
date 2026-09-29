import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AI_LEVELS, FEATURES, type AiCloudProvider, type AiMode, type FeatureKey, type Settings, type ThemeMode } from '../lib/settings'
import type { AiEnrichmentState, AiWorkerStatus } from '../lib/runner'
import { guideUrl } from '../lib/runner'
import { CLOUD_MODEL_SUGGESTIONS, LOCAL_MODELS, bareModelName, fitFor, type Fit } from '../lib/aiModels'
import { hexToRgba, relTime } from '../lib/format'
import { CalendarIcon, DocIcon, GlobeIcon, MoonIcon, PauseIcon, RefreshIcon, SearchIcon, SparkleIcon, SunIcon, TrophyIcon, WrenchIcon } from './Icons'

const AI = '#a855f7'
const LOCAL = '#14b8a6'
const AMBER = '#f59e0b'
const GREEN = '#22c55e'

const THEME_MODES: { key: ThemeMode; label: string; hint: string }[] = [
  { key: 'auto', label: 'Auto', hint: 'Follow the system appearance' },
  { key: 'fixed', label: 'All the time', hint: 'Stay on one theme' },
  { key: 'schedule', label: 'Time based', hint: 'Light by day, dark at night' },
]

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

type Setter = <K extends keyof Settings>(key: K, value: Settings[K]) => void

export function SettingsPanel({
  open,
  settings,
  onChange,
  onClose,
  aiLevelSynced,
  aiEnrichment,
}: {
  open: boolean
  settings: Settings
  onChange: (next: Settings) => void
  onClose: () => void
  /** false when the AI settings are local-only because there is no server to tell. */
  aiLevelSynced: boolean
  /** What the server knows about AI: can it run here, is the AI Intern container alive, what does it see. */
  aiEnrichment?: AiEnrichmentState | null
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

  const set: Setter = (key, value) => onChange({ ...settings, [key]: value })
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
            className="w-full max-w-[600px] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
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
                    <Choice active={settings.theme === 'light'} label="Light" icon={<SunIcon size={13} />} onClick={() => set('theme', 'light')} />
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
                    <FeatureCard key={f.key} feature={f} on={settings.features[f.key]} onToggle={(v) => setFeature(f.key, v)} />
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-[var(--muted)]">Hover a card for what it does. Click to turn it on or off.</p>
              </Section>

              <Section title="AI usage">
                <AiSection settings={settings} set={set} synced={aiLevelSynced} state={aiEnrichment ?? null} />
              </Section>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── AI usage ──────────────────────────────────────────────────────────────────

const MODES: { key: AiMode; label: string; hint: string; color: string; icon: (c: string) => React.ReactNode }[] = [
  { key: 'off', label: 'Off', hint: 'Deterministic reports only — no model, no tokens', color: '#64748b', icon: (c) => <PauseIcon size={14} color={c} /> },
  { key: 'local', label: 'Local model', hint: 'A model in the JIRA-LLM container — private, slow, free', color: LOCAL, icon: (c) => <WrenchIcon size={14} color={c} /> },
  { key: 'cloud', label: 'Cloud API', hint: 'Claude or an OpenAI-compatible API — fast, uses tokens', color: AI, icon: (c) => <GlobeIcon size={14} color={c} /> },
]

/**
 * Off / Local / Cloud, then the knobs that mode needs. The AI Intern container reports what it can
 * see (memory, runtime, models, keys) and that drives the fit badges and the readiness note — so a
 * choice that cannot work is visible here, not discovered from a report that stayed deterministic.
 */
function AiSection({ settings, set, synced, state }: { settings: Settings; set: Setter; synced: boolean; state: AiEnrichmentState | null }) {
  const worker = state?.worker ?? null
  const alive = !!state?.workerAlive
  const mode = settings.aiMode
  return (
    <>
      <div className="grid grid-cols-3 gap-1.5">
        {MODES.map((m) => {
          const on = mode === m.key
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => set('aiMode', m.key)}
              aria-pressed={on}
              className="flex flex-col gap-1 rounded-xl border p-2.5 text-left transition-all"
              style={{ borderColor: on ? hexToRgba(m.color, 0.55) : 'var(--line)', background: on ? hexToRgba(m.color, 0.1) : 'var(--surface-2)', opacity: on ? 1 : 0.75 }}
            >
              <span className="flex items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg" style={{ background: hexToRgba(on ? m.color : '#94a3b8', 0.16) }}>
                  {m.icon(on ? m.color : 'var(--muted)')}
                </span>
                <span className="text-[12px] font-bold leading-tight" style={{ color: on ? m.color : 'var(--ink-soft)' }}>
                  {m.label}
                </span>
              </span>
              <span className="text-[10.5px] leading-snug text-[var(--muted)]">{m.hint}</span>
            </button>
          )
        })}
      </div>

      {mode !== 'off' && (
        <div className="mt-3">
          <SubTitle>Effort</SubTitle>
          <div className="flex flex-col gap-1.5">
            {AI_LEVELS.filter((l) => l.key !== 'none').map((l) => (
              <AiChoice key={l.key} level={l} active={settings.aiLevel === l.key} color={mode === 'local' ? LOCAL : AI} onClick={() => set('aiLevel', l.key)} />
            ))}
          </div>
        </div>
      )}

      {mode === 'local' && <LocalModelPicker value={settings.aiLocalModel} onChange={(v) => set('aiLocalModel', v)} worker={worker} alive={alive} />}
      {mode === 'cloud' && (
        <CloudPicker
          provider={settings.aiCloudProvider}
          model={settings.aiCloudModel}
          onProvider={(p) => set('aiCloudProvider', p)}
          onModel={(m) => set('aiCloudModel', m)}
          worker={worker}
        />
      )}

      <AiAvailabilityNote synced={synced} state={state} mode={mode} localModel={settings.aiLocalModel} />
    </>
  )
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-[var(--muted)]">{children}</h4>
}

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span className="rounded-full border px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-wide" style={{ color, borderColor: hexToRgba(color, 0.45), background: hexToRgba(color, 0.1) }}>
      {children}
    </span>
  )
}

function FitBadge({ fit, ramGB }: { fit: Fit | null; ramGB: number }) {
  if (fit === null) return <Tag color="#64748b">needs ≈{ramGB} GB</Tag>
  if (fit === 'fits') return <Tag color={GREEN}>fits your VM</Tag>
  if (fit === 'tight') return <Tag color={AMBER}>tight fit</Tag>
  return <Tag color="#ef4444">too big for your VM</Tag>
}

/**
 * Local model: what the runtime already has (click to use), then the catalogue with a memory-fit
 * badge computed from the Docker VM the AI Intern reports. Picking a model that is not in the runtime
 * yet is allowed — the row says exactly what to download and where to put it.
 */
function LocalModelPicker({ value, onChange, worker, alive }: { value: string; onChange: (v: string) => void; worker: AiWorkerStatus | null; alive: boolean }) {
  const memGB = alive ? (worker?.vm?.memGB ?? null) : null
  const available = (worker?.runtime?.models ?? []).map(bareModelName)
  const isAvail = (tag: string) => available.includes(bareModelName(tag))
  const current = bareModelName(value)
  return (
    <div className="mt-3">
      <SubTitle>Local model</SubTitle>
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">
        {memGB
          ? `Docker VM: ${memGB} GB memory · ${worker?.vm?.cpus ?? '?'} CPUs. A model’s RAM figure has to fit inside that — raise it in Docker Desktop → Settings → Resources.`
          : 'Memory fit is unknown until the AI Intern container is running (bash start-jira-board.sh).'}{' '}
        <a href={`${guideUrl()}#ai`} target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--link)] hover:underline">
          Where to download and place models →
        </a>
      </p>

      {available.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10.5px] font-semibold text-[var(--ink-soft)]">Ready in the runtime now</div>
          <div className="flex flex-wrap gap-1.5">
            {available.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChange(m)}
                className="rounded-full border px-2.5 py-[3px] font-mono text-[11px] font-semibold transition-colors"
                style={{ borderColor: current === m ? LOCAL : 'var(--line)', background: current === m ? hexToRgba(LOCAL, 0.14) : 'transparent', color: current === m ? LOCAL : 'var(--ink-soft)' }}
              >
                {m} ✓
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-col gap-1.5">
        {LOCAL_MODELS.map((m) => {
          const fit = fitFor(m, memGB)
          const avail = isAvail(m.tag)
          const on = current === bareModelName(m.tag)
          return (
            <button
              key={m.tag}
              type="button"
              onClick={() => onChange(m.tag)}
              aria-pressed={on}
              className="flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors"
              style={{ borderColor: on ? hexToRgba(LOCAL, 0.55) : 'var(--line)', background: on ? hexToRgba(LOCAL, 0.1) : 'transparent', opacity: fit === 'no' ? 0.6 : 1 }}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-bold" style={{ color: on ? LOCAL : 'var(--ink)' }}>
                  {m.label}
                  <span className="font-mono text-[10.5px] font-semibold text-[var(--muted)]">{m.tag}</span>
                  {m.recommended && <Tag color={AI}>recommended</Tag>}
                  <FitBadge fit={fit} ramGB={m.ramGB} />
                  {avail && <Tag color={GREEN}>ready</Tag>}
                </span>
                <span className="block text-[11px] leading-snug text-[var(--muted)]">
                  {m.params} · download ≈ {m.fileGB} GB · RAM ≈ {m.ramGB} GB — {m.blurb}
                </span>
                {!avail && (
                  <span className="mt-0.5 block text-[10.5px] leading-snug text-[var(--muted)]">
                    Not in the runtime yet: download the Q4_K_M .gguf from{' '}
                    <a href={m.hf} target="_blank" rel="noopener noreferrer" className="text-[var(--link)] hover:underline" onClick={(e) => e.stopPropagation()}>
                      Hugging Face
                    </a>{' '}
                    into <span className="font-mono">jira-intern/models/</span>, or <span className="font-mono">docker exec JIRA-LLM ollama pull {m.tag}</span>.
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      <label className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted)]">
        Other model name
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="e.g. qwen3-8b-q4_k_m"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
        />
      </label>
    </div>
  )
}

function CloudPicker({
  provider,
  model,
  onProvider,
  onModel,
  worker,
}: {
  provider: AiCloudProvider
  model: string
  onProvider: (p: AiCloudProvider) => void
  onModel: (m: string) => void
  worker: AiWorkerStatus | null
}) {
  const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
  const keys = worker?.runtime?.keys
  const hasKey = keys ? !!keys[provider] : null
  return (
    <div className="mt-3">
      <SubTitle>Cloud provider</SubTitle>
      <div className="flex flex-wrap gap-1.5">
        <Choice active={provider === 'anthropic'} label="Claude" hint="Anthropic Messages API" icon={<SparkleIcon size={12} color={provider === 'anthropic' ? AI : 'currentColor'} />} onClick={() => onProvider('anthropic')} />
        <Choice active={provider === 'openai'} label="OpenAI-compatible" hint="OpenAI, Azure, a gateway, a second Ollama — set OPENAI_BASE_URL for anything but api.openai.com" onClick={() => onProvider('openai')} />
      </div>
      <label className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted)]">
        Model
        <input
          list="jb-cloud-models"
          value={model}
          onChange={(e) => onModel(e.target.value.trim())}
          placeholder={provider === 'anthropic' ? 'claude-opus-5' : 'the model name your provider expects'}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
        />
        <datalist id="jb-cloud-models">
          {CLOUD_MODEL_SUGGESTIONS[provider]
            .filter((s) => s.id)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.hint}
              </option>
            ))}
        </datalist>
      </label>
      {provider === 'anthropic' && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {CLOUD_MODEL_SUGGESTIONS.anthropic.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.hint}
              onClick={() => onModel(s.id)}
              className="rounded-full border px-2.5 py-[3px] font-mono text-[11px] font-semibold transition-colors"
              style={{ borderColor: model === s.id ? AI : 'var(--line)', background: model === s.id ? hexToRgba(AI, 0.14) : 'transparent', color: model === s.id ? AI : 'var(--ink-soft)' }}
            >
              {s.id}
            </button>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-[11px]" style={{ color: hasKey === false ? '#b45309' : hasKey ? GREEN : 'var(--muted)' }}>
        {hasKey === null
          ? `The AI Intern reads ${keyName} from the secrets file (~/.cursor/mcp-secrets.env).`
          : hasKey
            ? `${keyName} found in the secrets file.`
            : `${keyName} is missing from the secrets file (~/.cursor/mcp-secrets.env) — add it, then bash start-jira-board.sh so the container picks it up.`}
      </p>
    </div>
  )
}

/**
 * Where the AI passes will actually run for the current choice — and if they cannot, why, in the
 * words of the container that would run them. This is the one place a wrong setup announces itself.
 */
function AiAvailabilityNote({ synced, state, mode, localModel }: { synced: boolean; state: AiEnrichmentState | null; mode: AiMode; localModel: string }) {
  if (!synced) {
    return (
      <p className="mt-3 text-[11px] text-[var(--muted)]">
        Saved on this device only — without the local server the fetch scripts cannot be told, so they keep their configured level.
      </p>
    )
  }
  if (!state) return null
  if (state.available) return <p className="mt-3 text-[11px] text-[var(--muted)]">Applies to PR Readiness Report generation on the next run.</p>
  if (!state.handoff) {
    return (
      <Note color={AMBER} title="AI enrichment can’t run here">
        {state.detail} Install and sign in to the agent CLI on this machine, then regenerate.
      </Note>
    )
  }
  const w = state.worker
  if (!state.workerAlive) {
    return (
      <Note color={AMBER} title="The AI Intern container isn’t running">
        Reports stay deterministic until it is. The deploy script starts it alongside the board (and the JIRA-LLM runtime when Local is chosen):
        <code className="mt-1 block rounded bg-[var(--surface-2)] px-2 py-1 font-mono text-[10.5px] text-[var(--ink)]">bash start-jira-board.sh</code>
      </Note>
    )
  }
  if (mode === 'off') {
    return (
      <Note color="#64748b" title="AI Intern is running and idle">
        Reports stay deterministic. Choose Local model or Cloud API above to enrich them; the report footer explains each report’s state.
      </Note>
    )
  }
  const rt = w?.runtime
  if (rt && !rt.ok) {
    return (
      <Note color={AMBER} title={mode === 'local' ? 'Local runtime not reachable' : 'Cloud API not usable yet'}>
        {rt.error}
        {mode === 'local' && (
          <>
            {' '}
            Run <span className="font-mono">bash start-jira-board.sh</span> with Local selected — it starts the JIRA-LLM container — or point <span className="font-mono">AI_LOCAL_ENDPOINT</span> at a native Ollama.
          </>
        )}
      </Note>
    )
  }
  if (mode === 'local' && !localModel) {
    return (
      <Note color={AMBER} title="Pick a local model">
        The runtime is up; choose a model above. Files you drop into <span className="font-mono">jira-intern/models/</span> appear under “Ready in the runtime” within a minute.
      </Note>
    )
  }
  const color = mode === 'local' ? LOCAL : AI
  const last = w?.last
  return (
    <Note color={color} title={`AI Intern is running — ${mode === 'local' ? `local · ${localModel}` : `${w?.provider ?? 'cloud'} · ${w?.model ?? ''}`}`}>
      Regenerate and the bulk runs are enriched at the effort above; a report shows as generating until the enriched version lands.
      {w?.current && <span className="block">Working on {w.current} now.</span>}
      {last && (
        <span className="block" style={{ color: last.ok ? 'var(--ink-soft)' : '#b45309' }}>
          Last: {last.key} {last.ok ? 'enriched' : 'failed'} {relTime(last.at, Date.now())}
          {last.detail ? ` — ${last.detail}` : ''}
        </span>
      )}
    </Note>
  )
}

function Note({ color, title, children }: { color: string; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--ink-soft)]" style={{ borderColor: hexToRgba(color, 0.5), background: hexToRgba(color, 0.08) }}>
      <div className="font-bold" style={{ color }}>
        {title}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

// ── shared pieces ─────────────────────────────────────────────────────────────

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

function AiChoice({ level, active, color, onClick }: { level: (typeof AI_LEVELS)[number]; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors"
      style={{
        borderColor: active ? hexToRgba(color, 0.55) : 'var(--line)',
        background: active ? hexToRgba(color, 0.1) : 'transparent',
      }}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border" style={{ borderColor: active ? color : 'var(--line)' }}>
        {active && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] font-bold" style={{ color: active ? color : 'var(--ink)' }}>
          <SparkleIcon size={11} color={active ? color : 'currentColor'} />
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
