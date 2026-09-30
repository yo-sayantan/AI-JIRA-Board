"""Jira / Bitbucket REST access and field formatting shared by the fetch scripts.

daily_fetch.py (active board), completed_archive.py (history) and devinfo.py (branches/PRs)
all read the same Jira fields and render them the same way, so that logic lives here once.
"""
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html import escape

from _config import endpoints, load_config, load_secrets

INTERN = os.path.dirname(os.path.abspath(__file__))
JIRA_BASE, CONFLUENCE_BASE, BITBUCKET_BASE = endpoints(INTERN)
BB_BASE = f"{BITBUCKET_BASE}/rest/api/1.0" if BITBUCKET_BASE else ""

FIELDS = (
    "summary,status,issuetype,priority,updated,created,resolutiondate,assignee,reporter,"
    "labels,components,fixVersions,description,comment,issuelinks,parent,subtasks,"
    "customfield_10402,customfield_57402,customfield_10404,customfield_10405,customfield_10700"
)

# On-prem Jira and Bitbucket sit behind a private CA the container does not trust.
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def config_int(path_keys, default):
    try:
        node = load_config(INTERN)
        for k in path_keys:
            node = node[k]
        return int(node)
    except Exception:
        return default


REQUIRED_APPROVALS = config_int(("app", "requiredApprovals"), 2)


def _excluded_projects():
    try:
        raw = load_config(INTERN).get("excludeProjects") or []
    except Exception:
        return set()
    return {str(p).strip().upper() for p in raw if str(p).strip()}


EXCLUDE_PROJECTS = _excluded_projects()


def is_excluded(key):
    """True when a key belongs to a project in config.json → excludeProjects."""
    return bool(key) and key.split("-")[0].upper() in EXCLUDE_PROJECTS


def load_env():
    for key, value in load_secrets(INTERN).items():
        os.environ.setdefault(key, value)


# ── HTTP ─────────────────────────────────────────────────────────────────────


def _is_transient_net(exc):
    """DNS blips, timeouts and 5xx are worth retrying; 4xx is not."""
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500
    if isinstance(exc, urllib.error.URLError):
        return True
    return isinstance(exc, (TimeoutError, ConnectionError, OSError))


def get_json(url, headers, timeout, retries=4):
    """GET with backoff — Docker DNS and corporate VPN flaps are common here."""
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:
            last = e
            if attempt >= retries:
                break
            time.sleep(min(30, 2 ** attempt) if _is_transient_net(e) else 1 + attempt)
    raise last


def jira_get(path, timeout=120):
    return get_json(
        JIRA_BASE + path,
        {"Authorization": f"Bearer {os.environ['JIRA_PERSONAL_TOKEN']}", "Accept": "application/json"},
        timeout=timeout,
    )


def bb_get(path, timeout=45):
    tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN", "")
    return get_json(BB_BASE + path, {"Authorization": f"Bearer {tok}", "Accept": "application/json"}, timeout=timeout, retries=1)


def search_jira(jql, fields=FIELDS, expand=None):
    issues, start = [], 0
    while True:
        params = {"jql": jql, "startAt": start, "maxResults": 100, "fields": fields}
        if expand:
            params["expand"] = expand
        try:
            data = jira_get("/rest/api/2/search?" + urllib.parse.urlencode(params))
        except urllib.error.HTTPError as e:
            # Older Jira builds reject statusCategory in JQL.
            if "statusCategory = Done" in jql and e.code == 400:
                return search_jira(jql.replace("statusCategory = Done", "status in (Done, Closed, Resolved)"), fields, expand)
            raise
        batch = data.get("issues", [])
        issues.extend(batch)
        # Permission-filtered results can leave total > returned — never spin.
        if not batch:
            break
        start += len(batch)
        if start >= data.get("total", 0):
            break
    return issues


def search_keys(keys, expand=None):
    """Batched `key in (...)` lookup — one request per 100 keys."""
    keys = [k for k in keys if k]
    out = []
    for i in range(0, len(keys), 100):
        out.extend(search_jira("key in (" + ",".join(keys[i : i + 100]) + ")", expand=expand))
    return out


# ── Field formatting ─────────────────────────────────────────────────────────


def iso(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        ts = value / 1000 if value > 1e12 else value
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Staleness checks compare these as strings, so every timestamp must share one shape:
    # UTC, second precision, trailing Z — whatever offset or milliseconds Jira sent.
    s = str(value).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(s, fmt).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    return s


_STATUS_COLUMNS = (
    (("to do", "open", "backlog", "reopened", "selected for development"), "todo"),
    (("in progress", "dev in progress", "work in progress", "in development"), "prog"),
    (("in review", "code review", "ready4review", "ready for review", "review"), "rev"),
    (("qa", "in qa", "under qa", "ready for qa", "ready4qa", "awaiting qa",
      "testing", "in test", "in testing", "verification", "verify"), "qa"),
    (("done", "completed", "closed", "resolved", "released"), "done"),
    (("on hold", "hold", "blocked", "waiting", "parked", "impeded"), "hold"),
)


def status_column(name):
    """Board column for a raw Jira status: exact aliases, then a whole-word fallback so
    variants like "Moved to QA" land in QA. Unknown statuses count as in-flight work."""
    n = (name or "").lower().strip()
    for aliases, col in _STATUS_COLUMNS:
        if n in aliases:
            return col
    tokens = set(re.findall(r"[a-z0-9]+", n))
    if tokens & {"qa", "testing", "verification"}:
        return "qa"
    if "review" in tokens:
        return "rev"
    return "prog"


def changelog_done_date(changelog):
    """Jira stamps resolutiondate only when Resolution is set, so a transition straight to
    Done can leave it null. Use the newest changelog transition into a done status instead."""
    dates = [
        h.get("created")
        for h in (changelog or {}).get("histories") or []
        for it in h.get("items") or []
        if it.get("field") == "status" and status_column(it.get("toString")) == "done" and h.get("created")
    ]
    return iso(max(dates)) if dates else None


_LIGHT_TAGS = {"p", "b", "ul", "li", "code", "a", "i", "h3"}


def light_html(html):
    if not html:
        return None
    if "<" not in html:
        return f"<p>{escape(html)}</p>"
    html = re.sub(
        r"<(/?)([\w]+)[^>]*>",
        lambda m: f"<{m.group(1)}{m.group(2).lower()}>" if m.group(2).lower() in _LIGHT_TAGS else "",
        html,
    )
    html = re.sub(r'<a[^>]*href=["\']([^"\']+)["\'][^>]*>', r'<a href="\1">', html, flags=re.I)
    return html.strip() or None


def wiki_to_html(text):
    if not text:
        return None
    if text.strip().startswith("<"):
        return light_html(text)
    out, in_ul = [], False
    for line in text.split("\n"):
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


def ac_list(raw):
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    items = []
    for p in re.split(r"\n(?=\*|\d+\.|- )|\n\n", str(raw)):
        p = re.sub(r"^\d+\.\s*", "", re.sub(r"^[\*\-]\s*", "", p.strip()))
        if p:
            items.append(p)
    return items or ([str(raw).strip()] if str(raw).strip() else [])


def person_fmt(user):
    if not user:
        return None
    return f"{user.get('displayName')} ({(user.get('name') or user.get('key') or '').upper()})"


def issue_links(fields):
    related = []
    for link in fields.get("issuelinks") or []:
        for direction, rel_key in (("outwardIssue", "outward"), ("inwardIssue", "inward")):
            if direction in link:
                o = link[direction]
                related.append({
                    "key": o["key"],
                    "url": f"{JIRA_BASE}/browse/{o['key']}",
                    "summary": o["fields"]["summary"],
                    "status": o["fields"]["status"]["name"],
                    "relation": link.get("type", {}).get(rel_key, "relates"),
                })
    return related


def story_points(fields):
    sp = fields.get("customfield_10402") or fields.get("customfield_57402")
    if sp is None:
        return None
    return int(sp) if sp == int(sp) else float(sp)


# ── Comments ─────────────────────────────────────────────────────────────────


def _format_comments(raw):
    ordered = sorted(raw, key=lambda c: c.get("created", ""), reverse=True)
    out = []
    for c in ordered:
        body = c.get("renderedBody") or wiki_to_html(c.get("body", "")) or f"<p>{escape(c.get('body', ''))}</p>"
        out.append({
            "author": (c.get("author") or {}).get("displayName"),
            "when": iso(c.get("created")),
            "body": light_html(body) or body,
        })
    return out, len(ordered), (iso(ordered[0]["created"]) if ordered else None)


def comments_from_issue(fields):
    """Comments straight off the search payload when complete (saves one call per ticket).
    None when Jira truncated the list, so the caller paginates instead."""
    c = fields.get("comment") or {}
    listed = c.get("comments") or []
    if c.get("total", len(listed)) > len(listed):
        return None
    return _format_comments(listed)


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
    return _format_comments(comments)


def comments_for(key, fields):
    inline = comments_from_issue(fields)
    return inline if inline is not None else fetch_comments(key)
