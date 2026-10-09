#!/usr/bin/env python3
"""Move one Jira ticket to another board column — the write side of drag-and-drop.

    python3 transition.py <KEY> <todo|blocked|hold|prog|rev|qa|qaip|done> [--force|--undo]

Prints ONE JSON line and exits 0 whenever it reached a verdict:
    {"ok": true,  "moved": true, "status": "In Review", "warnings": ["No pull request…"]}
    {"ok": false, "blocked": true, "forcible": true, "reason": "Can't move to Done: #12 still open"}
    {"ok": false, "error": "…"}                       (Jira unreachable, no matching transition)

The rules read LIVE Jira (issue links, sub-tasks, dev-status PRs), not the board's cached data.json,
so a PR merged five minutes ago counts. Mirror of src/lib/moveRules.ts (which judges the cached dump):
  • QA lane   → QA and QA In Progress hold QA tickets (raised by the user or linked to their work). Only a
                QA ticket may enter them, and a QA ticket — wherever it sits — moves only to QA · QA In
                Progress · Blocked · On Hold · Done (`lane_blocker`). `qa` lands on a READY-for-QA status,
                `qaip` on an in-progress one. QA tickets face no PR / QA gate.
  • On Hold   → WARN when a PR of the ticket is still open (it sits unreviewed while parked).
  • In Review → BLOCK unless the ticket has a PR (open or merged) — or, for a sub-ticket, its parent has
                an OPEN one.
  • Done      → BLOCK while a PR is still open (each must be merged or declined), when there is no PR at
                all (a sub-ticket may have none of its own), or when no QA ticket is raised (a sub-ticket's
                parent's QA ticket counts). Only the sub-ticket's OWN PRs count as its PRs.
  --force skips the In Review / Done gates (the board's ⌥-drop or "Move anyway"), never the QA lane.
  --undo  skips every check: it puts a ticket back where it just was.

Nothing here writes data.json; the board follows up with a normal single-ticket refresh.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _jira import jira_get, jira_post, load_env, status_column  # noqa: E402

# The drag-and-drop targets. ONE list, shared with the server (server/jobs.mjs) and the board
# (src/lib/columns.ts), so a new target cannot be accepted by one side and refused by another.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "move_targets.json"), encoding="utf-8") as _f:
    COLUMNS = tuple(json.load(_f))
# Jira workflows rarely name statuses exactly like the board; prefer these, then any in the column.
PREFERRED = {
    "todo": ("to do", "open", "reopened", "backlog"),
    "blocked": ("blocked", "impeded"),
    "hold": ("on hold", "hold", "parked", "waiting", "paused"),
    "prog": ("in progress", "dev in progress", "in development"),
    "rev": ("in review", "code review", "ready for review", "ready4review"),
    "qa": ("ready for qa", "ready4qa", "qa", "awaiting qa", "ready for testing", "in qa", "testing", "in testing"),
    "qaip": ("qa in progress", "in qa", "under qa", "in testing", "testing", "in test"),
    "done": ("done", "closed", "resolved", "completed"),
}


# Mirror of src/lib/columns.ts (isQaInProgress, QA_LANE, moveBlockedReason). QA statuses that are NOT a
# waiting word count as "QA In Progress"; the rest are ready-for-QA.
_QA_READY = ("qa", "ready for qa", "ready4qa", "awaiting qa", "qa ready", "ready for testing", "ready for test", "to test", "to be tested")
_QA_WAITING_WORDS = {"ready", "awaiting", "pending", "queued", "moved", "handed", "for"}
QA_LANE = ("qa", "qaip", "blocked", "hold", "done")
LANE_NAMES = "QA, QA In Progress, Blocked, On Hold or Done"
LABELS = {"todo": "To Do", "blocked": "Blocked", "hold": "On Hold", "prog": "In Progress", "rev": "In Review", "qa": "QA", "qaip": "QA In Progress", "done": "Done"}


def is_qa_in_progress(status):
    s = (status or "").strip().lower()
    if not s or s in _QA_READY:
        return False
    return not any(w in _QA_WAITING_WORDS for w in re.split(r"[^a-z0-9]+", s))


_QA_TYPE = re.compile(r"(^|[^a-z0-9])qa([^a-z0-9]|$)", re.I)
# A label that marks the ticket ITSELF as QA — not one about a dev ticket's QA ("qa-failed", "needs-qa").
QA_LABEL = re.compile(r"^(qa|qa[-_ ]?(ticket|task|test|testing)|test(ing)?([-_ ]?(ticket|task))?)$", re.I)
_QA_TITLE_LEAD = re.compile(r"^\s*\[?\s*qa\b", re.I)
_QA_TITLE_PREFIX = re.compile(r"\bqa\s*[:\-–—]", re.I)


def is_qa_ticket(type_name, title, labels=()):
    """A QA ticket: its TYPE says QA / Test, a label marks it (QA_LABEL), or its TITLE leads with a QA prefix
    ("QA: …", "[QA] …"). Stricter than is_qa (a dev ticket that merely says "verify" is not one) because it
    locks the ticket into the QA lane. Mirror of isQaTicket in src/lib/moveRules.ts."""
    type_name, title = type_name or "", title or ""
    return bool(
        _QA_TYPE.search(type_name)
        or re.search("test", type_name, re.I)
        or any(QA_LABEL.match((l or "").strip()) for l in labels or ())
        or _QA_TITLE_LEAD.search(title)
        or _QA_TITLE_PREFIX.search(title)
    )


def lane_blocker(current_column, target, qa_ticket):
    """Why the QA lane forbids moving to `target` (None when it allows it). Anything in the QA column is the
    lane's; only a QA ticket may enter QA / QA In Progress; a QA ticket goes only to QA_LANE."""
    in_lane = current_column == "qa" or qa_ticket
    if target in ("qa", "qaip") and not in_lane:
        return f"Only QA tickets can be moved to {LABELS[target]} — this ticket is not one."
    if in_lane and target not in QA_LANE:
        return f"A QA ticket can only be moved to {LANE_NAMES} — not to {LABELS[target]}."
    return None


def is_qa(issue):
    """A QA ticket is a sub-task or linked issue whose type or title says QA / test / verify."""
    text = f"{issue.get('type') or ''} {issue.get('title') or ''}".lower()
    return "qa" in text.split() or "qa" in text or "test" in text or "verif" in text


def _is_open(p):
    return not p.get("merged") and p.get("state") not in ("declined", "merged", "none")


def _names(prs):
    return ", ".join(f"#{p['id']}" if p.get("id") else "a PR" for p in prs)


def evaluate(target, prs, qa_issues, is_subtask=False, parent_prs=None, parent_qa=None):
    """Gate verdict for a move: (blocker or None, [warnings]). Pure, so it is unit-tested.

    `parent_prs` / `parent_qa`: a sub-ticket's parent's PRs and QA tickets; None = unknown (could not be
    read), which never blocks — the same as the board does when the parent is not in its data."""
    live = [p for p in prs if p.get("state") not in ("declined", "none")]
    open_prs = [p for p in prs if _is_open(p)]
    warnings = []
    if target == "hold" and open_prs:
        warnings.append(f"{_names(open_prs)} is still open — it will wait unreviewed while the ticket is on hold.")

    if target == "rev" and not live:
        if not is_subtask:
            return "Can't move to In Review: no pull request raised yet.", warnings
        if parent_prs is not None and not any(_is_open(p) for p in parent_prs):
            return "Can't move to In Review: no pull request of its own, and its parent has no open one.", warnings

    if target != "done":
        return None, warnings

    problems = []
    if open_prs:
        problems.append(f"{_names(open_prs)} still open (merge or decline it)")
    elif not prs and not is_subtask:
        problems.append("no pull request raised")
    qa_unknown = is_subtask and parent_qa is None
    if not qa_issues and not (parent_qa or []) and not qa_unknown:
        problems.append("no QA ticket raised (on it or its parent)" if is_subtask else "no QA ticket raised")
    if problems:
        return "Can't move to Done: " + "; ".join(problems) + ".", warnings
    return None, warnings


def issue_summary(raw):
    f = raw.get("fields") or {}
    return {
        "key": raw.get("key"),
        "title": f.get("summary"),
        "type": (f.get("issuetype") or {}).get("name"),
        "status": (f.get("status") or {}).get("name"),
    }


def qa_issues_of(fields):
    found = {}
    for sub in fields.get("subtasks") or []:
        found[sub["key"]] = issue_summary(sub)
    for link in fields.get("issuelinks") or []:
        other = link.get("outwardIssue") or link.get("inwardIssue")
        if other:
            found.setdefault(other["key"], issue_summary(other))
    return [i for i in found.values() if is_qa(i)]


def live_prs(issue_id, key=None, parent=None):
    """The ticket's OWN pull requests from live Jira: not PRs that name only other tickets
    (devinfo.scope_to_ticket), and for a sub-ticket (`parent` = the parent's {id, key}) not a PR it
    shares with the parent either."""
    # Imported here: devinfo pulls in the Bitbucket client, which the gate-only tests don't need.
    import devinfo

    info = devinfo.fetch_one(issue_id, enrich_open=False)
    if info is None:
        raise RuntimeError("could not read pull requests from Jira")
    info = devinfo.scope_to_ticket(key, info)
    if parent and parent.get("id"):
        # If the parent cannot be read nothing can be told apart; scope_to_subtask then leaves the
        # list whole, which can only block more, never wrongly allow.
        info = devinfo.scope_to_subtask(key, info, devinfo.fetch_one(parent["id"], enrich_open=False))
    return info["prs"]


def pick_transition(transitions, target):
    """The available transition landing in `target`'s column, most conventional name first. QA splits in
    two: `qaip` accepts only an in-progress QA status; `qa` prefers a ready one (falling back to any)."""
    column = "qa" if target == "qaip" else target
    fits = [t for t in transitions if status_column((t.get("to") or {}).get("name")) == column]
    if target == "qaip":
        fits = [t for t in fits if is_qa_in_progress(t["to"]["name"])]
    elif target == "qa":
        fits = [t for t in fits if not is_qa_in_progress(t["to"]["name"])] or fits
    if not fits:
        return None
    for name in PREFERRED[target]:
        for t in fits:
            if (t["to"]["name"] or "").lower() == name:
                return t
    return fits[0]


ISSUE_FIELDS = "status,subtasks,issuelinks,issuetype,summary,labels,parent"


def parent_facts(parent):
    """A sub-ticket's parent: (its PRs, its QA tickets), each None when it could not be read."""
    if not parent or not parent.get("key"):
        return None, None
    import devinfo  # see live_prs

    try:
        info = devinfo.fetch_one(parent["id"], enrich_open=False) if parent.get("id") else None
        prs = devinfo.scope_to_ticket(parent["key"], info)["prs"] if info is not None else None
    except Exception:  # noqa: BLE001 — unknown, never a refusal
        prs = None
    try:
        raw = jira_get(f"/rest/api/2/issue/{parent['key']}?fields=subtasks,issuelinks", timeout=30, retries=1)
        qa = qa_issues_of(raw.get("fields") or {})
    except Exception:  # noqa: BLE001
        qa = None
    return prs, qa


def move(key, target, mode="normal"):
    issue = jira_get(f"/rest/api/2/issue/{key}?fields={ISSUE_FIELDS}", timeout=30, retries=1)
    fields = issue["fields"]
    current = fields["status"]["name"]
    here = status_column(current)
    # QA is one board column but two drop targets; "already there" has to tell them apart.
    here_target = ("qaip" if is_qa_in_progress(current) else "qa") if here == "qa" else here
    if here_target == target:
        return {"ok": True, "moved": False, "status": current, "warnings": []}

    warnings = []
    if mode != "undo":
        qa_ticket = is_qa_ticket((fields.get("issuetype") or {}).get("name"), fields.get("summary"), fields.get("labels"))
        lane = lane_blocker(here, target, qa_ticket)
        if lane:
            return {"ok": False, "blocked": True, "forcible": False, "reason": lane}
        # A QA ticket is someone else's test: no PR or QA ticket of its own to wait for.
        if mode == "normal" and not (qa_ticket or here == "qa"):
            parent = fields.get("parent") or None
            is_sub = bool(parent) or bool((fields.get("issuetype") or {}).get("subtask"))
            parent_prs, parent_qa = parent_facts(parent) if is_sub and target in ("rev", "done") else (None, None)
            blocker, warnings = evaluate(target, live_prs(issue["id"], key, parent), qa_issues_of(fields), is_sub, parent_prs, parent_qa)
            if blocker:
                return {"ok": False, "blocked": True, "forcible": True, "reason": blocker}

    transitions = jira_get(f"/rest/api/2/issue/{key}/transitions", timeout=30, retries=1).get("transitions") or []
    chosen = pick_transition(transitions, target)
    if not chosen:
        return {"ok": False, "error": f"Jira offers no transition from “{current}” to {target} for {key}."}
    jira_post(f"/rest/api/2/issue/{key}/transitions", {"transition": {"id": chosen["id"]}})
    return {"ok": True, "moved": True, "status": chosen["to"]["name"], "warnings": warnings}


MODES = {"--force": "force", "--undo": "undo"}


def main(argv):
    flags = [a for a in argv[3:] if a in MODES]
    if len(argv) - len(flags) != 3 or argv[2] not in COLUMNS or len(flags) > 1:
        print(json.dumps({"ok": False, "error": f"usage: transition.py <KEY> <{'|'.join(COLUMNS)}> [--force|--undo]"}))
        return 2
    key, target = argv[1].upper(), argv[2]
    mode = MODES[flags[0]] if flags else "normal"
    try:
        load_env()
        result = move(key, target, mode)
    except Exception as e:  # noqa: BLE001 — every failure must come back as a verdict
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
