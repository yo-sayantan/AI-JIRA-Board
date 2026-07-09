#!/usr/bin/env python3
"""Daily jira-intern fetch: active tickets only; preserves completed[] archive."""
import copy
import json
import os
import re
import ssl
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def atomic_write(path, text):
    """Write to a temp file in the same dir, then os.replace() over the target — atomic on the
    same filesystem, so a reader never sees a truncated / half-written data.json / data.js."""
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
JIRA_BASE = "https://agile.experian.com"
BB_BASE = "https://code.experian.local/rest/api/1.0"
USER = {"name": "Biswas, Sayantan", "accountId": "C22014E", "jiraBase": JIRA_BASE}
MY_ACCOUNT = "C22014E"

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

BB_OK = True


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


def bb_get(path, *, mark_down=True):
    global BB_OK
    tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN", "")
    req = urllib.request.Request(
        BB_BASE + path,
        headers={"Authorization": f"Bearer {tok}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
            return json.loads(r.read())
    except Exception:
        if mark_down:
            BB_OK = False
        raise


def iso(s):
    if s is None:
        return None
    if isinstance(s, (int, float)):
        ts = s / 1000 if s > 1e12 else s
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
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
        from html import escape
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
    from html import escape
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
        body = c.get("renderedBody") or wiki_to_html(c.get("body", "")) or f"<p>{c.get('body','')}</p>"
        out.append({
            "author": (c.get("author") or {}).get("displayName"),
            "when": iso(c.get("created")),
            "body": light_html(body) or body,
        })
    latest = iso(comments[0]["created"]) if comments else None
    return out, len(comments), latest


def build_update_log(key, created, status, resolved, prior_log=None):
    """Status lifecycle: newest first; text = new status name only; earliest = Opened."""
    entries = []
    seen_statuses = []
    try:
        data = jira_get(f"/rest/api/2/issue/{key}?expand=changelog&fields=created,status")
        created_dt = iso(data["fields"].get("created") or created)
        opened_day = (created_dt or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        hist = (data.get("changelog") or {}).get("histories") or []
        transitions = []
        for h in sorted(hist, key=lambda x: x.get("created", "")):
            day = iso(h.get("created"))[:10] if h.get("created") else opened_day
            for item in h.get("items") or []:
                if item.get("field") == "status":
                    to_st = item.get("toString")
                    if to_st:
                        transitions.append((day, to_st))
        # dedupe consecutive same status
        deduped = []
        prev = None
        for day, st in transitions:
            if st != prev:
                deduped.append({"when": day, "text": st})
                prev = st
        entries = list(reversed(deduped))
        if not entries or entries[-1]["text"] != "Opened":
            entries.append({"when": opened_day, "text": "Opened"})
    except Exception:
        opened_day = (iso(created) or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        entries = [{"when": opened_day, "text": "Opened"}]

    col, _ = status_column(status)
    if col == "done":
        done_day = (iso(resolved) or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if not any(e.get("text", "").startswith("Marked DONE") for e in entries):
            entries.insert(0, {"when": done_day, "text": f"Marked DONE — {done_day}"})

    # merge prior custom entries (Assigned — initial brief, etc.)
    if prior_log:
        prior_texts = {e.get("text") for e in entries}
        for e in prior_log:
            t = e.get("text") or ""
            if t.startswith("Assigned") or t.startswith("Marked DONE") or t.startswith("Refreshed"):
                if t not in prior_texts:
                    entries.insert(0, e)
    return entries


def pr_comment_stats(bb_proj, slug, pid):
    total, resolved = 0, 0
    try:
        start = 0
        pages = 0
        while pages < 3:
            data = bb_get(
                f"/projects/{bb_proj}/repos/{slug}/pull-requests/{pid}/activities?start={start}&limit=100",
                mark_down=False,
            )
            for act in data.get("values") or []:
                if act.get("action") == "COMMENTED":
                    total += 1
                    c = act.get("comment") or {}
                    if c.get("state") == "RESOLVED" or c.get("severity") == "BLOCKER":
                        resolved += 1
            pages += 1
            if data.get("isLastPage", True):
                break
            start += data.get("size", 100)
    except Exception:
        pass
    open_c = max(0, total - resolved)
    return total, resolved, open_c


def pr_to_obj(pr, bb_proj=None):
    if not pr:
        return None
    st = (pr.get("state") or "").upper()
    pid = pr.get("id")
    from_ref = pr.get("fromRef") or {}
    to_ref = pr.get("toRef") or {}
    repo = from_ref.get("repository") or {}
    project = bb_proj or (repo.get("project") or {}).get("key", "FRAUD")
    slug = repo.get("slug", "")
    url = f"https://code.experian.local/projects/{project}/repos/{slug}/pull-requests/{pid}" if slug else None
    merged = st == "MERGED"
    declined = st == "DECLINED" or st == "REJECTED"
    reviewers_raw = pr.get("reviewers") or []
    approvals = sum(1 for r in reviewers_raw if r.get("approved"))
    needs_work = sum(1 for r in reviewers_raw if r.get("status") == "NEEDS_WORK")
    reviewers = [((r.get("user") or {}).get("displayName")) for r in reviewers_raw if (r.get("user") or {}).get("displayName")]
    ct, cr, open_c = pr_comment_stats(project, slug, pid) if slug and pid else (0, 0, 0)
    if merged:
        pstate = "merged"
        open_c = 0
        cr = ct
    elif declined:
        pstate = "declined"
    elif needs_work:
        pstate = "changes"
    elif approvals >= 2 and open_c == 0:
        pstate = "approved"
    elif st == "OPEN":
        pstate = "comments"
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


def bb_search_all_prs(key):
    proj_prefix = key.split("-")[0]
    bb_proj = BB_PROJECT.get(proj_prefix, "FRAUD")
    repos = REPO_HINTS.get(proj_prefix, ["pidclientadm", "preciseid"])
    found = []
    seen_ids = set()
    key_u = key.upper()
    key_src = key.replace("-", "_").upper()
    for slug in repos:
        for state in ("OPEN", "MERGED"):
            try:
                start = 0
                q = urllib.parse.urlencode(
                    {"state": state, "start": start, "limit": 100, "order": "NEWEST"}
                )
                data = bb_get(
                    f"/projects/{bb_proj}/repos/{slug}/pull-requests?{q}",
                    mark_down=False,
                )
                for pr in data.get("values") or []:
                    title = (pr.get("title") or "").upper()
                    src = ((pr.get("fromRef") or {}).get("displayId") or "").upper()
                    if key_u in title or key_u in src or key_src in src:
                        pid = pr.get("id")
                        if pid not in seen_ids:
                            seen_ids.add(pid)
                            obj = pr_to_obj(pr, bb_proj)
                            if obj:
                                found.append(obj)
            except Exception:
                continue
    return found


def pick_primary_pr(prs):
    if not prs:
        return {"state": "none"}
    open_prs = [p for p in prs if not p.get("merged") and p.get("state") not in ("declined",)]
    if open_prs:
        return open_prs[0]
    merged = [p for p in prs if p.get("merged")]
    if merged:
        return merged[0]
    return prs[0]


def person_fmt(u):
    if not u:
        return None
    return f"{u.get('displayName')} ({(u.get('name') or u.get('key') or '').upper()})"


def is_mine(assignee):
    if not assignee:
        return False
    name = (assignee.get("name") or assignee.get("key") or "").upper()
    return name == MY_ACCOUNT or MY_ACCOUNT in (assignee.get("displayName") or "")


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


def extract_links(*texts, prior_conf=None, prior_ext=None):
    conf, ext, seen = [], [], set()
    for block in (prior_conf or []):
        u = block.get("url")
        if u and u not in seen:
            seen.add(u)
            conf.append(copy.deepcopy(block))
    for block in (prior_ext or []):
        u = block.get("url")
        if u and u not in seen:
            seen.add(u)
            ext.append(copy.deepcopy(block))

    def add_url(url, title=None):
        if not url or url in seen:
            return
        seen.add(url)
        title = title or url
        if "pages.experian.local" in url or "confluence" in url.lower():
            conf.append({"title": title, "url": url, "excerpt": next((c.get("excerpt") for c in (prior_conf or []) if c.get("url") == url), None)})
        elif url.startswith("http"):
            ext.append({"title": title, "url": url, "reachable": True})

    for text in texts:
        if not text:
            continue
        for m in re.finditer(r'href=["\']([^"\']+)["\']', text, re.I):
            add_url(m.group(1))
        for m in re.finditer(r'\[([^\]|]+)\|([^\]]+)\]', text):
            add_url(m.group(2), m.group(1))
        for m in re.finditer(r'https?://[^\s<>"\']+', text):
            add_url(m.group(0).rstrip(".,;)"))

    return conf, ext


def build_basic_subtask(si, parent_key):
    sf = si["fields"]
    sk = si["key"]
    col, hold = status_column(sf["status"]["name"])
    assignee = person_fmt(sf.get("assignee"))
    return {
        "key": sk,
        "title": sf.get("summary"),
        "status": sf["status"]["name"],
        "column": col,
        "type": sf["issuetype"]["name"],
        "priority": (sf.get("priority") or {}).get("name"),
        "url": f"{JIRA_BASE}/browse/{sk}",
        "assignee": assignee,
        "parentKey": parent_key,
        "done": col == "done",
        "onHold": hold,
    }


def build_ticket(issue, prior, state_entry, force_refresh=False):
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

    desc_html = light_html(wiki_to_html(f.get("description")))
    conf, ext = extract_links(
        f.get("description"), *[c.get("body") for c in comments],
        prior_conf=(prior or {}).get("confluence"),
        prior_ext=(prior or {}).get("externalLinks"),
    )

    # PRs from Bitbucket or carry forward
    prs = []
    if BB_OK:
        try:
            prs = bb_search_all_prs(key)
        except Exception:
            prs = copy.deepcopy((prior or {}).get("prs") or [])
    else:
        prs = copy.deepcopy((prior or {}).get("prs") or [])

    pr = pick_primary_pr(prs) if prs else ((prior or {}).get("pr") or {"state": "none"})
    if prs:
        pr = pick_primary_pr(prs)
    branches = list(dict.fromkeys(p.get("sourceBranch") for p in prs if p.get("sourceBranch")))
    branch = pr.get("sourceBranch") if pr and pr.get("sourceBranch") else ((prior or {}).get("branch") if not branches else branches[0])
    if branches:
        branch = branches[0]

    update_log = build_update_log(key, f.get("created"), status, f.get("resolutiondate"), (prior or {}).get("updateLog"))

    prev = state_entry or {}
    unchanged = (
        prior and not force_refresh
        and prev.get("status") == status
        and prev.get("comments") == comment_count
        and prev.get("latest_comment") == latest_comment
        and prev.get("last_update") == iso(f.get("updated"))
    )
    if unchanged and prior:
        ticket = copy.deepcopy(prior)
        ticket["lastUpdate"] = iso(f.get("updated"))
        return ticket

    def carry_ai_fields(ticket_obj):
        """aiSummary is owned by summarize-active.sh — never drop on refresh."""
        if prior:
            if prior.get("aiSummary") and not ticket_obj.get("aiSummary"):
                ticket_obj["aiSummary"] = prior["aiSummary"]
            if prior.get("aiSummaryAt") and not ticket_obj.get("aiSummaryAt"):
                ticket_obj["aiSummaryAt"] = prior["aiSummaryAt"]
        return ticket_obj

    ticket = {
        "key": key,
        "title": f.get("summary"),
        "status": status,
        "column": column,
        "type": itype,
        "priority": (f.get("priority") or {}).get("name"),
        "storyPoints": int(sp) if sp is not None and sp == int(sp) else (float(sp) if sp else None),
        "branch": branch,
        "branches": branches,
        "pr": pr if pr else {"state": "none"},
        "prs": prs,
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
        "description": desc_html,
        "acceptanceCriteria": ac_list(f.get("customfield_10700")),
        "comments": comments,
        "related": issue_links(f),
        "confluence": conf,
        "externalLinks": ext,
        "proposedSolution": (prior or {}).get("proposedSolution"),
        "effortEstimate": (prior or {}).get("effortEstimate"),
        "openQuestions": (prior or {}).get("openQuestions") or [],
        "sources": (prior or {}).get("sources") or [{"title": f"Jira {key}", "url": f"{JIRA_BASE}/browse/{key}"}],
        "updateLog": update_log,
    }
    if (prior or {}).get("estDays"):
        ticket["estDays"] = prior["estDays"]

    # New assignment
    if not state_entry and not prior:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        ticket["updateLog"].insert(0, {"when": day, "text": "Assigned — initial brief"})
    elif prev.get("status") != status or prev.get("comments") != comment_count:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if prev.get("status") != status:
            ticket["updateLog"].insert(0, {"when": day, "text": status})
        if prev.get("comments") != comment_count and comment_count > (prev.get("comments") or 0):
            ticket["updateLog"].insert(0, {"when": day, "text": f"New comment ({comment_count})"})

    return carry_ai_fields(ticket)


def fetch_subtasks(parent_key, prior_map, state):
    issues = search_jira(f'parent = {parent_key} ORDER BY key ASC', fields=FIELDS)
    subs = []
    for si in issues:
        sk = si["key"]
        assignee = si["fields"].get("assignee")
        if is_mine(assignee):
            full = build_ticket(
                jira_get(f"/rest/api/2/issue/{sk}?fields={FIELDS}"),
                prior_map.get(sk),
                state.get(sk),
                force_refresh=True,
            )
            full["parentKey"] = parent_key
            subs.append(full)
        else:
            subs.append(build_basic_subtask(si, parent_key))
    return subs


def ticket_to_state(t):
    pr = t.get("pr") or {}
    return {
        "title": t.get("title"), "status": t.get("status"), "column": t.get("column"),
        "type": t.get("type"), "priority": t.get("priority"),
        "story_points": t.get("storyPoints"), "branch": t.get("branch"),
        "est_days": t.get("estDays"), "pr_state": pr.get("state"),
        "pr_comments": pr.get("openComments"),
        "comments": t.get("commentCount"), "latest_comment": t.get("latestComment"),
        "last_update": t.get("lastUpdate"), "done": t.get("done", False),
    }


def main():
    global BB_OK
    load_env()
    existing_path = os.path.join(INTERN, "data.json")
    state_path = os.path.join(INTERN, ".state.json")

    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        if not os.path.isfile(existing_path):
            raise SystemExit("No JIRA token and no existing data.json")
        with open(existing_path) as f:
            existing = json.load(f)
        note = f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}: Jira MCP unavailable — showing last known state"
        out = copy.deepcopy(existing)
        out["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out["notes"] = [note]
        status_path = os.path.join(INTERN, "_STATUS.md")
        old_status = open(status_path).read() if os.path.isfile(status_path) else ""
        open(status_path, "w").write(f"{note}\n\n{old_status}")
        write_outputs(out)
        return out, {"unavailable": True}, [note]

    existing = json.load(open(existing_path)) if os.path.isfile(existing_path) else {"tickets": [], "completed": []}
    completed_preserved = copy.deepcopy(existing.get("completed") or [])
    state = json.load(open(state_path)) if os.path.isfile(state_path) else {}

    prior_map = {t["key"]: t for t in existing.get("tickets", [])}

    # probe Bitbucket once
    BB_OK = True
    try:
        bb_get("/projects/FRAUD/repos/pidclientadm/pull-requests?limit=1")
    except Exception:
        BB_OK = False

    # Fetch window (-10d) is wider than the board's 3-day "recent win" display window on purpose:
    # the app hides done tickets after 3 days, and the weekly job archives them — a ticket must
    # never drop out of tickets[] before it has landed in completed[].
    jql = "(assignee = currentUser() AND statusCategory != Done) OR (assignee = currentUser() AND statusCategory = Done AND resolved >= -10d)"
    issues = search_jira(jql + " ORDER BY updated DESC")
    active_keys = []
    seen = set()
    for i in issues:
        if i["key"] not in seen:
            seen.add(i["key"])
            active_keys.append(i["key"])

    changes = {"new": [], "refreshed": [], "done": []}
    tickets = []
    new_state = {}

    for key in active_keys:
        prior = prior_map.get(key)
        prev_state = state.get(key, {})
        issue = jira_get(f"/rest/api/2/issue/{key}?fields={FIELDS}")
        force = key not in state or not prior
        ticket = build_ticket(issue, prior, prev_state, force_refresh=force or bool(prev_state))

        # subtasks
        subs = fetch_subtasks(key, prior_map, state)
        if subs:
            ticket["subtasks"] = subs
            ticket["subtaskCount"] = len(subs)

        if not prev_state and not prior:
            changes["new"].append(f"{key}: {ticket.get('title', '')[:60]}")
        elif ticket.get("done") and not prev_state.get("done"):
            changes["done"].append(key)
        elif (
            prev_state.get("status") != ticket.get("status")
            or prev_state.get("comments") != ticket.get("commentCount")
            or prev_state.get("last_update") != ticket.get("lastUpdate")
        ):
            parts = []
            if prev_state.get("status") != ticket.get("status"):
                parts.append(f"status → {ticket.get('status')}")
            if prev_state.get("comments") != ticket.get("commentCount"):
                parts.append(f"comments {prev_state.get('comments')}→{ticket.get('commentCount')}")
            changes["refreshed"].append(f"{key}: {', '.join(parts)}")

        tickets.append(ticket)
        new_state[key] = ticket_to_state(ticket)

    notes = [f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}: Daily fetch — Jira REST" + ("" if BB_OK else "; Bitbucket unreachable — PR/branch data carried forward") + "."]
    if changes["new"]:
        notes.append("New: " + ", ".join(k.split(":")[0] for k in changes["new"]))
    if changes["done"]:
        notes.append("Marked done: " + ", ".join(changes["done"]))

    out = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "user": USER,
        "notes": notes,
        "tickets": tickets,
        "completed": completed_preserved,
    }
    write_outputs(out)
    atomic_dump(state_path, new_state)
    return out, changes, notes


def write_outputs(out):
    atomic_dump(os.path.join(INTERN, "data.json"), out)
    js = "// AUTO-GENERATED by jira-intern. Do not edit by hand.\nwindow.__JIRA_DATA__ = " + json.dumps(out, indent=2) + ";\n"
    atomic_write(os.path.join(INTERN, "data.js"), js)


if __name__ == "__main__":
    out, changes, notes = main()
    print(json.dumps({
        "generatedAt": out["generatedAt"],
        "tickets": len(out["tickets"]),
        "completed": len(out["completed"]),
        "keys": [t["key"] for t in out["tickets"]],
        "changes": changes,
        "notes": notes,
        "bb_ok": BB_OK,
    }, indent=2))
