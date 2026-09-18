/**
 * Board settings — theme policy, per-feature switches, and how much AI the pipeline may use.
 *
 * Everything lives in localStorage so the board keeps working from `file://`, where there is no
 * server to ask. The AI level is the one setting that also has to reach the shell runners (they
 * decide whether to invoke the agent at all), so served mode mirrors it to the server, which
 * writes jira-intern/.settings.json for `config.mjs shellenv` to pick up.
 */

export type ThemeMode = 'auto' | 'fixed' | 'schedule'
export type AiLevel = 'none' | 'low' | 'moderate' | 'full'

export interface Settings {
  /** auto = follow the OS · fixed = always `theme` · schedule = light between the day hours. */
  themeMode: ThemeMode
  theme: 'dark' | 'light'
  /** Local hours [start, end) during which the LIGHT theme applies in `schedule` mode. */
  dayStart: number
  dayEnd: number
  aiLevel: AiLevel
  features: Record<FeatureKey, boolean>
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
    hint: 'Focus search with / and refresh with r',
    detail:
      'Enables the single-key shortcuts on the board. They are already suppressed while a drawer is open or you are typing, so turn this off only if they still clash with something.',
  },
  {
    key: 'autoRefresh',
    default: true,
    label: 'Background auto-refresh',
    hint: 'Polls for fresh data and report progress',
    detail:
      'Quietly re-checks the server so reports started from a terminal or a scheduled run appear without reloading. Turning it off makes the board fully manual and removes all background network calls.',
  },
] as const

export type FeatureKey = (typeof FEATURES)[number]['key']

export const AI_LEVELS: { key: AiLevel; label: string; hint: string }[] = [
  { key: 'none', label: 'None', hint: 'No agent at all — reports stay deterministic' },
  { key: 'low', label: 'Low', hint: 'Agent runs, short leash — fastest and cheapest' },
  { key: 'moderate', label: 'Moderate', hint: 'Balanced depth and cost (default)' },
  { key: 'full', label: 'Full', hint: 'Maximum intelligence and time per ticket' },
]

const DEFAULT_FEATURES = Object.fromEntries(FEATURES.map((f) => [f.key, f.default])) as Record<FeatureKey, boolean>

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'auto',
  theme: 'dark',
  dayStart: 7,
  dayEnd: 19,
  aiLevel: 'moderate',
  features: DEFAULT_FEATURES,
}

const KEY = 'jb-settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return migrateLegacyTheme(DEFAULT_SETTINGS)
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      features: { ...DEFAULT_SETTINGS.features, ...(parsed.features ?? {}) },
    }
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
export function applySettings(s: Settings): void {
  const el = document.documentElement
  el.classList.toggle('dark', resolveDark(s))
  el.classList.toggle('jb-no-anim', !s.features.animations)
}
