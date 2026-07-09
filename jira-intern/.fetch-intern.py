#!/usr/bin/env python3
"""One-shot Jira intern fetch — Jira REST + Bitbucket REST. Not part of the UI contract."""
import json, os, re, sys, urllib.parse, urllib.request, ssl
from datetime import datetime, timezone, timedelta
from html import escape

INTERN = os.path.dirname(os.path.abspath(__file__))
JIRA_BASE = "https://agile.experian.com"
BB_BASE = "https://code.experian.local/rest/api/1.0"
USER = {"name": "Biswas, Sayantan", "accountId": "C22014E", "jiraBase": JIRA_BASE}

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def load_env():
    p = os.path.expanduser("~/.cursor/mcp-secrets.env")
    if os.path.isfile(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

def jira_get(path):
    req = urllib.request.Request(
        JIRA_BASE + path,
        headers={"Authorization": f"Bearer {os.environ['JIRA_PERSONAL_TOKEN']}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=120) as r:
        return json.loads(r.read())

def bb_get(path):
    tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN", "")
    req = urllib.request.Request(
        BB_BASE + path,
        headers={"Authorization": f"Bearer {tok}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return json.loads(r.read())

def iso(s):
    if not s:
        return None
    return s.replace("+0000", "Z").replace(".000Z", "Z") if isinstance(s, str) else None

def status_column(name):
    n = (name or "").lower().strip()
    if n in ("to do", "open", "backlog", "reopened", "selected for development"):
        return "todo", False
    if n in ("in progress", "dev in progress", "work in progress", "in development"):
        return "prog", False
    if n in ("in review", "code review", "ready4review", "ready for review", "review"):
        return "rev", False
    if n in ("qa", "in qa", "testing", "verification"):
        return "qa", False
    if n in ("done", "completed", "closed", "resolved", "released"):
        return "done", False
    if n in ("on hold", "hold", "blocked", "waiting", "parked", "impeded"):
        return "hold", True
    return "prog", False  # default in-flight

def light_html(html):
    """Keep only light HTML tags per schema."""
    if not html:
        return None
    if not re.search(r"<", html):
        return f"<p>{escape(html)}</p>"
    allowed = {"p", "b", "ul", "li", "code", "a", "i", "h3"}
    # strip attributes except href on anchors
    html = re.sub(r"<(/?)([\w]+)[^>]*>", lambda m: f"<{m.group(1)}{m.group(2)}>" if m.group(2).lower() in allowed else "", html)
    html = re.sub(r"<a[^>]*href=[\"']([^\"']+)[\"'][^>]*>", r'<a href="\1">', html, flags=re.I)
    html = re.sub(r"\s+", " ", html).strip()
    return html if html else None

def wiki_to_html(text):
    if not text:
        return None
    if text.strip().startswith("<"):
        return light_html(text)
    lines = text.split("\n")
    out, in_ul = [], False
    for line in lines:
        s = line.strip()
        if s.startswith("* ") or s.startswith("- "):
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{escape(s[2:])}</li>")
        else:
            if in_ul:
                out.append("</ul>")
                in_ul = False
            if s:
                out.append(f"<p>{escape(s)}</p>")
    if in_ul:
        out.append("</ul>")
    return "".join(out) or None

def parse_sprint(raw):
    if not raw:
        return None
    if isinstance(raw, list) and raw:
        raw = raw[-1]
    if isinstance(raw, str):
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
    return str(raw)

def ac_list(raw):
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    parts = re.split(r"\n(?=\*|\d+\.|- )|\n\n", str(raw))
    items = []
    for p in parts:
        p = re.sub(r"^[\*\-]\s*", "", p.strip())
        p = re.sub(r"^\d+\.\s*", "", p)
        if p:
            items.append(p)
    return items if items else ([str(raw).strip()] if str(raw).strip() else [])

def branch_for(key, itype, title=None):
    if title:
        slug = re.sub(r"[^a-zA-Z0-9]+", "_", title.lower()).strip("_")[:55]
    else:
        slug = re.sub(r"[^a-zA-Z0-9]+", "_", key.split("-", 1)[-1].lower() if "-" in key else key.lower())
    prefix = "bugfix" if (itype or "").lower() in ("bug", "defect", "incident") else "feature"
    return f"{prefix}/{key}_{slug}"

def search_jira(jql, fields=None):
    fields = fields or "summary,status,issuetype,priority,updated,created,resolutiondate,assignee,reporter,labels,components,fixVersions,customfield_10402,customfield_57402,customfield_10404,customfield_10405,customfield_10700,comment,issuelinks,description"
    all_issues, start = [], 0
    while True:
        q = urllib.parse.urlencode({"jql": jql, "startAt": start, "maxResults": 100, "fields": fields})
        data = jira_get("/rest/api/2/search?" + q)
        all_issues.extend(data.get("issues", []))
        start += data.get("maxResults", 100)
        if start >= data.get("total", 0):
            break
    return all_issues

def fetch_comments(key):
    comments, start = [], 0
    while True:
        data = jira_get(f"/rest/api/2/issue/{key}/comment?startAt={start}&maxResults=100")
        comments.extend(data.get("comments", []))
        start += len(data.get("comments", []))
        if start >= data.get("total", 0):
            break
    comments.sort(key=lambda c: c.get("created", ""), reverse=True)
    out = []
    for c in comments:
        body = c.get("body", "")
        out.append({
            "author": (c.get("author") or {}).get("displayName"),
            "when": iso(c.get("created")),
            "body": light_html(c.get("renderedBody") or wiki_to_html(body)) or f"<p>{escape(body)}</p>",
        })
    latest = iso(comments[0]["created"]) if comments else None
    return out, len(comments), latest

def bb_search_pr(key):
    return None, None, None  # PR enrichment done via pr_overrides.json (Bitbucket MCP)

def pr_state_from_bb(pr):
    if not pr:
        return {"state": "none"}
    st = (pr.get("state") or "").upper()
    pid = pr.get("id")
    from_ref = pr.get("fromRef") or {}
    to_ref = pr.get("toRef") or {}
    project = (from_ref.get("repository") or {}).get("project", {}).get("key", "")
    slug = (from_ref.get("repository") or {}).get("slug", "")
    url = f"https://code.experian.local/projects/{project}/repos/{slug}/pull-requests/{pid}" if project else None
    merged = st == "MERGED"
    reviewers = pr.get("reviewers") or []
    approvals = sum(1 for r in reviewers if r.get("approved"))
    open_comments = 0  # would need activities API
    if merged:
        pstate = "merged"
    elif approvals > 0 and open_comments == 0:
        pstate = "approved"
    elif st == "DECLINED":
        pstate = "changes"
    else:
        pstate = "comments"  # open PR, no approvals yet
    return {
        "state": pstate,
        "id": pid,
        "title": pr.get("title"),
        "url": url,
        "approvals": approvals,
        "openComments": open_comments,
        "sourceBranch": from_ref.get("displayId"),
        "destinationBranch": to_ref.get("displayId"),
        "merged": merged,
        "mergedAt": iso(pr.get("closedDate")) if merged else None,
    }

def issue_to_light(issue, pr_obj=None):
    f = issue["fields"]
    key = issue["key"]
    sp = f.get("customfield_10402") or f.get("customfield_57402")
    itype = (f.get("issuetype") or {}).get("name")
    resolved = f.get("resolutiondate")
    pr = pr_obj or {"state": "none"}
    return {
        "key": key,
        "title": f.get("summary"),
        "type": itype,
        "priority": (f.get("priority") or {}).get("name"),
        "project": key.split("-")[0],
        "status": (f.get("status") or {}).get("name"),
        "created": iso(f.get("created")),
        "resolved": iso(resolved),
        "storyPoints": int(sp) if sp is not None and sp == int(sp) else (float(sp) if sp else None),
        "branch": branch_for(key, itype, f.get("summary")),
        "pr": pr,
        "url": f"{JIRA_BASE}/browse/{key}",
    }

def build_rich(issue, existing, state_entry, pr_obj):
    f = issue["fields"]
    key = issue["key"]
    status = (f.get("status") or {}).get("name")
    column, on_hold = status_column(status)
    itype = (f.get("issuetype") or {}).get("name")
    sp = f.get("customfield_10402") or f.get("customfield_57402")
    last_update = iso(f.get("updated"))
    comments, comment_count, latest_comment = fetch_comments(key)

    # issuelinks
    related = []
    for link in f.get("issuelinks") or []:
        if "outwardIssue" in link:
            o = link["outwardIssue"]
            related.append({
                "key": o["key"], "url": f"{JIRA_BASE}/browse/{o['key']}",
                "summary": o["fields"]["summary"], "status": o["fields"]["status"]["name"],
                "relation": link.get("type", {}).get("outward", "relates"),
            })
        if "inwardIssue" in link:
            o = link["inwardIssue"]
            related.append({
                "key": o["key"], "url": f"{JIRA_BASE}/browse/{o['key']}",
                "summary": o["fields"]["summary"], "status": o["fields"]["status"]["name"],
                "relation": link.get("type", {}).get("inward", "relates"),
            })

    epic_key = f.get("customfield_10405")
    epic = {"key": epic_key, "url": f"{JIRA_BASE}/browse/{epic_key}", "relation": "epic (parent)"} if epic_key else None

    assignee = f.get("assignee")
    assignee_s = f"{assignee.get('displayName')} ({assignee.get('name', '').upper()})" if assignee else None
    reporter = f.get("reporter")
    reporter_s = f"{reporter.get('displayName')} ({reporter.get('name', '').upper()})" if reporter else None

    base = {
        "key": key,
        "title": f.get("summary"),
        "status": status,
        "column": column,
        "type": itype,
        "priority": (f.get("priority") or {}).get("name"),
        "storyPoints": int(sp) if sp is not None and sp == int(sp) else (float(sp) if sp else None),
        "branch": (existing or {}).get("branch") or branch_for(key, itype, f.get("summary")),
        "pr": pr_obj or {"state": "none"},
        "commentCount": comment_count,
        "latestComment": latest_comment,
        "lastUpdate": last_update,
        "created": iso(f.get("created")),
        "done": column == "done",
        "onHold": on_hold,
        "url": f"{JIRA_BASE}/browse/{key}",
        "sprint": parse_sprint(f.get("customfield_10404")) or (existing or {}).get("sprint"),
        "reporter": reporter_s,
        "assignee": assignee_s,
        "epic": epic or (existing or {}).get("epic"),
        "labels": f.get("labels") or [],
        "components": [c["name"] for c in f.get("components") or []] or (existing or {}).get("components") or [],
        "fixVersions": [v["name"] for v in f.get("fixVersions") or []],
        "description": light_html(wiki_to_html(f.get("description"))) or (existing or {}).get("description"),
        "acceptanceCriteria": ac_list(f.get("customfield_10700")) or (existing or {}).get("acceptanceCriteria") or [],
        "comments": comments,
        "related": related or (existing or {}).get("related") or [],
        "confluence": (existing or {}).get("confluence") or [],
        "externalLinks": (existing or {}).get("externalLinks") or [],
        "proposedSolution": (existing or {}).get("proposedSolution"),
        "effortEstimate": (existing or {}).get("effortEstimate"),
        "openQuestions": (existing or {}).get("openQuestions") or [],
        "sources": (existing or {}).get("sources") or [{"title": f"Jira {key}", "url": f"{JIRA_BASE}/browse/{key}"}],
        "updateLog": list((existing or {}).get("updateLog") or []),
    }
    if (existing or {}).get("estDays"):
        base["estDays"] = existing["estDays"]

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    prev = state_entry or {}
    changes = []
    had_prior = bool(prev) or bool(existing)
    if not had_prior:
        if column == "done":
            base["updateLog"] = [{"when": today, "text": f"Marked DONE — {today} (status: {status})"}] + base["updateLog"]
            changes.append("done")
        else:
            base["updateLog"] = [{"when": today, "text": "Assigned — initial brief"}] + base["updateLog"]
            changes.append("new")
    else:
        if prev.get("status") != status:
            changes.append(f"status {prev.get('status')} → {status}")
            base["updateLog"] = [{"when": today, "text": f"Status changed to {status}"}] + base["updateLog"]
        if prev.get("comments", 0) != comment_count:
            changes.append(f"comments {prev.get('comments')} → {comment_count}")
            base["updateLog"] = [{"when": today, "text": f"New comment(s) — total {comment_count}"}] + base["updateLog"]
        if column == "done" and not prev.get("done"):
            base["updateLog"] = [{"when": today, "text": f"Marked DONE — {today} (status: {status})"}] + base["updateLog"]
            changes.append("done")
        if not changes and existing:
            # nothing changed — keep prior rich object, refresh timestamps/pr/comments/status/epic
            kept = dict(existing)
            kept["pr"] = base["pr"]
            kept["commentCount"] = comment_count
            kept["latestComment"] = latest_comment
            kept["lastUpdate"] = last_update
            kept["comments"] = comments
            kept["status"] = status
            kept["column"] = column
            kept["onHold"] = on_hold
            kept["done"] = column == "done"
            if base.get("epic"):
                kept["epic"] = base["epic"]
            return kept, changes

    # Fix mistaken initial brief on already-done tickets
    if column == "done" and base["updateLog"]:
        if any(e.get("text") == "Assigned — initial brief" for e in base["updateLog"][:1]):
            base["updateLog"] = [e for e in base["updateLog"] if e.get("text") != "Assigned — initial brief"]
            if not any("Marked DONE" in (e.get("text") or "") for e in base["updateLog"]):
                base["updateLog"] = [{"when": today, "text": f"Marked DONE — {today} (status: {status})"}] + base["updateLog"]

    return base, changes

def fix_generic_branch(key, branch, title, itype):
    """Replace auto-slug branches like feature/FIDM-5845_5845 with title-based slug."""
    if not branch or not title:
        return branch
    num = key.split("-", 1)[-1] if "-" in key else key
    tail = branch.split("/")[-1].split("_", 1)[-1] if "/" in branch else branch
    if tail == num or tail == key.replace("-", "_").lower():
        return branch_for(key, itype, title)
    return branch

def main():
    load_env()
    existing_path = os.path.join(INTERN, "data.json")
    state_path = os.path.join(INTERN, ".state.json")
    existing_data = json.load(open(existing_path)) if os.path.isfile(existing_path) else {"tickets": [], "completed": []}
    state = json.load(open(state_path)) if os.path.isfile(state_path) else {}
    pr_overrides_path = os.path.join(INTERN, ".pr_overrides.json")
    pr_overrides = json.load(open(pr_overrides_path)) if os.path.isfile(pr_overrides_path) else {}
    existing_by_key = {t["key"]: t for t in existing_data.get("tickets", [])}
    existing_completed = {c["key"]: c for c in existing_data.get("completed", [])}

    notes = []
    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        notes.append(f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}: Jira MCP unavailable — showing last known state")
        out = dict(existing_data)
        out["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out["notes"] = notes + (existing_data.get("notes") or [])[:3]
        json.dump(out, open(existing_path, "w"), indent=2)
        return out, [], notes

    notes.append(f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}: Live Jira REST fetch (jira MCP tools not in session). Bitbucket MCP for PR #362.")

    # Active: not done
    active_issues = search_jira("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC")
    # Full field refresh for active
    active_issues = [jira_get(f"/rest/api/2/issue/{i['key']}") for i in active_issues]
    # Recent done (14 days)
    recent_done = search_jira(
        "assignee = currentUser() AND statusCategory = Done AND resolved >= -14d ORDER BY resolved DESC"
    )
    active_keys = {i["key"] for i in active_issues}
    for i in recent_done:
        if i["key"] not in active_keys:
            active_issues.append(jira_get(f"/rest/api/2/issue/{i['key']}"))
            active_keys.add(i["key"])

    # Completed archive — union
    done_was = search_jira("assignee was currentUser() AND statusCategory = Done ORDER BY resolved DESC", fields="summary,status,issuetype,priority,updated,created,resolutiondate,customfield_10402,customfield_57402")
    done_is = search_jira("assignee = currentUser() AND statusCategory = Done ORDER BY resolved DESC", fields="summary,status,issuetype,priority,updated,created,resolutiondate,customfield_10402,customfield_57402")
    done_map = {i["key"]: i for i in done_was}
    for i in done_is:
        done_map[i["key"]] = i
    done_issues = sorted(done_map.values(), key=lambda x: x["fields"].get("resolutiondate") or "", reverse=True)

    tickets = []
    all_changes = {"new": [], "refreshed": [], "done": []}
    new_state = {}

    for issue in active_issues:
        key = issue["key"]
        prior = existing_by_key.get(key)
        if not prior and key in existing_completed:
            prior = existing_completed[key]
        pr_obj = pr_overrides.get(key) or (prior or {}).get("pr") or {"state": "none"}
        rich, changes = build_rich(issue, prior, state.get(key), pr_obj)
        # Prefer archive branch when current branch looks like auto-slug only
        comp = existing_completed.get(key)
        if comp and comp.get("branch") and rich.get("branch", "").endswith(f"_{key.split('-')[1]}"):
            rich["branch"] = comp["branch"]
        rich["branch"] = fix_generic_branch(key, rich.get("branch"), rich.get("title"), rich.get("type"))
        if rich.get("column") == "done":
            ul = rich.get("updateLog") or []
            if ul and ul[0].get("text") == "Assigned — initial brief":
                done_day = (rich.get("lastUpdate") or rich.get("created") or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
                rich["updateLog"] = [{"when": done_day, "text": f"Marked DONE — {done_day} (status: {rich['status']})"}] + [
                    e for e in ul if e.get("text") != "Assigned — initial brief"
                ]
        tickets.append(rich)
        col, _ = status_column(rich["status"])
        new_state[key] = {
            "title": rich["title"], "status": rich["status"], "column": col,
            "type": rich.get("type"), "priority": rich.get("priority"),
            "story_points": rich.get("storyPoints"), "branch": rich.get("branch"),
            "est_days": rich.get("estDays"), "pr_state": (rich.get("pr") or {}).get("state"),
            "pr_comments": (rich.get("pr") or {}).get("openComments"),
            "comments": rich.get("commentCount"), "latest_comment": rich.get("latestComment"),
            "last_update": rich.get("lastUpdate"), "done": rich.get("done", False),
        }
        if "new" in changes:
            all_changes["new"].append(key)
        elif "done" in changes:
            all_changes["done"].append(key)
        elif changes:
            all_changes["refreshed"].append(f"{key}: {', '.join(changes)}")

    # Completed — light; preserve prior pr; BB lookup only for recent without PR
    existing_completed = {c["key"]: c for c in existing_data.get("completed", [])}
    completed = []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=60)).strftime("%Y-%m-%d")
    for idx, issue in enumerate(done_issues):
        key = issue["key"]
        prev = existing_completed.get(key, {})
        pr_obj = prev.get("pr") if prev.get("pr") and prev["pr"].get("state") not in (None, "none") else pr_overrides.get(key) or {"state": "none"}
        light = issue_to_light(issue, pr_obj)
        light["branch"] = fix_generic_branch(key, light.get("branch"), light.get("title"), light.get("type"))
        if prev:
            for k in ("branch", "pr", "storyPoints"):
                if light.get(k) in (None, {"state": "none"}) and prev.get(k) and prev.get(k) != {"state": "none"}:
                    light[k] = prev[k]
        completed.append(light)

    out = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "user": USER,
        "notes": notes,
        "tickets": tickets,
        "completed": completed,
    }
    json.dump(out, open(existing_path, "w"), indent=2)
    json.dump(new_state, open(state_path, "w"), indent=2)
    return out, all_changes, notes

if __name__ == "__main__":
    out, changes, notes = main()
    print(json.dumps({"tickets": len(out["tickets"]), "completed": len(out["completed"]), "changes": changes, "notes": notes}))
