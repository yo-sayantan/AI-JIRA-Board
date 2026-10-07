# Using the board

A tour of what's on screen and how to drive it. Anything marked *served* needs the local server
(Docker or `npm run serve`); on `file://` the board is read-only apart from **Reload**.

## Layout, top to bottom

- **Header** — your name, the **freshness pill** (how old the dump is), the **current-sprint pill**
  (name · dates · working days left · progress bar), live **search**, then the controls:
  **Refresh board / Reload**, the **trophy** archive menu (*served*), the **sparkle** reports menu
  (when PR reports are on), the **gear** (Settings), **?** (opens the offline Setup & Deployment
  guide, even when the server is down) and the light/dark toggle.
- **Stale banner** — a red banner under the header when the dump is more than **12 hours** old,
  with a Refresh/Reload button. Dismissable for the session.
- **Stat chips** — one per column plus scope toggles. Click to filter; click again to clear.
- **Board** — the kanban columns: To Do · In Progress · In Review · QA · Done.
- **On Hold** — appears only when something is blocked/waiting.
- **Next Sprint** — a corner icon / strip for tickets queued in a sprint that hasn't started.
- **Notices dock** — a small amber pill in the bottom-left when a run left notes (for example
  "Jira unavailable — showing last known state"). Click to expand, × to dismiss; it also hides
  itself after the Settings notification time.
- **Toasts** — job progress and results in the corner; duration and count are in Settings.
- **Footer** — tagline and badge from `config → app.branding`.

## The chips (top row)

| Chip | Does |
|---|---|
| **N active** | Clears all filters — the default view. |
| **To Do / In Progress / In Review / QA / Done** | Filters the board to that one column. Click again to clear. |
| **Next Sprint N** | Toggles the Next Sprint section. Picking any other chip hides it again. |
| **All** | Reveals everything at once — every column plus the Next Sprint queue, expanded. |
| **Completed N** | Opens the Completed archive (counts *your* tickets only). |

Search (`/` to focus) narrows everything live; a bare number is treated as a ticket/PR id.

## Next Sprint

Tickets assigned to you whose sprint **hasn't started yet** (Jira sprint state `future`, or a
grooming bucket like `… READY`) are deliberately kept **out** of the To Do column — otherwise a
sprint where you've finished all your To Do work still looks full. They live in their own section:

- Click the **Next Sprint** chip to reveal a minimal icon in the bottom-right corner.
- Click that icon to expand the full list, grouped by sprint, with when each one starts.
- Click **All** to jump straight to the fully-expanded list.
- The moment you actually start one (In Progress / Review / QA), it moves onto the board where
  its real status lives.

## Header menus (served)

Both menus share the same scope picker and show a progress bar while a job runs.

**Trophy — Rebuild the Completed archive.** Scopes: *All closed tickets*, *This year*, *Last 30 /
90 days* (from `config → archive.presetWindowDays`), *Resolved since a date*, or *One ticket key*.
A range or a single key updates only those rows. **Stop rebuild** cancels a rebuild this server
started. The menu is disabled while the quick refresh owns `data.json`. Offline it shows the
terminal command instead.

**Sparkle — Generate PR Readiness Reports.** Same scopes (all tickets with a PR, this year, a
window, since a date, one key) plus a **Force rebuild** checkbox to regenerate reports that are
already current. The subtitle shows "N of M tickets with a pull request have a report". **Stop
reports** clears the queue and tells AI-Intern to abandon in-flight enrichment.

## PR Readiness Report

Every ticket that has a pull request gets a management-grade **PR Readiness Report** — the
2-second verdict on "can this ship?", with the evidence behind it. Open a ticket: the report
button sits **above the AI brief**, coloured by its verdict.

| Button state | Meaning |
|---|---|
| **PR Readiness Report · Ready 90/100** (coloured) | A report exists — click to open it. |
| **Generating PR readiness report…** (spinner) | Being built in the background; the button appears when it lands. |
| **Generate PR readiness report** (dashed) | None yet — click to build one (*served*). |

The report opens as a tabbed overlay. Tabs are **colour-coded by relevance** so you can skip the green ones:

| Tab | Colour | What's in it |
|---|---|---|
| **Verdict** | the verdict's colour | Decision + next action (owner → action → due sprint), 5 at-a-glance tiles, the **gate checklist** (approvals, comments, changes requested, merged, QA sub-task, dependencies, fixVersion, release branch, CI, security scan — the first *Fail* is the reason for the verdict), release-gate warning when triggered |
| **Evidence** | worst row wins | Evidence chain — *Source · Observed · Conclusion*, one row per fact; every PR (cards, or a worst-first table when >4); timeline |
| **Open scope** | red / amber / green | What still blocks closure with an **Owner** column (UNASSIGNED in red), ≤3 next actions, status-consistency warning (e.g. closed in Jira but PR never merged) |
| **AI assessment** | violet | Only after the AI pass: per-file change classification (Required / Neutral cleanup / Risky / Unrelated), review focus, production proof, deployment & rollback facts, risks, the ticket-specific release gate |
| **Sources** | grey | Every link, run metadata, fingerprint |

Verdicts: *Ready to merge · Merge-ready, scope open · Awaiting approvals · Blocked (unresolved comments /
changes requested) · Merged, awaiting verification · Ready to close · Shipped · Shipped, no fixVersion ·
Closed in Jira, code not merged · Declined, no replacement · On hold* — plus a *stale* modifier after 14
idle days. The deterministic pass **owns** the verdict, score and every colour; the AI pass may only add
(its own tab, extra evidence rows, the CI / security-scan gate states, a business one-liner) — a report
that changes anything derived is rejected and the base is restored. Every block carries a provenance chip:
**measured**, **AI-enriched**, or **not verified** (a gap — shown, never hidden). A ring shows the 0–100
readiness score.

**How reports are produced.** Two passes, so a report always exists once a PR appears:

1. *Deterministic base* — `jira-intern/pr_report.py`, from the fetched ticket data. No AI, no network.
2. *AI enrichment* — the **AI-Intern** container merges structured JSON (business impact, per-file
   notes when a file list exists, risks, review focus). Settings **None** stops after the base;
   **Low / Moderate / Max** only change how long the model may take. **Local AI** is Ollama (in
   Docker, or on the host via *Host Ollama · Metal*); **Cloud AI** is Claude, Gemini or Cursor,
   each with its key read only from `~/.cursor/mcp-secrets.env`. The cloud model lists are curated:
   Claude shows Haiku models, Gemini shows Flash/Lite models, and Cursor shows the value-priced
   allow-list in `ai-intern/worker.py` (`_CURSOR_KEEP`); Cursor effort is **Low** (default) or
   **Medium**. The worker reads the local intern data plus live Jira/Bitbucket (same tokens) and,
   when the optional keys/endpoints are configured, Bitbucket build status (CI), Checkmarx and
   Dynatrace; without them those gate rows read *Not read* / *Not verified*.

**When they are generated.** Automatically after every fetch for any ticket whose PR appeared or
changed (background, capped by `reports.maxPerRun`), after a single-ticket refresh, on demand from
the drawer button or the sparkle menu, and on the *PR reports* cadence in Settings (missing, stale,
or scored under 100). Reports live in `jira-intern/reports/` — **git-ignored**, they contain real
company data. Terminal commands: [DEPLOYMENT.md → PR Readiness Reports](DEPLOYMENT.md#pr-readiness-reports).

## Cards

Every card is a **fixed height**, full column width. Pills wrap inside a two-line cap so banners
never grow the shell. Hover lifts with a light 3D tilt (off when motion is disabled). A **red
border** means the ticket carried across more than one sprint. Done cards spark once on first
paint after a page load. **Click a card** to open its full detail drawer. On a Done card, the
trophy button retires it to Completed immediately (undo from the strip under the board; the choice
is remembered in this browser).

## Ticket detail (drawer)

A slide-in with every section expanded: status pipeline, overview (sprint/people/epic/labels),
PR card, the PR Readiness Report button, the AI brief (feature switch), description, an interactive
acceptance-criteria checklist (ticks remembered per ticket in this browser), comments, related
issues, Confluence/docs, proposed solution, effort, open questions, a copy-able branch, and
sources. *Served:* a per-ticket **refresh** re-fetches just that ticket (queued one at a time).
Open a sub-task to stack another drawer on top; **Esc** or the backdrop closes the top one.

## Completed archive

A **full-screen dialog**, opened from the Completed chip. Rows are grouped
**newest first by year, then month**, each row showing type, key, title, resolved date, comments
and PR state. Controls:

- **Search** — its own box; a bare number searches ticket numbers (own, parent's, sub-tickets',
  PR numbers), anything else is a text search.
- **Mine only / Show context** — hides or shows parent tickets owned by someone else that appear
  because you delivered a sub-ticket under them (not counted in your totals). Remembered in this
  browser.
- **Expand all / Collapse all** — every row has a ▸ to **peek inline** (opened, closed, branch,
  PR/merged, sub-ticket owners and reviews) without leaving the page.
- **Filter chips** — tickets with any / merged / declined pull request, one project, one type.
- Click a row to open the full ticket detail on top. **Esc** closes the dialog (unless a drawer is
  open on top — then it closes the drawer first).

## Settings (gear)

Five sections. Appearance, notifications and feature switches are saved **in this browser**; the
job and AI choices are also synced to the server in *served* mode (`jira-intern/.settings.json`)
so scheduled runs and AI-Intern honour them.

| Section | What's in it |
|---|---|
| **Appearance** | Auto (follow the OS) · Light · Dark · Schedule (light between two hours you set). The header toggle pins a fixed theme. |
| **Background jobs** | *Runs:* Active tickets (off / daily / twice-daily), Whole board — active tickets then the Completed archive (off / daily / weekly / twice-weekly), PR reports — stale, missing or under 100 (same cadences). *At once:* Active tickets fetched in parallel (1–16), Archive tickets (1–16), PR reports built at once (1–6). Apply only while the server is running. |
| **AI** | AI usage **None / Low / Moderate / Max** (applies from the next report). Backend **Local AI** (Ollama; *Host Ollama · Metal* checkbox) with the model dropdown and download button, or **Cloud AI** with provider **Cursor / Gemini / Claude**, the curated model list, Cursor effort Low/Medium and a price estimate. Shows the intern's live status; the pickers need AI-Intern running. |
| **Notifications** | Seconds a notification stays (2–10) · notifications on screen at once (1–10). |
| **Features** | Nine switches: PR Readiness Reports · Next Sprint section · Completed archive · Motion & animations · Keyboard shortcuts · Background auto-refresh (status polling while open) · AI briefs · On Hold section (off puts those tickets back in To Do) · Refresh on open (fetch active tickets on every reload; scheduled jobs are separate). |

**Save** writes the changes; **Esc** or ✕ closes without saving.

## Keyboard

| Key | Action |
|---|---|
| `/` | Focus search |
| `r` | Refresh / reload data |
| `Esc` | Close the top drawer / dialog / overlay |
| `Enter` / `Space` | Open the focused card |

`/` and `r` are off while you type, while a dialog is open, and when the *Keyboard shortcuts*
feature is off; `Esc` always works.

## Refreshing

- **Docker / live server:** **Refresh board** runs the fetch for your active tickets and swaps in
  the data when it lands (seconds). The archive and reports have their own menus; the scheduler
  runs the cadences from Settings in the background. *Refresh on open* fetches active tickets each
  time you open or reload the board.
- **Static file:** **Reload** re-reads the last dump; run a fetch in a terminal for new tickets.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the fetch commands and cadences.
