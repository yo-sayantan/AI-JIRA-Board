# Architecture — how it works

## The one idea

The board **never talks to Jira**. A separate pipeline (`jira-intern/`) fetches your tickets and
writes them to a plain data file. The UI is a static single-page app that reads that file. An
optional Node server adds live buttons and a scheduler; an optional AI worker enriches PR reports
through a file queue. Decoupling the pieces means the app is a fast, dependency-free
`dist/index.html` you can double-click, and refreshing the data **never rebuilds the app**.

```
                 ┌──────────────────────────── docker compose (project jira-project) ────────────────────────────┐
                 │                                                                                                │
  Jira ◀──REST───┤  ┌─ JIRA-Board (node:26-bookworm-slim, user node) ───────────┐                               │
  Bitbucket ◀────┤  │  serve.mjs + server/*.mjs           :4321 ◀──────────────────── 127.0.0.1:4321 (BIND_IP)  │
  Confluence ◀───┤  │   ├─ spawns  jira-intern/local-runner/*.sh                 │                               │
                 │  │   │          └─ daily_fetch.py · completed_archive.py       │   ~/.cursor → /home/node/.cursor (ro)
                 │  │   │             pr_report.py (base)                         │   ~/.ai     → /home/node/.ai     (ro)
                 │  │   ├─ schedule.mjs  (Settings → Background jobs)             │   ./config  → /app/config         (ro)
                 │  │   └─ ai.mjs ── writes .ai-queue/*.json ── proxies /api/ai-* ┼─▶ http://jira-ai:4322            │
                 │  └───────────────┬──────────────────────────────────────────────┘                               │
                 │                  │  ./jira-intern  (bind mount, shared read-write)                             │
                 │  ┌───────────────┴──────────────────────────────────────────────┐                               │
  Jira/Bitbucket◀┤  │  AI-Intern (python:3.12-slim, root)  worker.py  :4322        │  ~/.cursor → /root/.cursor (ro) │
  (read-only)    │  │   claims .ai-queue → enriches reports/<KEY>.json             │  ~/.ai     → /root/.ai     (ro) │
  Anthropic /    │  │   ├─ OLLAMA_HOST=http://ollama:11434 ──────▶ AI-Ollama :11434 │  ./config  → /app/config  (ro)  │
  Gemini /       │  │   └─ HOST_OLLAMA_URL=http://host.docker.internal:11434 ──────┼──▶ Ollama.app on the host       │
  Cursor (opt.) ◀┤  └──────────────────────────────────────────────────────────────┘                               │
                 │  ┌─ AI-Ollama (ollama/ollama) ── volume jira-board_jira-ai-models ─┐                            │
                 │  └──────────────────────────────────────────────────────────────────┘                            │
                 └────────────────────────────────────────────────────────────────────────────────────────────────┘

  Browser ──▶ http://localhost:4321/dist/index.html   (or file://…/dist/index.html with no server at all)
                 reads  /jira-intern/data.json (served)  ·  ../jira-intern/data.js  (file://)
```

## Container topology

`docker-compose.yml` defines three services (`docker compose up -d --build` starts all of them;
`docker compose up -d --build jira-board` starts the board alone — the `jira-ai` dependency is
marked `required: false`, so the board degrades to "AI intern offline"):

| Service | Container | Image | Runs as | Port | Mounts |
|---|---|---|---|---|---|
| `jira-board` | **JIRA-Board** | built from `Dockerfile` — `node:26-bookworm-slim` + Debian `python3` (3.11), `tini`, `ca-certificates` | `node` (uid 1000, `HOME=/home/node`) | container 4321 → host `${BIND_IP:-127.0.0.1}:${PORT:-4321}` | `~/.cursor` → `/home/node/.cursor` (ro) · `~/.ai` → `/home/node/.ai` (ro) · `./config` → `/app/config` (ro) · `./jira-intern` → `/app/jira-intern` (rw) |
| `ollama` | **AI-Ollama** | `ollama/ollama:latest` | root | 11434 (internal only) | named volume `jira-board_jira-ai-models` → `/root/.ollama` (created automatically) |
| `jira-ai` | **AI-Intern** | built from `ai-intern/Dockerfile` — `python:3.12-slim` | root | 4322 (internal only; the board proxies it) | `./jira-intern` (rw) · `~/.cursor` → `/root/.cursor` (ro) · `~/.ai` → `/root/.ai` (ro) · `./config` (ro) · `./ai-intern/models.json` → `/app/models.json` (ro) |

Points worth knowing:

- **Only 4321 is published**, and on loopback by default. `BIND_IP=0.0.0.0` publishes it on the
  LAN; the server then also needs `ALLOWED_HOSTS=<host[:port]>,…` because it answers only to
  loopback names, its own bind address, or listed hosts (403 `forbidden host` otherwise — the
  defence against DNS rebinding). See [SECURITY.md](SECURITY.md).
- **Secrets are mounted as directories**, not files: a single-file bind keeps pointing at the old
  inode after an editor rewrites `mcp-secrets.env`.
- **The board image is non-root.** `./jira-intern` must be writable by uid 1000 — transparent on
  Docker Desktop; on a Linux host `sudo chown -R 1000:1000 ./jira-intern` once.
- **`host.docker.internal`** (`extra_hosts: host-gateway`) is how AI-Intern reaches an Ollama
  running on the host when Settings → **Host Ollama · Metal** is on.
- Both images have **HEALTHCHECK**s: the board probes `/api/intern-status`, the worker probes
  `/health` (503 once a queue thread has died). `tini` is PID 1 in the board so Python children
  are reaped.
- `start-jira-board.sh` wraps compose: frees the fixed port, rebuilds **without `--pull`** (set
  `PULL=1` to re-pull base images), redeploys, waits for health, opens the board.

## The pieces

### 1. `jira-intern/` — the data pipeline ("the intern")

Python scripts plus thin shell runners that produce two files: **`data.json`** (canonical) and
**`data.js`** (`window.__JIRA_DATA__ = <that json>;` plus `window.__JIRA_CONFIG__` = the `app`
config block, so the board loads from `file://` and re-themes without a rebuild).

| File | Role |
|---|---|
| `daily_fetch.py` | Active tickets assigned to you → `data.json`/`data.js`. `--key K` refreshes one ticket in place. Decides each ticket's `column` (`_jira.status_column`). |
| `completed_archive.py` | The full historical Completed archive (`completed[]`), cached per ticket in `cache/`. Scopes: all / year / since / key. Exit 4 = partial. |
| `pr_report.py` | PR Readiness Reports: deterministic base → `reports/<KEY>.json`; `needs-report`, `uptodate`, `validate`, `status-add/remove`, `mark-enriched`. Owns verdict, score and tones. |
| `_jira.py` · `devinfo.py` · `_sprint.py` | Shared Jira/Bitbucket HTTP (retry/backoff, TLS via `ssl_context()`), field formatting, dev-status (branches/PRs), sprint parsing. |
| `_config.py` · `datafile.py` · `progress.py` | Config deep-merge (mirrors `config.mjs`), the single atomic writer for `data.json`+`data.js` with the `.data.lock` flock, `.progress.json`. |
| `ai_queue.py` | The file queue under `.ai-queue/` shared with AI-Intern: validated `enqueue`, `claim_next` (rename → `.running`), `.ai-status.json`. |
| `local-runner/run-intern.sh` · `update-completed.sh` · `refresh-ticket.sh` | Locked runners for daily / archive / one ticket. Fast path = the Python script; an agent CLI is only a fallback. |
| `local-runner/pr-report.sh` · `pr-reports-backfill.sh` | One report / every ticket-with-PR. Write the base, then enqueue enrichment. |
| `local-runner/runner-env.sh` · `lock-util.sh` | PATH, config shellenv, secrets allow-list export, timeouts, log rotation; the lock protocol. |
| `local-runner/config.mjs` | Resolver: `get · export · validate · shellenv · policy · render · path`. |
| `local-runner/sync-datajs.mjs` · `sync-reports.mjs` · `carry-aisummary.mjs` | Atomic regeneration of `data.js` and `reports/index.js`; carry `aiSummary` across rewrites. |
| `prompts/intern-prompt.md` | The ticket schema in prose for the agent fallback — mirrors `src/types.ts`. The other prompt files are reference specifications. |

Configuration: `config/jira-board.config.json` (tracked defaults, schema-validated) ← sparse
override from `$AI_CONFIG_FILE` or `~/.ai/config.json` ← saved Settings in
`jira-intern/.settings.json`. Every key: [`../jira-intern/CONFIG.md`](../jira-intern/CONFIG.md).

The fetch needs only a **Jira token**. Confluence/Bitbucket tokens enrich the output (linked docs,
real branches, PR state); the optional AI keys are read only by AI-Intern.

### 2. `src/` — the React app

Vite + React 19 + Tailwind v4 + Motion, compiled to a **single** `dist/index.html` (all JS/CSS
inlined, module script downgraded to a classic one so `file://` works).

| File | Role |
|---|---|
| `src/types.ts` | **The data contract** for `data.json`. Mirrored in prose by `prompts/intern-prompt.md`. |
| `src/lib/reportTypes.ts` | The report contract for `reports/<KEY>.json`. Mirrored by `pr_report.py`. |
| `src/lib/columns.ts` | Column metadata and the **fallback** status → column mapping for dumps without `column`. Mirrors `_jira.py _STATUS_COLUMNS`. |
| `src/data.ts` | Normalises a dump, retires old Done tickets (`app.doneBoardDays`), applies manual "move to Completed" (`localStorage` `jb-archived`). |
| `src/lib/settings.ts` | Settings schema: the `FEATURES` registry, server-synced fields, parsing/clamping, theme resolution. |
| `src/lib/runner.ts` · `statusPoller.ts` | Typed client for the server API; the single poller for `/api/intern-status` (fastest subscriber wins, pauses when hidden). |
| `src/lib/boardView.ts` · `format.ts` · `search.ts` | Pure derivations: search → columns / On Hold / Next Sprint; freshness buckets; sprint parsing; ticket search. |
| `src/hooks/` | `useBoardSettings` (localStorage + server sync), `useBoardData`, `useInternJobs`, `useReports`, `useDrawerStack`, `useToasts`, `usePageEffects` (shortcuts, scroll lock). |
| `src/components/` | `board/` (columns, cards, Stats chips, Next Sprint, On Hold, StaleBanner), `header/` (Header, ArchiveMenu, ReportsMenu, ScopeMenu), `ticket/`, `completed/`, `reports/`, `settings/`, `common/` (NoticesDock, Toast, ErrorBoundary, Icons). |
| `vite.config.ts` | Single-file build; injects `../jira-intern/data.js` and `../jira-intern/reports/index.js` as external scripts. |

### 3. `serve.mjs` + `server/` — the optional local server

Zero-dependency Node (`node serve.mjs` / `npm run serve`; the container's `CMD`). `serve.mjs`
holds the route table and request guards (its header comment is the API reference, copied into
[API.md](API.md)); `server/` holds one module per concern:

| Module | One line |
|---|---|
| `config.mjs` | `PATHS` of every runtime file, `PORT`/`HOST`/`ALLOWED_HOSTS`, `AI_INTERN_URL`, key/year/date regexes. |
| `http.mjs` | JSON responses with security headers, body reader with 413 handling, the static handler (allow-list, in-memory gzip, ETag, `no-cache` vs `no-store`). |
| `locks.mjs` | Reads `.intern.lock` / `.completed.lock` with the three staleness rules; deletes stale locks. |
| `queue.mjs` | `runProcess` (spawn → exit code) and `KeyQueue` (FIFO of ticket keys, one at a time, waits while a writer is busy, bounded). |
| `jobs.mjs` | The data writers: start/stop the daily fetch and the archive rebuild, the per-ticket refresh queue, `runStatus()`. |
| `reports.mjs` | The report queue (base via `pr_report.py base`, then enqueue enrichment), bulk scope resolution via `needs-report`, mtime-cached report index, external-generation registry. |
| `ai.mjs` | Reads/writes `.ai-queue/`, 1 s-cached `/api/status` from AI-Intern, the `/api/ai-*` proxy with body limits and a 503 when the worker is down. |
| `settings.mjs` | The server-side settings schema, defaults from the project config, atomic writes to `.settings.json`. |
| `schedule.mjs` | The scheduler: once a minute, start jobs whose cadence is due; stamps in `.schedule.json`. |

### 4. `ai-intern/worker.py` — the AI-Intern worker

One Python process: HTTP control plane on **4322** (`/health`, `/api/status`, `/api/models`,
`/api/cloud-models`, `/api/jobs`, `/api/models/pull` — see [API.md](API.md)) plus
`reportParallel` worker threads consuming `.ai-queue/`. Providers: Ollama (compose service or
host), Anthropic Messages API, Google Gemini API, Cursor Cloud Agents. The system prompt is
`ai-intern/prompts/enrich.txt`; all ticket and PR text is wrapped in `<untrusted_data>`. Optional
proof lookups (Bitbucket build status, Checkmarx, Dynatrace) run when their keys/endpoints are
configured and fill the "CI green" / "Security scan" gate rows; otherwise those rows stay
"Not read" / "Not verified".

## How data reaches the screen

1. A runner writes `jira-intern/data.json`, then `data.js` (atomically, under `.data.lock`).
2. `dist/index.html` includes `<script src="../jira-intern/data.js">` (injected by the build).
3. `src/data.ts` normalises the dump and applies board rules.
4. React renders the board, sections and drawer from `src/types.ts`-shaped data.

Because the data file is external to the bundle, **new data never requires a rebuild**. In served
mode a finished job swaps in `/jira-intern/data.json` without reloading the page; on `file://` the
board reloads to pick up `data.js`.

Caching: the bundle, docs and setup templates are served `Cache-Control: no-cache` with an ETag,
so an unchanged file costs a 304. **`data.json`, `data.js` and `reports/index.js` are served
`Cache-Control: no-store`** — Jira content never lands in the browser's disk cache — so each
in-place reload transfers the file (an ETag is still set for clients that send `If-None-Match`).

## PR Readiness Reports — the AI queue flow

```
  trigger ─────────────▶ deterministic base ──────▶ enqueue ─────▶ AI-Intern ──────▶ validate ──▶ reports/<KEY>.json
  • fetch finished        pr_report.py base KEY      .ai-queue/      claim: rename       may only ADD      written atomically
    (backfill --auto)     reports/<KEY>.json         <id>-KEY.json   → .json.running     (validate_report  (restore the base
  • ticket refreshed      status-add KEY PID         {type:enrich-   snapshot base       + preserved_      copy on any error)
  • drawer / header       → "Generating…"            report, key,    build prompt        errors)
    button                                            level, backend, (untrusted_data)
  • scheduler                                         model, …}       infer → JSON
```

- **Who enqueues:** `server/reports.mjs` (served mode) or `pr-report.sh` → `ai_queue.py enqueue`
  (terminal, cron, backfill). Both validate the key and model tag; duplicates against pending and
  claimed jobs are collapsed.
- **Level None** stops after the base. Levels Low / Moderate / Max only change the inference
  timeout.
- **The worker** claims the oldest job by renaming it, writes `.ai-status.json`, re-runs
  `pr_report.py base` if the report is missing, snapshots the base to `reports/.base-<KEY>.json`,
  collects proof rows, calls the provider from the job (`backend`, `model`, `cloudProvider`,
  `cloudEffort`, `useHostOllama` — the saved Settings override the queued values), merges the
  JSON, runs `validate_report` against the base, and writes atomically. Any failure restores the
  base. `.ai-cancel-report` (written by **Stop reports**) aborts jobs claimed before it.
- **Orphans:** on restart, `.json.running` files are renamed back to `.json`; the board ignores a
  `.running` file older than 30 min.
- Other job types on the same queue: `summarize-active` (ticket briefs → `aiSummary`, written
  only when no data writer holds a lock) and `pull-model` (Ollama download with progress).

## The scheduler

`server/schedule.mjs` ticks every 60 s and reads **Settings → Background jobs** (defaults from
`config → schedule`, overridden by `jira-intern/.settings.json`):

| Setting | Cadences | Due action |
|---|---|---|
| `activeRefresh` | off · daily · twice-daily (default) | `run-intern.sh` — active tickets |
| `fullRefresh` | off · daily · weekly · twice-weekly (default) | active tickets, wait until idle, then `update-completed.sh` with `ARCHIVE_SCOPE=all` |
| `reportRefresh` | off · daily · weekly · twice-weekly (default) | queue reports that are missing, stale by fingerprint, or scored under 100 |

Last-run stamps live in `.schedule.json`; on start the scheduler **seeds** missing stamps with
"now" so a container restart never repeats the boot fetch. The entrypoint runs exactly one fetch on
boot (`REFRESH_ON_START` / `config → refresh.onStart`), through the locked `run-intern.sh`. There is
no fixed interval anywhere.

## Locks — the one-writer rule

`data.json` has one writer at a time. Each runner takes its own lock file (`.intern.lock`,
`.completed.lock`, `.refresh.lock`; `.report.lock` for backfills) atomically with `noclobber`, and
refuses to start (exit 3) while any sibling lock is held. Lock files hold one line,
`<pid> <ISO-timestamp> <hostname>`; `lock-util.sh` and `server/locks.mjs` apply the same three
staleness rules (dead PID → stale; no usable PID → stale after 45 min; live PID → held until an
8 h hard ceiling; another host's PID is ignored). The Python writers additionally take an advisory
`flock` on `.data.lock` around every read-modify-write. The full contract, including exit codes:
[RUNTIME-FILES.md](RUNTIME-FILES.md).

## Server load

One user, one tab, mostly idle with bursts of background work:

- The client makes **one** status request per interval however many things it watches
  (`app.polling`: 12 s idle, 4 s while runs or reports are in flight, 1 s only during a model
  download); none while the tab is hidden or Background auto-refresh is off with nothing running.
- `/api/intern-status` bundles run state, queues, reports and AI status; identical payloads don't
  re-render. The AI status is cached for 1 s on the server.
- The reports index is fetched when a report finishes, not on a timer; the server re-parses only
  report files whose mtime changed.
- Static files are gzipped once in memory and revalidated by ETag.

## Board rules worth knowing

- **Columns:** To Do · In Progress · In Review (folds in Ready4Review + Code Review) · QA · Done.
  The **intern decides** `column` (`_jira.py status_column`: exact aliases, then whole-word
  `qa` → `review` → otherwise *In Progress*). `src/lib/columns.ts` is the **fallback** for a dump
  without `column` (same aliases and word order, but an unknown status lands in *To Do*). Both map
  won't fix / cancelled / rejected to Done.
- **On Hold:** its own section, shown only when something is blocked/waiting (feature switch).
- **Next Sprint:** To Do tickets whose sprint hasn't started (`future`, or a `… READY` bucket) are
  pulled out of To Do into a collapsible section (`src/lib/format.ts isNextSprint`).
- **Done retirement:** a Done ticket stays on the board `app.doneBoardDays` days (default 5) as a
  "recent win", then retires to Completed (`src/data.ts`). The fetch keeps Done tickets for 10 days
  so none drops out before the archive has it.
- **Stale banner:** a red banner appears when the dump is older than 12 h (`format.ts freshness`).

## Three ways it runs

| Mode | Command | Refresh button | Needs |
|---|---|---|---|
| **Docker** (recommended) | `docker compose up -d --build` | Runs the fetch in-container; the scheduler follows Settings | Docker + Jira token |
| **Static file** | open `dist/index.html` | Re-reads the last dump | Nothing |
| **Live server** | `npm run serve` | Runs the fetch on your machine | Node 22.12+, Python 3.11+ |

See [DEPLOYMENT.md](DEPLOYMENT.md) for step-by-step instructions.
