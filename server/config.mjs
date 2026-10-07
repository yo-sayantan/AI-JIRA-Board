import { join } from 'node:path'
import { cfg } from '../jira-intern/local-runner/config.mjs'

export const PROJECT_CONFIG = cfg

export const ROOT = join(import.meta.dirname, '..')
export const INTERN = join(ROOT, 'jira-intern')
const RUNNER = join(INTERN, 'local-runner')

export const PATHS = {
  data: join(INTERN, 'data.json'),
  progress: join(INTERN, '.progress.json'),
  settings: join(INTERN, '.settings.json'),
  schedule: join(INTERN, '.schedule.json'),
  modelsDir: join(INTERN, 'models'),
  internLock: join(INTERN, '.intern.lock'),
  completedLock: join(INTERN, '.completed.lock'),
  aiQueue: join(INTERN, '.ai-queue'),
  aiCancelReport: join(INTERN, '.ai-cancel-report'),
  reportsDir: join(INTERN, 'reports'),
  reportsStatus: join(INTERN, 'reports', '.status.json'),
  reportPy: join(INTERN, 'pr_report.py'),
  dailyScript: join(RUNNER, 'run-intern.sh'),
  archiveScript: join(RUNNER, 'update-completed.sh'),
  refreshScript: join(RUNNER, 'refresh-ticket.sh'),
  transitionPy: join(INTERN, 'transition.py'),
  raisedScript: join(RUNNER, 'refresh-raised.sh'),
  modelCatalog: join(ROOT, 'ai-intern', 'models.json'),
}

export const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i
export const YEAR_RE = /^\d{4}$/
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const AI_INTERN_URL = process.env.AI_INTERN_URL || 'http://127.0.0.1:4322'
export const PORT = Number(process.env.PORT) || Number(cfg.app?.servePort) || 4321
// Loopback by default so a laptop run stays private; the Docker image sets BIND_HOST=0.0.0.0.
export const HOST = process.env.BIND_HOST || '127.0.0.1'
// Host header values the server answers for besides loopback and its own bind address, e.g. a LAN
// name used from another machine: ALLOWED_HOSTS="mymac.local:4321,192.168.1.20". Anything else is
// refused, which is what stops a DNS-rebinding page from talking to this server.
export const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)
export const BOARD_PATH = '/dist/index.html'
