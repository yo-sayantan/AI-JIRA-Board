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

## Cards

Each card shows type, key, story points, title, priority, PR state, approvals, branch, and how
long since it last moved. **Click a card** to open its full detail drawer. On a Done card, the
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
