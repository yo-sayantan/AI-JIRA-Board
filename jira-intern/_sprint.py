"""Sprint field helpers — current sprint string plus carry-over detection.

Jira's sprint custom field is a LIST of every sprint the issue has been in. Taking only the
last entry (the current/latest sprint) is right for the board header; a count > 1 of distinct
sprint names is the carry-over / overflow signal.
"""
import re


def _one(item):
    if not item:
        return None
    if isinstance(item, dict):
        name = item.get("name") or item.get("sprintName")
        if not name:
            return None
        st = str(item.get("state") or "").lower()
        tag = "active" if st == "active" else ("future" if st == "future" else st)
        start = str(item.get("startDate") or "")[:10]
        end = str(item.get("endDate") or "")[:10]
        dates = f" · {start} → {end}" if start and end else ""
        return f"{name} ({tag}{dates})" if tag else str(name)
    raw = str(item)
    m = re.search(r"name=([^,\]]+)", raw)
    state_m = re.search(r"state=([^,\]]+)", raw)
    start_m = re.search(r"startDate=([^,\]]+)", raw)
    end_m = re.search(r"endDate=([^,\]]+)", raw)
    name = m.group(1) if m else raw
    st = (state_m.group(1) if state_m else "").lower()
    tag = "active" if st == "active" else ("future" if st == "future" else st)
    dates = ""
    if start_m and end_m:
        dates = f" · {start_m.group(1)[:10]} → {end_m.group(1)[:10]}"
    return f"{name} ({tag}{dates})"


def _name_of(parsed):
    if not parsed:
        return None
    return parsed.split(" (")[0].strip()


def sprint_fields(raw):
    """Return {sprint, sprintOverflow, sprintCount} from the Jira sprint custom field."""
    if not raw:
        return {"sprint": None, "sprintOverflow": False, "sprintCount": 0}
    seq = raw if isinstance(raw, list) else [raw]
    parsed, names = [], []
    for item in seq:
        s = _one(item)
        if not s:
            continue
        parsed.append(s)
        n = _name_of(s)
        if n and n not in names:
            names.append(n)
    return {
        "sprint": parsed[-1] if parsed else None,
        "sprintOverflow": len(names) > 1,
        "sprintCount": len(names),
    }


def parse_sprint(raw):
    """Back-compat: the current/latest sprint string only."""
    return sprint_fields(raw)["sprint"]


def apply_sprint(ticket, raw):
    ticket.update(sprint_fields(raw))
    return ticket
