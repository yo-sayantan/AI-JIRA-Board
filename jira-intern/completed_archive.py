#!/usr/bin/env python3
"""Completed-archive intern — refresh cache + merge completed[] only into data.json.

Scope. Only work I was actually part of:
  1. Every issue ever assigned to me (standalone tickets AND my sub-tickets).
  2. The PARENT of each of my sub-tickets — pulled in purely for lineage/context, even when
     the parent belongs to someone else. Marked `mine: false`.
We deliberately do NOT fetch the parent's OTHER children. A sibling sub-ticket a team-mate
delivered, that I never touched, is not my work — fetching it wasted Jira/Bitbucket calls and
buried my own tickets in team noise. `mine` still distinguishes my tickets from the context
parents so the UI can tint the latter.

Branches, pull requests and review state come from Jira's dev-status index via devinfo.py —
see that module for why repo-guessing was removed.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
import ssl
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import devinfo  # noqa: E402  (needs the path fix above when run from another cwd)
from _config import endpoints, load_config  # noqa: E402
from datafile import atomic_write, write_outputs  # noqa: E402
from progress import clear_progress, set_progress  # noqa: E402

INTERN = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(INTERN, "cache")
DATA_JSON = os.path.join(INTERN, "data.json")
STATUS_MD = os.path.join(INTERN, "_STATUS.md")
JIRA_BASE, _CONFLUENCE_BASE, BITBUCKET_BASE = endpoints(INTERN)
# Identity is resolved server-side via JQL currentUser(); the `mine` flag is set from
# membership in that search's result set, not by comparing account ids here.

# Bump when the cached ticket shape changes so old entries are refetched exactly once.
# 2: branches/PRs come from Jira dev-status (repo + reviewers + real URLs).
# 3: a master's subtasks[] now nests ONLY my sub-tickets, never team-mates'.
# 4: `mine` = ever-assigned-to-me (membership in the mine-search), not the current assignee,
#    so work I finished and handed off stays mine instead of flipping to a context parent.
SCHEMA = 4


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


FIELDS = (
    "summary,status,issuetype,priority,updated,created,resolutiondate,assignee,reporter,"
    "labels,components,fixVersions,description,comment,issuelinks,parent,subtasks,"
    "customfield_10402,customfield_57402,customfield_10404,customfield_10405,customfield_10700"
)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

MAX_FETCH = int(os.environ.get("COMPLETED_MAX_FETCH", "999"))
WORKERS = int(os.environ.get("COMPLETED_WORKERS", "6"))
# How many freshly built tickets to accumulate before flushing data.json. A deep rebuild
# takes minutes; flushing as we go means an interrupted run still leaves the board better
# off than it started, instead of throwing everything away.
FLUSH_EVERY = 10


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
            delay = min(30, 2 ** attempt) if _is_transient_net(e) else (1 + attempt)
            time.sleep(delay)
    raise last


def jira_get(path):
    return _get_json(
        JIRA_BASE + path,
        {"Authorization": f"Bearer {os.environ['JIRA_PERSONAL_TOKEN']}", "Accept": "application/json"},
        timeout=120,
    )


def iso(s):
    if not s:
        return None
    if isinstance(s, str):
        return s.replace("+0000", "Z").replace(".000+0000", "Z").replace(".000Z", "Z")
    return None


def status_column(name):
    """Map a raw Jira status name onto a board column. See daily_fetch.status_column."""
    n = (name or "").lower().strip()
    for keys, col in [
        (("to do", "open", "backlog", "reopened", "selected for development"), "todo"),
        (("in progress", "dev in progress", "work in progress", "in development"), "prog"),
        (("in review", "code review", "ready4review", "ready for review", "review"), "rev"),
        (("qa", "in qa", "under qa", "ready for qa", "ready4qa", "awaiting qa",
          "testing", "in test", "in testing", "verification", "verify"), "qa"),
        (("done", "completed", "closed", "resolved", "released"), "done"),
        (("on hold", "hold", "blocked", "waiting", "parked", "impeded"), "hold"),
    ]:
        if n in keys:
            return col
    tokens = set(re.findall(r"[a-z0-9]+", n))
    if "qa" in tokens or "testing" in tokens or "verification" in tokens:
        return "qa"
    if "review" in tokens:
        return "rev"
    return "prog"


def is_done(issue):
    f = issue.get("fields") or {}
    cat = ((f.get("status") or {}).get("statusCategory") or {}).get("key")
    if cat:
        return cat == "done"
    return status_column((f.get("status") or {}).get("name")) == "done"


def changelog_done_date(changelog):
    """Fallback for resolved: Jira stamps resolutiondate only when the Resolution field is
    set, so a workflow transition straight to Done can leave it null. Use the newest
    changelog transition into a done-column status instead."""
    dates = [
        h.get("created")
        for h in (changelog or {}).get("histories") or []
        for it in h.get("items") or []
        if it.get("field") == "status" and status_column(it.get("toString")) == "done" and h.get("created")
    ]
    return iso(max(dates)) if dates else None


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


def search_jira(jql, fields=FIELDS, expand=None):
    all_issues, start = [], 0
    while True:
        params = {"jql": jql, "startAt": start, "maxResults": 100, "fields": fields}
        if expand:
            params["expand"] = expand
        try:
            data = jira_get("/rest/api/2/search?" + urllib.parse.urlencode(params))
        except urllib.error.HTTPError as e:
            if "statusCategory" in jql and e.code == 400:
                return search_jira(jql.replace("statusCategory = Done", "status in (Done, Closed, Resolved)"), fields, expand)
            raise
        batch = data.get("issues", [])
        all_issues.extend(batch)
        if not batch:  # permission-filtered results can leave total > returned — never spin
            break
        start += len(batch)
        if start >= data.get("total", 0):
            break
    return all_issues


def search_keys(keys, expand=None):
    """Batched `key in (...)` lookup — one request per 100 keys instead of one per key."""
    out = []
    keys = [k for k in keys if k]
    for i in range(0, len(keys), 100):
        out.extend(search_jira("key in (" + ",".join(keys[i : i + 100]) + ")", expand=expand))
    return out


def comments_from_issue(f):
    """Comments straight off the search payload when complete; None when Jira truncated."""
    c = f.get("comment") or {}
    listed = c.get("comments") or []
    total = c.get("total", len(listed))
    if total > len(listed):
        return None
    ordered = sorted(listed, key=lambda x: x.get("created", ""), reverse=True)
    out = []
    for x in ordered:
        body = x.get("renderedBody") or wiki_to_html(x.get("body", "")) or f"<p>{escape(x.get('body',''))}</p>"
        out.append({
            "author": (x.get("author") or {}).get("displayName"),
            "when": iso(x.get("created")),
            "body": light_html(body) or body,
        })
    return out, len(ordered), (iso(ordered[0]["created"]) if ordered else None)


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
        body = c.get("renderedBody") or wiki_to_html(c.get("body", "")) or f"<p>{escape(c.get('body',''))}</p>"
        out.append({
            "author": (c.get("author") or {}).get("displayName"),
            "when": iso(c.get("created")),
            "body": light_html(body) or body,
        })
    return out, len(comments), (iso(comments[0]["created"]) if comments else None)


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
                related.append({
                    "key": o["key"], "url": f"{JIRA_BASE}/browse/{o['key']}",
                    "summary": o["fields"]["summary"], "status": o["fields"]["status"]["name"],
                    "relation": link.get("type", {}).get(rel_key, "relates"),
                })
    return related


def build_update_log(created, changelog):
    """Status lifecycle from the changelog that rode along with the search — newest first."""
    opened = iso(created)
    events = []
    for h in sorted((changelog or {}).get("histories") or [], key=lambda x: x.get("created", "")):
        when = iso(h.get("created"))
        for item in h.get("items") or []:
            if item.get("field") == "status" and item.get("toString"):
                events.append({"when": when, "text": item["toString"]})
    deduped, prev = [], None
    for e in reversed(events):
        if e["text"] == prev:
            continue
        deduped.append(e)
        prev = e["text"]
    if not deduped or deduped[-1]["text"] != "Opened":
        deduped.append({"when": opened, "text": "Opened"})
    return deduped


def cache_is_stale(ticket):
    return (ticket or {}).get("schema", 0) < SCHEMA


def dev_fields(key, dev_map, prior):
    """Branch/PR block for a ticket. A key missing from dev_map means the lookup failed —
    keep whatever the cache already had rather than blanking real review history."""
    info = dev_map.get(key)
    if info is None:
        return {
            "branch": (prior or {}).get("branch"),
            "branches": (prior or {}).get("branches") or [],
            "pr": (prior or {}).get("pr") or {"state": "none"},
            "prs": (prior or {}).get("prs") or [],
        }
    return {"branch": info["branch"], "branches": info["branches"], "pr": info["pr"], "prs": info["prs"]}


def build_subtask(si, parent_key, dev_map, pr_overrides, mine=True):
    """Compact child row shown under its parent. Carries owner + review state so a master
    ticket's delivery is readable without opening Jira. Only my sub-tickets are ever nested,
    so `mine` defaults True."""
    sf = si["fields"]
    sk = si["key"]
    col = status_column(sf["status"]["name"])
    sub = {
        "key": sk,
        "title": sf.get("summary"),
        "status": sf["status"]["name"],
        "column": col,
        "type": sf["issuetype"]["name"],
        "priority": (sf.get("priority") or {}).get("name"),
        "parentKey": parent_key,
        "url": f"{JIRA_BASE}/browse/{sk}",
        "assignee": person_fmt(sf.get("assignee")),
        "mine": mine,
        "done": col == "done",
        "onHold": col == "hold",
        "created": iso(sf.get("created")),
        "resolved": iso(sf.get("resolutiondate")) or (changelog_done_date(si.get("changelog")) if col == "done" else None),
    }
    sub.update(dev_fields(sk, dev_map, None))
    if pr_overrides.get(sk) and sub["pr"].get("state") == "none":
        sub["pr"] = pr_overrides[sk]
    return sub


def build_completed(issue, prior, dev_map, children, pr_overrides, mine):
    """`mine` = was this ever assigned to me (membership in the mine-search set), NOT the
    current assignee — a ticket I finished and handed off is still my work. Only pure context
    parents (pulled in solely because I own a sub-ticket under them) are mine=False."""
    f = issue["fields"]
    key = issue["key"]
    status = f["status"]["name"]
    column = status_column(status)
    sp = f.get("customfield_10402") or f.get("customfield_57402")

    # Full comment history is worth an extra request for my own tickets; for a context parent
    # the inline page that came free with the search is plenty.
    inline = comments_from_issue(f)
    if inline is not None:
        comments, comment_count, latest_comment = inline
    elif mine:
        comments, comment_count, latest_comment = fetch_comments(key)
    else:
        comments, comment_count, latest_comment = [], (f.get("comment") or {}).get("total", 0), None

    parent = f.get("parent") or {}
    parent_key = parent.get("key")
    parent_title = (parent.get("fields") or {}).get("summary")
    epic_key = f.get("customfield_10405")
    if epic_key:
        epic = {"key": epic_key, "url": f"{JIRA_BASE}/browse/{epic_key}", "relation": "epic (parent)"}
    elif parent_key:
        epic = {"key": parent_key, "url": f"{JIRA_BASE}/browse/{parent_key}", "relation": "parent"}
    else:
        epic = (prior or {}).get("epic")

    # Nested children are drawn only from my own sub-tickets, so they are all mine.
    subtasks = [build_subtask(si, key, dev_map, pr_overrides, mine=True) for si in children]
    subtasks.sort(key=lambda s: s["key"])

    ticket = {
        "schema": SCHEMA,
        "key": key,
        "title": f.get("summary"),
        "status": status,
        "column": column,
        "type": f["issuetype"]["name"],
        "priority": (f.get("priority") or {}).get("name"),
        "storyPoints": int(sp) if sp is not None and sp == int(sp) else (float(sp) if sp else None),
        "commentCount": comment_count,
        "latestComment": latest_comment,
        "lastUpdate": iso(f.get("updated")),
        "created": iso(f.get("created")),
        "resolved": iso(f.get("resolutiondate")) or changelog_done_date(issue.get("changelog")),
        "done": column == "done",
        "onHold": column == "hold",
        "mine": mine,
        "url": f"{JIRA_BASE}/browse/{key}",
        "sprint": parse_sprint(f.get("customfield_10404")),
        "reporter": person_fmt(f.get("reporter")),
        "assignee": person_fmt(f.get("assignee")),
        "epic": epic,
        "parentKey": parent_key,
        "parentTitle": parent_title,
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
        "updateLog": build_update_log(f.get("created"), issue.get("changelog")),
        "subtasks": subtasks,
        "subtaskCount": len(subtasks),
    }
    ticket.update(dev_fields(key, dev_map, prior))
    if pr_overrides.get(key) and ticket["pr"].get("state") == "none":
        ticket["pr"] = pr_overrides[key]
    return ticket


COMPLETED_KEYS = (
    "key", "title", "type", "priority", "status", "created", "resolved", "storyPoints",
    "branch", "branches", "pr", "prs", "url", "lastUpdate", "sprint", "reporter", "assignee",
    "epic", "parentKey", "parentTitle", "mine", "labels", "components", "fixVersions",
    "description", "acceptanceCriteria", "comments", "commentCount", "related", "confluence",
    "externalLinks", "proposedSolution", "effortEstimate", "openQuestions", "sources",
    "updateLog", "subtasks", "subtaskCount",
)


def completed_entry(t):
    c = {k: t[k] for k in COMPLETED_KEYS if k in t}
    c["project"] = t["key"].split("-")[0]
    c["column"] = "done"
    c["done"] = True
    return c


def assemble(keys):
    """Archive rows for every key that has a cache file, newest first."""
    rows = []
    for key in keys:
        path = os.path.join(CACHE, f"{key}.json")
        if not os.path.isfile(path):
            continue
        try:
            rows.append(completed_entry(json.load(open(path))))
        except Exception as e:
            sys.stderr.write(f"WARN cache read {key}: {e}\n")
    rows.sort(key=lambda r: (r.get("resolved") or "", r["key"]), reverse=True)
    return rows


def merge_completed_only(completed_list):
    """Replace completed[] and nothing else — tickets[] belongs to the daily fetch."""
    data = json.loads(open(DATA_JSON, "r", encoding="utf-8").read())
    data["completed"] = completed_list
    write_outputs(data)


def prepend_status(note):
    existing = open(STATUS_MD, "r", encoding="utf-8").read() if os.path.isfile(STATUS_MD) else ""
    atomic_write(STATUS_MD, note + "\n\n" + existing)


def main():
    load_env()
    os.makedirs(CACHE, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    set_progress("archive", done=0, total=0, phase="starting")

    try:
        return _main(ts)
    finally:
        clear_progress()


def _main(ts):
    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        prepend_status(f"**{ts}** — Jira unavailable (no token). Left data.json + cache unchanged.")
        print(json.dumps({"error": "no jira token", "stopped": True}))
        return 1
    if not os.path.isfile(DATA_JSON):
        print(json.dumps({"error": "data.json missing"}))
        return 1

    pr_overrides_path = os.path.join(INTERN, ".pr_overrides.json")
    pr_overrides = json.load(open(pr_overrides_path)) if os.path.isfile(pr_overrides_path) else {}

    # ── 1. Everything ever assigned to me — standalone tickets AND my sub-tickets.
    # `was` catches work reassigned away from me after I finished it.
    set_progress("archive", done=0, total=0, phase="searching")
    mine = search_jira(
        "(assignee was currentUser() OR assignee = currentUser()) ORDER BY resolved DESC",
        expand="changelog",
    )
    # Drop excluded projects (config.json → excludeProjects) up front, so their context parents
    # are never pulled in and they never reach completed[].
    if EXCLUDE_PROJECTS:
        mine = [i for i in mine if not is_excluded(i["key"])]
    issues = {i["key"]: i for i in mine}
    mine_keys = set(issues)  # capture BEFORE adding context parents
    parent_keys = {(i["fields"].get("parent") or {}).get("key") for i in mine}
    parent_keys.discard(None)

    # ── 2. Pull in the PARENT of each of my sub-tickets, for lineage/context only — even when
    # it belongs to someone else. We do NOT fetch its other children: a team-mate's sibling
    # sub-ticket I never touched is not my work to track (see the module docstring).
    set_progress("archive", done=0, total=0, phase="parents")
    for issue in search_keys(sorted(parent_keys), expand="changelog"):
        issues.setdefault(issue["key"], issue)

    # ── 3. Nest ONLY my own sub-tickets under their parent (they are already in `mine`).
    children_by_parent = {}
    for key in mine_keys:
        pk = (issues[key]["fields"].get("parent") or {}).get("key")
        if pk:
            children_by_parent.setdefault(pk, []).append(issues[key])

    # ── 4. Only closed work belongs in the archive (and never an excluded project).
    done_keys = [k for k, i in issues.items() if is_done(i) and not is_excluded(k)]
    done_keys.sort(key=lambda k: issues[k]["fields"].get("resolutiondate") or "", reverse=True)

    # ── 5. Which of those actually need rebuilding.
    priors, stale = {}, []
    for key in done_keys:
        path = os.path.join(CACHE, f"{key}.json")
        prior = None
        if os.path.isfile(path):
            try:
                prior = json.load(open(path))
            except Exception:
                prior = None
        priors[key] = prior
        if prior is None or cache_is_stale(prior):
            stale.append(key)
    stale = stale[:MAX_FETCH]

    # Progress denominator: tickets that actually need work this run. If the cache is warm,
    # fall back to the full archive size so the button still fills through assemble/write.
    work_keys = stale if stale else done_keys
    total = len(work_keys) or 1

    # ── 6. One parallel dev-status batch for the stale tickets AND their children, so no
    # ticket build has to make its own branch/PR calls. (Children are my own sub-tickets, so
    # they are usually already in `stale` — this just guarantees a nested row has its PRs.)
    set_progress("archive", done=0, total=total, phase="devinfo")
    dev_targets = set(stale)
    for key in stale:
        dev_targets.update(c["key"] for c in children_by_parent.get(key, []))
    dev_map = devinfo.fetch_many(sorted(dev_targets), workers=WORKERS) if dev_targets else {}

    newly_cached, failed = [], []
    pending = 0

    def build(key):
        try:
            ticket = build_completed(
                issues[key], priors.get(key), dev_map, children_by_parent.get(key, []),
                pr_overrides, key in mine_keys,
            )
            atomic_write(os.path.join(CACHE, f"{key}.json"), json.dumps(ticket, indent=2))
            return key, None
        except Exception as e:
            return key, e

    if stale:
        set_progress("archive", done=0, total=total, phase="building")
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for key, err in ex.map(build, stale):
                if err is not None:
                    sys.stderr.write(f"WARN build {key}: {err}\n")
                    failed.append(key)
                else:
                    newly_cached.append(key)
                    pending += 1
                    if pending >= FLUSH_EVERY:
                        merge_completed_only(assemble(done_keys))
                        pending = 0
                done_n = len(newly_cached) + len(failed)
                set_progress("archive", done=done_n, total=total, phase="building", current=key)
    else:
        # Warm cache — still walk the list so the button fills while we assemble.
        set_progress("archive", done=0, total=total, phase="assembling")
        for i, key in enumerate(done_keys, start=1):
            set_progress("archive", done=i, total=total, phase="assembling", current=key)

    set_progress("archive", done=total, total=total, phase="writing")
    completed = assemble(done_keys)
    merge_completed_only(completed)

    mine_count = sum(1 for r in completed if r.get("mine"))
    context_count = len(completed) - mine_count
    sub_count = sum(1 for r in completed if r.get("parentKey"))
    note = (
        f"**{ts}** — Completed-archive intern: **{len(completed)}** rows "
        f"({mine_count} mine + {context_count} parent tickets I have a sub-ticket under; "
        f"{sub_count} of the rows are sub-tickets). {len(newly_cached)} rebuilt this run, "
        f"{len(done_keys) - len(stale)} reused, {len(failed)} failed. "
        f"Jira dev-status; merged completed[] only — tickets[] untouched."
    )
    prepend_status(note)
    set_progress("archive", done=total, total=total, phase="done")
    print(json.dumps({
        "completed_in_archive": len(completed),
        "mine": mine_count,
        "context_parents": context_count,
        "subtasks": sub_count,
        "with_prs": sum(1 for r in completed if r.get("prs")),
        "universe_scanned": len(issues),
        "rebuilt_this_run": len(newly_cached),
        "reused_cache": len(done_keys) - len(stale),
        "failed": failed[:10],
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except urllib.error.URLError as e:
        print(json.dumps({
            "error": "jira unreachable",
            "detail": str(getattr(e, "reason", e)),
        }, indent=2))
        sys.exit(1)
