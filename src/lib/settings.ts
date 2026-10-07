/**
 * Board settings — theme policy, per-feature switches, and how much AI the pipeline may use.
 *
 * Everything lives in localStorage so the board keeps working from `file://`, where there is no
 * server to ask. The AI level is the one setting that also has to reach the shell runners (they
 * decide whether to invoke the agent at all), so served mode mirrors it to the server, which
 * writes jira-intern/.settings.json for `config.mjs shellenv` to pick up.
 */
import modelCatalog from '../../ai-intern/models.json'
import { APP_CONFIG } from './appConfig'

export type ThemeMode = 'auto' | 'fixed' | 'schedule'
export type AiLevel = 'none' | 'low' | 'moderate' | 'full'
export type AiBackend = 'local' | 'cloud'
export type AiCloudProvider = 'claude' | 'cursor' | 'gemini'
/** Cursor reasoning effort. Low is the default; medium is the only step up. */
export type AiCloudEffort = 'low' | 'medium'

export interface Settings {
  /** auto = follow the OS · fixed = always `theme` · schedule = light between the day hours. */
  themeMode: ThemeMode
  theme: 'dark' | 'light'
  /** Local hours [start, end) during which the LIGHT theme applies in `schedule` mode. */
  dayStart: number
  dayEnd: number
  aiLevel: AiLevel
  /** Local Ollama (in-container or host Metal) vs a cloud chat API. */
  aiBackend: AiBackend
  /** Ollama tag to pull/run when aiBackend is local. */
  aiLocalModel: string
  /** Claude, Cursor, or Gemini. Keys stay in ~/.cursor/mcp-secrets.env. */
  aiCloudProvider: AiCloudProvider
  /** Model id returned by that provider's list-models API. */
  aiCloudModel: string
  /** Cursor only. Low by default. Medium is the only other pass. */
  aiCloudEffort: AiCloudEffort
  /** Talk to Ollama.app on the Mac (Metal) instead of the Linux Docker VM (CPU). */
  aiUseHostOllama: boolean
  /** PR readiness reports the AI intern builds at once. */
  reportParallel: number
  /** Tickets the Completed-archive rebuild fetches at once. */
  archiveParallel: number
  /** Tickets the dashboard refresh builds at once. */
  refreshParallel: number
  /** Seconds a notification stays on screen before it dismisses itself. */
  toastSeconds: number
  /** Most notifications on screen at once; the oldest go first. */
  toastMax: number
  /** Server schedule for the active-ticket fetch. */
  activeRefresh: ActiveCadence
  /** Server schedule for active tickets plus the Completed archive. */
  fullRefresh: BoardCadence
  /** Server schedule for PR reports that are stale or below 100. */
  reportRefresh: BoardCadence
  features: Record<FeatureKey, boolean>
}

/** Inclusive bounds for the number boxes. The server clamps to the same ranges. */
export const LIMITS = {
  reportParallel: { min: 1, max: 6 },
  archiveParallel: { min: 1, max: 16 },
  refreshParallel: { min: 1, max: 16 },
  toastSeconds: { min: 2, max: 10 },
  toastMax: { min: 1, max: 10 },
} as const

export function clampSetting(key: keyof typeof LIMITS, v: unknown, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(LIMITS[key].max, Math.max(LIMITS[key].min, n))
}

/**
 * The feature registry is the single source of truth: the FeatureKey union, the defaults and the
 * settings cards are all derived from it, so adding a switch means adding ONE entry here (plus its
 * colour/icon in Settings.tsx, which TypeScript will demand because that map is keyed exhaustively).
 */
export const FEATURES = [
  {
    key: 'prReports',
    default: true,
    label: 'PR Readiness Reports',
    hint: 'Ship/no-ship verdict per ticket',
    detail:
      'Adds the report button to any ticket with a pull request, plus the header control that generates reports in bulk. Each report grades approvals, open comments, merge state and release gates into a single verdict. Turn off to hide the whole feature.',
  },
  {
    key: 'nextSprint',
    default: true,
    label: 'Next Sprint section',
    hint: 'Queue for the sprint that has not started',
    detail:
      'Shows the strip below the board holding To Do tickets whose sprint has not begun yet, so upcoming work stays visible without cluttering the active columns.',
  },
  {
    key: 'completedArchive',
    default: true,
    label: 'Completed archive',
    hint: 'The Completed chip and its drawer',
    detail:
      'Keeps the gold Completed counter and the full archive of closed tickets. Turn off for a board that only ever shows work in flight.',
  },
  {
    key: 'raisedTickets',
    default: true,
    label: 'Raised by me',
    hint: 'Tickets you reported, and who holds them',
    detail:
      'Adds the indigo Raised button beside Completed, listing every ticket you reported (sub-tickets you cut under your own work are excluded): its current status, who it is assigned to now, every hand-off since you raised it, and its AI brief.',
  },
  {
    key: 'animations',
    default: true,
    label: 'Motion & animations',
    hint: 'Transitions, spinners and hover effects',
    detail:
      'Card entrance transitions, drawer slides, spinners and hover lifts. Turning this off applies the same treatment as the system reduce-motion setting, which also helps on a slow or remote display.',
  },
  {
    key: 'shortcuts',
    default: true,
    label: 'Keyboard shortcuts',
    hint: '/ search · r refresh',
    detail:
      'Turns on / to focus search and r to refresh, and shows those keys on the search box and refresh button. They stay off while you are typing or a ticket is open. Escape still closes a ticket.',
  },
  {
    key: 'autoRefresh',
    default: true,
    label: 'Background auto-refresh',
    hint: 'Live progress while the board is open',
    detail:
      'Polls for report progress and intern status while the board is open. Off stops those polls. A refresh or report you start yourself still updates until it finishes.',
  },
  {
    key: 'aiBriefs',
    default: true,
    label: 'AI briefs',
    hint: 'The summary at the top of a ticket',
    detail: 'Shows the generated brief on the ticket page. Off hides it. Reports and the intern keep running.',
  },
  {
    key: 'onHold',
    default: true,
    label: 'On Hold section',
    hint: 'The strip for blocked tickets',
    detail: 'Shows On Hold under the board. Off puts those tickets back in To Do instead of hiding them.',
  },
  {
    key: 'reloadActive',
    default: true,
    label: 'Refresh on open',
    hint: 'Fetch active tickets on every reload',
    detail: 'Each time you open or reload the board, fetch your active tickets. Scheduled jobs are separate and keep running when this is off.',
  },
] as const

/** How often the server refreshes active tickets. */
export const ACTIVE_CADENCE = ['off', 'daily', 'twice-daily'] as const
/** How often the server rebuilds the whole board, or refreshes unfinished PR reports. */
export const BOARD_CADENCE = ['off', 'daily', 'weekly', 'twice-weekly'] as const
export type ActiveCadence = (typeof ACTIVE_CADENCE)[number]
export type BoardCadence = (typeof BOARD_CADENCE)[number]

export function pickCadence<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

type Parse<T> = (value: unknown, fallback: T) => T
const oneOf =
  <T extends string>(allowed: readonly T[]): Parse<T> =>
  (v, f) =>
    pickCadence(allowed, v, f)
const bool: Parse<boolean> = (v, f) => (typeof v === 'boolean' ? v : f)
const bounded =
  (key: keyof typeof LIMITS): Parse<number> =>
  (v, f) =>
    clampSetting(key, v, f)
/** Hour of day for the schedule window: an integer 0–23, else the fallback. */
const hour: Parse<number> = (v, f) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : f
}

/**
 * Model ids reach shell runners and CLIs, so they are limited to tag characters — the SAME regex and
 * lengths server/settings.mjs enforces. Anything else would make the server reject the whole patch
 * with a 400, and every other setting in it would silently never reach the server.
 */
export const MODEL_ID_RE = /^[\w.:/-]*$/
export const MODEL_ID_MAX = { aiLocalModel: 80, aiCloudModel: 128 } as const
export function isModelId(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max && MODEL_ID_RE.test(v)
}
const modelId =
  (max: number): Parse<string> =>
  (v, f) =>
    isModelId(v, max) ? v : f

/** Settings the server-side jobs honour, mirrored to jira-intern/.settings.json in served mode. */
const SERVER_FIELDS = {
  aiLevel: oneOf<AiLevel>(['none', 'low', 'moderate', 'full']),
  aiBackend: oneOf<AiBackend>(['local', 'cloud']),
  aiLocalModel: modelId(MODEL_ID_MAX.aiLocalModel),
  aiCloudModel: modelId(MODEL_ID_MAX.aiCloudModel),
  aiCloudProvider: oneOf<AiCloudProvider>(['claude', 'cursor', 'gemini']),
  aiCloudEffort: oneOf<AiCloudEffort>(['low', 'medium']),
  aiUseHostOllama: bool,
  reportParallel: bounded('reportParallel'),
  archiveParallel: bounded('archiveParallel'),
  refreshParallel: bounded('refreshParallel'),
  activeRefresh: oneOf(ACTIVE_CADENCE),
  fullRefresh: oneOf(BOARD_CADENCE),
  reportRefresh: oneOf(BOARD_CADENCE),
} satisfies { [K in keyof Settings]?: Parse<Settings[K]> }

type ServerKey = keyof typeof SERVER_FIELDS
export type ServerSettings = Pick<Settings, ServerKey>
const SERVER_KEYS = Object.keys(SERVER_FIELDS) as ServerKey[]

export function serverSettingsOf(s: Settings): ServerSettings {
  return Object.fromEntries(SERVER_KEYS.map((k) => [k, s[k]])) as ServerSettings
}

/** Overlay the server's saved values, keeping the current value for anything missing or invalid. */
export function mergeServerSettings(current: Settings, saved: Record<string, unknown>): Settings {
  const next = { ...current }
  for (const k of SERVER_KEYS) {
    const parse = SERVER_FIELDS[k] as Parse<Settings[typeof k]>
    ;(next as Record<ServerKey, unknown>)[k] = parse(saved[k], current[k])
  }
  return next
}

export type FeatureKey = (typeof FEATURES)[number]['key']

/** Everything that lives only in localStorage. Together with SERVER_FIELDS this covers every key of Settings. */
const LOCAL_FIELDS = {
  themeMode: oneOf<ThemeMode>(['auto', 'fixed', 'schedule']),
  theme: oneOf<Settings['theme']>(['dark', 'light']),
  dayStart: hour,
  dayEnd: hour,
  toastSeconds: bounded('toastSeconds'),
  toastMax: bounded('toastMax'),
} satisfies { [K in Exclude<keyof Settings, ServerKey | 'features'>]: Parse<Settings[K]> }

export const AI_LEVELS: {
  key: AiLevel
  label: string
  hint: string
  plus: string[]
  cons: string[]
}[] = [
  {
    key: 'none',
    label: 'None',
    hint: 'Base report only — no intern',
    plus: ['Instant and free', 'Verdict stays deterministic', 'Works even if the intern is down'],
    cons: ['No business-impact write-up', 'No per-file review notes'],
  },
  {
    key: 'low',
    label: 'Low',
    hint: 'Short timeout — fastest pass',
    plus: ['Quick on nano / mini models', 'Cheapest cloud option', 'Unblocks the queue sooner'],
    cons: ['Shallow file notes', 'May skip longer diffs'],
  },
  {
    key: 'moderate',
    label: 'Moderate',
    hint: 'Balanced depth (default)',
    plus: ['Solid JSON follow-through', 'Fits 7B local models', 'Sensible wait vs quality'],
    cons: ['Slower than Low', 'Still skips live CI / scan proof'],
  },
  {
    key: 'full',
    label: 'Max',
    hint: 'Longest timeout — deepest pass',
    plus: ['Best local / cloud quality', 'Room for 14B+ models', 'Richer file and risk notes'],
    cons: ['Slowest, especially on CPU', 'Burns the most cloud tokens'],
  },
]

const DEFAULT_FEATURES = {
  ...(Object.fromEntries(FEATURES.map((f) => [f.key, f.default])) as Record<FeatureKey, boolean>),
  ...(APP_CONFIG.settingsDefaults?.features as Partial<Record<FeatureKey, boolean>> | undefined),
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: APP_CONFIG.settingsDefaults?.themeMode ?? 'auto',
  theme: APP_CONFIG.settingsDefaults?.theme ?? 'dark',
  dayStart: APP_CONFIG.settingsDefaults?.dayStart ?? 7,
  dayEnd: APP_CONFIG.settingsDefaults?.dayEnd ?? 19,
  aiLevel: APP_CONFIG.ai?.level ?? 'moderate',
  aiBackend: APP_CONFIG.ai?.backend ?? 'local',
  aiLocalModel: APP_CONFIG.ai?.localModel || modelCatalog.defaultLocal,
  aiCloudProvider: APP_CONFIG.ai?.cloudProvider ?? 'cursor',
  aiCloudModel: APP_CONFIG.ai?.cloudModel ?? '',
  aiCloudEffort: APP_CONFIG.ai?.cloudEffort ?? 'low',
  aiUseHostOllama: APP_CONFIG.ai?.useHostOllama ?? false,
  reportParallel: clampSetting('reportParallel', APP_CONFIG.ai?.parallel, 4),
  archiveParallel: clampSetting('archiveParallel', APP_CONFIG.archive?.workers, 8),
  refreshParallel: clampSetting('refreshParallel', APP_CONFIG.refresh?.workers, 8),
  toastSeconds: clampSetting('toastSeconds', APP_CONFIG.settingsDefaults?.toastSeconds, 10),
  toastMax: clampSetting('toastMax', APP_CONFIG.settingsDefaults?.toastMax, 4),
  activeRefresh: pickCadence(ACTIVE_CADENCE, APP_CONFIG.schedule?.activeRefresh, 'twice-daily'),
  fullRefresh: pickCadence(BOARD_CADENCE, APP_CONFIG.schedule?.fullRefresh, 'twice-weekly'),
  reportRefresh: pickCadence(BOARD_CADENCE, APP_CONFIG.schedule?.reportRefresh, 'twice-weekly'),
  features: DEFAULT_FEATURES,
}

const KEY = 'jb-settings'

/**
 * Validate a saved settings object field by field; anything missing, of the wrong type, out of
 * range or no longer a valid choice (an old "aiLevel": "high", a model tag with a space) takes the
 * default instead of being passed through. Never throws — a non-object yields the defaults.
 */
export function parseSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const next: Record<string, unknown> = { ...defaults }
  for (const k of SERVER_KEYS) {
    const parse = SERVER_FIELDS[k] as Parse<Settings[typeof k]>
    next[k] = parse(saved[k], defaults[k])
  }
  for (const k of Object.keys(LOCAL_FIELDS) as (keyof typeof LOCAL_FIELDS)[]) {
    const parse = LOCAL_FIELDS[k] as Parse<Settings[typeof k]>
    next[k] = parse(saved[k], defaults[k])
  }
  const rawFeatures = (typeof saved.features === 'object' && saved.features !== null ? saved.features : {}) as Record<string, unknown>
  const features = { ...defaults.features }
  for (const key of Object.keys(features) as FeatureKey[]) features[key] = bool(rawFeatures[key], defaults.features[key])
  next.features = features
  return next as unknown as Settings
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return migrateLegacyTheme(DEFAULT_SETTINGS)
    return parseSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** The pre-settings build stored only `jb-theme`; honour it so an existing choice isn't lost. */
function migrateLegacyTheme(base: Settings): Settings {
  try {
    const saved = localStorage.getItem('jb-theme')
    if (saved === 'dark' || saved === 'light') return { ...base, themeMode: 'fixed', theme: saved }
  } catch {
    /* file:// localStorage may be blocked */
  }
  return base
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* file:// localStorage may be blocked */
  }
}

/** Should the board be dark right now, given the policy? */
export function resolveDark(s: Settings, at: Date = new Date()): boolean {
  if (s.themeMode === 'fixed') return s.theme === 'dark'
  if (s.themeMode === 'schedule') {
    const h = at.getHours()
    // A window that wraps midnight (e.g. 19→7) is still a single "day" span.
    const isDay = s.dayStart <= s.dayEnd ? h >= s.dayStart && h < s.dayEnd : h >= s.dayStart || h < s.dayEnd
    return !isDay
  }
  try {
    return !(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches)
  } catch {
    return true
  }
}

/** Apply the resolved theme (and the animation switch) to <html>. */
export function applySettings(s: Settings, at: Date = new Date()): void {
  const el = document.documentElement
  el.classList.toggle('dark', resolveDark(s, at))
  el.classList.toggle('jb-no-anim', !s.features.animations)
}
