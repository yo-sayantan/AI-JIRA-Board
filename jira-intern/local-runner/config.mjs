// Config resolver for the jira-intern pipeline. Reads ../config.json (single source of
// truth) and serves it to every consumer so portability lives in ONE file:
//
//   node config.mjs get <dot.path>       → print a value ("user.accountId" → C22014E)
//   node config.mjs shellenv             → eval-able lines for the bash runners
//                                          (AGENT_BIN, AGENT_PROMPT_FLAG, AGENT_EXTRA_ARGS,
//                                           AGENT_MODEL_FLAG, AGENT_SECRETS, AGENT_API_KEY_ENV,
//                                           AGENT_INSTALL_HINT, AGENT_CONNECTOR, MODEL_MAIN,
//                                           MODEL_SUMMARY, TIMEOUT_* …)
//   node config.mjs policy               → the generated MCP POLICY block (allow + read/write)
//   node config.mjs render <prompt.md>   → prompt with {{TOKENS}} substituted, to stdout
//
// Missing config.json → built-in defaults (current cursor setup), so nothing breaks.
import { readFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, '..', 'config.json')

const DEFAULTS = {
  user: { name: '', accountId: '', email: '' },
  endpoints: { jiraBase: '', confluenceBase: '', bitbucketBase: '' },
  connector: {
    active: 'cursor',
    cursor: {
      bin: 'cursor-agent',
      binFallbacks: ['~/.local/bin/cursor-agent'],
      promptFlag: '-p',
      extraArgs: ['--output-format', 'text', '--force'],
      modelFlag: '--model',
      secretsFile: '~/.cursor/mcp-secrets.env',
      apiKeyEnv: 'CURSOR_API_KEY',
      install: 'curl https://cursor.com/install -fsS | bash',
    },
  },
  mcp: {
    jira: { enabled: true, read: true, write: false },
    confluence: { enabled: true, read: true, write: false },
    bitbucket: { enabled: true, read: true, write: false },
  },
  models: { main: 'auto', summary: 'auto' },
  timeouts: { dailySec: 1800, weeklySec: 7200, summarySec: 600, refreshSec: 600 },
  app: { servePort: 4321, requiredApprovals: 2, branding: {} },
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    // Shallow-merge top-level sections over defaults so a sparse config still works.
    const merged = { ...DEFAULTS }
    for (const k of Object.keys(raw)) if (!k.startsWith('_')) merged[k] = raw[k]
    return merged
  } catch (e) {
    process.stderr.write(`config.mjs: config.json invalid (${e.message}) — using defaults\n`)
    return DEFAULTS
  }
}

const cfg = loadConfig()
const untilde = (p) => (typeof p === 'string' && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function activeConnector() {
  const name = cfg.connector?.active || 'cursor'
  const c = cfg.connector?.[name]
  if (!c) {
    process.stderr.write(`config.mjs: connector "${name}" not defined in config.json — falling back to cursor defaults\n`)
    return { name: 'cursor', ...DEFAULTS.connector.cursor }
  }
  return { name, ...c }
}

/** Generated MCP allow/deny + read/write policy block, injected into every agent prompt. */
function mcpPolicy() {
  const conn = activeConnector()
  const entries = Object.entries(cfg.mcp || {})
  // A server is usable only when enabled AND at least one of read/write is granted.
  const allowed = entries.filter(([, v]) => v?.enabled && (v.read !== false || v.write === true))
  const denied = entries.filter(([, v]) => !(v?.enabled && (v.read !== false || v.write === true)))
  const lines = []
  lines.push(`MCP POLICY (from config.json — enforced; the "${conn.name}" connector provides these servers):`)
  for (const [name, v] of allowed) {
    const canRead = v.read !== false
    const canWrite = v.write === true
    const rw =
      canRead && canWrite
        ? 'READ + WRITE allowed (create/update/comment permitted when the task requires it)'
        : canWrite
          ? 'WRITE-ONLY: you may create/update when the task requires it, but do NOT query/browse it'
          : 'READ-ONLY: query/fetch freely, but NEVER create, update, delete, transition, comment, or push'
    lines.push(`  • ${name} — ALLOWED, ${rw}.`)
  }
  for (const [name] of denied) lines.push(`  • ${name} — FORBIDDEN: do not call it at all.`)
  lines.push('Any MCP server NOT listed above is FORBIDDEN. Never write anywhere unless its line explicitly allows WRITE.')
  return lines.join('\n')
}

/** {{TOKEN}} substitution map for the prompt files. */
function tokens() {
  return {
    USER_NAME: cfg.user?.name ?? '',
    USER_ID: cfg.user?.accountId ?? '',
    USER_EMAIL: cfg.user?.email ?? '',
    JIRA_BASE: cfg.endpoints?.jiraBase ?? '',
    CONFLUENCE_BASE: cfg.endpoints?.confluenceBase ?? '',
    BITBUCKET_BASE: cfg.endpoints?.bitbucketBase ?? '',
    REQUIRED_APPROVALS: String(cfg.app?.requiredApprovals ?? 2),
    // Machine-derived (not from config) — makes the prompts path-portable automatically.
    INTERN_DIR: resolve(HERE, '..'),
    MCP_POLICY: mcpPolicy(),
  }
}

function render(file) {
  let text = readFileSync(resolve(file), 'utf8')
  const map = tokens()
  // Identity-critical tokens must not be empty — an agent run without them burns a full
  // timed run fetching nothing. Loud warning (lands in the runner's log via stderr).
  const missing = ['USER_NAME', 'USER_ID', 'JIRA_BASE'].filter((k) => !map[k])
  if (missing.length)
    process.stderr.write(`config.mjs: WARNING identity tokens empty (fill config.json → user/endpoints): ${missing.join(', ')}\n`)
  text = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in map ? map[key] : m))
  // Any token we don't know stays literal — flag it so a typo never reaches the agent silently.
  const leftover = [...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1])
  if (leftover.length) process.stderr.write(`config.mjs: WARNING unknown tokens left in ${file}: ${[...new Set(leftover)].join(', ')}\n`)
  return text
}

const shq = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'` // single-quote for shell eval

function shellenv() {
  const conn = activeConnector()
  const out = []
  out.push(`AGENT_CONNECTOR=${shq(conn.name)}`)
  out.push(`AGENT_BIN=${shq(conn.bin)}`)
  out.push(`AGENT_BIN_FALLBACKS=${shq((conn.binFallbacks || []).map(untilde).join(':'))}`)
  out.push(`AGENT_PROMPT_FLAG=${shq(conn.promptFlag ?? '-p')}`)
  // NOTE: args are space-joined — individual args must not contain spaces (documented in CONFIG.md).
  out.push(`AGENT_EXTRA_ARGS=${shq((conn.extraArgs || []).join(' '))}`)
  out.push(`AGENT_MODEL_FLAG=${shq(conn.modelFlag ?? '--model')}`)
  out.push(`AGENT_SECRETS=${shq(untilde(conn.secretsFile ?? ''))}`)
  out.push(`AGENT_API_KEY_ENV=${shq(conn.apiKeyEnv ?? '')}`)
  out.push(`AGENT_INSTALL_HINT=${shq(conn.install ?? '')}`)
  out.push(`REQUIRED_APPROVALS=${shq(cfg.app?.requiredApprovals ?? 2)}`)
  out.push(`MODEL_MAIN=${shq(cfg.models?.main ?? 'auto')}`)
  out.push(`MODEL_SUMMARY=${shq(cfg.models?.summary ?? 'auto')}`)
  out.push(`TIMEOUT_DAILY=${shq(cfg.timeouts?.dailySec ?? 1800)}`)
  out.push(`TIMEOUT_WEEKLY=${shq(cfg.timeouts?.weeklySec ?? 7200)}`)
  out.push(`TIMEOUT_SUMMARY=${shq(cfg.timeouts?.summarySec ?? 600)}`)
  out.push(`TIMEOUT_REFRESH=${shq(cfg.timeouts?.refreshSec ?? 600)}`)
  return out.join('\n')
}

const [cmd, arg] = process.argv.slice(2)
switch (cmd) {
  case 'get': {
    const v = getPath(cfg, arg ?? '')
    if (v === undefined) process.exit(1)
    process.stdout.write(typeof v === 'object' ? JSON.stringify(v) : String(v))
    break
  }
  case 'shellenv':
    process.stdout.write(shellenv() + '\n')
    break
  case 'policy':
    process.stdout.write(mcpPolicy() + '\n')
    break
  case 'render':
    if (!arg) {
      process.stderr.write('usage: node config.mjs render <prompt-file>\n')
      process.exit(2)
    }
    process.stdout.write(render(arg))
    break
  default:
    process.stderr.write('usage: node config.mjs <get <dot.path> | shellenv | policy | render <file>>\n')
    process.exit(2)
}
