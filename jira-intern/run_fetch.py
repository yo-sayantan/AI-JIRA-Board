#!/usr/bin/env python3
"""Jira intern — live fetch with per-ticket cache. Jira REST + Bitbucket REST."""
import json, os, re, sys, urllib.parse, urllib.request, ssl, time, tempfile
from datetime import datetime, timezone, timedelta
from html import escape


def atomic_write(path, text):
    """Write to a temp file in the same dir, then os.replace() over the target. The rename
    is atomic on the same filesystem, so a reader (the board / another script) never sees a
    truncated or half-written data.json / data.js."""
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".swap")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def atomic_dump(path, obj):
    atomic_write(path, json.dumps(obj, indent=2))


INTERN = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(INTERN, "cache")
JIRA_BASE = "https://agile.experian.com"
BB_BASE = "https://code.experian.local/rest/api/1.0"
USER = {"name": "Biswas, Sayantan", "accountId": "C22014E", "jiraBase": JIRA_BASE}

REPO_HINTS = {
    "FIDM": ["pidclientadm", "preciseid", "preciseid_eks", "pidadmin", "fraudadmin"],
    "ACKYARISK": ["agent-insight", "agent-trust"],
    "DFMM": ["fars", "as1bizid"],
    "PMIEN": ["precisematch", "precisematchv2"],
    "POPD": ["fars"],
    "NACLEN": ["frdbizid"],
}
BB_PROJECT = {
    "FIDM": "FRAUD", "ACKYARISK": "PHIN", "DFMM": "FRDBIZID", "PMIEN": "PRECISEMATCH",
    "POPD": "FARS", "NACLEN": "FRDBIZID",
}

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

FIELDS = (
    "summary,status,issuetype,priority,updated,created,resolutiondate,assignee,reporter,"
    "labels,components,fixVersions,description,comment,issuelinks,parent,subtasks,"
    "customfield_10402,customfield_57402,customfield_10404,customfield_10405,customfield_10700"
)


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
    if isinstance(s, str):
        return s.replace("+0000", "Z").replace(".000+0000", "Z").replace(".000Z", "Z")
    return None


def status_column(name):
    n = (name or "").lower().strip()
    mapping = [
        (("to do", "open", "backlog", "reopened", "selected for development"), "todo", False),
        (("in progress", "dev in progress", "work in progress", "in development"), "prog", False),
        (("in review", "code review", "ready4review", "ready for review", "review"), "rev", False),
        (("qa", "in qa", "testing", "verification"), "qa", False),
        (("done", "completed", "closed", "resolved", "released"), "done", False),
        (("on hold", "hold", "blocked", "waiting", "parked", "impeded"), "hold", True),
    ]
    for keys, col, hold in mapping:
        if n in keys:
            return col, hold
    return "prog", False


def light_html(html):
    if not html:
        return None
    if not re.search(r"<", html):
        return f"<p>{escape(html)}</p>"
    allowed = {"p", "b", "ul", "li", "code", "a", "i", "h3"}
    html = re.sub(
        r"<(/?)([\w]+)[^>]*>",
        lambda m: f"<{m.group(1)}{m.group(2).lower()}>" if m.group(2).lower() in allowed else "",
        html,
    )
    html = re.sub(r'<a[^>]*href=["\']([^"\']+)["\'][^>]*>', r'<a href="\1">', html, flags=re.I)
    return html.strip() or None


def wiki_to_html(text):
    if not text:
        return None
    if text.strip().startswith("<"):
        return light_html(text)
    lines, out, in_ul = text.split("\n"), [], False
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
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", (title or key).lower()).strip("_")[:55]
    if title:
        num = key.split("-", 1)[-1] if "-" in key else key
        tail = slug.split("_")[-1] if "_" in slug else slug
        if tail == num.lower():
            slug = re.sub(r"[^a-zA-Z0-9]+", "_", title.lower()).strip("_")[:55]
    prefix = "bugfix" if (itype or "").lower() in ("bug", "defect", "incident") else "feature"
    return f"{prefix}/{key}_{slug}"


def search_jira(jql, fields=FIELDS):
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
        data = jira_get(f"/rest/api/2/issue/{key}/comment?startAt={start}&maxResults=100&expand=renderedBody")
        batch = data.get("comments", [])
        comments.extend(batch)
        start += len(batch)
        if start >= data.get("total", 0):
            break
    comments.sort(key=lambda c: c.get("created", ""), reverse=True)
    out = []
    for c in comments:
        body = c.get("renderedBody") or wiki_to_html(c.get("body", "")) or f"<p>{escape(c.get('body',''))}</p>"
        out.append({"author": (c.get("author") or {}).get("displayName"), "when": iso(c.get("created")), "body": light_html(body) or body})
    latest = iso(comments[0]["created"]) if comments else None
    return out, len(comments), latest


def build_changelog_update_log(key, created, status, resolved):
    entries = []
    try:
        data = jira_get(f"/rest/api/2/issue/{key}?expand=changelog&fields=created,status")
        created_dt = iso(data["fields"].get("created") or created)
        opened_day = (created_dt or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        entries.append({"when": opened_day, "text": f"Opened — {opened_day}"})
        hist = (data.get("changelog") or {}).get("histories") or []
        for h in sorted(hist, key=lambda x: x.get("created", ""), reverse=True):
            day = iso(h.get("created"))[:10] if h.get("created") else None
            for item in h.get("items") or []:
                if item.get("field") == "status":
                    frm, to = item.get("fromString"), item.get("toString")
                    if frm and to and day:
                        entries.append({"when": day, "text": f"Moved {frm} → {to} — {day}"})
        col, _ = status_column(status)
        if col == "done":
            done_day = (iso(resolved) or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
            if not any("Marked DONE" in (e.get("text") or "") for e in entries):
                entries.insert(0, {"when": done_day, "text": f"Marked DONE — {done_day}"})
    except Exception:
        opened_day = (iso(created) or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        entries = [{"when": opened_day, "text": f"Opened — {opened_day}"}]
    return entries


def bb_search_pr(key):
    proj_prefix = key.split("-")[0]
    bb_proj = BB_PROJECT.get(proj_prefix, "FRAUD")
    repos = REPO_HINTS.get(proj_prefix, ["pidclientadm", "preciseid"])
    best = None
    for slug in repos:
        try:
            q = urllib.parse.urlencode({"filterText": key, "limit": 10, "order": "NEWEST"})
            data = bb_get(f"/projects/{bb_proj}/repos/{slug}/pull-requests?{q}")
            for pr in data.get("values") or []:
                title = (pr.get("title") or "").upper()
                src = ((pr.get("fromRef") or {}).get("displayId") or "").upper()
                if key in title or key.replace("-", "_") in src or key in src:
                    if not best or pr.get("id", 0) > best.get("id", 0):
                        best = pr
        except Exception:
            continue
    return pr_to_obj(best, bb_proj) if best else {"state": "none"}


def pr_comment_stats(bb_proj, slug, pid):
    """Count total vs resolved review comments on a PR (from its activity stream)."""
    total, resolved = 0, 0
    try:
        start = 0
        while True:
            data = bb_get(f"/projects/{bb_proj}/repos/{slug}/pull-requests/{pid}/activities?start={start}&limit=100")
            for act in data.get("values") or []:
                if act.get("action") == "COMMENTED":
                    total += 1
                    c = act.get("comment") or {}
                    if c.get("state") == "RESOLVED" or c.get("severity") == "BLOCKER":
                        resolved += 1
            if data.get("isLastPage", True):
                break
            start += data.get("size", 100)
    except Exception:
        pass
    return total, resolved, max(0, total - resolved)


def pr_to_obj(pr, bb_proj=None):
    if not pr:
        return {"state": "none"}
    st = (pr.get("state") or "").upper()
    pid = pr.get("id")
    from_ref = pr.get("fromRef") or {}
    to_ref = pr.get("toRef") or {}
    repo = from_ref.get("repository") or {}
    project = bb_proj or (repo.get("project") or {}).get("key", "FRAUD")
    slug = repo.get("slug", "")
    url = f"https://code.experian.local/projects/{project}/repos/{slug}/pull-requests/{pid}" if slug else None
    merged = st == "MERGED"
    declined = st in ("DECLINED", "REJECTED")
    reviewers_raw = pr.get("reviewers") or []
    approvals = sum(1 for r in reviewers_raw if r.get("approved"))
    needs_work = sum(1 for r in reviewers_raw if r.get("status") == "NEEDS_WORK")
    reviewers = [((r.get("user") or {}).get("displayName")) for r in reviewers_raw if (r.get("user") or {}).get("displayName")]
    ct, cr, open_c = pr_comment_stats(project, slug, pid) if (slug and pid) else (0, 0, 0)
    # State per the contract: merged | declined | changes | approved(>=2 & no open comments) | comments.
    if merged:
        pstate = "merged"
        open_c, cr = 0, ct
    elif declined:
        pstate = "declined"
    elif needs_work:
        pstate = "changes"
    elif approvals >= 2 and open_c == 0:
        pstate = "approved"
    else:
        pstate = "comments"
    return {
        "state": pstate,
        "id": pid,
        "title": pr.get("title"),
        "url": url,
        "approvals": approvals,
        "openComments": open_c,
        "commentsTotal": ct,
        "commentsResolved": cr,
        "reviewers": reviewers,
        "sourceBranch": from_ref.get("displayId"),
        "destinationBranch": to_ref.get("displayId"),
        "merged": merged,
        "mergedAt": iso(pr.get("closedDate")) if merged else None,
    }


def person_fmt(u):
    if not u:
        return None
    return f"{u.get('displayName')} ({(u.get('name') or u.get('key') or '').upper()})"


def issue_links(f):
    related = []
    for link in f.get("issuelinks") or []:
        for direction, issue_key in [("outwardIssue", "outward"), ("inwardIssue", "inward")]:
            if direction in link:
                o = link[direction]
                rel = link.get("type", {})
                relation = rel.get(issue_key, "relates")
                related.append({
                    "key": o["key"], "url": f"{JIRA_BASE}/browse/{o['key']}",
                    "summary": o["fields"]["summary"], "status": o["fields"]["status"]["name"],
                    "relation": relation,
                })
    return related


def fetch_subtasks(key, prior_map, pr_overrides, shallow=False):
    issues = search_jira(f'parent = {key} ORDER BY key ASC', fields=FIELDS)
    subs = []
    for si in issues:
        sk = si["key"]
        if shallow:
            sf = si["fields"]
            col, hold = status_column(sf["status"]["name"])
            subs.append({
                "key": sk, "title": sf["summary"], "status": sf["status"]["name"], "column": col,
                "type": sf["issuetype"]["name"], "priority": (sf.get("priority") or {}).get("name"),
                "parentKey": key, "url": f"{JIRA_BASE}/browse/{sk}", "done": col == "done", "onHold": hold,
                "branch": branch_for(sk, sf["issuetype"]["name"], sf["summary"]),
                "pr": prior_map.get(sk, {}).get("pr") or pr_overrides.get(sk) or {"state": "none"},
            })
        else:
            full = build_ticket(jira_get(f"/rest/api/2/issue/{sk}?fields={FIELDS}"), prior_map.get(sk), pr_overrides, force=True)
            full["parentKey"] = key
            subs.append(full)
            save_cache(sk, full)
    return subs


def merge_preserve(new, old):
    if not old:
        return new
    for k in ("proposedSolution", "effortEstimate", "openQuestions", "estDays", "confluence", "externalLinks", "sources"):
        if not new.get(k) and old.get(k):
            new[k] = old[k]
    if old.get("updateLog") and new.get("updateLog"):
        old_texts = {e.get("text") for e in old["updateLog"]}
        merged = list(new["updateLog"])
        for e in old["updateLog"]:
            if e.get("text") not in old_texts or e.get("text") not in {x.get("text") for x in merged}:
                if e.get("text") not in {x.get("text") for x in merged}:
                    merged.append(e)
        new["updateLog"] = merged[:20]
    elif old.get("updateLog") and not new.get("updateLog"):
        new["updateLog"] = old["updateLog"]
    return new


def build_ticket(issue, prior, pr_overrides, force=False, skip_pr=False):
    f = issue["fields"]
    key = issue["key"]
    status = f["status"]["name"]
    column, on_hold = status_column(status)
    itype = f["issuetype"]["name"]
    sp = f.get("customfield_10402") or f.get("customfield_57402")
    comments, comment_count, latest_comment = fetch_comments(key)

    epic_key = f.get("customfield_10405")
    parent = f.get("parent")
    epic = None
    if epic_key:
        epic = {"key": epic_key, "url": f"{JIRA_BASE}/browse/{epic_key}", "relation": "epic (parent)"}
    elif parent:
        pk = parent.get("key")
        epic = {"key": pk, "url": f"{JIRA_BASE}/browse/{pk}", "relation": "parent"}

    pr = (prior or {}).get("pr")
    if pr_overrides.get(key):
        pr = pr_overrides[key]
    elif not skip_pr and (force or column != "done" or not pr or pr.get("state") == "none"):
        found = bb_search_pr(key)
        if found.get("state") != "none":
            pr = found
    if not pr:
        pr = {"state": "none"}

    update_log = build_changelog_update_log(key, f.get("created"), status, f.get("resolutiondate"))
    if prior and prior.get("updateLog"):
        prior_texts = {e.get("text") for e in prior["updateLog"]}
        for e in prior["updateLog"]:
            if e.get("text") not in {x.get("text") for x in update_log}:
                update_log.append(e)

    ticket = {
        "key": key,
        "title": f.get("summary"),
        "status": status,
        "column": column,
        "type": itype,
        "priority": (f.get("priority") or {}).get("name"),
        "storyPoints": int(sp) if sp is not None and sp == int(sp) else (float(sp) if sp else None),
        "branch": (prior or {}).get("branch") or branch_for(key, itype, f.get("summary")),
        "pr": pr,
        "commentCount": comment_count,
        "latestComment": latest_comment,
        "lastUpdate": iso(f.get("updated")),
        "created": iso(f.get("created")),
        "resolved": iso(f.get("resolutiondate")),
        "done": column == "done",
        "onHold": on_hold,
        "url": f"{JIRA_BASE}/browse/{key}",
        "sprint": parse_sprint(f.get("customfield_10404")),
        "reporter": person_fmt(f.get("reporter")),
        "assignee": person_fmt(f.get("assignee")),
        "epic": epic,
        "parentKey": parent.get("key") if parent else None,
        "labels": f.get("labels") or [],
        "components": [c["name"] for c in f.get("components") or []],
        "fixVersions": [v["name"] for v in f.get("fixVersions") or []],
        "description": light_html(wiki_to_html(f.get("description"))),
        "acceptanceCriteria": ac_list(f.get("customfield_10700")),
        "comments": comments,
        "related": issue_links(f),
        "confluence": (prior or {}).get("confluence") or [],
        "externalLinks": (prior or {}).get("externalLinks") or [],
        "proposedSolution": (prior or {}).get("proposedSolution"),
        "effortEstimate": (prior or {}).get("effortEstimate"),
        "openQuestions": (prior or {}).get("openQuestions") or [],
        "sources": (prior or {}).get("sources") or [{"title": f"Jira {key}", "url": f"{JIRA_BASE}/browse/{key}"}],
        "updateLog": update_log,
    }
    if (prior or {}).get("estDays"):
        ticket["estDays"] = prior["estDays"]
    return merge_preserve(ticket, prior)


def cache_path(key):
    return os.path.join(CACHE, f"{key}.json")


def load_cache(key):
    p = cache_path(key)
    if os.path.isfile(p):
        return json.load(open(p))
    return None


def save_cache(key, ticket):
    os.makedirs(CACHE, exist_ok=True)
    atomic_dump(cache_path(key), ticket)


def ticket_to_state(t):
    col, _ = status_column(t.get("status", ""))
    return {
        "title": t.get("title"), "status": t.get("status"), "column": t.get("column", col),
        "type": t.get("type"), "priority": t.get("priority"),
        "story_points": t.get("storyPoints"), "branch": t.get("branch"),
        "est_days": t.get("estDays"), "pr_state": (t.get("pr") or {}).get("state"),
        "pr_comments": (t.get("pr") or {}).get("openComments"),
        "comments": t.get("commentCount"), "latest_comment": t.get("latestComment"),
        "last_update": t.get("lastUpdate"), "done": t.get("done", False),
    }


def completed_from_ticket(t):
    if t.get("parentKey") or (t.get("type") or "").lower() == "sub-task":
        return None
    c = {k: t.get(k) for k in (
        "key", "title", "type", "priority", "status", "created", "resolved", "storyPoints",
        "branch", "pr", "url", "lastUpdate", "sprint", "reporter", "assignee", "epic",
        "labels", "components", "fixVersions", "description", "acceptanceCriteria", "comments",
        "commentCount", "related", "confluence", "externalLinks", "proposedSolution",
        "effortEstimate", "openQuestions", "sources", "updateLog", "subtasks", "subtaskCount",
    ) if t.get(k) is not None}
    c["project"] = t["key"].split("-")[0]
    c["done"] = True
    c["column"] = "done"
    return c


def main():
    load_env()
    os.makedirs(CACHE, exist_ok=True)
    existing_path = os.path.join(INTERN, "data.json")
    state_path = os.path.join(INTERN, ".state.json")
    pr_overrides_path = os.path.join(INTERN, ".pr_overrides.json")

    existing = json.load(open(existing_path)) if os.path.isfile(existing_path) else {"tickets": [], "completed": []}
    state = json.load(open(state_path)) if os.path.isfile(state_path) else {}
    pr_overrides = json.load(open(pr_overrides_path)) if os.path.isfile(pr_overrides_path) else {}

    # Live PR for FIDM-6048 from Bitbucket MCP data (2 approvals)
    pr_overrides["FIDM-6048"] = {
        "state": "approved", "id": 362,
        "title": "FIDM-6048 - Force base image refresh",
        "url": "https://code.experian.local/projects/FRAUD/repos/pidclientadm/pull-requests/362",
        "approvals": 2, "openComments": 0,
        "sourceBranch": "feature/FIDM-6048_jboss_container_vulnerabilities_stg",
        "destinationBranch": "dev-eks-eksa", "merged": False, "mergedAt": None,
    }

    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        note = f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}: Jira MCP unavailable — showing last known state"
        out = dict(existing)
        out["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out["notes"] = [note] + (existing.get("notes") or [])[:2]
        atomic_dump(existing_path, out)
        return out, {}, [note]

    prior_map = {}
    for t in existing.get("tickets", []):
        prior_map[t["key"]] = t
    for c in existing.get("completed", []):
        prior_map.setdefault(c["key"], c)

    notes = [f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}: Live Jira REST fetch; per-ticket cache; Bitbucket REST for PRs."]

    # Active board tickets
    active_keys = set()
    active_issues = search_jira("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC")
    for i in active_issues:
        active_keys.add(i["key"])
    # Fetch window (-10d) is wider than the board's 3-day "recent win" display window on purpose:
    # the app hides done tickets after 3 days, and the weekly job archives them — a ticket must
    # never drop out of tickets[] before it has landed in completed[].
    recent_done = search_jira("assignee = currentUser() AND statusCategory = Done AND resolved >= -10d ORDER BY resolved DESC")
    for i in recent_done:
        active_keys.add(i["key"])

    # Completed archive — parents only
    done_was = search_jira("assignee was currentUser() AND statusCategory = Done ORDER BY resolved DESC", fields=FIELDS)
    done_is = search_jira("assignee = currentUser() AND statusCategory = Done ORDER BY resolved DESC", fields=FIELDS)
    done_map = {i["key"]: i for i in done_was}
    for i in done_is:
        done_map[i["key"]] = i
    parent_done_keys = []
    subtask_keys = set()
    for key, issue in done_map.items():
        f = issue["fields"]
        if f["issuetype"]["name"] == "Sub-task" or f.get("parent"):
            subtask_keys.add(key)
        else:
            parent_done_keys.append(key)

    all_fetch_keys = sorted(set(active_keys) | set(parent_done_keys))
    changes = {"new": [], "refreshed": [], "done": []}

    for key in all_fetch_keys:
        is_active = key in active_keys
        cached = load_cache(key)
        prior = prior_map.get(key) or cached
        if cached and not is_active:
            ticket = cached
        else:
            issue = jira_get(f"/rest/api/2/issue/{key}?fields={FIELDS}")
            ticket = build_ticket(issue, prior, pr_overrides, force=is_active)
            save_cache(key, ticket)
            prev = state.get(key, {})
            if not prev and not prior:
                changes["new"].append(key)
            elif ticket.get("done") and not prev.get("done"):
                changes["done"].append(key)
            elif prev.get("status") != ticket.get("status") or prev.get("comments") != ticket.get("commentCount"):
                changes["refreshed"].append(f"{key}: status/comments updated")

    # Attach subtasks to parent tickets in cache
    for key in parent_done_keys:
        ticket = load_cache(key) or prior_map.get(key)
        if not ticket:
            continue
        subs = fetch_subtasks(key, prior_map, pr_overrides, shallow=False)
        ticket["subtasks"] = subs
        ticket["subtaskCount"] = len(subs)
        save_cache(key, ticket)

    # Assemble tickets[] from active keys
    tickets = []
    new_state = {}
    for key in sorted(active_keys, key=lambda k: prior_map.get(k, {}).get("lastUpdate") or "", reverse=True):
        ticket = load_cache(key) or prior_map.get(key)
        if not ticket:
            continue
        # Drop tickets no longer assigned (except recent done still in query)
        if key not in active_keys:
            continue
        tickets.append(ticket)
        new_state[key] = ticket_to_state(ticket)

    # Assemble completed[] from parent caches only
    completed = []
    for key in sorted(parent_done_keys, key=lambda k: done_map[k]["fields"].get("resolutiondate") or "", reverse=True):
        ticket = load_cache(key)
        if not ticket:
            issue = done_map[key]
            ticket = build_ticket(issue, prior_map.get(key), pr_overrides, force=False, skip_pr=False)
            subs = fetch_subtasks(key, prior_map, pr_overrides, shallow=False)
            ticket["subtasks"] = subs
            ticket["subtaskCount"] = len(subs)
            save_cache(key, ticket)
        c = completed_from_ticket(ticket)
        if c:
            completed.append(c)
        new_state[key] = ticket_to_state(ticket)

    out = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "user": USER,
        "notes": notes,
        "tickets": tickets,
        "completed": completed,
    }
    atomic_dump(existing_path, out)
    atomic_dump(state_path, new_state)
    js = "// AUTO-GENERATED by jira-intern. Do not edit by hand.\nwindow.__JIRA_DATA__ = " + json.dumps(out, indent=2) + ";\n"
    atomic_write(os.path.join(INTERN, "data.js"), js)
    atomic_dump(pr_overrides_path, pr_overrides)
    return out, changes, notes


if __name__ == "__main__":
    out, changes, notes = main()
    print(json.dumps({
        "tickets": len(out["tickets"]),
        "completed": len(out["completed"]),
        "cache_files": len(os.listdir(os.path.join(INTERN, "cache"))),
        "changes": changes,
        "ticket_keys": [t["key"] for t in out["tickets"]],
    }, indent=2))
