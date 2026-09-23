# Using the board

A tour of what's on screen and how to drive it.

## Layout, top to bottom

- **Header** — your name, last-fetch freshness, the current-sprint pill (name · dates · working
  days left · progress bar), live **search**, light/dark toggle, and **Refresh/Reload**.
- **Stat chips** — one per column plus scope toggles. Click to filter; click again to clear.
- **Board** — the kanban columns: To Do · In Progress · In Review · QA · Done.
- **On Hold** — appears only when something is blocked/waiting.
- **Next Sprint** — a bar for tickets queued in a sprint that hasn't started (see below).
- **Completed** — the full historical archive (top-right trophy chip).

## The chips (top row)

| Chip | Does |
|---|---|
| **N active** | Clears all filters — the default view. |
| **To Do / In Progress / In Review / QA / Done** | Filters the board to that one column. Click again to clear. |
| **Next Sprint N** | Toggles the Next Sprint bar. Picking any other chip hides it again. |
| **All** | Reveals everything at once — every column plus the Next Sprint queue, expanded. |
| **Completed** | Opens the full archive of every Done ticket. |

Search (`/` to focus) narrows everything live; a bare number is treated as a ticket/PR id.

## Next Sprint

Tickets assigned to you whose sprint **hasn't started yet** (Jira sprint state `future`, or a
grooming bucket like `… READY`) are deliberately kept **out** of the To Do column — otherwise a
sprint where you've finished all your To Do work still looks full. They live in their own bar:

- Click the **Next Sprint** chip (top row) to reveal a minimal icon in the bottom-right corner.
- Click that icon to expand the full list; grouped by sprint, with when each one starts.
- Click **All** to jump straight to the fully-expanded list.
- The moment you actually start one (In Progress / Review / QA), it moves onto the board where
  its real status lives.

## PR Readiness Report

Every ticket that has a pull request gets a management-grade **PR Readiness Report** — the
2-second verdict on "can this ship?", with the evidence behind it. Open a ticket: the report
button sits **above the AI brief**, coloured by its verdict.

| Button state | Meaning |
|---|---|
| **PR Readiness Report · Ready 90/100** (coloured) | A report exists — click to open it. |
| **Generating PR readiness report…** (spinner) | Being built in the background; the button appears when it lands. |
| **Generate PR readiness report** (dashed) | None yet — click to build one (server/Docker mode). |

The report opens as a tabbed overlay. Tabs are **colour-coded by relevance** so you can skip the green ones:

| Tab | Colour | What's in it |
|---|---|---|
| **Verdict** | the verdict's colour | Decision + next action (owner → action → due sprint), 5 at-a-glance tiles, the **gate checklist** (approvals, comments, changes requested, merged, QA sub-task, dependencies, fixVersion, release branch, CI, security scan — the first *Fail* is the reason for the verdict), release-gate warning when triggered |
| **Evidence** | worst row wins | Evidence chain — *Source · Observed · Conclusion*, one row per fact; every PR (cards, or a worst-first table when >4); timeline |
| **Open scope** | red / amber / green | What still blocks closure with an **Owner** column (UNASSIGNED in red), ≤3 next actions, status-consistency warning (e.g. closed in Jira but PR never merged) |
| **AI assessment** | violet | Only after the AI pass: per-file change classification (Required / Neutral / Risky), review focus, production proof (Dynatrace), deployment & rollback facts, risks, the ticket-specific release gate |
| **Sources** | grey | Every link, run metadata, fingerprint |

Verdicts: *Ready to merge · Merge-ready, scope open · Awaiting approvals · Blocked (unresolved comments /
changes requested) · Merged, awaiting verification · Ready to close · Shipped · Shipped, no fixVersion ·
Closed in Jira, code not merged · Declined, no replacement · On hold* — plus a *stale* modifier after 14
idle days. The deterministic pass **owns** the verdict, score and every colour; the AI pass may only add
(its own tab, extra evidence rows, CI/scan gate states) — a report that changes anything derived is
rejected and the base is restored. Every block carries a provenance chip: **measured**, **AI-enriched**,
or **not verified** (a gap — shown, never hidden). A ring shows the 0–100 readiness score.

**How reports are produced.** Two passes, so a report always exists once a PR appears:
1. *Deterministic base* — `jira-intern/pr_report.py`, from the fetched ticket data. No AI, no network.
2. *AI enrichment* — **JIRA-AI-Intern** (Ollama locally, or a cloud chat API) merges structured JSON
   (business impact, per-file notes when a file list exists, risks). Settings **None** stops after
   the base. **Max** is the longest timeout (`full`). CI / Checkmarx / live Dynatrace stay Not verified.

**When they are generated.** Automatically after every fetch for any ticket whose PR appeared or
changed (background, capped by `reports.maxPerRun`), after a single-ticket refresh, or on demand from
the button. Reports live in `jira-intern/reports/` — **git-ignored**, they contain real company data.
Backfill a whole year by hand: `bash jira-intern/local-runner/pr-reports-backfill.sh --year 2026`.

## Cards

Every card is a **fixed height**, full column width. Pills wrap inside a two-line cap so banners
never grow the shell. Hover lifts with a light 3D tilt (off when motion is disabled). A **red
border** means the ticket carried across more than one sprint. Done cards spark once on first
paint after a page load. **Click a card** to open its full detail drawer. On a Done card, the
trophy button retires it to Completed immediately (undo from the strip under the board).

## Ticket detail (drawer)

A slide-in with every section expanded: status pipeline, overview (sprint/people/epic/labels),
PR card, description, an interactive acceptance-criteria checklist, comments, related issues,
Confluence/docs, proposed solution, effort, open questions, a copy-able branch, and sources.
Open a sub-task to stack another drawer on top; **Esc** or the backdrop closes.

## Completed archive

Collapsed by default. Expand to a compact list (number · name · status); each row has a ▸ to
**peek inline** (opened, closed, branch, PR/merged) without leaving the page, plus *Expand all*.
Click a row for the full detail page.

## Keyboard

| Key | Action |
|---|---|
| `/` | Focus search |
| `r` | Refresh / reload data |
| `Esc` | Close the top drawer / overlay |
| `Enter` / `Space` | Open the focused card |

## Refreshing

- **Docker / live server:** the header **Refresh** runs the fetch and reloads when data lands.
- **Static file:** **Reload** re-reads the last dump; run a fetch in a terminal for new tickets.

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the fetch commands.
