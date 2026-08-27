#!/usr/bin/env python3
"""Daily jira-intern fetch: active tickets only; preserves completed[] archive."""
import copy
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import devinfo  # noqa: E402  (needs the path fix above when run from another cwd)
from _config import endpoints, identity, load_config  # noqa: E402
from datafile import atomic_dump, atomic_write, write_outputs  # noqa: E402
from progress import clear_progress, set_progress  # noqa: E402

INTERN = os.path.dirname(os.path.abspath(__file__))
# Identity and endpoints come from config.json (see _config.py for the resolution order) —
# never hardcoded, so this repo carries no company hostnames and porting is config-only.
JIRA_BASE, CONFLUENCE_BASE, BITBUCKET_BASE = endpoints(INTERN)
BB_BASE = f"{BITBUCKET_BASE}/rest/api/1.0" if BITBUCKET_BASE else ""
# Host-only form, used to recognise Confluence links among a ticket's remote links.
CONFLUENCE_HOST = CONFLUENCE_BASE.split("://")[-1].split("/")[0] if CONFLUENCE_BASE else ""
_ME = identity(INTERN)
USER = {"name": _ME["name"], "accountId": _ME["accountId"], "jiraBase": JIRA_BASE}
MY_ACCOUNT = _ME["accountId"]

REPO_HINTS = {
    "FIDM": ["pidclientadm", "preciseid", "preciseid_eks", "pidadmin", "fraudadmin"],
    "FRAUDBUSTE": ["pidclientadm", "fraudadmin", "preciseid"],
    "DFMM": ["fars", "as1bizid"],
    "PMIEN": ["precisematch", "precisematchv2"],
    "POPD": ["fars"],
    "NACLEN": ["frdbizid"],
}
BB_PROJECT = {
    "FIDM": "FRAUD", "FRAUDBUSTE": "FRAUD", "DFMM": "FRDBIZID", "PMIEN": "PRECISEMATCH",
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

# Branches/PRs/reviews for every key in this run, prefetched in one parallel batch from
# Jira's dev-status API (see devinfo.py). A key missing from the map means the lookup
# FAILED — never that the ticket has no code — so callers fall back instead of wiping data.
DEV = {}


def _config_int(path_keys, default):
    try:
        cfg = load_config(INTERN)
        for k in path_keys:
            cfg = cfg[k]
        return int(cfg)
    except Exception:
        return default


REQUIRED_APPROVALS = _config_int(("app", "requiredApprovals"), 2)


def _excluded_projects():
    """Project keys to drop entirely (config.json → excludeProjects). Case-insensitive."""
    try:
        cfg = load_config(INTERN)
        return {str(p).strip().upper() for p in (cfg.get("excludeProjects") or []) if str(p).strip()}
    except Exception:
        return set()


EXCLUDE_PROJECTS = _excluded_projects()


def is_excluded(key):
    """True when a ticket key belongs to an excluded project (e.g. ACKYARISK-190 → ACKYARISK)."""
    return bool(key) and key.split("-")[0].upper() in EXCLUDE_PROJECTS


def load_env():
    p = os.path.expanduser("~/.cursor/mcp-secrets.env")
    if os.path.isfile(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _is_transient_net(exc):
    """DNS blips, timeouts, and 5xx — worth retrying. 4xx is not."""
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500
    if isinstance(exc, urllib.error.URLError):
        return True
    return isinstance(exc, (TimeoutError, ConnectionError, OSError))


def _get_json(url, headers, timeout, retries=4):
    """GET with retry/backoff — Docker DNS and corporate VPN flaps are common here."""
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:
            last = e
            if attempt >= retries:
                break
            # Exponential backoff for network/DNS; short linear for other errors.
            delay = min(30, 2 ** attempt) if _is_transient_net(e) else (1 + attempt)
            time.sleep(delay)
    raise last


def jira_get(path):
    return _get_json(
        JIRA_BASE + path,
        {"Authorization": f"Bearer {os.environ['JIRA_PERSONAL_TOKEN']}", "Accept": "application/json"},
        timeout=120,
    )


def bb_get(path, *, mark_down=True):
    global BB_OK
    tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN", "")
    try:
        return _get_json(
            BB_BASE + path,
            {"Authorization": f"Bearer {tok}", "Accept": "application/json"},
            timeout=45,
            retries=1,
        )
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
    """Map a raw Jira status name onto a board column.

    Exact aliases first; then a whole-word fallback so variants like "Ready for QA" /
    "Under QA" land in QA without every phrasing having to be listed. Unknown statuses
    default to In Progress (in-flight work).
    """
    n = (name or "").lower().strip()
    mapping = [
        (("to do", "open", "backlog", "reopened", "selected for development"), "todo", False),
        (("in progress", "dev in progress", "work in progress", "in development"), "prog", False),
        (("in review", "code review", "ready4review", "ready for review", "review"), "rev", False),
        # "Ready for QA" / "Under QA" / plain "QA" all fold into the QA column.
        (("qa", "in qa", "under qa", "ready for qa", "ready4qa", "awaiting qa",
          "testing", "in test", "in testing", "verification", "verify"), "qa", False),
        (("done", "completed", "closed", "resolved", "released"), "done", False),
        (("on hold", "hold", "blocked", "waiting", "parked", "impeded"), "hold", True),
    ]
    for keys, col, hold in mapping:
        if n in keys:
            return col, hold
    # Whole-word fallback — catches "Ready for QA", "Moved to QA", etc. without listing every phrasing.
    # "qa" checked before "review" so "Ready for QA Review" (if it ever appears) still lands in QA.
    tokens = set(re.findall(r"[a-z0-9]+", n))
    if "qa" in tokens or "testing" in tokens or "verification" in tokens:
        return "qa", False
    if "review" in tokens:
        return "rev", False
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


def search_jira(jql, fields=FIELDS, expand=None):
    all_issues, start = [], 0
    while True:
        params = {"jql": jql, "startAt": start, "maxResults": 100, "fields": fields}
        if expand:
            params["expand"] = expand
        data = jira_get("/rest/api/2/search?" + urllib.parse.urlencode(params))
        batch = data.get("issues", [])
        all_issues.extend(batch)
        if not batch:  # permission-filtered results can leave total > returned — never spin
            break
        start += len(batch)
        if start >= data.get("total", 0):
            break
    return all_issues


def comments_from_issue(f):
    """Comments straight off the search payload when it's complete — saves one HTTP call per
    ticket. Returns None when Jira truncated the list (caller falls back to pagination)."""
    c = f.get("comment") or {}
    listed = c.get("comments") or []
    total = c.get("total", len(listed))
    if total > len(listed):
        return None
    ordered = sorted(listed, key=lambda x: x.get("created", ""), reverse=True)
    out = []
    for x in ordered:
        body = x.get("renderedBody") or wiki_to_html(x.get("body", "")) or f"<p>{x.get('body','')}</p>"
        out.append({
            "author": (x.get("author") or {}).get("displayName"),
            "when": iso(x.get("created")),
            "body": light_html(body) or body,
        })
    latest = iso(ordered[0]["created"]) if ordered else None
    return out, len(ordered), latest


def fetch_comments(key):
    comments, start = [], 0
    while True:
        data = jira_get(f"/rest/api/2/issue/{key}/comment?startAt={start}&maxResults=100&expand=renderedBody")
        batch = data.get("comments", [])
        comments.extend(batch)
        if not batch:
            break
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


def changelog_done_date(changelog):
    """Fallback resolved date: Jira stamps resolutiondate only when the Resolution field is
    set, so a workflow transition straight to Done can leave it null. Use the newest
    changelog transition into a done-column status instead."""
    dates = [
        h.get("created")
        for h in (changelog or {}).get("histories") or []
        for it in h.get("items") or []
        if it.get("field") == "status" and status_column(it.get("toString"))[0] == "done" and h.get("created")
    ]
    return iso(max(dates)) if dates else None


def build_update_log(key, created, status, resolved, changelog, prior_log=None):
    """Status lifecycle: newest first; text = new status name only; earliest = Opened.
    Uses the changelog that came back with the search (expand=changelog) — no extra call."""
    opened_day = (iso(created) or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hist = (changelog or {}).get("histories") or []
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
    url = f"{BITBUCKET_BASE}/projects/{project}/repos/{slug}/pull-requests/{pid}" if slug and BITBUCKET_BASE else None
    merged = st == "MERGED"
    declined = st == "DECLINED" or st == "REJECTED"
    reviewers_raw = pr.get("reviewers") or []
    approvals = sum(1 for r in reviewers_raw if r.get("approved"))
    needs_work = sum(1 for r in reviewers_raw if r.get("status") == "NEEDS_WORK")
    reviewers = [((r.get("user") or {}).get("displayName")) for r in reviewers_raw if (r.get("user") or {}).get("displayName")]
    # Activity pages are only needed while a PR is still reviewable — merged/declined PRs
    # get fixed stats (saves 1-3 Bitbucket calls per closed PR).
    ct, cr, open_c = pr_comment_stats(project, slug, pid) if slug and pid and not (merged or declined) else (0, 0, 0)
    if merged:
        pstate = "merged"
        open_c = 0
        cr = ct
    elif declined:
        pstate = "declined"
    elif needs_work:
        pstate = "changes"
    elif approvals >= REQUIRED_APPROVALS and open_c == 0:
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
    """All PRs referencing this ticket key. The repo×state listings are independent HTTP
    calls, so they run concurrently — wall-clock is one round-trip, not repos×3."""
    proj_prefix = key.split("-")[0]
    bb_proj = BB_PROJECT.get(proj_prefix, "FRAUD")
    repos = REPO_HINTS.get(proj_prefix, ["pidclientadm", "preciseid"])
    key_u = key.upper()
    key_src = key.replace("-", "_").upper()
    combos = [(slug, state) for slug in repos for state in ("OPEN", "MERGED", "DECLINED")]

    def list_prs(combo):
        slug, state = combo
        try:
            q = urllib.parse.urlencode({"state": state, "limit": 100, "order": "NEWEST"})
            data = bb_get(f"/projects/{bb_proj}/repos/{slug}/pull-requests?{q}", mark_down=False)
            return data.get("values") or []
        except Exception:
            return []

    found, seen_ids = [], set()
    with ThreadPoolExecutor(max_workers=min(8, len(combos))) as ex:
        for values in ex.map(list_prs, combos):
            for pr in values:
                title = (pr.get("title") or "").upper()
                src = ((pr.get("fromRef") or {}).get("displayId") or "").upper()
                if key_u in title or key_u in src or key_src in src:
                    pid = pr.get("id")
                    if pid not in seen_ids:
                        seen_ids.add(pid)
                        obj = pr_to_obj(pr, bb_proj)
                        if obj:
                            found.append(obj)
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


def code_for(key):
    """Branches + PRs for one ticket, or None when nothing could be looked up.

    Jira's dev-status index is authoritative and repo-agnostic, so it leads. The old
    Bitbucket key-scan stays on as a supplement for the handful of tickets in a daily
    run: it costs little here and covers the case where the Jira↔Bitbucket link is
    temporarily down."""
    dev = DEV.get(key)
    prs = list(dev["prs"]) if dev else []
    branches = list(dev["branches"]) if dev else []

    if BB_OK:
        try:
            seen = {p.get("id") for p in prs}
            for extra in bb_search_all_prs(key):
                if extra.get("id") not in seen:
                    seen.add(extra.get("id"))
                    prs.append(extra)
                    if extra.get("sourceBranch"):
                        branches.append(extra["sourceBranch"])
        except Exception:
            pass
    elif dev is None:
        return None

    if dev is None and not prs:
        return None

    branches = list(dict.fromkeys(b for b in branches if b))
    pr = pick_primary_pr(prs)
    return {
        "branches": branches,
        "prs": prs,
        "pr": pr,
        "branch": pr.get("sourceBranch") or (branches[0] if branches else None),
    }


def apply_code(ticket, key):
    """Overwrite a ticket's branch/PR fields from the live lookup; leave them untouched
    (carried forward from the previous dump) when the lookup could not be made."""
    info = code_for(key)
    if info is None:
        return ticket
    ticket["branches"] = info["branches"]
    ticket["prs"] = info["prs"]
    ticket["pr"] = info["pr"]
    ticket["branch"] = info["branch"]
    return ticket


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
        if (CONFLUENCE_HOST and CONFLUENCE_HOST in url) or "confluence" in url.lower():
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
    """Sub-task owned by someone else. Deliberately not a full brief (no comments/description),
    but it carries everything needed to judge the work from the board: who owns it, where it
    stands, and its real branches, pull requests and review state. A master ticket is usually
    delivered through other people's sub-tasks, and that review state is precisely what used
    to force a trip to Jira."""
    sf = si["fields"]
    sk = si["key"]
    col, hold = status_column(sf["status"]["name"])
    sp = sf.get("customfield_10402") or sf.get("customfield_57402")
    sub = {
        "key": sk,
        "title": sf.get("summary"),
        "status": sf["status"]["name"],
        "column": col,
        "type": sf["issuetype"]["name"],
        "priority": (sf.get("priority") or {}).get("name"),
        "storyPoints": int(sp) if sp is not None and sp == int(sp) else (float(sp) if sp else None),
        "url": f"{JIRA_BASE}/browse/{sk}",
        "assignee": person_fmt(sf.get("assignee")),
        "reporter": person_fmt(sf.get("reporter")),
        "parentKey": parent_key,
        "done": col == "done",
        "onHold": hold,
        "created": iso(sf.get("created")),
        "lastUpdate": iso(sf.get("updated")),
        "resolved": iso(sf.get("resolutiondate")) or (changelog_done_date(si.get("changelog")) if col == "done" else None),
        "sprint": parse_sprint(sf.get("customfield_10404")),
        "commentCount": (sf.get("comment") or {}).get("total"),
        "branch": None,
        "branches": [],
        "pr": {"state": "none"},
        "prs": [],
    }
    return apply_code(sub, sk)


def refresh_prs_only(ticket, key):
    """Review activity lives in Bitbucket and does NOT bump Jira's `updated` — so even an
    otherwise-unchanged in-flight ticket needs its PR badges refreshed."""
    return apply_code(ticket, key)


def build_ticket(issue, prior, state_entry, force_refresh=False):
    f = issue["fields"]
    key = issue["key"]
    status = f["status"]["name"]
    column, on_hold = status_column(status)
    itype = f["issuetype"]["name"]
    sp = f.get("customfield_10402") or f.get("customfield_57402")

    # ── Unchanged short-circuit — skips the expensive Jira side (comments, links, changelog).
    # Jira bumps `updated` on every edit/comment/transition, so matching (status, updated)
    # means the ticket text is identical to what we already have.
    # Code state is refreshed regardless of column: approving, declining or merging a PR
    # happens in Bitbucket and never touches Jira's `updated`, and a PR can still land after
    # the ticket itself is closed.
    prev = state_entry or {}
    if (
        prior and not force_refresh
        and prev.get("status") == status
        and prev.get("last_update") == iso(f.get("updated"))
    ):
        ticket = copy.deepcopy(prior)
        if ticket.get("resolved") and column != "done":
            ticket["resolved"] = None  # self-heal: a reopened ticket must not keep a resolved date
        return refresh_prs_only(ticket, key)

    inline = comments_from_issue(f)
    comments, comment_count, latest_comment = inline if inline is not None else fetch_comments(key)

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

    # Branches/PRs from Jira dev-status (+ Bitbucket supplement); carry forward on failure.
    info = code_for(key)
    if info is None:
        prs = copy.deepcopy((prior or {}).get("prs") or [])
        branches = copy.deepcopy((prior or {}).get("branches") or [])
        pr = (prior or {}).get("pr") or {"state": "none"}
        branch = (prior or {}).get("branch")
    else:
        prs, branches, pr, branch = info["prs"], info["branches"], info["pr"], info["branch"]

    update_log = build_update_log(
        key, f.get("created"), status, f.get("resolutiondate"), issue.get("changelog"), (prior or {}).get("updateLog")
    )

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
        "resolved": iso(f.get("resolutiondate")) or (changelog_done_date(issue.get("changelog")) if column == "done" else None),
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


def build_subtasks(parent_key, sub_issues, prior_map, state):
    """Sub-tasks from the single batched `parent in (…)` search — the issues already carry
    full FIELDS + changelog, so no per-subtask GETs. Mine → full brief; others → basic."""
    subs = []
    for si in sub_issues:
        sk = si["key"]
        assignee = si["fields"].get("assignee")
        if is_mine(assignee):
            full = build_ticket(si, prior_map.get(sk), state.get(sk))
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
    global BB_OK, DEV
    load_env()
    existing_path = os.path.join(INTERN, "data.json")
    state_path = os.path.join(INTERN, ".state.json")
    set_progress("daily", done=0, total=0, phase="starting")

    try:
        return _main(existing_path, state_path)
    finally:
        clear_progress()


def _main(existing_path, state_path):
    global BB_OK, DEV

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
    try:
        state = json.load(open(state_path)) if os.path.isfile(state_path) else {}
    except Exception:
        state = {}  # corrupt hidden memory just means "treat everything as changed" — never fatal

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
    # expand=changelog rides along with the search — updateLog and the resolved-date fallback
    # come from this single query instead of one extra GET per ticket.
    set_progress("daily", done=0, total=0, phase="searching")
    jql = "(assignee = currentUser() AND statusCategory != Done) OR (assignee = currentUser() AND statusCategory = Done AND resolved >= -10d)"
    issues = search_jira(jql + " ORDER BY updated DESC", expand="changelog")
    # Drop excluded projects (config.json → excludeProjects) so they never reach the board.
    if EXCLUDE_PROJECTS:
        issues = [i for i in issues if not is_excluded(i.get("key"))]
    active_keys, issue_map = [], {}
    for i in issues:
        if i["key"] not in issue_map:
            issue_map[i["key"]] = i
            active_keys.append(i["key"])

    total = len(active_keys)
    set_progress("daily", done=0, total=total, phase="subtasks")

    # ONE batched search for every parent's sub-tasks (instead of one search per ticket,
    # plus one GET per sub-task of mine). None ⇒ the search itself failed (≠ "no subtasks"),
    # so existing subtask lists are carried forward rather than wiped.
    subs_by_parent = {}
    if active_keys:
        try:
            sub_issues = search_jira(
                "parent in (" + ",".join(active_keys) + ") ORDER BY key ASC", expand="changelog"
            )
            for si in sub_issues:
                pk = (si["fields"].get("parent") or {}).get("key")
                if pk:
                    subs_by_parent.setdefault(pk, []).append(si)
        except Exception:
            subs_by_parent = None

    # One parallel dev-status batch covering parents AND every sub-task, before any ticket is
    # built. Sub-tasks are included unconditionally: their PRs are the whole point of showing
    # a master ticket's children here.
    set_progress("daily", done=0, total=total, phase="devinfo")
    dev_keys = list(active_keys)
    for subs in (subs_by_parent or {}).values():
        dev_keys.extend(si["key"] for si in subs)
    try:
        DEV = devinfo.fetch_many(list(dict.fromkeys(dev_keys)), workers=10)
    except Exception:
        DEV = {}

    changes = {"new": [], "refreshed": [], "done": []}
    tickets = []
    new_state = {}

    for i, key in enumerate(active_keys, start=1):
        set_progress("daily", done=i - 1, total=total, phase="building", current=key)
        prior = prior_map.get(key)
        prev_state = state.get(key, {})
        issue = issue_map[key]
        force = key not in state or not prior
        ticket = build_ticket(issue, prior, prev_state, force_refresh=force)

        # subtasks
        if subs_by_parent is not None:
            subs = build_subtasks(key, subs_by_parent.get(key, []), prior_map, state)
            if subs:
                ticket["subtasks"] = subs
                ticket["subtaskCount"] = len(subs)
            else:
                ticket.pop("subtasks", None)
                ticket["subtaskCount"] = 0

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
            changes["refreshed"].append(f"{key}: {', '.join(parts) if parts else 'updated'}")

        tickets.append(ticket)
        new_state[key] = ticket_to_state(ticket)
        set_progress("daily", done=i, total=total, phase="building", current=key)

    set_progress("daily", done=total, total=total, phase="writing")
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

    # Keep _STATUS.md the audit log for script-driven runs too (the agent used to own this).
    changed = len(changes["new"]) + len(changes["refreshed"]) + len(changes["done"])
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    summary = (
        f"new {len(changes['new'])} · refreshed {len(changes['refreshed'])} · done {len(changes['done'])}"
        if changed else "no new or changed tickets"
    )
    prepend_status(
        f"{day}: Daily fetch (fast path) — {len(tickets)} active ({summary}); "
        f"completed[] {len(completed_preserved)} preserved unchanged."
        + ("" if BB_OK else " Bitbucket unreachable — PR data carried forward.")
    )
    set_progress("daily", done=total, total=total, phase="done")
    return out, changes, notes


def prepend_status(note):
    p = os.path.join(INTERN, "_STATUS.md")
    old = open(p, encoding="utf-8").read() if os.path.isfile(p) else ""
    atomic_write(p, f"{note}\n\n{old}")


def fetch_issue(key):
    """One issue with the same FIELDS + changelog the daily search returns."""
    q = urllib.parse.urlencode({"expand": "changelog", "fields": FIELDS})
    return jira_get(f"/rest/api/2/issue/{urllib.parse.quote(key)}?{q}")


def _find_prior(data, key):
    """Locate an existing ticket object by key in tickets[] / nested subtasks / completed[]."""
    for t in data.get("tickets") or []:
        if t.get("key") == key:
            return t, "tickets"
        for s in t.get("subtasks") or []:
            if s.get("key") == key:
                return s, "subtask"
    for t in data.get("completed") or []:
        if t.get("key") == key:
            return t, "completed"
        for s in t.get("subtasks") or []:
            if s.get("key") == key:
                return s, "subtask"
    return None, None


def _merge_ticket(data, ticket, prior_where):
    """Replace the matching entry in place, or append when the key is new to the dump."""
    key = ticket["key"]
    if prior_where == "tickets":
        for i, t in enumerate(data["tickets"]):
            if t.get("key") == key:
                data["tickets"][i] = ticket
                return "tickets"
    if prior_where == "subtask":
        for t in data.get("tickets") or []:
            subs = t.get("subtasks") or []
            for j, s in enumerate(subs):
                if s.get("key") == key:
                    subs[j] = ticket
                    t["subtasks"] = subs
                    return "subtask"
        for t in data.get("completed") or []:
            subs = t.get("subtasks") or []
            for j, s in enumerate(subs):
                if s.get("key") == key:
                    subs[j] = ticket
                    t["subtasks"] = subs
                    return "subtask"
    if prior_where == "completed":
        for i, t in enumerate(data.get("completed") or []):
            if t.get("key") == key:
                data["completed"][i] = ticket
                return "completed"
    # New to the dump — active board first; done tickets still land in tickets[] so the
    # "recent win" column can show them (same as the daily fetch window).
    data.setdefault("tickets", []).append(ticket)
    return "tickets-new"


def refresh_one(key):
    """Re-fetch ONE ticket from Jira and merge it into data.json / data.js.

    Used by refresh-ticket.sh so Docker (no cursor-agent) can still update a single card.
    Always force-rebuilds the ticket body — the user clicked refresh because they expect
    the latest status even when our .state.json short-circuit would skip work.
    """
    global BB_OK, DEV
    load_env()
    key = (key or "").strip()
    if not key:
        raise SystemExit("refresh_one: missing key")
    if is_excluded(key):
        raise SystemExit(f"refresh_one: {key} is in excludeProjects — refused")
    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        raise SystemExit("refresh_one: JIRA_PERSONAL_TOKEN missing")

    existing_path = os.path.join(INTERN, "data.json")
    state_path = os.path.join(INTERN, ".state.json")
    data = json.load(open(existing_path)) if os.path.isfile(existing_path) else {"tickets": [], "completed": []}
    try:
        state = json.load(open(state_path)) if os.path.isfile(state_path) else {}
    except Exception:
        state = {}

    prior, prior_where = _find_prior(data, key)
    prior_map = {t["key"]: t for t in data.get("tickets") or []}
    if prior and prior_where == "subtask":
        prior_map[key] = prior

    # Skip Bitbucket entirely for single-ticket refresh. A hung BB from Docker was
    # timing out the shell (and before that, making the agent-only path look "successful"
    # while never writing). Status/column come from Jira; PR badges from Jira's own
    # dev-status (enrich_open=False). Setting BB_OK=False also stops code_for()'s
    # Bitbucket key-scan supplement.
    BB_OK = False

    issue = fetch_issue(key)
    # Sub-tasks of this parent (if any) — same batch shape as the daily path.
    subs_by_parent = {}
    try:
        sub_issues = search_jira(f"parent = {key} ORDER BY key ASC", expand="changelog")
        if sub_issues:
            subs_by_parent[key] = sub_issues
    except Exception:
        subs_by_parent = None

    dev_keys = [key]
    for si in (subs_by_parent or {}).get(key, []):
        dev_keys.append(si["key"])
    try:
        # enrich_open=False: skip Bitbucket activity pages (30s timeouts each). Jira
        # dev-status still supplies branches/PRs/approvals — enough for the card badge.
        DEV = devinfo.fetch_many(list(dict.fromkeys(dev_keys)), workers=6, enrich_open=False)
    except Exception:
        DEV = {}

    ticket = build_ticket(issue, prior, state.get(key, {}), force_refresh=True)

    if subs_by_parent is not None:
        subs = build_subtasks(key, subs_by_parent.get(key, []), prior_map, state)
        if subs:
            ticket["subtasks"] = subs
            ticket["subtaskCount"] = len(subs)
        else:
            ticket.pop("subtasks", None)
            ticket["subtaskCount"] = 0
    elif prior and prior.get("subtasks"):
        # Search failed — keep the previous tree rather than wiping children.
        ticket["subtasks"] = copy.deepcopy(prior["subtasks"])
        ticket["subtaskCount"] = prior.get("subtaskCount") or len(ticket["subtasks"])

    # Parent link when refreshing a sub-task in isolation.
    parent = (issue.get("fields") or {}).get("parent")
    if parent and parent.get("key") and not ticket.get("parentKey"):
        ticket["parentKey"] = parent["key"]

    where = _merge_ticket(data, ticket, prior_where)
    data["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Touch notes so the dump is visibly fresh even when fields look identical.
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    note = f"{day}: Refreshed {key} (status={ticket.get('status')}, column={ticket.get('column')})."
    notes = list(data.get("notes") or [])
    notes = [note] + [n for n in notes if not (isinstance(n, str) and n.startswith(f"{day}: Refreshed {key}"))]
    data["notes"] = notes[:12]

    write_outputs(data)
    state[key] = ticket_to_state(ticket)
    for s in ticket.get("subtasks") or []:
        if s.get("key"):
            state[s["key"]] = ticket_to_state(s)
    atomic_dump(state_path, state)

    # Optional per-ticket cache (same path the agent refresh wrote).
    cache_dir = os.path.join(INTERN, "cache")
    os.makedirs(cache_dir, exist_ok=True)
    atomic_dump(os.path.join(cache_dir, f"{key}.json"), ticket)

    prepend_status(f"{day}: Single-ticket refresh {key} → {ticket.get('status')} ({where}).")
    return data, ticket, where


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Daily jira-intern fetch (or --key for one ticket)")
    ap.add_argument("--key", help="Refresh a single ticket and merge into data.json")
    args = ap.parse_args()

    t0 = time.monotonic()
    try:
        if args.key:
            out, ticket, where = refresh_one(args.key)
            print(json.dumps({
                "mode": "refresh_one",
                "key": ticket.get("key"),
                "status": ticket.get("status"),
                "column": ticket.get("column"),
                "where": where,
                "generatedAt": out["generatedAt"],
                "durationSec": round(time.monotonic() - t0, 1),
                "bb_ok": BB_OK,
            }, indent=2))
        else:
            out, changes, notes = main()
            changed_count = sum(len(v) for v in changes.values() if isinstance(v, list))
            print(json.dumps({
                "generatedAt": out["generatedAt"],
                "durationSec": round(time.monotonic() - t0, 1),
                "tickets": len(out["tickets"]),
                "completed": len(out["completed"]),
                "keys": [t["key"] for t in out["tickets"]],
                "changes": changes,
                "changedCount": changed_count,
                "notes": notes,
                "bb_ok": BB_OK,
            }, indent=2))
    except urllib.error.URLError as e:
        # DNS / VPN / offline — keep prior data; no multi-page traceback in docker logs.
        print(json.dumps({
            "error": "jira unreachable",
            "detail": str(getattr(e, "reason", e)),
            "durationSec": round(time.monotonic() - t0, 1),
        }, indent=2))
        sys.exit(1)
