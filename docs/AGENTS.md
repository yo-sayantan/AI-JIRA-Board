# AGENTS.md — working on this repo (humans and AI agents)

This is the onboarding file. Read it first; it tells you what exists, the rules that keep the
system consistent, and where the deep documentation lives. Written to be enough context for an
AI agent to make a correct change without re-deriving the architecture.

## The 60-second mental model

```
 Jira / Bitbucket / Confluence  ──(your tokens)──▶  jira-intern/*.py  ──▶  jira-intern/data.json + data.js
                                                        (the "intern")           │
 AI-Intern container (worker.py) ◀── .ai-queue jobs ◀── serve.mjs ◀──────────────┤ reads
        │ writes aiSummary/reports back into data.json / reports/                ▼
        └────────────────────────────────────────────────────▶  dist/index.html (React, single file)
```

- **The app never talks to Jira.** Python scripts ("the intern") fetch into `jira-intern/data.json`
  (+ a `data.js` twin for `file://`); the React app only renders that file.
- **One data contract.** `src/types.ts` is the single source of truth for every shape in
  `data.json`. `jira-intern/prompts/intern-prompt.md` restates it in prose for the LLM-agent
  fallback path. **Change one → change both.**
- **One writer at a time.** Every job that writes `data.json` is serialised by lock files and the
  server's in-memory flags. Never add a second concurrent writer.

## Repo map

| Path | What it is |
|---|---|
| `src/` | React 19 + Tailwind v4 + Motion app → built into ONE `dist/index.html` (vite-plugin-singlefile). |
| `src/types.ts` | **THE CONTRACT** — `Ticket`, `CompletedTicket`, `RaisedTicket`, `JiraData`, adapters. |
| `src/data.ts` | Dump → board rules (normalise columns, retire old Done tickets, merge user-archived keys). |
| `src/lib/` | Pure logic: `boardView` (derivations/index), `search` (query grammar), `columns` (status→column), `format` (every display helper), `runner` (typed API client), `settings` (feature registry), `statusPoller`. |
| `src/hooks/` | Stateful glue: `useBoardData`, `useInternJobs` (daily/archive/raised/per-ticket jobs), `useReports`, `useDrawerStack`, `useBoardSettings`, `useToasts`. |
| `src/components/` | Feature folders: `board/` `header/` `ticket/` `completed/` `raised/` `reports/` `settings/` `common/`. |
| `jira-intern/` | The data pipeline. `daily_fetch.py` (active tickets + raised list + single-ticket refresh), `completed_archive.py` (historical archive), `raised.py` (raised-by-me fetch, shared), `_jira.py` (HTTP + field formatting), `devinfo.py` (branches/PRs via Jira dev-status), `pr_report.py` (deterministic PR reports), `datafile.py` (atomic writes, data.js sync), `progress.py` (progress file for button fills). |
| `jira-intern/local-runner/` | Shell entrypoints the server invokes: `run-intern.sh`, `update-completed.sh`, `refresh-ticket.sh`, `refresh-raised.sh`, `pr-report.sh`; `runner-env.sh` (env, locks, timeouts), `config.mjs` (config merge → shellenv/prompts), `sync-datajs.mjs`. |
| `serve.mjs` + `server/` | Zero-dependency Node server: static allowlist + the `/api/*` routes (jobs, reports, settings, AI proxy, status). |
| `ai-intern/` | The AI worker container: `worker.py` (job queue + HTTP; Ollama local or Claude/Cursor/Gemini cloud), `models.json` (local model catalog). |
| `config/` | `jira-board.config.json` — tracked, **generic** project defaults (+ JSON schema). Personal values live OUTSIDE the repo in `~/.ai/config.json`. |
| `setup/` | Templates ONLY (secrets, personal config, MCP, Desktop launcher) — the guide for them is `docs/SETUP.md`. Shipped into the Docker image. |
| `docs/` | **All** documentation lives here (see index at the bottom): the suite, `index.html` (served Setup Guide), `doc.html` (styled viewer for the .md files), `legal.html` (policies). The only `.md` files outside are runtime inputs, not docs: `jira-intern/prompts/*.md` (LLM prompts read by scripts) and `.github/pull_request_template.md` (GitHub requires its location). |
| `jira-intern/demo/` | Demo mode's sample board: `data.json` (the source — tracked in git, unlike the real dump), `tickets/*.json` (per-ticket mirror, `npm run demo:split`), `README.md`. |
| `src/demo/` | Demo mode's code: loads + re-dates `jira-intern/demo/data.json`, two canned PR reports, and a browser-side mirror of the move gates. Driven by the `demoMode` feature toggle; `runner.ts::setDemoMode` blocks every server call while it is on. |
| `tests/` | Python unittests (`npm test`). |

## Golden rules (break these and the system corrupts)

1. **The contract is law.** Any new field flows `types.ts` → intern script(s) → (if the agent
   fallback should produce it) `prompts/intern-prompt.md`. The UI must tolerate the field being
   absent — old dumps keep rendering.
2. **Single writer.** `data.json` writers: `daily_fetch.py` (daily + `--key` + `--raised`),
   `completed_archive.py`, `ai-intern/worker.py::write_briefs`. All are serialised via
   `.intern.lock` / `.completed.lock` / `.refresh.lock` / `.raised.lock` + `server/jobs.mjs`
   state flags. A new write path must take a lock and be registered in `dataWriterBusy()`.
3. **Preserve, never wipe.** Each job rewrites ONLY its slice and carries the rest forward:
   the daily fetch preserves `completed[]`; the archive preserves `tickets[]` and refreshes
   `raised[]`; every writer preserves keys it does not own (`raisedAt`, `aiSummary`, notes…).
   A FAILED lookup must carry forward prior data, never write an empty list — "couldn't fetch"
   ≠ "there is nothing" (see `code_for`, `fetch_raised`, `subs_by_parent=None` patterns).
4. **Atomic writes + twin sync.** All dump writes go through `datafile.write_outputs()` /
   `atomic_dump()` (temp file + `os.replace`). `data.js` must always equal `data.json` —
   `write_outputs` does both; shell paths re-sync with `sync-datajs.mjs`.
5. **No secrets in the repo. Ever.** Tokens live in `~/.cursor/mcp-secrets.env`, identity in
   `~/.ai/config.json`. The repo is public. Before every commit run the leak scan:
   `git diff --cached | grep -icE "<internal hostnames / ids / names>"` must print 0, stage files
   by name (never `git add -A`), and keep `config/jira-board.config.json` generic.
6. **`npm run build` must pass before any commit** (`tsc --noEmit && vite build`), and
   `npm test` runs the Python unittests.
7. **Deploy packages the host-built dist.** `start-jira-board.sh` builds `dist/` on the host and
   passes `--build-arg DIST_SOURCE=prebuilt`; in-image `npm ci` over the Docker VM's slow network
   silently drops optional native binaries (TypeScript 7's platform packages) and the build dies.
   Never add `--pull` to compose build. See `docs/DEPLOYMENT.md`.

## How to add a feature (worked example: the Raised-by-me view)

The "Raised by me" view (every non-sub-task ticket the user REPORTED, its status, current
assignee, hand-off history) is the most recent full-stack feature — copy its shape:

1. **Fetch** — `jira-intern/raised.py`: one JQL (`reporter = currentUser() AND issuetype not in
   subTaskIssueTypes()`), pages fetched in parallel (`REFRESH_WORKERS`), compact rows built from
   search fields + changelog only (no per-ticket calls, no Bitbucket). Failure keeps prior rows.
2. **Contract** — `src/types.ts`: `RaisedTicket`, `AssigneeHop`, `JiraData.raised`/`raisedAt`,
   adapter `raisedToTicket` so the existing detail drawer renders rows.
3. **Wire into every write path** — daily fetch rides it along; `refresh_one` updates the raised
   row in place (and must NOT plant someone else's ticket into `tickets[]`); the archive rebuild
   refreshes it; the agent prompt says "preserve raised[] unchanged".
4. **Index** — `src/lib/boardView.ts::indexByKey` adds adapted rows LAST (board/archive copies
   are richer and must win).
5. **UI** — `src/components/raised/Raised.tsx`: overlay cloned from the Completed anatomy
   (hero + stat tiles + sticky filter bar + year/month timeline + expandable rows), own colour
   identity. Entry chip in `board/Stats.tsx`, state in `App.tsx`.
6. **Server job** — `local-runner/refresh-raised.sh` → `server/jobs.mjs::startRaised` (respects
   `dataWriterBusy`) → route in `serve.mjs` → `src/lib/runner.ts` client → `useInternJobs`.
7. **Feature flag** — one entry in `src/lib/settings.ts::FEATURES` + colour/icon in
   `Settings.tsx::FEATURE_STYLE` (TypeScript forces this) + `FEATURE_ORDER`.
8. **AI** — `ai-intern/worker.py::summarize_active` walks `raised[]` after `tickets[]`;
   `write_briefs` stamps both copies of a key; `fetch_raised` carries briefs across refreshes.

## UI style guardrails

- Controls are **flat chips**: thin outline `hexToRgba(color, 0.45)`, tinted fill
  `hexToRgba(color, 0.07)`, coloured text/icon, Motion spring on hover/tap. **No 3D/skeuomorphic
  buttons** (tried; rejected). The gold `gold-sheen` Completed trophy is the single exception.
- Colour accents are welcome and each view owns a hue (Completed green/gold · Raised indigo ·
  Next Sprint pink · On Hold orange · Blocked red · QA In Progress deep teal). Never monochrome; keep gradients, the freshness pill, the
  sprint block, and animations.
- Fixed-width right-hand "rails" in list rows (one width table shared by header + rows) so
  columns align to the pixel; labels truncate, never overflow.
- Every icon-only button gets `aria-label`; toggles get `aria-pressed`; overlays are
  `role="dialog"` with focus management; Esc closes ONLY the top layer (`pauseEsc` pattern).

## Build · test · run · deploy

```bash
npm run dev          # Vite dev server with fixture data (src/fixtures.ts)
npm run build        # tsc --noEmit && vite build → dist/index.html (single file)
npm test             # python unittest under tests/
npm run serve        # zero-dependency local server on :4321
bash start-jira-board.sh   # Docker deploy (host-builds dist, DIST_SOURCE=prebuilt)
```

Docker compose runs three containers: **JIRA-Board** (server + fetch), **AI-Intern** (worker),
**AI-Ollama**. `./jira-intern` is bind-mounted — **the live data lives in whatever directory you
deployed from** (see `docs/DEPLOYMENT.md` → "the data mount follows the deploy directory").

## Gotcha catalogue (hard-won; check before "fixing")

- `search_jira` retries `statusCategory = Done` as explicit statuses on 400 (old Jira);
  `fetch_raised` retries without `subTaskIssueTypes()` the same way.
- Jira comment lists in search payloads are TRUNCATED when long — `comments_for` falls back to
  pagination; don't read `fields.comment.comments` directly.
- `devinfo` returning **no entry** for a key means the LOOKUP failed; `{}`-with-empty-lists means
  "genuinely no code". Callers must carry prior PR data forward on failure.
- PR review state lives in Bitbucket and does NOT bump Jira `updated` — the daily fast path
  re-checks PRs even for "unchanged" tickets (`refresh_prs_only`); sprints are re-applied on the
  fast path too (sprint objects mutate without touching the issue).
- `resolutiondate` can be null for tickets transitioned straight to Done —
  `changelog_done_date()` is the fallback.
- A sub-task of yours is stored TWICE (own card + nested under parent); `_merge_ticket` must
  replace every copy. `indexByKey` prefers standalone rows.
- PR numbers are per-repository — identity is `(project, repo, id)` (`_pr_identity`), never id alone.
- localStorage keys in use: `jb-settings`, `jb-archived`, `jb-completed-show-context`,
  `jb-guide-os` (+ legacy `jb-theme`, `jb-hidden` migrations). No cookies anywhere.
- The board can run from `file://` — every feature must degrade: served-only controls hide or
  toast, data comes from `data.js`, reports from `reports/index.js`.
- Models sometimes return `{"html": "..."}` for briefs despite the prompt — `_clean_brief`
  (worker) unwraps at generation, `unwrapBrief` (src/lib/format.ts) heals at render.

## The full documentation suite

| File | Read it for |
|---|---|
| `docs/FEATURES.md` | Every user-facing feature, how it behaves, where its code lives. |
| `docs/DATA-FLOW.md` | Every file on disk, every writer/reader, locks, lifecycles, flows per job. |
| `docs/AI-PIPELINE.md` | Levels, backends, model catalog, briefs, PR-report enrichment, queues. |
| `docs/INTEGRATIONS.md` | Jira/Bitbucket/Confluence specifics, the full HTTP API, Docker topology, config/settings chain. |
| `docs/ARCHITECTURE.md` | The component-level overview (start here if new). |
| `docs/DEPLOYMENT.md` | Run modes, Docker details, deploy pitfalls. |
| `docs/USAGE.md` | The board as a user sees it. |
| `docs/SETUP.md` | The two outside-the-repo files (secrets, personal config), MCP templates, the public-repo checklist. |
| `docs/CONFIG.md` | Key-by-key reference for `config/jira-board.config.json` and the personal override. |
| `docs/INTERN.md` | The fetch pipeline (`jira-intern/`) from the inside: scripts, runners, behaviours. |
| `docs/OVERVIEW.md` | The project overview (features, quick start, repository layout). |
