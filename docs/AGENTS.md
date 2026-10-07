# Guide for AI coding agents

You are working in **My Jira Board**: a personal Jira mirror made of a Python fetch pipeline, a
React single-file app, a zero-dependency Node server, and an optional Python AI worker, deployed
with Docker Compose. Read this page first; it is imported by the root `CLAUDE.md`. The human
documentation is under `docs/` — link to it, do not duplicate it.

## Repo map

| Path | What lives there | Change it when |
|---|---|---|
| `src/` | React 19 + TypeScript 7 + Tailwind v4 + Motion. `types.ts` = ticket contract; `lib/` pure helpers (`columns`, `format`, `search`, `settings`, `runner`, `reportTypes`, `boardView`); `hooks/`; `components/{board,header,ticket,completed,reports,settings,common}` | UI behaviour, settings, rendering of data or reports |
| `serve.mjs` + `server/*.mjs` | The local server: route table and guards in `serve.mjs`; `config`, `http`, `locks`, `queue`, `jobs`, `reports`, `ai`, `settings`, `schedule` modules | API, scheduler, job orchestration, static serving |
| `jira-intern/*.py` | `daily_fetch.py`, `completed_archive.py`, `pr_report.py`, `_jira.py`, `devinfo.py`, `_sprint.py`, `_config.py`, `datafile.py`, `progress.py`, `ai_queue.py` — standard library only | Fetching, data shape, reports, config resolution |
| `jira-intern/local-runner/` | Shell runners (`run-intern.sh`, `update-completed.sh`, `refresh-ticket.sh`, `pr-report.sh`, `pr-reports-backfill.sh`), `runner-env.sh`, `lock-util.sh`, `config.mjs`, `sync-*.mjs`, `carry-aisummary.mjs` | Locking, timeouts, how jobs are launched |
| `jira-intern/prompts/` | `intern-prompt.md` (executed by the agent fallback; mirrors `src/types.ts`); `intern-completed-prompt.md`; `pr-readiness-prompt.md` and `intern-summary-prompt.md` are **reference specifications**, not executed | The ticket schema or report spec changes |
| `jira-intern/CONFIG.md`, `jira-intern/README.md` | Config key reference; the pipeline from the inside | Config keys / env vars change |
| `ai-intern/` | `worker.py` (queue consumer + HTTP on 4322, providers, proof lookups, validation), `models.json` (local model catalogue), `prompts/enrich.txt` (the live system prompt), `Dockerfile` | AI enrichment, model lists, provider calls |
| `config/` | `jira-board.config.json` (tracked defaults — **placeholders only**) + `jira-board.config.schema.json` | New config key (update both + `CONFIG.md`) |
| `setup/` | Templates for secrets, personal config, MCP, launcher; `setup/README.md` | Setup steps change |
| `docs/` | All human docs: `index.html` (offline guide), `ARCHITECTURE`, `DEPLOYMENT`, `USAGE`, `API`, `RUNTIME-FILES`, `SECURITY`, `CONTRIBUTING`, `CHANGELOG`, this file | Any behaviour change |
| `tests/` | Python `unittest` suites (no network) | Pipeline / config / lock behaviour |
| `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `start-jira-board.sh` | Three services: `jira-board` (JIRA-Board, non-root `node`), `ollama` (AI-Ollama), `jira-ai` (AI-Intern) | Runtime layout, mounts, ports, boot sequence |
| `.github/` | CI (shellcheck, config validate, tests, typecheck, build, Docker smoke), Dependabot, templates | CI steps |

## Commands

```bash
npm install
npm run dev               # UI with the sample fixture, no Jira needed
npm run serve             # local server on 4321 (needs jira-intern/data.json)
npm run typecheck · npm run build · npm test · npm run test:py · npm run test:js
npm run config:validate
bash -n jira-intern/local-runner/*.sh docker-entrypoint.sh start-jira-board.sh
python3 -m py_compile jira-intern/*.py ai-intern/worker.py
shellcheck -S error docker-entrypoint.sh start-jira-board.sh open-guide.sh jira-intern/local-runner/*.sh
docker compose up -d --build            # full stack · add `jira-board` for the board alone
```

## Contracts that must move together

1. `src/types.ts` ↔ `jira-intern/prompts/intern-prompt.md` ↔ the Python builders — the ticket shape.
2. `src/lib/reportTypes.ts` ↔ `jira-intern/pr_report.py` (`BLOCK_KINDS`, `TONES`, `validate_report`,
   `preserved_errors`) ↔ `ai-intern/worker.py merge_enrichment` — the report shape. The AI may only
   **add**; never loosen `preserved_errors`.
3. `src/lib/columns.ts` ↔ `jira-intern/_jira.py _STATUS_COLUMNS` — status → column aliases and
   word-fallback order. Intended difference: unknown status → In Progress (Python) / To Do (TS).
4. `jira-intern/_config.py` ↔ `local-runner/config.mjs` (config resolution) and `datafile.py` ↔
   `sync-datajs.mjs` (byte-identical `data.js`) — both enforced by tests.
5. `lock-util.sh` ↔ `server/locks.mjs` — the three staleness rules and the lock line format.
6. The `serve.mjs` header comment ↔ `docs/API.md` — the route reference.

Details and recipes: [CONTRIBUTING.md](CONTRIBUTING.md).

## Rules

- **Docs change with behaviour.** If you change what the code does, change the sentence in `docs/`
  (and `jira-intern/CONFIG.md` for config, `docs/index.html` for anything a first-time installer
  sees) in the same change, and add a line to `docs/CHANGELOG.md`. Every `.md` guide lives under
  `docs/`; only `README.md` and `LICENSE` stay at the root.
- **No internal names.** Never write a real company name, hostname, tenant id, project key, user
  id or ticket content into the tree — not in code, tests, fixtures, docs, comments or commit
  messages. Use `PROJ-123`, `jira.your-company.example`, `YOUR_CORP_ID`. `config/jira-board.config.json`
  stays placeholders; real values belong in the untracked `~/.ai/config.json`.
- **Never commit runtime files.** `jira-intern/data.json`, `data.js`, `reports/`, `.settings.json`,
  `.schedule.json`, `.ai-queue/`, `.ai-status.json`, `cache/`, `logs/`, `.state.json`, `_STATUS.md`,
  `.progress.json`, every `*.lock`, `dist/`. They are git-ignored; do not force-add them. Do not
  read `~/.cursor/mcp-secrets.env` or print its contents.
- **Secrets are parsed, never sourced.** Keep it that way in any new script; read only the names
  listed in [SECURITY.md → Secrets read](SECURITY.md#secrets-read).
- **One `data.json` writer at a time.** Any new writer goes through `runner-env.sh`'s lock helpers
  and `datafile.data_lock`, and returns the exit codes in
  [RUNTIME-FILES.md](RUNTIME-FILES.md#exit-codes).
- **Validate at the edges, spawn with arrays.** Keys, years, dates and model tags are checked with
  the existing regexes before touching a path, a REST URL or a child process.
- **Zero dependencies stay zero.** The server (`serve.mjs`, `server/`) and the Python side use
  the standard library only; the app's dependencies are React, React DOM and Motion.
- **Don't invent features in docs.** Describe what the code does today; verify by reading it.
  Default values come from `config/jira-board.config.json`, `server/settings.mjs` and
  `src/lib/settings.ts`.

## Where runtime state lives

Inside the container everything is under `/app/jira-intern` (bind-mounted from `./jira-intern`);
secrets are at `/home/node/.cursor/mcp-secrets.env` (board) or `/root/.cursor/mcp-secrets.env`
(worker); the personal config at `/home/node/.ai/config.json` or `/root/.ai/config.json`. The full
file list, lock format and exit codes are in [RUNTIME-FILES.md](RUNTIME-FILES.md); HTTP routes in
[API.md](API.md); topology in [ARCHITECTURE.md](ARCHITECTURE.md).

## How to verify a change

Run what CI runs, in this order, and stop at the first failure:

1. `npm run typecheck`
2. `npm run build` (produces `dist/index.html`; a `file://` regression shows up as a module-script warning)
3. `npm test` (`test:py` for pipeline changes, `test:js` for `src/lib` changes)
4. `npm run config:validate` when `config/` or the schema changed
5. `bash -n …` and `shellcheck -S error …` for shell changes; `python3 -m py_compile …` for Python
6. `docker build -t smoke .` when `Dockerfile`, `docker-entrypoint.sh` or the file layout changed
7. Grep your diff for internal names and runtime files before finishing:
   `git diff --name-only` must not list `jira-intern/data.*`, `reports/`, `.settings.json`.
