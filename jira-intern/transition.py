#!/usr/bin/env python3
"""Move one Jira ticket to another board column — the write side of drag-and-drop.

    python3 transition.py <KEY> <todo|prog|rev|qa|done>

Prints ONE JSON line and exits 0 whenever it reached a verdict:
    {"ok": true,  "moved": true, "status": "In Review", "warnings": ["No pull request…"]}
    {"ok": false, "blocked": true, "reason": "PR #12 is not merged yet"}
    {"ok": false, "error": "…"}                       (Jira unreachable, no matching transition)

The gates read LIVE Jira (issue links, sub-tasks, dev-status PRs), not the board's cached
data.json, so a PR merged five minutes ago counts:
  • In Review → warn when there is no open or merged PR.        (the move still happens)
  • QA        → warn when the ticket has no QA ticket.           (the move still happens)
  • Done      → BLOCK unless every PR is merged and every QA ticket is done.

Nothing here writes data.json; the board follows up with a normal single-ticket refresh.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _jira import jira_get, jira_post, load_env, status_column  # noqa: E402

COLUMNS = ("todo", "prog", "rev", "qa", "done")
# Jira workflows rarely name statuses exactly like the board; prefer these, then any in the column.
PREFERRED = {
    "todo": ("to do", "open", "reopened", "backlog"),
    "prog": ("in progress", "dev in progress", "in development"),
    "rev": ("in review", "code review", "ready for review", "ready4review"),
    "qa": ("qa", "in qa", "in testing", "testing", "ready for qa"),
    "done": ("done", "closed", "resolved", "completed"),
}


def is_qa(issue):
    """A QA ticket is a sub-task or linked issue whose type or title says QA / test / verify."""
    text = f"{issue.get('type') or ''} {issue.get('title') or ''}".lower()
    return "qa" in text.split() or "qa" in text or "test" in text or "verif" in text


def evaluate(target, prs, qa_issues):
    """Gate verdict for a move: (blocker or None, [warnings]). Pure, so it is unit-tested."""
    live = [p for p in prs if p.get("state") != "declined"]
    warnings = []
    if target == "rev" and not live:
        warnings.append("No pull request found for this ticket — raise one for review.")
    if target == "qa" and not qa_issues:
        warnings.append("No QA ticket found for this ticket — QA needs one.")
    if target != "done":
        return None, warnings

    problems = []
    if not live:
        problems.append("it has no merged pull request")
    else:
        unmerged = [p for p in live if not p.get("merged")]
        if unmerged:
            names = ", ".join(f"#{p['id']}" if p.get("id") else "a PR" for p in unmerged)
            problems.append(f"{names} not merged yet")
    if not qa_issues:
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


def live_prs(issue_id):
    # Imported here: devinfo pulls in the Bitbucket client, which the gate-only tests don't need.
    import devinfo

    info = devinfo.fetch_one(issue_id, enrich_open=False)
    if info is None:
        raise RuntimeError("could not read pull requests from Jira")
    return info["prs"]


def pick_transition(transitions, target):
    """The available transition landing in `target`'s column, most conventional name first."""
    fits = [t for t in transitions if status_column((t.get("to") or {}).get("name")) == target]
    if not fits:
        return None
    for name in PREFERRED[target]:
        for t in fits:
            if (t["to"]["name"] or "").lower() == name:
                return t
    return fits[0]


def move(key, target):
    issue = jira_get(f"/rest/api/2/issue/{key}?fields=status,subtasks,issuelinks,issuetype,summary", timeout=30)
    fields = issue["fields"]
    current = fields["status"]["name"]
    if status_column(current) == target:
        return {"ok": True, "moved": False, "status": current, "warnings": []}

    blocker, warnings = evaluate(target, live_prs(issue["id"]), qa_issues_of(fields))
    if blocker:
        return {"ok": False, "blocked": True, "reason": blocker}

    transitions = jira_get(f"/rest/api/2/issue/{key}/transitions", timeout=30).get("transitions") or []
    chosen = pick_transition(transitions, target)
    if not chosen:
        return {"ok": False, "error": f"Jira offers no transition from “{current}” to {target} for {key}."}
    jira_post(f"/rest/api/2/issue/{key}/transitions", {"transition": {"id": chosen["id"]}})
    return {"ok": True, "moved": True, "status": chosen["to"]["name"], "warnings": warnings}


def main(argv):
    if len(argv) != 3 or argv[2] not in COLUMNS:
        print(json.dumps({"ok": False, "error": "usage: transition.py <KEY> <todo|prog|rev|qa|done>"}))
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
