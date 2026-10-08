# Demo tickets

The sample board behind **Settings → Features → Demo mode**. Everything here is invented: no
ticket, person, URL or pull request is real, and nothing in this folder is ever sent to Jira,
Bitbucket or the AI intern. Your real dump (`../data.json`) is never read or written while Demo
mode is on.

| File | What it is |
|---|---|
| `data.json` | **The source of truth.** The whole sample dump, same shape as the real `jira-intern/data.json` (`src/types.ts::JiraData`). The board loads this. |
| `tickets/<KEY>.json` | One file per ticket — the easy way to read them by hand. Generated from `data.json`. |
| `tickets/completed-<KEY>.json` | One file per Completed-archive row. |
| `tickets/raised-<KEY>.json` | One file per Raised-by-me row. |
| `build.mjs` | Regenerates `tickets/` from `data.json`. |

## Editing

Edit `data.json`, then:

```bash
npm run demo:split      # refresh tickets/ to match
```

With the board **served** (`npm run serve`, or Docker), Demo mode fetches this `data.json`, so a
reload shows your edits — no rebuild needed. Opened from `file://`, the board falls back to the
copy compiled into `dist/index.html`, which is refreshed by `npm run build`.

## Dates stay fresh

Timestamps are stored as real dates anchored to `_demoNow`. On load the board shifts every date by
the difference between that anchor and the current time, so the sample board always looks as if it
were fetched minutes ago — a Done card still says "archives in 1d", the active sprint is still
active, and Next Sprint has still not started. Keep `_demoNow` as it is unless you want to rebase
the whole set.

## What the set covers

- **Every column** — To Do, Blocked, In Progress, In Review, QA (both the ready shelf and *QA In
  Progress*), Done, plus On Hold and Next Sprint.
- **Every pull-request state** — merged, approved, changes requested, unresolved comments,
  declined, none; one approval short of the requirement; approved while comments are still open;
  every attempt declined; several PRs across repositories; merged while the ticket is still
  blocked; closed in Jira with the code never merged.
- **The Done gate** — `DEMO-242` passes every gate (drag it to Done and it goes through).
  `DEMO-240` (QA not started), `DEMO-241` (no QA ticket), `DEMO-244` (fix PR unmerged) and
  `DEMO-201` (no PR at all) are each refused for a different reason.
- **Hierarchy** — my tickets with my sub-tasks, sub-tasks owned by QA, a sub-task with its own
  child, a team-mate's ticket carrying my sub-task, an unassigned ticket, and an epic.
- **Card edges** — no story points, 21 points, no branch, several branches, no description, a very
  long title, many labels, carried across three sprints, minutes old, a year old, archiving
  tomorrow, and a long unresolved comment thread.
