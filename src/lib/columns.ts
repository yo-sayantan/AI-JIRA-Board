import type { ColumnKey } from '../types'

export interface ColumnMeta {
  key: ColumnKey
  label: string
  /** Accent color (the column's identity). */
  accent: string
  /** Lowercased Jira statuses that fold into this column. */
  statuses: string[]
  emoji: string
}

// The five board columns, left → right, exactly as requested.
// "In Review" intentionally folds in Ready4Review + Code Review + In Review.
export const BOARD_COLUMNS: ColumnMeta[] = [
  {
    key: 'todo',
    label: 'To Do',
    accent: '#64748b',
    emoji: '📋',
    statuses: ['to do', 'todo', 'open', 'backlog', 'reopened', 'selected for development', 'new'],
  },
  {
    key: 'prog',
    label: 'In Progress',
    accent: '#3b82f6',
    emoji: '⚙️',
    statuses: ['in progress', 'dev in progress', 'work in progress', 'in development', 'development', 'implementing'],
  },
  {
    key: 'rev',
    label: 'In Review',
    accent: '#8b5cf6',
    emoji: '👀',
    statuses: ['in review', 'code review', 'ready4review', 'ready for review', 'review', 'peer review', 'pr review'],
  },
  {
    key: 'qa',
    label: 'QA',
    accent: '#14b8a6',
    emoji: '🧪',
    statuses: [
      'qa',
      'in qa',
      'under qa',
      'ready for qa',
      'ready4qa',
      'awaiting qa',
      'testing',
      'in test',
      'in testing',
      'test',
      'verification',
      'verify',
    ],
  },
  {
    key: 'done',
    label: 'Done',
    accent: '#22c55e',
    emoji: '✅',
    // Mirrors jira-intern/_jira.py `_STATUS_COLUMNS`: a ticket closed as won't-fix or cancelled is
    // finished work, not a card stuck in progress.
    statuses: ['done', 'completed', 'closed', 'resolved', 'shipped', 'released', "won't fix", 'wont fix', 'won’t fix', 'cancelled', 'canceled', 'rejected'],
  },
]

// Not part of the kanban row — rendered as its own section, only when occupied.
export const HOLD_COLUMN: ColumnMeta = {
  key: 'hold',
  label: 'On Hold',
  accent: '#f97316',
  emoji: '⏸️',
  statuses: ['on hold', 'hold', 'blocked', 'waiting', 'parked', 'impeded', 'paused', 'stalled'],
}

// NOT a column — a *partition* of the To Do column. Tickets keep `column: 'todo'`; they're
// pulled out of the kanban row by isNextSprint() (see lib/format.ts) because their sprint
// hasn't started, and rendered in their own section below the board.
export const NEXT_SPRINT_SECTION = {
  label: 'Next Sprint',
  accent: '#ec4899',
  emoji: '🗓️',
} as const

const ALL: ColumnMeta[] = [...BOARD_COLUMNS, HOLD_COLUMN]

export const COLUMN_META: Record<ColumnKey, ColumnMeta> = ALL.reduce(
  (acc, c) => {
    acc[c.key] = c
    return acc
  },
  {} as Record<ColumnKey, ColumnMeta>,
)

/** Safety net: derive a column from a raw status if the intern didn't set one. */
export function mapStatusToColumn(status: string | null | undefined): ColumnKey {
  const s = (status ?? '').trim().toLowerCase()
  if (!s) return 'todo'
  // Whole-word (token) match, NOT naive substring — otherwise "Awaiting Deployment" matches the
  // "waiting" hold keyword, and "Preview"/"Reopened" match "review"/"open". Boundaries are any
  // non-alphanumeric char (handles multi-word keywords like "on hold" / "in progress").
  const hasWord = (kw: string) =>
    new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(s)
  // On Hold takes precedence so blocked work surfaces in its own section.
  if (HOLD_COLUMN.statuses.some((x) => s === x || hasWord(x))) return 'hold'
  for (const col of BOARD_COLUMNS) {
    if (col.statuses.some((x) => s === x)) return col.key
  }
  // Word fallback in the SAME order as the Python intern (qa → review → progress), so "QA In
  // Progress" lands in QA on both sides instead of matching "in progress" first here.
  for (const key of WORD_FALLBACK_ORDER) {
    if (COLUMN_META[key].statuses.some((x) => hasWord(x))) return key
  }
  return 'todo'
}

const WORD_FALLBACK_ORDER: ColumnKey[] = ['qa', 'rev', 'prog', 'todo', 'done']
