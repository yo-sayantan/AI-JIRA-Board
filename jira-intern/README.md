# JIRA Intern

A headless agent that, on every run, fetches my Jira work and **dumps it as structured data**
(`data.json` + `data.js`) for the **`git/jira-board`** app to render. Built with the models + MCPs
from your Cursor setup.

> **Architecture (since 2026-06):** the intern no longer writes HTML. It produces data; the
> `git/jira-board` React app is the UI. The old `status.html`, `tickets/*.html` and `assets/` are
> **retired legacy** (left on disk, no longer maintained).

## Open the board
Double-click **`../../jira-board/dist/index.html`** (or `open` it). It reads the intern's latest dump
from `data.js`, so just reopen/refresh after a run — no rebuild. See `git/jira-board/README.md`.

## What the intern writes (all under `jira-board/jira-intern/`)
- **`data.json`** — canonical, parseable dump. The contract; schema mirrors `git/jira-board/src/types.ts`.
- **`data.js`**   — `window.__JIRA_DATA__ = <that json>;` so the board loads it from `file://`.
- **`.state.json`** — hidden memory (incremental briefing + "done once"). You never open it.

The full output spec lives in **`intern-prompt.md`** — edit that to change what the intern collects,
and keep its schema block in sync with `jira-board/src/types.ts`.

## Two runners (Cursor CLI, headless)
Both run `cursor-agent` with your Cursor model + the `jira`/`confluence`/`bitbucket` MCP servers (sourcing
`~/.cursor/mcp-secrets.env` for `CURSOR_API_KEY`). Split so the slow part runs less often:

| Script | Scope | What it writes | Schedule |
|---|---|---|---|
| **`local-runner/run-intern.sh`** | ACTIVE tickets (fast) | `tickets[]` (+ preserves `completed[]`) | **daily** (e.g. 9:00) |
| **`local-runner/update-completed.sh`** | the full COMPLETED archive (slow) | `completed[]` (+ leaves `tickets[]` alone) | **weekly** |

- Daily: Shortcut → Run Shell Script → `bash /Users/c22014e/git/jira-board/jira-intern/local-runner/run-intern.sh` → Automation → Time of Day → 9:00 Daily.
- Weekly: Shortcut → Run Shell Script → `bash /Users/c22014e/git/jira-board/jira-intern/local-runner/update-completed.sh` → Automation → Day of Week (once/week). It pages through every closed ticket, fetches **real** branches + all PRs, caches each in `cache/<KEY>.json`, and is **resumable** (a timeout just continues next run).
- `FRESH=1 bash …/update-completed.sh` wipes the cache and rebuilds the archive from scratch (use it once now to replace any fabricated branch names / missing PRs with real Bitbucket data). `TIMEOUT_SEC=10800` raises the 2h ceiling.
- They share one `data.json` (daily owns `tickets[]`, weekly owns `completed[]`); each re-syncs `data.js` after running.

## How it behaves
- **Board columns:** To Do · In Progress · **In Review** (folds Ready4Review + Code Review) · QA · Done.
- **On Hold:** Blocked/Waiting/Parked tickets get `column:"hold"`; the board shows that section only when occupied.
- **Completed:** the **weekly** `update-completed.sh` pages a full-history JQL (`assignee was currentUser() AND
  statusCategory = Done`) into `completed[]` — every Done ticket I've ever worked, with real branches + all PRs.
  The daily run never touches it. It's the board's archive (gold pill → full-screen overlay, real branches/PRs).
- **On assignment:** an active ticket gets a full rich object in `tickets[]` immediately.
- **Refresh:** rich fields update only on a **new comment** or **status change**, each prepended to `updateLog`.
- **PR status:** from Bitbucket (by branch / key) → approved / comments / changes / merged / none.
- **Done once:** at QA/Done, one final "Marked DONE" entry; `state.done=true`; kept visible in the Done column + archive.
- **MCP scope:** only `jira`, `confluence`, `bitbucket` (others blocked via `git/.cursor/cli.json`).
- **Never invents data:** if Jira MCP is unavailable, it rewrites the dump from last-known `.state.json`,
  adds a `notes[]` notice (also prepended to `_STATUS.md`), and stops.

## Branch convention
`<type>/<KEY>_<short_description>` — `feature` for stories/tasks, `bugfix` for bugs.

## Notes
- Requires the corporate network/VPN.
- `cursor-agent -p` headless can hang; the runner kills it after 30 min. Logs in `logs/`.
