# jira-board

A personal, beautiful replacement for staring at the Jira board. It renders the data that
**`jira-intern`** dumps into `jira-intern/` — no Jira login, no waiting on the web UI.

React 19 · Vite 6 · Tailwind v4 · Motion (Framer Motion). Built to a **single self-contained
`dist/index.html`** you just double-click — no server, no rebuild when the data refreshes.

## Open it — two ways

**1. No server (default).** Just double-click **`Open Board.html`** (or `dist/index.html`). It reads the
last data the intern dumped to `../jira-intern/data.js` straight off `file://` — nothing to run.
The header's **Reload** button (or press `r`) re-reads the latest dump; run the intern in a terminal
whenever you want fresh tickets. **You never rebuild the app to see new data.**

```
open dist/index.html        # macOS — or double-click "Open Board.html"
```

**2. Live server (optional).** `npm run serve` → open the printed `http://localhost:4321/...` URL.
Here the header button becomes **Refresh** and actually runs `run-intern.sh` for you, shows a spinner,
and reloads when fresh data lands. If a run is already going (even one you started in a terminal), the
button reattaches to it — and if you refresh the page mid-run, it reconnects instead of looking idle.

## What you get

- **Board** — To Do · In Progress · **In Review** (folds in *Ready4Review* + *Code Review*) · QA · Done.
  Colour-coded, animated cards; click one for full details. Stat chips filter the board; live search.
- **On Hold** — its own section, shown **only when something is blocked/waiting** (hidden otherwise).
- **Completed** — the full historical archive of every Done ticket, **collapsed by default**. Expand to a
  list (number · name · status); each row has a ▸ to **peek inline** (opened, closed, branch, status, PR /
  merged) without leaving the page, plus *Expand all*. Click a row to open the full detail page.
- **Ticket details** — a slide-in drawer with **every section expanded by default**: status pipeline,
  overview, PR card, description, an interactive acceptance-criteria checklist, comments, related issues,
  Confluence/docs, proposed solution, effort, open questions, copy-able branch, sources. Light/dark toggle.

## Data contract

`src/types.ts` is the single source of truth for the data shape. `jira-intern/intern-prompt.md`
documents the **same** schema for the intern to produce — keep the two in sync. Files the intern writes:

- `jira-intern/data.json` — canonical, parseable dump.
- `jira-intern/data.js`   — `window.__JIRA_DATA__ = <that json>;` for `file://` loading.

## Develop / rebuild

```
npm install                                  # uses a writable cache: npm i --cache "$TMPDIR/npm-cache-jb"
npm run dev                                  # localhost:5173 — renders a SAMPLE fixture (src/fixtures.ts)
npm run build                                # -> dist/index.html (single self-contained file)
```

`npm run dev` shows rich sample data so you can design every state (On Hold, Completed, the drawer).
The production build only ever reads the real `window.__JIRA_DATA__`; the fixture is dead-code-eliminated.

## Layout

```
src/
  types.ts              # THE CONTRACT (shared with intern-prompt.md)
  data.ts               # window.__JIRA_DATA__ → app  (dev fixture / empty-state fallback)
  fixtures.ts           # SAMPLE data for `npm run dev` only
  lib/columns.ts        # status → column mapping + colours
  lib/format.ts         # priority / type / PR / date helpers
  components/            # Header, Stats, Board, Column, TicketCard, OnHold, Completed, TicketDetail, …
vite.config.ts          # single-file build + injects the external data.js <script>
```
