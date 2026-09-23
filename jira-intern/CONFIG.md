# Central project configuration

[`config/jira-board.config.json`](../config/jira-board.config.json) is the versioned source
of truth for every non-secret default and policy in jira-board + jira-intern. Its schema is
[`config/jira-board.config.schema.json`](../config/jira-board.config.schema.json).

## Precedence

Configuration is deep-merged in this order:

| # | Location | Purpose |
|---|---|---|
| 1 | `config/jira-board.config.json` | Complete tracked defaults and policy. |
| 2 | `$AI_CONFIG_FILE` or `~/.ai/config.json` | Optional sparse personal override. |
| 3 | `jira-intern/.settings.json` | Saved runtime AI choices from the Settings window. |

Only put fields that differ from project defaults in the personal override:

```bash
mkdir -p ~/.ai
cp setup/config.example.json ~/.ai/config.json
chmod 600 ~/.ai/config.json
```

Check which file is actually in effect at any time:

```bash
node jira-intern/local-runner/config.mjs path
```

Node, Python, the local server, shell runners, Docker, and the AI worker all use the same
deep-merge contract. Run `node jira-intern/local-runner/config.mjs validate` to validate it,
or `... export` to inspect the effective configuration.

> **Note:** no API tokens live in `config.json` — those go in your secrets env file
> (see `setup/mcp-secrets.env.template`).

Consumed by:
- `local-runner/config.mjs` — resolver. Runners call it for shell vars (`shellenv`), rendered
  prompts (`render`, substituting the `{{TOKENS}}` below), and the MCP policy block (`policy`).
- `local-runner/*.sh` — daily / weekly / summary / per-ticket runners (connector, models, timeouts).
- `jira-board/serve.mjs` — port.
- `local-runner/sync-datajs.mjs` — injects the `app` section into `data.js` as
  `window.__JIRA_CONFIG__`, so the **built** app re-themes at runtime (no rebuild needed).

The tracked project config is required. Invalid JSON, schema fields, port, or AI policy fails
validation loudly. An invalid timezone falls back to UTC; legacy `IST` normalizes to
`Asia/Kolkata`.

---

## `user` — who you are
| key | meaning |
|---|---|
| `name` | Your display name exactly as Jira shows it (used to match "assigned to me"). |
| `accountId` | Your corporate user id (e.g. `ABC1234`). Matched case-insensitively against assignee strings. |
| `email` | Informational. |

## `endpoints` — your company's servers
`jiraBase`, `confluenceBase`, `bitbucketBase` — base URLs, no trailing slash. Injected into
every prompt (`{{JIRA_BASE}}` etc.), so ticket/PR links and JQL all point at YOUR instances.

## `connector` — which agent CLI provides the MCP servers
`active` selects the profile: `"cursor"` (default), `"codex"`, or `"claude"` — add your own
profile object with the same keys for any other CLI.

Per-profile keys:
| key | meaning |
|---|---|
| `bin` | CLI executable name on PATH. |
| `binFallbacks` | Extra absolute paths to try (supports `~`). |
| `promptFlag` | Flag/subcommand that takes the prompt (`-p` for cursor/claude, `exec` for codex). |
| `extraArgs` | Additional args. **Each arg must not contain spaces** (they are space-joined for the shell). |
| `modelFlag` | Flag that selects a model (`--model`). |
| `secretsFile` | Env file sourced before each run (API key + MCP tokens). Never committed. |
| `apiKeyEnv` | Env var the CLI needs for headless auth (warned about when empty). |
| `install` | One-liner shown when the CLI is missing. |

The MCP **servers themselves** (jira/confluence/bitbucket) are configured in the connector's
own config (e.g. `~/.cursor/mcp.json`) — this file decides which of them the agent MAY use.

## `mcp` — allow-list + read/write policy per MCP server
```json
"jira": { "enabled": true, "read": true, "write": false }
```
- `enabled: false` → the server is FORBIDDEN (the generated policy tells the agent not to call it).
- `read: true, write: false` → READ-ONLY: query/fetch, but never create/update/delete/
  transition/comment/push on that system.
- `write: true` → write operations are also allowed when a task requires them.
- `read: false, write: false` → treated as FORBIDDEN (nothing is permitted).
- `read: false, write: true` → WRITE-ONLY (may create/update, told not to browse).

This map is rendered into the `{{MCP_POLICY}}` block of every prompt (daily, weekly,
per-ticket refresh), so tightening/loosening permissions is a config-only change.

### Prompt tokens (rendered by `config.mjs render`)
`{{USER_NAME}} {{USER_ID}} {{USER_EMAIL}} {{JIRA_BASE}} {{CONFLUENCE_BASE}} {{BITBUCKET_BASE}}
{{REQUIRED_APPROVALS}} {{MCP_POLICY}} {{INTERN_DIR}}` — the last one is machine-derived (the
absolute path of this folder), so the prompts are path-portable with zero configuration.

## `models`
| key | meaning |
|---|---|
| `main` | Model for the daily/weekly/refresh runs. `"auto"` = let the connector pick (no flag passed). Env `MODEL=` overrides per run. |
| `summary` | Model for the cheap local AI-summary pass — set a fast/cheap one (e.g. `haiku-4.5`, `gpt-4o-mini`, `gemini-2.5-flash`). Env `SUMMARY_MODEL=` overrides. |

## `ai`
Defaults for Settings and the intern worker: `level`, `backend`, local/cloud models,
`cloudProvider`, `cloudEffort`, `useHostOllama`, and the allowed effort list. Saved choices
in `jira-intern/.settings.json` override these defaults. The local model catalog remains
`ai-intern/models.json`; `models.catalog` points to it.

## `reports` — PR Readiness Reports
| key | meaning |
|---|---|
| `autoGenerate` | `true` (default): after every fetch / single-ticket refresh, (re)generate the report of any ticket whose PR appeared or changed — in the background, never delaying the fetch. `false` turns the automation off (the drawer button still works). |
| `year` | Which tickets the automatic pass and `pr-reports-backfill.sh` consider (by created/resolved year). Default `2026`. |
| `maxPerRun` | Cap per automatic pass so a backlog never runs for hours. Default `5`. Manual backfills are uncapped unless `--max` is given. |

Models: `models.report` picks the connector-agent model (`"auto"` = connector default; env
`REPORT_MODEL=` overrides). `timeouts.reportSec` (default 600) bounds one enrichment run.
Settings AI usage **None** skips report AI; otherwise enrichment is queued for JIRA-AI-Intern.
Reports are written to `jira-intern/reports/` — git-ignored; they contain real ticket and PR content.

`defaultWindowDays` and `presetWindowDays` control the report menu's custom-date default and
quick ranges.

## `archive`
`maxFetch`, `workers`, `defaultWindowDays`, and `presetWindowDays` control archive rebuild
capacity and the archive menu.

## `refresh`
`onStart` and `intervalSec` control the container's initial and periodic active-ticket fetch.
Explicit `REFRESH_ON_START` / `REFRESH_INTERVAL` environment values still win.

## `timeouts` (seconds)
`dailySec` (default 1800), `weeklySec` (7200, env `TIMEOUT_SEC` overrides), `summarySec` (600),
`refreshSec` (600).

## `app` — UI/runtime settings (picked up without a rebuild)
| key | meaning |
|---|---|
| `servePort` | Port for `npm run serve` (env `PORT` overrides). |
| `requiredApprovals` | How many PR approvals count as "approved" (badge + pips). |
| `timeZone` | IANA timezone used for report generation, enrichment, UI, and PDF timestamps. |
| `doneBoardDays` | Days a newly Done ticket remains on the active board. |
| `polling` | Busy/idle report and AI polling intervals. |
| `progress` | Header progress phase percentages. |
| `settingsDefaults` | Appearance and feature defaults before saved browser choices. |
| `branding.tagline` | Left footer text. |
| `branding.badgeText` / `badgeUrl` / `badgeTitle` | The footer "made by" badge — put your own name/portfolio here. |

> The `app` section reaches the built app through `data.js` (`window.__JIRA_CONFIG__`), which
> is regenerated by every runner — so after editing it, run any intern job (or
> `node local-runner/sync-datajs.mjs .` from this folder) to see it in the UI.

---

## Porting checklist (new user)
0. `mkdir -p ~/.ai && cp setup/config.example.json ~/.ai/config.json` — optional sparse
   personal override, outside the repo.
1. Edit `~/.ai/config.json`: your `user`, your `endpoints`, your `connector.active` (+ its
   `secretsFile` with your API key/tokens), your `app.branding`.
2. Make sure your connector CLI has the three MCP servers (jira / confluence / bitbucket)
   configured (e.g. `~/.cursor/mcp.json` for cursor).
3. `bash local-runner/run-intern.sh` → daily data; `bash local-runner/update-completed.sh` →
   full archive; open `dist/index.html`.
