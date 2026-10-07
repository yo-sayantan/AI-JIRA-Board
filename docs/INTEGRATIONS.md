# Integrations — Jira, Bitbucket, the server API, Docker, and the config chain

How the pieces talk to each other and to the outside world. Companion to `DATA-FLOW.md`
(files) and `AI-PIPELINE.md` (models).

## Jira (REST v2, personal access token)

- Auth: `Authorization: Bearer $JIRA_PERSONAL_TOKEN` (`_jira.py::jira_get`), TLS with a relaxed
  context (on-prem instances behind private CAs), retry-with-backoff on 5xx/network
  (`get_json`, 4 retries), 120s timeout.
- One field list (`_jira.py::FIELDS`) shared by all fetches: summary, status, issuetype,
  priority, updated, created, resolutiondate, assignee, reporter, labels, components,
  fixVersions, description, comment, issuelinks, parent, subtasks, and the instance's custom
  fields (story points ×2, sprint, epic link, acceptance criteria). The raised fetch uses a
  lighter list (`raised.py::RAISED_FIELDS`) — no comment bodies, no subtasks.
- `expand=changelog` rides along with every search: it powers status timelines
  (`build_update_log`), done-date fallback (`changelog_done_date` — `resolutiondate` is null when
  a ticket jumps straight to Done), and the Raised view's assignee hand-off trail
  (`assignee_history`).
- The JQL queries, complete list:

| Query | Job |
|---|---|
| `assignee = currentUser() AND statusCategory != Done OR (… Done AND resolved >= -10d)` | daily fetch |
| `parent in (<active keys>)` | all sub-tasks, one batched search |
| `(assignee WAS currentUser() OR assignee = currentUser()) [+ scope]` | archive rebuild |
| `key in (<parent keys>)` | archive context parents |
| `reporter = currentUser() AND issuetype not in subTaskIssueTypes()` | raised list (pages in parallel) |
| `parent = <KEY>` | per-ticket refresh sub-tasks |

  Compat fallbacks: `statusCategory = Done` → explicit statuses on 400;
  `subTaskIssueTypes()` → plain reporter search on 400 (the parent-field filter still drops
  sub-tasks). Pagination never trusts `total` blindly — permission-filtered results can return
  fewer rows than promised, so the loop stops on an empty batch.

## Bitbucket (Server/DC REST 1.0) + Jira dev-status

Branch/PR truth comes from **Jira's dev-status API first** (`devinfo.py` — repo-agnostic,
authoritative, includes reviewers/approvals); a Bitbucket **key-scan** of hinted repos
(`REPO_HINTS`/`BB_PROJECT` maps in `daily_fetch.py`) only supplements when dev-status has no PRs
(the symptom of the Jira↔Bitbucket link being down). Rules:

- PR identity is `(project, repo, id)` — ids repeat across repos (`_pr_identity`).
- PR state mapping: ≥`requiredApprovals` approvals + 0 open comments → `approved`; NEEDS_WORK →
  `changes`; merged/declined terminal (with fixed comment stats — closed PRs skip activity pages).
- Bitbucket is probed once per run; if down, `BB_OK=False` and all PR data is **carried forward**
  (the run note says so). Single-ticket refresh always skips Bitbucket (dev-status only) so a
  hung Bitbucket can't wedge the queue.
- Review activity never bumps Jira's `updated` → even "unchanged" tickets re-check PRs on the
  daily fast path.

## Confluence & links

No Confluence API calls in the scripted path — Confluence/external links are harvested from
ticket descriptions/comments by URL pattern (`extract_links`), keeping prior excerpts. The
LLM-agent fallback may read Confluence through MCP (policy string from `config.mjs policy`).

## The local server — complete API

`serve.mjs` routes (all under `http://localhost:4321`):

| Route | Does |
|---|---|
| `POST /api/run-intern` | Start the daily fetch (409 if any writer is busy). |
| `POST /api/run-archive?scope=all|year|since|key&…` | Start the archive rebuild. `POST /api/run-archive/stop` kills it. |
| `POST /api/run-raised` | Start the raised-by-me refresh. |
| `POST /api/refresh-ticket?key=K` | Queue a single-ticket refresh (FIFO, idempotent). |
| `GET /api/intern-status` | THE poll: run state + job type (daily/archive/raised/external), lastExit, progress, refresh queue, report queues, AI status. |
| `GET /api/reports` · `GET /api/reports/<KEY>` · `POST /api/report?key=K` · `POST /api/reports/bulk?scope=…` · `POST /api/reports/stop` | PR-report index / one report / generate one / bulk / stop. |
| `GET|POST /api/settings` | Machine-wide settings (mirrored to `.settings.json`). |
| `GET /api/ai-status` · `GET /api/ai-models` · `GET /api/cloud-models` · `POST /api/ai-models/pull` · `POST /api/ai-jobs` | Proxied to the AI intern. |
| static | Allowlist only: `/dist/`, `/docs/`, `/setup/`, `/ai-intern/models.json`, `/jira-intern/data.js(on)`, `/jira-intern/reports/index.js`. Gzip + ETag/304, in-memory cache keyed by mtime. |

Client side, every route has a typed wrapper in `src/lib/runner.ts`; `src/lib/statusPoller.ts`
multiplexes all watchers onto ONE `/api/intern-status` request at the fastest subscribed rate.

## Docker topology

```
docker compose (project jira-project)
├─ JIRA-Board   :4321  server + fetch scripts (python3 + tini), REFRESH_ON_START/INTERVAL
├─ AI-Intern    :4322  worker.py (jobs: briefs, report enrichment, pulls)
└─ AI-Ollama    :11434 local inference (volume jira-ai-models)
shared mounts: ./jira-intern (DATA — follows the deploy directory!), ./config,
               ~/.cursor (read-only, tokens), ~/.ai (read-only, identity)
```

Image build: stage `dist-build` (npm ci + vite) **or** stage `dist-prebuilt` (host-built `dist/`
copied in), selected by `--build-arg DIST_SOURCE`; `start-jira-board.sh` host-builds and passes
`prebuilt` because in-image npm over the Docker VM's network silently drops optional native
binaries (TypeScript 7 platform packages). The runtime stage seeds `/opt/jira-intern-seed` so an
empty mounted volume gets a working skeleton on first boot.

## Config & settings precedence (identity, URLs, knobs)

```
config/jira-board.config.json      tracked, GENERIC defaults + policy (ports, repo hints, AI defaults…)
        ▲ deep-merged with
~/.ai/config.json ($AI_CONFIG_FILE) personal: your name, accountId, company base URLs   [outside repo]
        ▲ overridden at runtime by
jira-intern/.settings.json          what you change in the board's Settings (server-relevant slice)
```

`local-runner/config.mjs` is the single merger: `shellenv` (vars for the runners, incl.
`REFRESH_WORKERS`), `policy` (MCP policy string for agent prompts), `path`/`print` for debugging.
The app receives the non-secret slice as `window.__JIRA_CONFIG__` (written next to the data by
`datafile._app_config`). Secrets NEVER pass through this chain — scripts read
`~/.cursor/mcp-secrets.env` directly into process env (`load_agent_secrets` / `load_env`).

## Scheduler

`server/schedule.mjs` runs the Settings cadences (active refresh daily/twice-daily; full refresh
and report backfill daily/weekly/twice-weekly), stamping `.schedule.json`, always through the
same `startDaily`/`startArchive` gates as the buttons — so scheduled and manual runs can never
overlap. In-container cron behaviour additionally honours `REFRESH_ON_START` / `REFRESH_INTERVAL`
(default: fetch on boot, then every 15 minutes).
