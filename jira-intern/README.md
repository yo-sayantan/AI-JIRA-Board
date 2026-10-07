# jira-intern — the fetch pipeline

Fetches your Jira work and **dumps it as structured data** (`data.json` + `data.js`) for the board
(the React app in `../src/`) to render. The intern never writes HTML; the board is the only UI.

The deterministic Python scripts here are the **primary path**. An agent CLI (`cursor-agent`,
`claude` or `codex`, chosen by `connector.active` in the config) is only a **fallback**, used when
`daily_fetch.py` or `completed_archive.py` fails for a reason other than a missing token.

## Open the board

Run the board with Docker (`docker compose up -d --build`, then open `http://localhost:4321/dist/index.html`)
or open `../dist/index.html` after `npm run build`. See [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

## What is in this folder

| Path | Role |
|---|---|
| `daily_fetch.py` | Active tickets (`tickets[]`): fetch, merge with `.state.json`, write the dump. Also `--key KEY` for a single-ticket refresh. |
| `completed_archive.py` | The Completed archive (`completed[]`), resumable, cached per ticket in `cache/<KEY>.json`. |
| `devinfo.py` | Branches, pull requests and approvals from Jira's dev-status index; Bitbucket only enriches still-open PRs. |
| `pr_report.py` | Deterministic PR Readiness Reports (`reports/<KEY>.json`). The AI worker may only add to them. |
| `ai_queue.py` | The file queue (`.ai-queue/*.json`) that hands report enrichment and briefs to the AI-Intern container. |
| `_config.py`, `_jira.py`, `_sprint.py`, `datafile.py`, `progress.py` | Config loading, Jira HTTP + mapping, sprint labels, atomic output writing, run progress. |
| `local-runner/` | Shell and Node wrappers: locks, environment, timeouts, log rotation, the agent fallback. |
| `prompts/` | `intern-prompt.md` (the agent fallback's output contract; keep its schema in sync with `../src/types.ts`) and reference specs. |
| `CONFIG.md` | Every configuration key and environment variable. |

Runtime files written here (`data.json`, `cache/`, `logs/`, `.state.json`, locks and so on) are
git-ignored. [`../docs/RUNTIME-FILES.md`](../docs/RUNTIME-FILES.md) lists each one, who writes it, the
lock rules, the runner exit codes and how to debug a failed fetch.

## Runners

| Script | Scope | Writes |
|---|---|---|
| `local-runner/run-intern.sh` | Active tickets (fast, capped at 300 s on the fast path) | `tickets[]`; preserves `completed[]` |
| `local-runner/update-completed.sh` | The full Completed archive (slow, resumable) | `completed[]`; leaves `tickets[]` alone |
| `local-runner/refresh-ticket.sh KEY` | One ticket | that ticket's entry |
| `local-runner/pr-report.sh`, `pr-reports-backfill.sh` | PR readiness reports | `reports/*.json` |

The board schedules these itself (Settings, Background jobs), so you normally never call them by
hand. Calling them from a terminal or an OS scheduler works too and uses the same locks.
`FRESH=1 bash local-runner/update-completed.sh` wipes the archive cache and rebuilds from scratch;
`TIMEOUT_SEC` raises the archive ceiling.

Exit codes the board understands: `0` ok, `2` no Jira token (no agent fallback), `3` skipped because
another writer holds a lock, `4` archive finished with some tickets keeping their previous row,
`124` timeout, `127` agent CLI missing.

## How it behaves

- **Columns:** To Do, In Progress, In Review (folds Ready4Review and Code Review), QA, Done. The
  intern decides `column` (`_jira.py status_column`); `../src/lib/columns.ts` is only the fallback
  for dumps without it. On Hold tickets get `column: "hold"` and have their own section.
- **Completed:** the archive query is `(assignee was currentUser() OR assignee = currentUser())`,
  filtered client-side to Done tickets, plus the parent of each of your sub-tasks as a context row
  (`mine: false`). `ARCHIVE_SCOPE=year|since|key` (with `ARCHIVE_YEAR`, `ARCHIVE_SINCE` or
  `ARCHIVE_KEY`) rebuilds a slice. The daily run never touches `completed[]`.
- **Refresh:** rich fields update only on a new comment or a status change, each prepended to
  `updateLog`. A Done ticket gets exactly one "Marked DONE" entry.
- **PR status:** from Jira's dev-status index. The Bitbucket key-scan fallback runs only for projects
  listed in `bitbucket.projectMap` and `bitbucket.repoHints`, which are empty by default.
- **One bad ticket never stops a run:** a ticket that fails to build keeps its previous entry and
  logs a `WARN` line; the run fails only when every ticket failed.
- **Never invents data:** with no Jira access it re-stamps the last known dump, adds a `notes[]`
  notice and stops.

## Branch convention

`<type>/<KEY>_<short_description>`: `feature` for stories and tasks, `bugfix` for bugs.

## Notes

- Needs network access to your Jira (VPN if it is internal). TLS is verified; for a private CA set
  `JIRA_CA_BUNDLE`, see [`CONFIG.md`](CONFIG.md).
- Logs are in `logs/`. The agent fallback is killed after its timeout (30 min for the daily run).
