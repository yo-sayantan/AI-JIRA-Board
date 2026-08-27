#!/usr/bin/env python3
"""Jira Development-Information client — branches, pull requests and review state.

This reads Jira's dev-status API, the same source that renders the "Development"
panel on a Jira issue. Bitbucket indexes every commit and branch against the ticket
keys it mentions and pushes that to Jira, so one call per issue returns work in ANY
repository — including repos this tool has never been told about.

That matters most for sub-tasks: a master ticket is usually delivered through
sub-tasks that several people own, and their branches often live in infrastructure
or pipeline repos far away from the team's main application repo.

Bitbucket is still called, but only to enrich a pull request that is still open
(reviewer NEEDS_WORK flags and unresolved comment counts, which dev-status omits).
Those calls address the PR by its exact project/repo/id taken from the dev-status
URL, so there is no repo guessing anywhere in this module.
"""
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from _config import endpoints, load_config

INTERN = os.path.dirname(os.path.abspath(__file__))
# Endpoints come from config.json (see _config.py) — no company hosts baked into the repo.
JIRA_BASE, _CONFLUENCE_BASE, BITBUCKET_BASE = endpoints(INTERN)
BB_BASE = f"{BITBUCKET_BASE}/rest/api/1.0" if BITBUCKET_BASE else ""

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE

_PR_URL_RE = re.compile(r"/projects/([^/]+)/repos/([^/]+)/pull-requests/(\d+)")


def _config_int(path_keys, default):
    try:
        cfg = load_config(INTERN)
        for k in path_keys:
            cfg = cfg[k]
        return int(cfg)
    except Exception:
        return default


REQUIRED_APPROVALS = _config_int(("app", "requiredApprovals"), 2)


def _is_transient_net(exc):
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500
    if isinstance(exc, urllib.error.URLError):
        return True
    return isinstance(exc, (TimeoutError, ConnectionError, OSError))


def _get_json(url, headers, timeout, retries=4):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, context=_ctx, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:
            last = e
            if attempt >= retries:
                break
            delay = min(30, 2 ** attempt) if _is_transient_net(e) else (1 + attempt)
            time.sleep(delay)
    raise last


def _jira_get(path, timeout=90):
    return _get_json(
        JIRA_BASE + path,
        {"Authorization": f"Bearer {os.environ['JIRA_PERSONAL_TOKEN']}", "Accept": "application/json"},
        timeout=timeout,
    )


def _bb_get(path, timeout=30):
    tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN", "")
    return _get_json(
        BB_BASE + path,
        {"Authorization": f"Bearer {tok}", "Accept": "application/json"},
        timeout=timeout,
        retries=1,
    )


def _iso(s):
    if not s:
        return None
    if isinstance(s, (int, float)):
        from datetime import datetime, timezone

        ts = s / 1000 if s > 1e12 else s
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(s).replace("+0000", "Z").replace(".000+0000", "Z").replace(".000Z", "Z")


def resolve_issue_ids(keys):
    """Map issue keys → numeric ids (dev-status only accepts ids), 100 keys per search."""
    ids = {}
    keys = [k for k in keys if k]
    for i in range(0, len(keys), 100):
        chunk = keys[i : i + 100]
        try:
            q = urllib.parse.urlencode(
                {"jql": "key in (" + ",".join(chunk) + ")", "maxResults": 100, "fields": "summary"}
            )
            for issue in _jira_get("/rest/api/2/search?" + q).get("issues", []):
                ids[issue["key"]] = issue["id"]
        except Exception:
            continue
    return ids


def _pr_comment_stats(proj, slug, pid):
    """Unresolved vs resolved review comments — dev-status reports neither."""
    total, resolved = 0, 0
    try:
        start, pages = 0, 0
        while pages < 3:
            data = _bb_get(f"/projects/{proj}/repos/{slug}/pull-requests/{pid}/activities?start={start}&limit=100")
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
    return total, resolved, max(0, total - resolved)


def _needs_work(proj, slug, pid):
    try:
        data = _bb_get(f"/projects/{proj}/repos/{slug}/pull-requests/{pid}")
        return any(r.get("status") == "NEEDS_WORK" for r in data.get("reviewers") or [])
    except Exception:
        return False


def _to_pr(raw, enrich_open=True):
    status = (raw.get("status") or "").upper()
    merged = status == "MERGED"
    declined = status in ("DECLINED", "REJECTED")
    src = raw.get("source") or {}
    dst = raw.get("destination") or {}
    reviewers_raw = raw.get("reviewers") or []
    approvals = sum(1 for r in reviewers_raw if r.get("approved"))
    url = raw.get("url")

    total = resolved = open_c = 0
    needs_work = False
    m = _PR_URL_RE.search(url or "")
    if m and enrich_open and not (merged or declined):
        proj, slug, pid = m.groups()
        total, resolved, open_c = _pr_comment_stats(proj, slug, pid)
        needs_work = _needs_work(proj, slug, pid)

    if merged:
        state = "merged"
    elif declined:
        state = "declined"
    elif needs_work:
        state = "changes"
    elif approvals >= REQUIRED_APPROVALS and open_c == 0:
        state = "approved"
    else:
        state = "comments"

    pid_raw = str(raw.get("id") or "").lstrip("#")
    return {
        "state": state,
        "id": int(pid_raw) if pid_raw.isdigit() else (pid_raw or None),
        "title": raw.get("name"),
        "url": url,
        "approvals": approvals,
        "openComments": open_c,
        "commentsTotal": total,
        "commentsResolved": resolved,
        "reviewers": [r.get("name") for r in reviewers_raw if r.get("name")],
        "sourceBranch": src.get("branch"),
        "destinationBranch": dst.get("branch"),
        # Which repository the review actually happened in. With dev-status a single ticket
        # can span several repos, so the badge is meaningless without it.
        "repo": (src.get("repository") or {}).get("name") or (m.group(2) if m else None),
        "author": (raw.get("author") or {}).get("name"),
        "merged": merged,
        "mergedAt": _iso(raw.get("lastUpdate")) if merged else None,
        "updatedAt": _iso(raw.get("lastUpdate")),
    }


def pick_primary_pr(prs):
    """Badge PR: an in-flight review outranks history; otherwise newest merged, else newest."""
    if not prs:
        return {"state": "none"}
    open_prs = [p for p in prs if not p.get("merged") and p.get("state") != "declined"]
    if open_prs:
        return open_prs[0]
    merged = [p for p in prs if p.get("merged")]
    return merged[0] if merged else prs[0]


def fetch_one(issue_id, enrich_open=True):
    """Branches + PRs for one issue id. Returns None when the call fails, so callers can
    tell "Jira says there is no code" apart from "we could not ask"."""
    try:
        data = _jira_get(
            f"/rest/dev-status/latest/issue/detail?issueId={issue_id}"
            f"&applicationType=stash&dataType=pullrequest",
            timeout=45,
        )
    except Exception:
        return None
    detail = (data.get("detail") or [{}])[0]
    prs = [_to_pr(p, enrich_open) for p in detail.get("pullRequests") or []]
    prs.sort(key=lambda p: (p.get("updatedAt") or ""), reverse=True)

    branches = [b.get("name") for b in detail.get("branches") or [] if b.get("name")]
    for p in prs:
        if p.get("sourceBranch"):
            branches.append(p["sourceBranch"])
    branches = list(dict.fromkeys(branches))

    pr = pick_primary_pr(prs)
    branch = pr.get("sourceBranch") or (branches[0] if branches else None)
    return {"branches": branches, "prs": prs, "branch": branch, "pr": pr}


def fetch_many(keys, ids=None, workers=10, enrich_open=True):
    """Dev info for many issue keys at once. Keys whose lookup failed are omitted, never
    reported as empty — an empty result would wipe good cached data."""
    ids = ids or resolve_issue_ids(keys)
    todo = [(k, ids[k]) for k in keys if k in ids]
    out = {}
    if not todo:
        return out

    def one(pair):
        key, issue_id = pair
        return key, fetch_one(issue_id, enrich_open)

    with ThreadPoolExecutor(max_workers=min(workers, len(todo))) as ex:
        for key, info in ex.map(one, todo):
            if info is not None:
                out[key] = info
    return out
