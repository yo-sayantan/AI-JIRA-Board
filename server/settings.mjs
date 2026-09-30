import { readFile, writeFile } from 'node:fs/promises'
import { PATHS, PROJECT_CONFIG } from './config.mjs'

export const AI_LEVELS = ['none', 'low', 'moderate', 'full']
export const CLOUD_PROVIDERS = ['claude', 'cursor', 'gemini']
export const DEFAULT_LOCAL_MODEL = 'qwen2.5-coder:7b'

const ACTIVE_CADENCE = ['off', 'daily', 'twice-daily']
const BOARD_CADENCE = ['off', 'daily', 'weekly', 'twice-weekly']
const oneOf = (values) => (v) => (values.includes(v) ? { value: v } : null)
const text = (max) => (v) => (typeof v === 'string' && v.length <= max ? { value: v } : null)
const int = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? { value: v } : null)
const bool = (v) => ({ value: !!v })

// Only the settings the shell runners and the AI intern read. Presentation stays in localStorage.
const SCHEMA = {
  aiLevel: oneOf(AI_LEVELS),
  aiBackend: oneOf(['local', 'cloud']),
  aiLocalModel: text(80),
  aiCloudModel: text(128),
  aiCloudProvider: oneOf(CLOUD_PROVIDERS),
  aiCloudEffort: oneOf(['low', 'medium']),
  aiUseHostOllama: bool,
  reportParallel: int(1, 6),
  archiveParallel: int(1, 16),
  refreshParallel: int(1, 16),
  activeRefresh: oneOf(ACTIVE_CADENCE),
  fullRefresh: oneOf(BOARD_CADENCE),
  reportRefresh: oneOf(BOARD_CADENCE),
}

async function readSaved() {
  return readFile(PATHS.settings, 'utf8').then(JSON.parse, () => ({}))
}

/** Central project defaults overlaid by jira-intern/.settings.json. */
export async function readBoardSettings() {
  const ai = PROJECT_CONFIG.ai || {}
  const schedule = PROJECT_CONFIG.schedule || {}
  const pick = (allowed, value, fallback) => (allowed.includes(value) ? value : fallback)
  const defaults = {
    aiLevel: ai.level || 'moderate',
    aiBackend: ai.backend || 'local',
    aiLocalModel: ai.localModel || '',
    aiCloudModel: ai.cloudModel || '',
    aiCloudProvider: ai.cloudProvider || 'cursor',
    aiCloudEffort: ai.cloudEffort || 'low',
    aiUseHostOllama: !!ai.useHostOllama,
    reportParallel: ai.parallel || 4,
    archiveParallel: PROJECT_CONFIG.archive?.workers || 8,
    refreshParallel: PROJECT_CONFIG.refresh?.workers || 8,
    activeRefresh: pick(ACTIVE_CADENCE, schedule.activeRefresh, 'twice-daily'),
    fullRefresh: pick(BOARD_CADENCE, schedule.fullRefresh, 'twice-weekly'),
    reportRefresh: pick(BOARD_CADENCE, schedule.reportRefresh, 'twice-weekly'),
  }
  return { ...defaults, ...(await readSaved()) }
}

/**
 * Validate and persist a partial update. Written to jira-intern/.settings.json rather than the
 * config, which may resolve to the user's personal ~/.ai/config.json.
 */
export async function updateBoardSettings(patch) {
  const next = await readSaved()
  for (const [key, value] of Object.entries(patch ?? {})) {
    const check = SCHEMA[key]
    if (!check || value === undefined) continue
    const ok = check(value)
    if (!ok) return { error: `bad ${key}` }
    next[key] = ok.value
  }
  await writeFile(PATHS.settings, JSON.stringify(next, null, 2) + '\n')
  return { settings: next }
}
