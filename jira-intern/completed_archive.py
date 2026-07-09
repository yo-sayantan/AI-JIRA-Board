#!/usr/bin/env python3
"""Completed-archive intern — refresh cache + merge completed[] only into data.json."""
import json
import os
import re
import sys
import time
import tempfile
import urllib.parse
import urllib.request
import ssl
from datetime import datetime, timezone
from html import escape


def atomic_write(path, text):
    """Write to a temp file in the same dir, then os.replace() over the target — atomic on the
    same filesystem, so a reader never sees a truncated / half-written file."""
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


INTERN = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(INTERN, "cache")
DATA_JSON = os.path.join(INTERN, "data.json")
STATUS_MD = os.path.join(INTERN, "_STATUS.md")
JIRA_BASE = "https://agile.experian.com"
BB_BASE = "https://code.experian.local/rest/api/1.0"

REPO_HINTS = {
    "FIDM": ["pidclientadm", "preciseid", "preciseid_eks", "pidadmin", "fraudadmin", "pmv2", "fraud-admin"],
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

FIELDS = (
    "summary,status,issuetype,priority,updated,created,resolutiondate,assignee,reporter,"
    "labels,components,fixVersions,description,comment,issuelinks,parent,subtasks,"
    "customfield_10402,customfield_57402,customfield_10404,customfield_10405,customfield_10700"
)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

MAX_FETCH = int(os.environ.get("COMPLETED_MAX_FETCH", "999"))


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
    for keys, col in [
        (("to do", "open", "backlog", "reopened", "selected for development"), "todo"),
        (("in progress", "dev in progress", "work in progress", "in development"), "prog"),
        (("in review", "code review", "ready4review", "ready for review", "review"), "rev"),
        (("qa", "in qa", "testing", "verification"), "qa"),
        (("done", "completed", "closed", "resolved", "released"), "done"),
        (("on hold", "hold", "blocked", "waiting", "parked", "impeded"), "hold"),
    ]:
        if n in keys:
            return col
    return "prog"


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


def search_jira(jql, fields=FIELDS):
    all_issues, start = [], 0
    while True:
        q = urllib.parse.urlencode({"jql": jql, "startAt": start, "maxResults": 100, "fields": fields})
        try:
            data = jira_get("/rest/api/2/search?" + q)
        except urllib.error.HTTPError as e:
            if "statusCategory" in jql and e.code == 400:
                jql_fb = jql.replace("statusCategory = Done", "status in (Done, Closed, Resolved)")
                return search_jira(jql_fb, fields)
            raise
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
        out.append({
            "author": (c.get("author") or {}).get("displayName"),
            "when": iso(c.get("created")),
            "body": light_html(body) or body,
        })
    latest = iso(comments[0]["created"]) if comments else None
    return out, len(comments), latest


def person_fmt(u):
    if not u:
        return None
    return f"{u.get('displayName')} ({(u.get('name') or u.get('key') or '').upper()})"


def issue_links(f):
    related = []
    for link in f.get("issuelinks") or []:
        for direction, rel_key in [("outwardIssue", "outward"), ("inwardIssue", "inward")]:
            if direction in link:
                o = link[direction]
                rel = link.get("type", {})
                relation = rel.get(rel_key, "relates")
                related.append({
                    "key": o["key"], "url": f"{JIRA_BASE}/browse/{o['key']}",
                    "summary": o["fields"]["summary"], "status": o["fields"]["status"]["name"],
                    "relation": relation,
                })
    return related


def is_templated_branch(key, branch):
    """True when branch slug is auto-generated like feature/FIDM-5845_5845."""
    if not branch:
        return False
    num = key.split("-", 1)[-1] if "-" in key else key
    key_us = key.replace("-", "_").lower()
    tail = branch.split("/")[-1].lower()
    if tail == f"{key_us}_{num}":
        return True
    if tail.endswith(f"_{num}"):
        rest = tail[: -(len(num) + 1)]
        if rest == key_us or rest.replace("_", "-") == key.lower():
            return True
    return False


def cache_is_stale(ticket):
    key = ticket.get("key", "")
    if is_templated_branch(key, ticket.get("branch")):
        return True
    if "branches" not in ticket:
        return True
    if "prs" not in ticket:
        return True
    pr = ticket.get("pr") or {}
    if ticket.get("column") == "done" and pr.get("state") == "none":
        # Branches exist but no merged PR — re-scan Bitbucket
        if ticket.get("branches"):
            return True
        # Empty branches + prs[] present (even []) = confirmed no PR existed
        return False
    return False


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
    reviewers = pr.get("reviewers") or []
    approvals = sum(1 for r in reviewers if r.get("approved"))
    if merged:
        pstate = "merged"
    elif st == "DECLINED":
        pstate = "declined"
    elif approvals > 0:
        pstate = "approved"
    elif st == "OPEN":
        pstate = "comments"
    else:
        pstate = "changes"
    return {
        "state": pstate,
        "id": pid,
        "title": pr.get("title"),
        "url": url,
        "approvals": approvals,
        "openComments": 0,
        "sourceBranch": from_ref.get("displayId"),
        "destinationBranch": to_ref.get("displayId"),
        "merged": merged,
        "mergedAt": iso(pr.get("closedDate")) if merged else None,
    }


def pr_matches_key(pr, key):
    key_up = key.upper()
    key_us = key.replace("-", "_").upper()
    title = (pr.get("title") or "").upper()
    src = ((pr.get("fromRef") or {}).get("displayId") or "").upper()
    return key_up in title or key_up in src or key_us in src


def bb_prs_for_branch(bb_proj, slug, branch):
    """Bitbucket filterText on /pull-requests is broken here; query by branch ref instead."""
    found = []
    try:
        at = urllib.parse.quote(f"refs/heads/{branch}", safe="")
        q = f"at={at}&direction=OUTGOING&state=ALL&limit=20"
        data = bb_get(f"/projects/{bb_proj}/repos/{slug}/pull-requests?{q}")
        for pr in data.get("values") or []:
            found.append(pr)
    except Exception:
        pass
    return found


def bb_scan_prs_by_key(bb_proj, slug, key, max_pages=12):
    """Paginate MERGED/DECLINED PRs; filterText search does not work on this Bitbucket."""
    found, seen = [], set()
    for state in ("MERGED", "DECLINED"):
        start, empty_pages = 0, 0
        while start < max_pages * 100:
            try:
                q = urllib.parse.urlencode(
                    {"state": state, "limit": 100, "start": start, "order": "NEWEST"}
                )
                data = bb_get(f"/projects/{bb_proj}/repos/{slug}/pull-requests?{q}")
            except Exception:
                break
            vals = data.get("values") or []
            if not vals:
                break
            page_hits = 0
            for pr in vals:
                pid = pr.get("id")
                if pid in seen:
                    continue
                if pr_matches_key(pr, key):
                    seen.add(pid)
                    found.append(pr)
                    page_hits += 1
            if page_hits == 0:
                empty_pages += 1
                if empty_pages >= 4:
                    break
            else:
                empty_pages = 0
            start += len(vals)
            if data.get("isLastPage"):
                break
    return found


def bb_fetch_prs_and_branches(key, lightweight=False):
    proj_prefix = key.split("-")[0]
    bb_proj = BB_PROJECT.get(proj_prefix, "FRAUD")
    repos = REPO_HINTS.get(proj_prefix, ["pidclientadm", "preciseid"])
    if lightweight:
        repos = repos[:2]
    prs_raw = []
    branches = set()
    key_up = key.upper()
    key_us = key.replace("-", "_")

    for slug in repos:
        try:
            bq = urllib.parse.urlencode({"filterText": key, "limit": 100})
            bdata = bb_get(f"/projects/{bb_proj}/repos/{slug}/branches?{bq}")
            for b in bdata.get("values") or []:
                bid = b.get("displayId") or b.get("id", "")
                if key_up in bid.upper() or key_us.upper() in bid.upper():
                    branches.add(bid)
        except Exception:
            pass

        for branch in list(branches):
            for pr in bb_prs_for_branch(bb_proj, slug, branch):
                prs_raw.append((pr, bb_proj))
                sb = (pr.get("fromRef") or {}).get("displayId")
                if sb:
                    branches.add(sb)

        if lightweight:
            continue

        scan_pages = 5 if slug in ("preciseid", "pidclientadm") else 3
        seen_ids = {p.get("id") for p, _ in prs_raw}
        for pr in bb_scan_prs_by_key(bb_proj, slug, key, max_pages=scan_pages):
            if pr.get("id") in seen_ids:
                continue
            seen_ids.add(pr.get("id"))
            prs_raw.append((pr, bb_proj))
            sb = (pr.get("fromRef") or {}).get("displayId")
            if sb:
                branches.add(sb)

    pr_objs = []
    seen_ids = set()
    for pr, proj in prs_raw:
        obj = pr_to_obj(pr, proj)
        if obj and obj.get("id") not in seen_ids:
            seen_ids.add(obj.get("id"))
            pr_objs.append(obj)
    pr_objs.sort(key=lambda p: (0 if p.get("merged") else 1, -(p.get("id") or 0)))

    branch_list = sorted(branches)
    primary_branch = None
    primary_pr = {"state": "none"}
    merged = [p for p in pr_objs if p.get("merged")]
    if merged:
        primary_pr = merged[0]
        primary_branch = primary_pr.get("sourceBranch")
    elif pr_objs:
        primary_pr = pr_objs[0]
        primary_branch = primary_pr.get("sourceBranch")
    elif branch_list:
        primary_branch = branch_list[0]

    return branch_list, pr_objs, primary_branch, primary_pr


def build_update_log(key, created, status):
    """Status lifecycle from changelog — newest first; text = NEW status name only."""
    entries = []
    try:
        data = jira_get(f"/rest/api/2/issue/{key}?expand=changelog&fields=created,status")
        created_dt = iso(data["fields"].get("created") or created)
        opened_when = created_dt or iso(created)
        status_events = []
        hist = (data.get("changelog") or {}).get("histories") or []
        for h in sorted(hist, key=lambda x: x.get("created", "")):
            when = iso(h.get("created"))
            for item in h.get("items") or []:
                if item.get("field") == "status" and item.get("toString"):
                    status_events.append({"when": when, "text": item["toString"]})
        # newest first, skip duplicate consecutive statuses
        deduped = []
        prev_text = None
        for e in reversed(status_events):
            if e["text"] == prev_text:
                continue
            deduped.append(e)
            prev_text = e["text"]
        opened = {"when": opened_when, "text": "Opened"}
        if not deduped or deduped[-1]["text"] != "Opened":
            deduped.append(opened)
        entries = deduped
    except Exception:
        entries = [{"when": iso(created), "text": "Opened"}]
    return entries


def build_subtask(si, parent_key, pr_overrides):
    sf = si["fields"]
    sk = si["key"]
    col = status_column(sf["status"]["name"])
    branches, prs, branch, pr = bb_fetch_prs_and_branches(sk, lightweight=True)
    if pr_overrides.get(sk):
        pr = pr_overrides[sk]
    return {
        "key": sk,
        "title": sf.get("summary"),
        "status": sf["status"]["name"],
        "column": col,
        "type": sf["issuetype"]["name"],
        "priority": (sf.get("priority") or {}).get("name"),
        "parentKey": parent_key,
        "url": f"{JIRA_BASE}/browse/{sk}",
        "done": col == "done",
        "onHold": col == "hold",
        "created": iso(sf.get("created")),
        "resolved": iso(sf.get("resolutiondate")),
        "branch": branch,
        "branches": branches,
        "pr": pr,
        "prs": prs if prs else None,
    }


def build_completed_parent(issue, prior, pr_overrides):
    f = issue["fields"]
    key = issue["key"]
    status = f["status"]["name"]
    column = status_column(status)
    itype = f["issuetype"]["name"]
    sp = f.get("customfield_10402") or f.get("customfield_57402")
    comments, comment_count, latest_comment = fetch_comments(key)

    epic_key = f.get("customfield_10405")
    epic = {"key": epic_key, "url": f"{JIRA_BASE}/browse/{epic_key}", "relation": "epic (parent)"} if epic_key else (prior or {}).get("epic")

    branches, prs, branch, pr = bb_fetch_prs_and_branches(key)
    if pr_overrides.get(key) and pr.get("state") == "none":
        pr = pr_overrides[key]

    subs_issues = search_jira(f"parent = {key} ORDER BY key ASC", fields=FIELDS)
    subtasks = [build_subtask(si, key, pr_overrides) for si in subs_issues]

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
        "pr": pr,
        "prs": prs if prs else [],
        "commentCount": comment_count,
        "latestComment": latest_comment,
        "lastUpdate": iso(f.get("updated")),
        "created": iso(f.get("created")),
        "resolved": iso(f.get("resolutiondate")),
        "done": True,
        "onHold": False,
        "url": f"{JIRA_BASE}/browse/{key}",
        "sprint": parse_sprint(f.get("customfield_10404")),
        "reporter": person_fmt(f.get("reporter")),
        "assignee": person_fmt(f.get("assignee")),
        "epic": epic,
        "parentKey": None,
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
        "updateLog": build_update_log(key, f.get("created"), status),
        "subtasks": subtasks,
        "subtaskCount": len(subtasks),
    }
    return ticket


def completed_entry(t):
    c = {k: t[k] for k in (
        "key", "title", "type", "priority", "status", "created", "resolved", "storyPoints",
        "branch", "branches", "pr", "prs", "url", "lastUpdate", "sprint", "reporter", "assignee",
        "epic", "labels", "components", "fixVersions", "description", "acceptanceCriteria",
        "comments", "commentCount", "related", "confluence", "externalLinks", "proposedSolution",
        "effortEstimate", "openQuestions", "sources", "updateLog", "subtasks", "subtaskCount",
    ) if k in t}
    c["project"] = t["key"].split("-")[0]
    c["column"] = "done"
    c["done"] = True
    return c


def merge_completed_only(completed_list):
    raw = open(DATA_JSON, "r", encoding="utf-8").read()
    data = json.loads(raw)
    data["completed"] = completed_list
    # Preserve formatting (indent=2 like existing) and write atomically so a reader never
    # sees a torn file mid-write.
    atomic_write(DATA_JSON, json.dumps(data, indent=2) + "\n")


def prepend_status(note):
    existing = open(STATUS_MD, "r", encoding="utf-8").read() if os.path.isfile(STATUS_MD) else ""
    with open(STATUS_MD, "w", encoding="utf-8") as f:
        f.write(note + "\n\n" + existing)


def main():
    load_env()
    os.makedirs(CACHE, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        prepend_status(f"**{ts}** — Jira unavailable (no token). Left data.json + cache unchanged.")
        print(json.dumps({"error": "no jira token", "stopped": True}))
        return 1

    if not os.path.isfile(DATA_JSON):
        print(json.dumps({"error": "data.json missing"}))
        return 1

    pr_overrides_path = os.path.join(INTERN, ".pr_overrides.json")
    pr_overrides = json.load(open(pr_overrides_path)) if os.path.isfile(pr_overrides_path) else {}

    # Paginated done union
    done_was = search_jira("assignee was currentUser() AND statusCategory = Done ORDER BY resolved DESC")
    done_is = search_jira("assignee = currentUser() AND statusCategory = Done ORDER BY resolved DESC")
    done_map = {i["key"]: i for i in done_was}
    for i in done_is:
        done_map[i["key"]] = i

    parent_keys = []
    for key, issue in done_map.items():
        f = issue["fields"]
        if f["issuetype"]["name"] == "Sub-task" or f.get("parent"):
            continue
        parent_keys.append(key)
    parent_keys.sort(key=lambda k: done_map[k]["fields"].get("resolutiondate") or "", reverse=True)

    newly_cached = []
    reused = []

    for key in parent_keys:
        cache_path = os.path.join(CACHE, f"{key}.json")
        prior = json.load(open(cache_path)) if os.path.isfile(cache_path) else None
        need_fetch = prior is None or cache_is_stale(prior)
        if need_fetch and len(newly_cached) >= MAX_FETCH:
            continue
        if need_fetch:
            try:
                issue = jira_get(f"/rest/api/2/issue/{key}?fields={FIELDS}")
                ticket = build_completed_parent(issue, prior, pr_overrides)
                atomic_write(cache_path, json.dumps(ticket, indent=2))
                newly_cached.append(key)
                time.sleep(0.15)
            except Exception as e:
                sys.stderr.write(f"WARN fetch {key}: {e}\n")
                if prior:
                    reused.append(key)
        else:
            reused.append(key)

    # Assemble completed[] from cache for all parent keys (use stale cache if fetch skipped)
    completed = []
    for key in parent_keys:
        cache_path = os.path.join(CACHE, f"{key}.json")
        if not os.path.isfile(cache_path):
            continue
        t = json.load(open(cache_path))
        completed.append(completed_entry(t))

    merge_completed_only(completed)

    note = (
        f"**{ts}** — Completed-archive intern: **{len(completed)}** parent tickets in archive "
        f"({len(newly_cached)} newly fetched/cached this run, {len(reused)} reused from cache). "
        f"Jira REST + Bitbucket REST; merged completed[] only — tickets[] untouched."
    )
    prepend_status(note)

    print(json.dumps({
        "completed_in_archive": len(completed),
        "newly_cached_this_run": len(newly_cached),
        "reused_cache": len(reused),
        "parent_keys_total": len(parent_keys),
        "missing_cache": len(parent_keys) - len(completed),
        "newly_cached_keys": newly_cached[:10],
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
