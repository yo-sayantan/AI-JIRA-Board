# Features — what the board does and where each piece lives

Every user-facing capability, its behaviour rules, and the code that implements it. File paths
are the fastest way into any feature.

## The kanban board

| Aspect | Behaviour | Code |
|---|---|---|
| Columns | To Do · **Blocked** · In Progress · In Review (folds Ready4Review/Code Review) · QA · Done, fixed order. Blocked is a side state (not a pipeline stage); while empty and nothing is being dragged it folds to a slim rail so the working columns get the width, and opens the moment a drag starts | `src/lib/columns.ts` (`BOARD_COLUMNS`), mapping fallback `mapStatusToColumn` |
| Column assignment | The intern maps raw Jira status → `column`; the app trusts it, with a word-boundary fallback for unknown statuses | `jira-intern/_jira.py::status_column`, `src/data.ts::normalizeTicket` |
| QA In Progress | A shelf inside the QA column for tickets the QA team has picked up (`In QA`, `Under QA`, `In Testing`, `QA In Progress`… — any QA status that is not a ready/awaiting word). Appears only when occupied. Never a drop target: dropping on QA lands on a ready-for-QA status and QA moves it on in Jira | `src/lib/columns.ts` (`isQaInProgress`, `QA_IN_PROGRESS`), `board/Column.tsx`, `transition.py` (`PREFERRED['qa']`) |
| Cards | Key, title, type/priority glyphs, points, branch, PR badge (the PR of the ticket's newest branch), `+N PR` for the others, comment count, age, sprint-carryover marker | `src/components/board/TicketCard.tsx` |
| Done retirement | A Done ticket stays ~3 days as a "recent win", then auto-retires into Completed (`app.doneBoardDays`) | `src/data.ts::prepare` |
| Manual archive | Trophy button on a Done card/drawer moves it to Completed immediately; undoable until reload drops it | `src/data.ts` (localStorage `jb-archived`), `ArchivedUndo` in `board/BoardNotices.tsx` |
| Empty board | Celebration state when nothing is active | `board/FunEmptyBoard.tsx` |
| Drag to change status | Drop a card in To Do / Blocked / In Progress / In Review / QA / Done and the ticket is transitioned **in Jira** in the background. The card moves at once; Jira's verdict arrives a few seconds later. In Review warns when there is no PR, QA warns when there is no QA ticket (the move still happens). Done is **refused** until every PR is merged and every QA ticket is done — the card slides back. A **sub-ticket** is lighter: with no PR (and no QA ticket) of its own it can go straight to Done, because its work usually rides on the parent's PR; a PR *of its own* that is not merged (or an open QA ticket) still blocks. The parent's PR never counts for its sub-tickets. Gates read live Jira, not the cached dump. Settings → *Drag to change status*; needs the local server. | `board/Column.tsx` (drop target), `board/TicketCard.tsx` (native drag), `src/hooks/useTicketMoves.ts` (optimistic override + bounce-back), `POST /api/move-ticket` in `server/serve.mjs` → `server/jobs.mjs::moveTicket` → `jira-intern/transition.py` |

## Demo mode

Settings → Features → **Demo mode**. Replaces the board with ~20 invented tickets so every
feature can be exercised without real data — and with every server call switched off.

| Aspect | Behaviour | Code |
|---|---|---|
| Where the tickets live | **`jira-intern/demo/`** — beside the real dump, so they can be read and edited by hand. `data.json` is the source the board loads; `tickets/<KEY>.json` is a per-ticket mirror (`npm run demo:split`). Served mode fetches the folder, so an edit shows on reload with no rebuild; `file://` uses the copy compiled into the bundle | `jira-intern/demo/`, `src/demo/data.ts` |
| Dates stay fresh | The file stores real dates anchored to `_demoNow`; every date is shifted onto the current clock at load, so the active sprint is still running, Next Sprint still has not started, and the oldest Done card still says "archives in 1d" | `src/demo/data.ts::rebaseDemoDump` |
| What you get | 34 board tickets across all six columns (Blocked included) and both QA shelves, plus On Hold, Next Sprint, nested sub-tasks, PRs in **every** state (merged · approved · one approval short · approved-with-open-comments · changes requested · declined-then-retried · all attempts declined · none · several across repos), a 13-row Completed archive over ~2 years, Raised by me with hand-off trails, and two sample PR Readiness Reports (`DEMO-230` ships, `DEMO-210` does not) | `jira-intern/demo/data.json`, `src/demo/reports.ts` |
| The Done gate, both ways | `DEMO-242` passes every gate — drag it to Done and it goes through. `DEMO-240` (QA not started), `DEMO-241` (no QA ticket), `DEMO-244` (fix PR unmerged) and `DEMO-201` (no PR) are each refused for a different reason | `src/demo/gates.ts` |
| Drag-and-drop | Works fully, and runs the **same PR / QA gates in the browser** — a Done with an unmerged PR or open QA still slides back with the reason. `src/demo/gates.ts` mirrors `jira-intern/transition.py::evaluate`; `gates.test.ts` pins both | `src/demo/gates.ts` |
| Nothing is sent | Board/archive/raised refreshes, per-ticket refresh, report generation and transitions are all refused with one message. `runner.ts::setDemoMode` is the hard switch — it makes those calls return a refusal before any `fetch`, so a path nobody guarded still cannot reach Jira or the AI intern. Settings (including an AI model pull) still work: they configure the machine and are never triggered by a demo ticket | `src/lib/runner.ts`, `src/hooks/useInternJobs.ts`, `useReports.ts`, `useTicketMoves.ts` |
| Your real data | Untouched. The dump is built in the browser, never written; the archive set is kept in memory so `jb-archived` keeps the real board's keys. Turning the toggle off restores the real board immediately, no reload | `src/hooks/useBoardData.ts` |
| Telling them apart | An amber **Demo mode** banner sits above the chips with a "Show my real board" button; `DataSource` reports `demo`; every URL in the data points at `example.com` | `board/BoardNotices.tsx::DemoBanner` |

## Stat chips (the row above the board)

`src/components/board/Stats.tsx` — one selection drives everything (`StatSelection`):
column chips filter the board; **Next Sprint** toggles its bar; **All** expands everything;
**N active** clears. Mutually exclusive by design — picking one clears the rest.
Right-aligned: the indigo **Raised open/total** chip and the gold **Completed N** trophy.

## Search

`src/lib/search.ts` — one grammar shared by the board, Completed and Raised views:

- A **bare number is an identifier**, matched only against ticket numbers (own, parent's,
  sub-tickets') and PR ids — never free text. `611` prefix-matches `6115`; single digits match
  exactly only.
- `FIDM-6115` / `fidm6115` count as exact key matches (lazy project parse so `fidm6115` reads as
  `fidm`+`6115`).
- Everything else is token-AND substring search over a cached haystack (title, status, people,
  labels, branches, PR metadata, sub-tickets). Rows are indexed once per load (`WeakMap`).

## Completed archive

Near-full-screen overlay (gold trophy chip) listing every Done ticket ever assigned to you.

- Hero stat band (tickets done, story points, PRs merged, releases, onboarding).
- Sticky controls: search, PR filters (any/merged/declined), project chips, type chips,
  expand-all; **Mine only** hides "context parents" (`mine: false` rows — someone else's parent
  shown because you delivered a sub-ticket under it; never counted in totals).
- Pure chronology: year → month by `resolved`; row peek shows lead time vs dev time
  (`cycleTime`), branches/PRs, sub-ticket delivery table.
- Data: weekly `completed_archive.py` rebuild (full or scoped year/since/key via the header's
  Archive menu), per-ticket `cache/*.json`, schema-version busting.
- Code: `src/components/completed/Completed.tsx`, `jira-intern/completed_archive.py`,
  `header/ArchiveMenu.tsx`.

## Raised by me

Overlay (indigo megaphone chip, `open/total` count) for every non-sub-task ticket you
**reported** — bugs filed for later, whoever works them now.

- Answers three questions per row: current **status** (colour-coded pill + left border), **who
  holds it** (me / other / unassigned), and **hand-offs** (↻ count; full `assigneeLog` trail
  from the Jira changelog, rendered as a pill chain with dates).
- Linked tickets: Jira issue links + epic shown as a `⇄ KEY` chip and a "Linked tickets"
  section — what the bug was raised from / blocks / duplicates.
- Row peek: AI brief (when present), full description (scrollable), field grid, hand-off trail.
- Filters: status buckets (Open / In progress / Review-QA / Fixed), assignment
  (With me / With others / Unassigned / Reassigned), projects, types; same search grammar.
- **Hard refresh** button: full re-pull of every reported ticket (existing rows update, new ones
  appear) — these tickets never ride the normal board refresh once someone else works them.
  Shows a "fetched X ago" stamp (`raisedAt`).
- Sub-tasks are excluded twice (JQL + parent-field filter): a sub-ticket you cut under your own
  work is yours by default, not "raised" work.
- Code: `src/components/raised/Raised.tsx`, `jira-intern/raised.py`,
  `local-runner/refresh-raised.sh`, `POST /api/run-raised`, counts in `lib/boardView.ts`.

## Next Sprint

To Do tickets whose sprint hasn't started (Jira sprint state `future`, or a grooming bucket)
are pulled OUT of To Do into a collapsible bar so a finished sprint doesn't look full.
`src/lib/format.ts::isNextSprint`, `board/NextSprint.tsx`, chip in `Stats.tsx`.

## On Hold

Blocked/waiting statuses get their own strip below the board (feature-toggleable; off folds
them back into To Do). `board/OnHold.tsx`, `splitBoard` in `lib/boardView.ts`.

## Ticket detail drawer

Click any card/row anywhere → a right-side drawer with the full ticket: AI brief, description,
acceptance criteria, code (branches + PRs with reviewers/approvals/comment-resolution), comments,
links (related/Confluence/external), update log, sub-tickets (each openable — drawers **stack**,
with breadcrumb depth and Esc closing only the top layer).
`src/components/ticket/TicketDetail.tsx`, stack in `hooks/useDrawerStack.ts`; archive/raised rows
are adapted via `completedToTicket` / `raisedToTicket` so one component renders all three.

## PR Readiness Reports

Ship/no-ship verdict per ticket-with-PR. Deterministic base in seconds
(`jira-intern/pr_report.py` → `reports/<KEY>.json`), optional AI enrichment on top. Rendered from
a fixed block vocabulary (callout/stats/table/cards/list/timeline/links/kv) with per-block
provenance (derived/ai). Bulk generation from the header menu; staleness by PR fingerprint.
`src/components/reports/PrReport.tsx`, `header/ReportsMenu.tsx`, `hooks/useReports.ts`,
`server/reports.mjs`. Details in `docs/AI-PIPELINE.md`.

## AI briefs

Per-ticket summary at the top of the drawer (and in Raised row peeks). Written by the AI
intern's `summarize-active` pass; staleness = `aiSummaryAt` vs `lastUpdate`; ≤8 per pass;
raised rows queue after active tickets. Render path heals JSON-wrapped model output
(`unwrapBrief`). Toggle: Settings → AI briefs; level None disables generation entirely.

## Header

- **Freshness pill** — when the intern last ran, coloured by staleness (`lib/format.ts::freshness`).
- **Sprint block** — active sprint name, dates, working-days-left, progress bar (`sprintStatus`).
- **Refresh board** — the quick daily fetch; the button IS its own progress bar (fill + x/y count
  from `.progress.json`). **Archive menu** — full/year/since/key rebuild with live progress and
  Stop. **Reports menu** — bulk PR-report generation with scope.
- Settings gear, help (?) → the served Setup Guide, theme toggle.
- `src/components/header/Header.tsx`, `ArchiveMenu.tsx`, `ReportsMenu.tsx`.

## Settings

Overlay with three areas (`src/components/settings/Settings.tsx`):
- **Appearance** — theme auto/fixed/scheduled (+ day window).
- **Features** — one switch per board feature, generated from the registry in
  `src/lib/settings.ts::FEATURES` (add an entry there + a colour/icon in `FEATURE_STYLE`;
  TypeScript enforces both). Current keys: prReports, nextSprint, completedArchive,
  raisedTickets, animations, shortcuts, autoRefresh, aiBriefs, onHold, reloadActive.
- **AI usage** — level None/Low/Moderate/Max, backend local (Ollama tag dropdown, host-Ollama
  checkbox, model pulls with live progress) or cloud (provider/model/effort), parallelism knobs,
  server cadences. Server-relevant keys mirror to `jira-intern/.settings.json`.

## Live jobs & notifications

- `useInternJobs` — start/attach/watch daily, archive, raised and per-ticket refresh jobs with
  one shared status poller (`lib/statusPoller.ts`: 12s idle / 4s busy / 1s pulls; pauses when
  the tab is hidden). Toast lifecycle per job; stale-run attach on page load.
- Toasts (`useToasts` + `common/Toast.tsx`), run notices dock (`common/NoticesDock.tsx`),
  stale-data handling via the freshness pill.

## Keyboard & accessibility

`/` focuses search, `r` refreshes, Esc closes the top layer; disabled while typing/overlays and
toggleable. Reduce-motion honoured via the animations toggle (`jb-no-anim`). Colour is never the
only signal (labels/glyphs everywhere). See `docs/legal.html#a11y` for the public statement.
