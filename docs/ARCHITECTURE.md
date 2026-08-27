# Architecture — how it works

## The one idea

The board **never talks to Jira**. A separate pipeline (`jira-intern/`) fetches your tickets on
a schedule and writes them to a plain data file. The UI is a static single-page app that reads
that file. Decoupling the two means the app is a fast, dependency-free `dist/index.html` you can
double-click, and refreshing the data **never rebuilds the app**.

```
  ┌─────────────┐   fetch (Python/agent)   ┌──────────────────────┐   reads    ┌───────────────┐
  │    Jira      │ ───────────────────────▶ │  jira-intern/data.js  │ ─────────▶ │  dist/         │
  │  Confluence  │   tokens from            │  window.__JIRA_DATA__  │            │  index.html    │
  │  Bitbucket   │   ~/.cursor/mcp-secrets  │  window.__JIRA_CONFIG  │            │  (React app)   │
  └─────────────┘                          └──────────────────────┘            └───────────────┘
```

## The two halves

### 1. `jira-intern/` — the data pipeline ("the intern")

Python scripts (plus an optional AI pass) that produce two files:

- **`jira-intern/data.json`** — the canonical, parseable dump.
- **`jira-intern/data.js`** — `window.__JIRA_DATA__ = <that json>;` so the app can load it from
  `file://` with no server. Also carries `window.__JIRA_CONFIG__` (the `app` branding block),
  so branding re-themes at runtime with no rebuild.

Key scripts:

| File | Role |
|---|---|
| `daily_fetch.py` / `run_fetch.py` | Pull active tickets assigned to you → `data.json` / `data.js`. |
| `completed_archive.py` | Build the full historical "Completed" archive. |
| `local-runner/*.sh` | Thin wrappers: daily, weekly, per-ticket refresh, summary. |
| `local-runner/config.mjs` | Resolves `config.json` into shell vars, rendered prompts, MCP policy. |
| `prompts/intern-prompt.md` | The schema the fetch must produce, in prose — mirrors `src/types.ts`. |
| `config.json` | **Single source of truth** for identity, endpoints, connector, policy, branding. |

The fetch needs only a **Jira token**. Confluence/Bitbucket tokens and MCP servers are optional
and only enrich the output (linked docs, real branches, PR state, AI briefings).

### 2. `src/` — the React app

Vite + React 19 + Tailwind v4 + Motion, compiled to a **single** `dist/index.html` (all JS/CSS
inlined) so it runs from a double-click. It reads `window.__JIRA_DATA__` at load.

| File | Role |
|---|---|
| `src/types.ts` | **The data contract.** Single source of truth for the ticket shape; mirrored by `prompts/intern-prompt.md`. |
| `src/data.ts` | Loads `window.__JIRA_DATA__`; applies lifecycle rules (e.g. retire old Done tickets). Falls back to a dev fixture. |
| `src/lib/columns.ts` | Jira status → board column mapping + colours; the Next Sprint / On Hold section identities. |
| `src/lib/format.ts` | Priority / type / PR / date / sprint helpers (incl. `isNextSprint`, `futureSprintOf`). |
| `src/components/` | `Header`, `Stats`, `Board`, `Column`, `TicketCard`, `OnHold`, `NextSprint`, `Completed`, `TicketDetail`, … |
| `serve.mjs` | Zero-dependency Node server for the *optional* live mode (the in-app **Refresh** button runs the fetch). |
| `vite.config.ts` | Single-file build; injects the external `../jira-intern/data.js` `<script>`. |

## How data reaches the screen

1. The fetch writes `jira-intern/data.js` → `window.__JIRA_DATA__`.
2. `dist/index.html` includes `<script src="../jira-intern/data.js">` (injected by the build).
3. `src/data.ts` reads that global, normalizes it, and applies board rules.
4. React renders the board, sections, and drawer from `src/types.ts`-shaped data.

Because the data file is external to the bundle, **new data never requires a rebuild** — reload
the page (or press `r`) and the latest dump shows.

## Board rules worth knowing

- **Columns:** To Do · In Progress · In Review (folds in Ready4Review + Code Review) · QA · Done.
- **On Hold:** its own section, shown only when something is blocked/waiting.
- **Next Sprint:** To Do tickets whose sprint hasn't started yet (Jira sprint state `future`, or
  a grooming bucket like `… READY`) are pulled out of To Do into their own collapsible bar, so a
  cleared current-sprint To Do doesn't look full. See `src/lib/format.ts` → `isNextSprint`.
- **Completed:** the full historical archive, collapsed by default.
- **Done retirement:** a Done ticket stays on the board a few days as a "recent win", then retires
  to Completed automatically (`src/data.ts` → `DONE_BOARD_DAYS`).

## Two ways it runs

| Mode | Command | Refresh button | Needs |
|---|---|---|---|
| **Docker** (recommended) | `docker compose up -d --build` | Runs the fetch in-container; also auto-refreshes every 15 min | Docker + Jira token |
| **Static file** | open `dist/index.html` | Re-reads the last dump | Nothing |
| **Live server** | `npm run serve` | Runs the fetch on your machine | Node + a working local fetch |

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for step-by-step instructions.
