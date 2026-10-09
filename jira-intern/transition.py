#!/usr/bin/env python3
"""Move one Jira ticket to another board column — the write side of drag-and-drop.

    python3 transition.py <KEY> <todo|blocked|hold|prog|rev|qa|qaip|done>

Prints ONE JSON line and exits 0 whenever it reached a verdict:
    {"ok": true,  "moved": true, "status": "In Review", "warnings": ["No pull request…"]}
    {"ok": false, "blocked": true, "reason": "PR #12 is not merged yet"}
    {"ok": false, "error": "…"}                       (Jira unreachable, no matching transition)

The gates read LIVE Jira (issue links, sub-tasks, dev-status PRs), not the board's cached
data.json, so a PR merged five minutes ago counts:
  • Blocked   → no gate; any card may be marked blocked.
  • On Hold   → no gate; WARN when a PR of the ticket is still open (it sits unreviewed while parked).
  • In Review → warn when there is no open or merged PR.        (the move still happens)
  • QA lane   → QA and QA In Progress hold QA tickets (not the user's own work). A QA ticket can only
                move among QA · QA In Progress · To Do · Done, and only a QA ticket may be moved
                into QA / QA In Progress — anything else is REFUSED (`lane_blocker`).
                `qa` lands on a READY-for-QA status, `qaip` on an in-progress one.
  • Done      → BLOCK unless every PR is merged and every QA ticket is done.
                A SUB-TICKET is lighter: no PR and no QA ticket are fine (its work usually rides on
                the parent's PR), but a PR of its own that is not merged yet, or an open QA ticket,
                still blocks. Only the sub-ticket's OWN PRs count — the parent's PR is not its PR.

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
QA_LANE = ("qa", "qaip", "todo", "done")
LABELS = {"todo": "To Do", "blocked": "Blocked", "hold": "On Hold", "prog": "In Progress", "rev": "In Review", "qa": "QA", "qaip": "QA In Progress", "done": "Done"}


def is_qa_in_progress(status):
    s = (status or "").strip().lower()
    if not s or s in _QA_READY:
        return False
    return not any(w in _QA_WAITING_WORDS for w in re.split(r"[^a-z0-9]+", s))


_QA_TYPE = re.compile(r"(^|[^a-z0-9])qa([^a-z0-9]|$)", re.I)
_QA_TITLE_LEAD = re.compile(r"^\s*\[?\s*qa\b", re.I)
_QA_TITLE_PREFIX = re.compile(r"\bqa\s*[:\-–—]", re.I)


def is_qa_ticket(type_name, title):
    """A QA ticket: its TYPE says QA / Test, or its TITLE leads with a QA prefix ("QA: …", "[QA] …"). Stricter
    than is_qa (a dev ticket that merely says "verify" is not one) because it locks the ticket into the QA
    lane. Mirror of isQaTicket in src/lib/columns.ts."""
    type_name, title = type_name or "", title or ""
    return bool(_QA_TYPE.search(type_name) or re.search("test", type_name, re.I) or _QA_TITLE_LEAD.search(title) or _QA_TITLE_PREFIX.search(title))


def lane_blocker(current_column, target, qa_ticket):
    """Why this ticket may not move to `target` (None when it may). A QA ticket — in the lane or not — can
    only move among QA · QA In Progress · To Do · Done; only a QA ticket may be moved INTO QA / QA In Progress."""
    in_lane = current_column == "qa" or qa_ticket
    if target in ("qa", "qaip") and not in_lane:
        return f"Only QA tickets can be moved to {LABELS[target]} — this ticket is not one."
    if in_lane and target not in QA_LANE:
        return f"A QA ticket can only be moved between QA, QA In Progress, To Do and Done — not to {LABELS[target]}."
    return None


def is_qa(issue):
    """A QA ticket is a sub-task or linked issue whose type or title says QA / test / verify."""
    text = f"{issue.get('type') or ''} {issue.get('title') or ''}".lower()
    return "qa" in text.split() or "qa" in text or "test" in text or "verif" in text


def evaluate(target, prs, qa_issues, is_subtask=False):
    """Gate verdict for a move: (blocker or None, [warnings]). Pure, so it is unit-tested."""
    live = [p for p in prs if p.get("state") != "declined"]
    warnings = []
    if target == "rev" and not live and not is_subtask:
        warnings.append("No pull request found for this ticket — raise one for review.")
    if target == "hold":
        open_prs = [p for p in live if not p.get("merged")]
        if open_prs:
            names = ", ".join(f"#{p['id']}" if p.get("id") else "a PR" for p in open_prs)
            warnings.append(f"{names} is still open — it will wait unreviewed while the ticket is on hold.")
    if target != "done":
        return None, warnings

    problems = []
    if not live:
        if not is_subtask:
            problems.append("it has no merged pull request")
    else:
        unmerged = [p for p in live if not p.get("merged")]
        if unmerged:
            names = ", ".join(f"#{p['id']}" if p.get("id") else "a PR" for p in unmerged)
            problems.append(f"{names} not merged yet")
    if not qa_issues:
        if not is_subtask:
            problems.append("it has no QA ticket")
    else:
        open_qa = [q for q in qa_issues if status_column(q.get("status")) != "done"]
        if open_qa:
            problems.append("QA not done (" + ", ".join(f"{q['key']} is {q.get('status')}" for q in open_qa) + ")")
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


def move(key, target):
    issue = jira_get(f"/rest/api/2/issue/{key}?fields=status,subtasks,issuelinks,issuetype,summary,parent", timeout=30, retries=1)
    fields = issue["fields"]
    current = fields["status"]["name"]
    here = status_column(current)
    # QA is one board column but two drop targets; "already there" has to tell them apart.
    here_target = ("qaip" if is_qa_in_progress(current) else "qa") if here == "qa" else here
    if here_target == target:
        return {"ok": True, "moved": False, "status": current, "warnings": []}

    qa_ticket = is_qa_ticket((fields.get("issuetype") or {}).get("name"), fields.get("summary"))
    lane = lane_blocker(here, target, qa_ticket)
    if lane:
        return {"ok": False, "blocked": True, "reason": lane}

    parent = fields.get("parent") or None
    # A sub-ticket, and a QA ticket (someone else's tests, no PR of its own), may close without a PR
    # or QA ticket; a PR of their own that is not merged still blocks.
    lenient = bool(parent) or bool((fields.get("issuetype") or {}).get("subtask")) or qa_ticket or here == "qa"
    blocker, warnings = evaluate(target, live_prs(issue["id"], key, parent), qa_issues_of(fields), lenient)
    if blocker:
        return {"ok": False, "blocked": True, "reason": blocker}

    transitions = jira_get(f"/rest/api/2/issue/{key}/transitions", timeout=30, retries=1).get("transitions") or []
    chosen = pick_transition(transitions, target)
    if not chosen:
        return {"ok": False, "error": f"Jira offers no transition from “{current}” to {target} for {key}."}
    jira_post(f"/rest/api/2/issue/{key}/transitions", {"transition": {"id": chosen["id"]}})
    return {"ok": True, "moved": True, "status": chosen["to"]["name"], "warnings": warnings}


def main(argv):
    if len(argv) != 3 or argv[2] not in COLUMNS:
        print(json.dumps({"ok": False, "error": f"usage: transition.py <KEY> <{'|'.join(COLUMNS)}>"}))
        return 2
    key, target = argv[1].upper(), argv[2]
    try:
        load_env()
        result = move(key, target)
    except Exception as e:  # noqa: BLE001 — every failure must come back as a verdict
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
