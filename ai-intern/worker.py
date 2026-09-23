#!/usr/bin/env python3
"""JIRA-AI-Intern worker: HTTP control plane + file-queue consumer.

Listens on PORT (default 4322). Polls jira-intern/.ai-queue for enrich-report,
summarize-active, and pull-model jobs. Local inference is Ollama (compose
service or host.docker.internal); cloud is Claude (Messages API) or Cursor
(Cloud Agents, no repo). Both keys are read only from mcp-secrets.env.
"""
from __future__ import annotations

import base64
import json
import os
import re
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTERN = Path(os.environ.get("INTERN_DIR") or str(HERE.parent / "jira-intern")).resolve()
sys.path.insert(0, str(INTERN))

import ai_queue  # noqa: E402
from _config import endpoints, load_config, load_secrets as load_config_secrets, secrets_path  # noqa: E402

PORT = int(os.environ.get("PORT") or 4322)
OLLAMA_URL = os.environ.get("OLLAMA_HOST") or "http://ollama:11434"
HOST_OLLAMA_URL = os.environ.get("HOST_OLLAMA_URL") or "http://host.docker.internal:11434"
SECRETS = Path(secrets_path(str(INTERN)))
CATALOG_PATH = HERE / "models.json"
ENRICH_PROMPT = (HERE / "prompts" / "enrich.txt").read_text(encoding="utf-8")
CTX = ssl.create_default_context()
# Checkmarx and Dynatrace sit behind the corporate proxy, which presents a
# private CA the slim image does not trust. The Checkmarx launcher already
# uses curl -k for the same reason. On-prem Jira/Bitbucket keep MCP_SSL.
CLOUD_SSL = ssl._create_unverified_context()
STOP = threading.Event()

BADGE_TONE = {
    "Required": "info",
    "Neutral cleanup": "neutral",
    "Risky": "danger",
    "Unrelated": "warning",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    print(f"[jira-ai] {msg}", flush=True)


def load_secrets():
    try:
        return load_config_secrets(str(INTERN))
    except OSError:
        return {}


# Cloud chat keys are never copied into the process environment. The intern
# re-reads mcp-secrets.env on each cloud call so a key added on the host is picked up
# without a container recreate. Jira / Bitbucket tokens still flow through os.environ.
_FILE_ONLY_KEYS = {"ANTHROPIC_API_KEY", "CURSOR_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"}
SECRETS_ENV = load_secrets()
for _k, _v in SECRETS_ENV.items():
    if _k in _FILE_ONLY_KEYS:
        continue
    os.environ.setdefault(_k, _v)

EFFORTS = ("low", "medium")
# Claude stays on Haiku. Cursor is a separate allow-list (see _cursor_bucket).
_CHEAP_RANK = (("haiku", 0),)
_FLAGSHIP = re.compile(r"opus|sonnet|grok|codex|thinking|composer|\bpro\b|gpt-|gemini", re.I)
_CURSOR_DROP = re.compile(r"xhigh|(^|[-_.])fast($|[-_.])", re.I)
_CN_MODELS = ("qwen", "deepseek", "kimi", "glm", "chatglm", "baichuan", "internlm", "minimax", "hunyuan", "moonshot", "yi-")
_CLOUD_CACHE = {"at": 0.0, "val": None}

MCP_SSL = ssl.create_default_context()
MCP_SSL.check_hostname = False
MCP_SSL.verify_mode = ssl.CERT_NONE
PR_URL_RE = re.compile(r"/projects/([^/]+)/repos/([^/]+)/pull-requests/(\d+)", re.I)


def http_json(url, payload=None, headers=None, timeout=120, method=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method=method or ("POST" if body is not None else "GET"),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, context=CTX, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


def ollama_base(job):
    return HOST_OLLAMA_URL if job.get("useHostOllama") else OLLAMA_URL


def ollama_tags(base):
    try:
        data = http_json(base.rstrip("/") + "/api/tags", timeout=8)
        return [m.get("name") for m in (data.get("models") or []) if m.get("name")]
    except Exception as e:
        return {"error": str(e)}


def catalog():
    try:
        return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"models": [], "defaultLocal": "qwen2.5-coder:7b"}


def _fmt_bytes(n):
    n = float(n or 0)
    if n >= 1024 ** 3:
        return f" {n / (1024 ** 3):.1f} GB".strip()
    if n >= 1024 ** 2:
        return f" {n / (1024 ** 2):.0f} MB".strip()
    if n >= 1024:
        return f" {n / 1024:.0f} KB".strip()
    return f"{int(n)} B"


def mem_gb():
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                kb = int(line.split()[1])
                return round(kb / 1024 / 1024, 1)
    except Exception:
        pass
    return None


def timeout_for(level, default=600):
    cfg = load_config(str(INTERN))
    base = int((cfg.get("timeouts") or {}).get("reportSec") or default)
    if level == "low":
        return max(60, base // 2)
    if level == "full":
        return base * 2
    return base


def extract_json(text):
    if not text:
        return None
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None


def chat_ollama(base, model, system, user, timeout):
    data = http_json(
        base.rstrip("/") + "/api/chat",
        {
            "model": model,
            "stream": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "options": {"temperature": 0.2},
        },
        timeout=timeout,
    )
    return (data.get("message") or {}).get("content") or ""


def chat_openai(model, system, user, timeout, key, base_url="https://api.openai.com/v1"):
    data = http_json(
        base_url.rstrip("/") + "/chat/completions",
        {
            "model": model or "gpt-4o-mini",
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        },
        headers={"Authorization": f"Bearer {key}"},
        timeout=timeout,
    )
    return (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""


def chat_anthropic(model, system, user, timeout, key):
    data = http_json(
        "https://api.anthropic.com/v1/messages",
        {
            "model": model,
            "max_tokens": 4096,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        timeout=timeout,
    )
    parts = data.get("content") or []
    return "".join(p.get("text") or "" for p in parts if isinstance(p, dict))


def file_secret(name):
    """Cloud keys come only from mcp-secrets.env, re-read each call."""
    return (load_secrets().get(name) or "").strip()


def _http_fail(exc):
    if isinstance(exc, urllib.error.HTTPError):
        try:
            raw = exc.read().decode("utf-8", "replace")[:400]
        except Exception:
            raw = ""
        msg = raw
        try:
            parsed = json.loads(raw) if raw else {}
            err = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(err, dict):
                msg = err.get("message") or err.get("type") or raw
            elif isinstance(err, str):
                msg = err
            elif isinstance(parsed, dict) and parsed.get("message"):
                msg = parsed["message"]
        except json.JSONDecodeError:
            pass
        return RuntimeError(f"HTTP {exc.code}: {str(msg).strip()[:240]}")
    return RuntimeError(str(exc)[:240])


def _cheap_rank(text):
    blob = text or ""
    if _FLAGSHIP.search(blob):
        return None
    best = None
    low = blob.lower()
    for token, rank in _CHEAP_RANK:
        if re.search(rf"(^|[^a-z]){token}([^a-z]|$)", low):
            best = rank if best is None else min(best, rank)
    return best


def _cursor_bucket(text):
    """0 gemini flash (capped) · 1 gpt-4o · 2 grok · 3 Chinese models. None = hide."""
    low = (text or "").lower()
    if _CURSOR_DROP.search(low):
        return None
    if "gemini" in low and "flash" in low and not re.search(r"(^|[^a-z])pro([^a-z]|$)", low):
        return 0
    if "gpt-4o" in low:
        return 1
    if "grok" in low:
        return 2
    if any(tok in low for tok in _CN_MODELS):
        return 3
    return None


def _publish_cursor(models):
    buckets = {0: [], 1: [], 2: [], 3: []}
    for m in models:
        bucket = _cursor_bucket(f"{m.get('id') or ''} {m.get('label') or ''}")
        if bucket is None:
            continue
        efforts = [e for e in EFFORTS if e in (m.get("efforts") or [])]
        row = {**m, "efforts": efforts}
        if row.get("effortParam") and not efforts:
            row["effortParam"] = None
        buckets[bucket].append(row)
    gemini = sorted(buckets[0], key=lambda m: m["id"], reverse=True)[:3]
    rest = []
    for bucket in (1, 2, 3):
        rest.extend(sorted(buckets[bucket], key=lambda m: m["id"]))
    return gemini + rest


def _gemini_keep(model_id, label=""):
    low = f"{model_id} {label}".lower()
    if any(tok in low for tok in ("embed", "imagen", "veo", "aqa", "tts", "robotics")):
        return False
    if "gemini" not in low or re.search(r"(^|[^a-z])pro([^a-z]|$)|ultra", low):
        return False
    return "flash" in low or "lite" in low


def _publish_models(models):
    kept = []
    for m in models:
        rank = _cheap_rank(f"{m.get('id') or ''} {m.get('label') or ''}")
        if rank is None:
            continue
        efforts = [e for e in EFFORTS if e in (m.get("efforts") or [])]
        if m.get("effortParam") and not efforts:
            continue
        kept.append((rank, (m.get("label") or m["id"]).lower(), {**m, "efforts": efforts}))
    kept.sort()
    return [m for _, _, m in kept]


def _effort_meta(item):
    """Pick the parameter whose allowed values include low or medium."""
    best = None
    for param in item.get("parameters") or []:
        if not isinstance(param, dict):
            continue
        values = []
        for v in param.get("values") or []:
            raw = v.get("value") if isinstance(v, dict) else v
            if raw is not None:
                values.append(str(raw))
        offered = [e for e in EFFORTS if e in values]
        if not offered:
            continue
        pid = str(param.get("id") or "")
        rank = 0 if re.search(r"effort|reason", pid, re.I) else 1
        if best is None or rank < best[0]:
            best = (rank, pid, offered)
    if not best or not best[1]:
        return None, []
    return best[1], best[2]


def list_claude_models(key):
    models = []
    after = None
    headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    for _ in range(5):
        url = "https://api.anthropic.com/v1/models?limit=100"
        if after:
            url += "&after_id=" + urllib.parse.quote(after)
        data = http_json(url, headers=headers, timeout=30)
        for m in data.get("data") or []:
            if not isinstance(m, dict) or not m.get("id"):
                continue
            models.append({"id": m["id"], "label": m.get("display_name") or m["id"], "efforts": []})
        if not data.get("has_more"):
            break
        after = data.get("last_id")
        if not after:
            break
    return _publish_models(models)


def list_cursor_models(key):
    token = base64.b64encode(f"{key}:".encode()).decode()
    data = http_json(
        "https://api.cursor.com/v1/models",
        headers={"Authorization": f"Basic {token}"},
        timeout=30,
    )
    models = []
    for item in data.get("items") or data.get("models") or []:
        if isinstance(item, str):
            models.append({"id": item, "label": item, "efforts": [], "effortParam": None})
            continue
        if not isinstance(item, dict) or not item.get("id"):
            continue
        param_id, efforts = _effort_meta(item)
        models.append({
            "id": item["id"],
            "label": item.get("displayName") or item["id"],
            "efforts": efforts,
            "effortParam": param_id,
        })
    return _publish_cursor(models)


def list_gemini_models(key):
    models = []
    page = None
    headers = {"x-goog-api-key": key}
    for _ in range(5):
        url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100"
        if page:
            url += "&pageToken=" + urllib.parse.quote(page)
        data = http_json(url, headers=headers, timeout=30)
        for m in data.get("models") or []:
            if not isinstance(m, dict):
                continue
            methods = [str(x).lower() for x in (m.get("supportedGenerationMethods") or m.get("supportedActions") or [])]
            if methods and not any("generatecontent" in x for x in methods):
                continue
            mid = str(m.get("name") or "").split("/")[-1]
            label = m.get("displayName") or mid
            if not mid or not _gemini_keep(mid, label):
                continue
            models.append({"id": mid, "label": label, "efforts": []})
        page = data.get("nextPageToken")
        if not page:
            break
    models.sort(key=lambda m: m["id"], reverse=True)
    return models


def cloud_models(force=False):
    now = time.time()
    if not force and _CLOUD_CACHE["val"] is not None and now - _CLOUD_CACHE["at"] < 60:
        return _CLOUD_CACHE["val"]
    out = {
        "ok": True,
        "claude": {"configured": False, "models": [], "error": None},
        "cursor": {"configured": False, "models": [], "error": None},
        "gemini": {"configured": False, "models": [], "error": None},
    }
    claude_key = file_secret("ANTHROPIC_API_KEY")
    cursor_key = file_secret("CURSOR_API_KEY")
    gemini_key = file_secret("GEMINI_API_KEY")
    if claude_key:
        out["claude"]["configured"] = True
        try:
            out["claude"]["models"] = list_claude_models(claude_key)
            if not out["claude"]["models"]:
                out["claude"]["error"] = "No cheaper Claude models on this key (Haiku only)."
        except Exception as e:
            out["claude"]["error"] = str(_http_fail(e) if not isinstance(e, RuntimeError) else e)
    else:
        out["claude"]["error"] = "Add ANTHROPIC_API_KEY to ~/.cursor/mcp-secrets.env"
    if cursor_key:
        out["cursor"]["configured"] = True
        try:
            out["cursor"]["models"] = list_cursor_models(cursor_key)
            if not out["cursor"]["models"]:
                out["cursor"]["error"] = "No matching Cursor models (Gemini Flash, GPT-4o, Grok, or Qwen/DeepSeek/Kimi/GLM)."
        except Exception as e:
            out["cursor"]["error"] = str(_http_fail(e) if not isinstance(e, RuntimeError) else e)
    else:
        out["cursor"]["error"] = "Add CURSOR_API_KEY to ~/.cursor/mcp-secrets.env"
    if gemini_key:
        out["gemini"]["configured"] = True
        try:
            out["gemini"]["models"] = list_gemini_models(gemini_key)
            if not out["gemini"]["models"]:
                out["gemini"]["error"] = "No Gemini Flash models on this key."
        except Exception as e:
            out["gemini"]["error"] = str(_http_fail(e) if not isinstance(e, RuntimeError) else e)
    else:
        out["gemini"]["error"] = "Add GEMINI_API_KEY to ~/.cursor/mcp-secrets.env"
    _CLOUD_CACHE["at"] = now
    _CLOUD_CACHE["val"] = out
    return out


def chat_cursor(model, effort, system, user, timeout, key):
    """One no-repo Cloud Agent run. Archived when the reply is in, so nothing is left running."""
    catalog = cloud_models().get("cursor") or {}
    hit = next((m for m in catalog.get("models") or [] if m.get("id") == model), None)
    params = []
    used = effort if effort in EFFORTS else "low"
    if hit and hit.get("effortParam") and hit.get("efforts"):
        if used not in hit["efforts"]:
            used = hit["efforts"][0]
        params.append({"id": hit["effortParam"], "value": used})
    prompt = (
        "Return only the JSON object requested below. "
        "Do not edit files, do not run commands, and do not open a pull request.\n\n"
        f"{system}\n\n{user}"
    )
    token = base64.b64encode(f"{key}:".encode()).decode()
    headers = {"Authorization": f"Basic {token}"}
    try:
        return _cursor_run(model, params, used, prompt, headers, timeout)
    except urllib.error.HTTPError as e:
        raise _http_fail(e) from e


CANCEL = INTERN / ".ai-cancel-report"
ACTIVE_JOB_TYPE = None


def stop_requested():
    return ACTIVE_JOB_TYPE == "enrich-report" and CANCEL.is_file()


class Stopped(Exception):
    """The board asked this enrich run to end."""


def _release_stop_if_idle():
    try:
        CANCEL.unlink()
    except OSError:
        pass


def _cursor_run(model, params, used, prompt, headers, timeout):
    if stop_requested():
        raise Stopped()
    # Creating a Cloud Agent often takes about a minute. A 60s socket
    # timeout was aborting runs that finished a few seconds later.
    created = http_json(
        "https://api.cursor.com/v1/agents",
        {
            "prompt": {"text": prompt[:100_000]},
            "name": "jira-board",
            "mode": "agent",
            "autoCreatePR": False,
            "model": {"id": model, **({"params": params} if params else {})},
        },
        headers=headers,
        timeout=min(300, max(180, timeout // 4)),
    )
    agent = created.get("agent") or {}
    run = created.get("run") or {}
    agent_id = agent.get("id")
    run_id = run.get("id") or agent.get("latestRunId")
    if not agent_id or not run_id:
        raise RuntimeError("Cursor did not start a run")
    log(f"cursor run started model={model} effort={used}")
    deadline = time.time() + max(60, timeout)
    try:
        while time.time() < deadline:
            info = http_json(
                f"https://api.cursor.com/v1/agents/{urllib.parse.quote(agent_id)}/runs/{urllib.parse.quote(run_id)}",
                headers=headers,
                timeout=30,
            )
            status = str(info.get("status") or "").upper()
            if status == "FINISHED":
                return info.get("result") or "", used
            if status in ("ERROR", "CANCELLED", "EXPIRED"):
                raise RuntimeError((info.get("result") or f"Cursor run {status}")[:240])
            if stop_requested():
                raise Stopped()
            time.sleep(3)
        raise RuntimeError("Cursor run timed out")
    except urllib.error.HTTPError as e:
        raise _http_fail(e) from e
    finally:
        try:
            http_json(
                f"https://api.cursor.com/v1/agents/{urllib.parse.quote(agent_id)}/archive",
                {},
                headers=headers,
                timeout=20,
            )
        except Exception as e:
            log(f"cursor archive skipped: {_http_fail(e)}")


def chat_gemini(model, system, user, timeout, key):
    name = model.split("/")[-1]
    data = http_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(name)}:generateContent",
        {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
        },
        headers={"x-goog-api-key": key},
        timeout=timeout,
    )
    cands = data.get("candidates") or []
    parts = (((cands[0].get("content") or {}).get("parts")) if cands else None) or []
    return "".join(p.get("text") or "" for p in parts if isinstance(p, dict))


def _cloud_allowed(provider, model):
    if not model:
        return False
    if provider == "cursor":
        return _cursor_bucket(model) is not None
    if provider == "gemini":
        return _gemini_keep(model, model)
    return _cheap_rank(model) is not None


def infer(job, system, user):
    timeout = timeout_for(job.get("level") or "moderate")
    backend = job.get("backend") or "local"
    model = job.get("model") or catalog().get("defaultLocal") or ""
    if backend == "cloud":
        provider = job.get("cloudProvider") or "cursor"
        model = (job.get("model") or "").strip()
        if provider not in ("claude", "cursor", "gemini"):
            provider = "cursor"
        if not _cloud_allowed(provider, model):
            raise RuntimeError("Pick a listed model in Settings.")
        if provider == "cursor":
            key = file_secret("CURSOR_API_KEY")
            if not key:
                raise RuntimeError("Add CURSOR_API_KEY to ~/.cursor/mcp-secrets.env")
            effort = job.get("cloudEffort") if job.get("cloudEffort") in EFFORTS else "low"
            text, used = chat_cursor(model, effort, system, user, timeout, key)
            return text, f"cloud · cursor · {model} · {used}"
        if provider == "gemini":
            key = file_secret("GEMINI_API_KEY")
            if not key:
                raise RuntimeError("Add GEMINI_API_KEY to ~/.cursor/mcp-secrets.env")
            return chat_gemini(model, system, user, timeout, key), f"cloud · gemini · {model}"
        key = file_secret("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("Add ANTHROPIC_API_KEY to ~/.cursor/mcp-secrets.env")
        return chat_anthropic(model, system, user, timeout, key), f"cloud · claude · {model}"
    base = ollama_base(job)
    tags = ollama_tags(base)
    if isinstance(tags, dict) and tags.get("error"):
        raise RuntimeError(f"Ollama unreachable ({base}): {tags['error']}")
    names = tags if isinstance(tags, list) else []
    if model not in names and not any(n.startswith(f"{model}") for n in names):
        raise RuntimeError(f"no model downloaded ({model}). Use Settings → Download.")
    return chat_ollama(base, model, system, user, timeout), f"local · {model}"


def load_ticket(key):
    data = json.loads((INTERN / "data.json").read_text(encoding="utf-8"))
    key_u = key.upper()
    for t in data.get("tickets") or []:
        if (t.get("key") or "").upper() == key_u:
            return t, data
        for s in t.get("subtasks") or []:
            if (s.get("key") or "").upper() == key_u:
                return s, data
    for t in data.get("completed") or []:
        if (t.get("key") or "").upper() == key_u:
            return t, data
    return None, data


def compact_ticket(t):
    keep = (
        "key", "title", "status", "column", "type", "priority", "storyPoints", "sprint",
        "description", "acceptanceCriteria", "comments", "prs", "pr", "branches", "branch",
        "confluence", "related", "fixVersions", "labels", "components", "epic",
        "proposedSolution", "openQuestions", "updateLog", "subtasks", "url",
    )
    out = {k: t.get(k) for k in keep if t.get(k) not in (None, [], "")}
    comments = out.get("comments") or []
    if isinstance(comments, list) and len(comments) > 8:
        out["comments"] = comments[:8]
    return out


def mcp_policy(name):
    pol = (load_config(str(INTERN)).get("mcp") or {}).get(name) or {}
    return bool(pol.get("enabled", True) and pol.get("read", True))


def mcp_get(url, token, timeout=20):
    if not url or not token:
        raise RuntimeError("missing url or token")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    with urllib.request.urlopen(req, context=MCP_SSL, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


def parse_pr_url(url):
    if not url:
        return None
    m = PR_URL_RE.search(str(url))
    if not m:
        return None
    return {"project": m.group(1), "slug": m.group(2), "id": m.group(3)}


def local_disk_pack(key, ticket, data):
    """Facts already on the intern volume — data.json, related tickets, cache."""
    related = []
    seen = {key.upper()}
    for ref in ticket.get("related") or []:
        rk = (ref.get("key") if isinstance(ref, dict) else None) or ""
        if not rk or rk.upper() in seen:
            continue
        seen.add(rk.upper())
        t, _ = load_ticket(rk)
        if t:
            related.append({"key": t.get("key"), "title": t.get("title"), "status": t.get("status"), "column": t.get("column")})
        if len(related) >= 8:
            break
    cache = {}
    for name in (f"{key}.json", f"issue-{key}.json"):
        p = INTERN / "cache" / name
        if p.is_file():
            try:
                cache[name] = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                cache[name] = {"error": "unreadable"}
    return {
        "source": "jira-intern volume",
        "ticket": compact_ticket(ticket),
        "relatedOnBoard": related,
        "sprint": (data or {}).get("sprint"),
        "cache": cache or None,
    }


def live_mcp_pack(key, ticket):
    """Read-only Jira / Bitbucket REST using the same tokens as Cursor MCP."""
    jira_base, conf_base, bb_base = endpoints(str(INTERN))
    jira_tok = os.environ.get("JIRA_PERSONAL_TOKEN") or SECRETS_ENV.get("JIRA_PERSONAL_TOKEN")
    bb_tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN") or SECRETS_ENV.get("BITBUCKET_PAT") or SECRETS_ENV.get("ATLASSIAN_TOKEN")
    used, errors, files, live = [], [], [], {}

    if mcp_policy("jira") and jira_base and jira_tok:
        try:
            issue = mcp_get(f"{jira_base}/rest/api/2/issue/{urllib.parse.quote(key)}?fields=status,comment,fixVersions,labels,issuelinks", jira_tok)
            fields = issue.get("fields") or {}
            live["jiraStatus"] = ((fields.get("status") or {}).get("name"))
            live["jiraLabels"] = fields.get("labels") or []
            comments = ((fields.get("comment") or {}).get("comments") or [])[-5:]
            live["jiraRecentComments"] = [
                {"author": ((c.get("author") or {}).get("displayName")), "body": (c.get("body") or "")[:400]}
                for c in comments
            ]
            used.append("jira")
        except Exception as e:
            errors.append(f"jira: {e}")
    elif mcp_policy("jira"):
        errors.append("jira: no token or jiraBase")

    if mcp_policy("bitbucket") and bb_base and bb_tok:
        prs = list(ticket.get("prs") or [])
        if ticket.get("pr"):
            prs = [ticket["pr"], *[p for p in prs if p is not ticket.get("pr")]]
        seen_ids = set()
        for pr in prs[:4]:
            if not isinstance(pr, dict):
                continue
            parsed = parse_pr_url(pr.get("url"))
            if not parsed or parsed["id"] in seen_ids:
                continue
            seen_ids.add(parsed["id"])
            try:
                data = mcp_get(
                    f"{bb_base}/rest/api/1.0/projects/{parsed['project']}/repos/{parsed['slug']}/pull-requests/{parsed['id']}/changes?limit=100",
                    bb_tok,
                    timeout=30,
                )
                for row in data.get("values") or []:
                    path = row.get("path") or {}
                    name = path.get("toString") or path.get("name")
                    if name:
                        files.append(name)
                used.append(f"bitbucket:{parsed['slug']}#{parsed['id']}")
            except Exception as e:
                errors.append(f"bitbucket {parsed['slug']}#{parsed['id']}: {e}")
        if not seen_ids:
            errors.append("bitbucket: no PR url to read")
    elif mcp_policy("bitbucket"):
        errors.append("bitbucket: no token or bitbucketBase")

    if mcp_policy("confluence") and conf_base:
        pages = ticket.get("confluence") or []
        live["confluenceOnTicket"] = pages if pages else "none in local dump — no extra Confluence fetch"
        used.append("confluence-local")

    return {
        "source": "live REST with MCP tokens (read-only)",
        "used": used,
        "errors": errors,
        "changedFiles": files[:80],
        "live": live,
    }


def _plain(ticket):
    desc = re.sub(r"<[^>]+>", " ", ticket.get("description") or "")
    labels = " ".join(ticket.get("labels") or [])
    return f"{ticket.get('title') or ''} {ticket.get('type') or ''} {labels} {desc}"


def classify_ticket(ticket):
    """Which proof this ticket actually needs. Unrelated systems are omitted, not listed as skipped."""
    text = _plain(ticket).lower()
    kinds = []
    if re.search(r"cve-\d{4}-\d+|checkmarx|vulnerab|\bsca\b|\bsast\b|cwe-\d|dependency|spring4shell", text):
        kinds.append("security")
    if re.search(r"dynatrace|splunk|\blogging\b|\blogs\b|distributed trace|\bspan\b|observab", text):
        kinds.append("observability")
    if re.search(r"production incident|\boutage\b|error rate|\bsev-?[123]\b", text):
        kinds.append("incident")
    pages = ticket.get("confluence") or []
    if pages or re.search(r"\bconfluence\b|\brunbook\b|design doc", text):
        kinds.append("spec")
    return kinds


def _prs_of(ticket):
    prs = [p for p in (ticket.get("prs") or []) if isinstance(p, dict) and p.get("url")]
    one = ticket.get("pr")
    if isinstance(one, dict) and one.get("url") and one not in prs:
        prs = [one, *prs]
    return prs[:4]


def _cloud_json(url, payload=None, headers=None, timeout=30):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST" if body is not None else "GET",
        headers={"Accept": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, context=CLOUD_SSL, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:180]
        except Exception:
            detail = ""
        raise RuntimeError(f"HTTP {e.code} {detail}".strip()) from e


def _checkmarx_token():
    key = file_secret("CHECKMARX_API_KEY")
    if not key:
        raise RuntimeError("no CHECKMARX_API_KEY")
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": "ast-app",
        "refresh_token": key,
    }).encode()
    req = urllib.request.Request(
        "https://experian.cxone.cloud/auth/realms/experian/protocol/openid-connect/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, context=CLOUD_SSL, timeout=25) as r:
        tok = json.loads(r.read().decode("utf-8"))
    access = tok.get("access_token") or ""
    if not access:
        raise RuntimeError(tok.get("error") or "no access token")
    return access


def _cx_get(token, path):
    return _cloud_json("https://experian.cxone.cloud" + path, headers={"Authorization": f"Bearer {token}"})


def _sev_count(counters, name):
    for row in (counters or {}).get("severityCounters") or []:
        if str(row.get("severity") or "").upper() == name:
            return int(row.get("counter") or 0)
    return 0


def _pkg_name(data):
    pkg = (data or {}).get("packageIdentifier")
    if isinstance(pkg, str) and pkg.strip():
        return pkg.strip()
    if isinstance(pkg, dict):
        for k in ("packageName", "name", "id", "packageId"):
            if pkg.get(k):
                return str(pkg[k])
    return "package"


def bitbucket_ci(ticket):
    """Build status already posted on the PR commit (Jenkins, Bamboo, or Checkmarx)."""
    _jira, _conf, bb_base = endpoints(str(INTERN))
    token = os.environ.get("BITBUCKET_PAT") or SECRETS_ENV.get("BITBUCKET_PAT") or file_secret("BITBUCKET_PAT")
    if not bb_base or not token:
        return {"state": "Not verified", "detail": "No Bitbucket token", "error": True}
    bits = []
    worst = "none"
    rank = {"FAILED": 3, "INPROGRESS": 2, "SUCCESSFUL": 1}
    for pr in _prs_of(ticket):
        parsed = parse_pr_url(pr.get("url"))
        if not parsed:
            continue
        label = f"PR #{parsed['id']}"
        try:
            info = mcp_get(
                f"{bb_base}/rest/api/1.0/projects/{parsed['project']}/repos/{parsed['slug']}/pull-requests/{parsed['id']}",
                token,
                timeout=25,
            )
            commit = ((info.get("fromRef") or {}).get("latestCommit")) or ""
            if not commit:
                bits.append(f"{label}: no commit")
                continue
            st = mcp_get(f"{bb_base}/rest/build-status/1.0/commits/{commit}", token, timeout=25)
            values = st.get("values") or []
            if not values:
                bits.append(f"{label}: no build")
                continue
            for v in values[:3]:
                state = str(v.get("state") or "UNKNOWN").upper()
                name = v.get("name") or v.get("key") or "build"
                bits.append(f"{label} {name} {state}")
                if rank.get(state, 0) > rank.get(worst, 0):
                    worst = state
        except Exception as e:
            bits.append(f"{label}: {e}")
            return {"state": "Not verified", "detail": "; ".join(bits)[:180], "error": True}
    if not bits:
        return {"state": "Not verified", "detail": "No pull request to check", "error": False}
    missing = any(": no build" in b or ": no commit" in b for b in bits)
    if worst in ("FAILED", "INPROGRESS"):
        state = "Fail"
    elif worst == "SUCCESSFUL" and not missing:
        state = "Pass"
    else:
        state = "Not verified"
    tone = {"Pass": "success", "Fail": "danger"}.get(state, "warning")
    return {"state": state, "tone": tone, "detail": "; ".join(bits)[:180], "error": False}


def checkmarx_proof(ticket):
    text = _plain(ticket)
    cves = []
    for cve in re.findall(r"CVE-\d{4}-\d+", text, re.I):
        cve = cve.upper()
        if cve not in cves:
            cves.append(cve)
    slugs = []
    branches = set()
    for pr in _prs_of(ticket):
        parsed = parse_pr_url(pr.get("url"))
        if parsed and parsed["slug"] not in slugs:
            slugs.append(parsed["slug"])
        for b in (pr.get("sourceBranch"), pr.get("destinationBranch")):
            if b:
                branches.add(b)
    if not slugs:
        return [{"check": "Checkmarx", "result": "No repo", "detail": "No pull request to match to a project", "tone": "warning"}], True
    try:
        token = _checkmarx_token()
    except Exception as e:
        return [{"check": "Checkmarx", "result": "Not read", "detail": str(e)[:140], "tone": "warning"}], True
    project = None
    slug = slugs[0]
    try:
        data = _cx_get(token, f"/api/projects?limit=8&name={urllib.parse.quote(slug)}")
        for p in data.get("projects") or []:
            name = p.get("name") or ""
            if name == slug or name.endswith("/" + slug):
                project = p
                break
        if project is None and (data.get("projects") or []):
            project = data["projects"][0]
    except Exception as e:
        return [{"check": "Checkmarx", "result": "Not read", "detail": str(e)[:140], "tone": "warning"}], True
    if not project:
        return [{"check": "Checkmarx", "result": "No project", "detail": f"No Checkmarx project named {slug}", "tone": "warning"}], True
    try:
        scans = _cx_get(token, f"/api/scans?project-id={project['id']}&limit=8&statuses=Completed").get("scans") or []
    except Exception as e:
        return [{"check": "Checkmarx", "result": "Not read", "detail": str(e)[:140], "tone": "warning"}], True
    scan = next((s for s in scans if s.get("branch") in branches), None) or (scans[0] if scans else None)
    if not scan:
        return [{"check": "Checkmarx", "result": "No scan", "detail": f"No completed scan for {slug}", "tone": "warning"}], True
    sid = scan["id"]
    try:
        summary = _cx_get(token, f"/api/scan-summary?scan-ids={sid}")
        sca = ((summary.get("scansSummaries") or [{}])[0].get("scaCounters")) or {}
    except Exception:
        sca = {}
    day = str(scan.get("createdAt") or "")[:10]
    branch = scan.get("branch") or "?"
    crit, high = _sev_count(sca, "CRITICAL"), _sev_count(sca, "HIGH")
    rows = [{
        "check": "Checkmarx",
        "result": "Scan read",
        "detail": f"{day} · {branch} · {crit} critical · {high} high still open (SCA)",
        "tone": "danger" if crit else ("warning" if high else "success"),
    }]
    found = {}
    if cves:
        wanted = set(cves)
        try:
            for sev in ("CRITICAL", "HIGH", "MEDIUM"):
                offset = 0
                while offset < 250 and wanted - set(found):
                    page = _cx_get(token, f"/api/results?scan-id={sid}&limit=100&offset={offset}&severity={sev}")
                    batch = page.get("results") or []
                    if not batch:
                        break
                    for row in batch:
                        name = str(((row.get("vulnerabilityDetails") or {}).get("cveName")) or "").upper()
                        if name in wanted and name not in found:
                            found[name] = row
                    offset += len(batch)
                    if offset >= int(page.get("totalCount") or 0):
                        break
        except Exception as e:
            rows.append({"check": "CVEs", "result": "Not read", "detail": str(e)[:140], "tone": "warning"})
            return rows, True
        open_states = {"TO_VERIFY", "CONFIRMED", "URGENT", "PROPOSED_NOT_EXPLOITABLE"}
        for cve in cves[:6]:
            hit = found.get(cve)
            if not hit:
                rows.append({
                    "check": cve,
                    "result": "Not in scan",
                    "detail": f"Absent from critical, high, and medium on {branch} ({day})",
                    "tone": "success",
                })
                continue
            state = str(hit.get("state") or "")
            pkg = _pkg_name(hit.get("data") or {})
            sev = str(hit.get("severity") or "")
            cleared = state.upper() in {"NOT_EXPLOITABLE", "RESOLVED"} or str(hit.get("status") or "").upper() == "FIXED"
            rows.append({
                "check": cve,
                "result": "Cleared" if cleared else "Still open",
                "detail": f"{sev} · {state or hit.get('status') or 'open'} · {pkg}",
                "tone": "success" if cleared or state.upper() not in open_states else "danger",
            })
    return rows, False


def dynatrace_proof(ticket, kinds):
    plain = _plain(ticket)
    codes = []
    for code in re.findall(r"\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+){1,3}-\d+\b", plain):
        if code not in codes:
            codes.append(code)
    services = re.findall(r"\bSERVICE-[A-Z0-9]+\b", plain)
    term = (codes or services or [None])[0]
    if not term:
        return [{"check": "Dynatrace", "result": "No handle", "detail": "No error code or service id on the ticket to query", "tone": "warning"}], True
    host = "hdt38619"
    if "hzi75060" in plain:
        host = "hzi75060"
    elif "ilr81083" in plain:
        host = "ilr81083"
    token = file_secret("DYNATRACE_PAT")
    if not token:
        return [{"check": "Dynatrace", "result": "Not read", "detail": "No DYNATRACE_PAT", "tone": "warning"}], True
    safe = str(term).replace('"', "")
    if "observability" in kinds:
        query = f'fetch logs, from:now()-24h | filter matchesPhrase(content, "{safe}") | limit 3'
        window = "24h"
    else:
        query = f'fetch dt.davis.problems, from:now()-7d | filter matchesPhrase(event.name, "{safe}") | limit 5'
        window = "7d"
    try:
        data = _cloud_json(
            f"https://{host}.apps.dynatrace.com/platform/storage/query/v1/query:execute",
            {"query": query, "requestTimeoutMilliseconds": 20000, "maxResultRecords": 5},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=30,
        )
    except Exception as e:
        return [{"check": "Dynatrace", "result": "Not read", "detail": str(e)[:140], "tone": "warning"}], True
    records = ((data.get("result") or {}).get("records")) or []
    if not records:
        return [{"check": "Dynatrace", "result": "None", "detail": f"No match for {safe} in the last {window} ({host})", "tone": "success"}], False
    names = []
    for rec in records[:3]:
        if not isinstance(rec, dict):
            continue
        label = rec.get("display_id") or rec.get("event.name") or rec.get("status") or "record"
        names.append(str(label)[:40])
    return [{
        "check": "Dynatrace",
        "result": f"{len(records)} seen",
        "detail": f"{safe} · {', '.join(names) or 'records returned'} · last {window}",
        "tone": "warning",
    }], False


def confluence_proof(ticket):
    pages = ticket.get("confluence") or []
    rows = []
    if isinstance(pages, list):
        for page in pages[:5]:
            if isinstance(page, dict):
                title = page.get("title") or page.get("label") or "Page"
                rows.append({"check": "Confluence", "result": "Linked", "detail": str(title)[:120], "tone": "info"})
            elif isinstance(page, str) and page.strip():
                rows.append({"check": "Confluence", "result": "Linked", "detail": page.strip()[:120], "tone": "info"})
    if rows:
        return rows
    return [{"check": "Confluence", "result": "None linked", "detail": "Acceptance criteria are only in the Jira description", "tone": "neutral"}]


def collect_class_proof(ticket):
    kinds = classify_ticket(ticket)
    rows = []
    warnings = []
    sources = []
    ci = bitbucket_ci(ticket)
    rows.append({"check": "CI", "result": ci["state"], "detail": ci["detail"], "tone": ci.get("tone") or "neutral"})
    sources.append("Bitbucket builds")
    if ci.get("error"):
        warnings.append("CI was not read.")
    if "security" in kinds:
        cx_rows, failed = checkmarx_proof(ticket)
        rows.extend(cx_rows)
        sources.append("Checkmarx")
        if failed:
            warnings.append("Checkmarx was not read.")
    if "observability" in kinds or "incident" in kinds:
        dt_rows, failed = dynatrace_proof(ticket, kinds)
        rows.extend(dt_rows)
        sources.append("Dynatrace")
        if failed:
            warnings.append("Dynatrace was not read.")
    if "spec" in kinds:
        rows.extend(confluence_proof(ticket))
        sources.append("Confluence")
    title = "Proof"
    if "security" in kinds:
        title = "Proof · vulnerability fix"
    elif "observability" in kinds:
        title = "Proof · logging"
    elif "incident" in kinds:
        title = "Proof · incident"
    elif "spec" in kinds:
        title = "Proof · spec"
    return {"kinds": kinds, "rows": rows, "warnings": warnings, "sources": sources, "title": title, "ci": ci}


def _set_gate(report, name, state, evidence):
    tone = {"Pass": "success", "Fail": "danger"}.get(state, "neutral")
    for tab in report.get("tabs") or []:
        if tab.get("id") != "verdict":
            continue
        for block in tab.get("blocks") or []:
            if block.get("title") != "Gate checklist":
                continue
            for row in block.get("rows") or []:
                cells = row.get("cells") or []
                if cells and cells[0] == name:
                    row["cells"] = [name, state, evidence[:180], cells[3] if len(cells) > 3 else "No"]
                    row["tone"] = tone


def apply_class_proof(report, proof):
    if not proof or not proof.get("rows"):
        return report
    ci = proof.get("ci") or {}
    if ci.get("state"):
        _set_gate(report, "CI green", ci["state"], ci.get("detail") or "")
    if "security" in (proof.get("kinds") or []):
        cx = next((r for r in proof["rows"] if r["check"] == "Checkmarx"), None)
        cve_open = [r for r in proof["rows"] if str(r["check"]).startswith("CVE-") and r["result"] == "Still open"]
        cleared = [r["check"] for r in proof["rows"] if str(r["check"]).startswith("CVE-") and r["result"] == "Not in scan"]
        if cve_open:
            _set_gate(report, "Security scan (Checkmarx) clean", "Fail", "; ".join(r["check"] + " still open" for r in cve_open[:4]))
        elif cx and cx.get("tone") == "success":
            evidence = (", ".join(cleared[:4]) + " not in the latest scan") if cleared else (cx.get("detail") or "Scan clean")
            _set_gate(report, "Security scan (Checkmarx) clean", "Pass", evidence)
        elif cx and cx.get("result") == "Scan read":
            extra = ("; " + ", ".join(cleared[:3]) + " not in this scan") if cleared else ""
            _set_gate(report, "Security scan (Checkmarx) clean", "Fail", (cx.get("detail") or "Findings still open") + extra)
        elif cx:
            _set_gate(report, "Security scan (Checkmarx) clean", "Not verified", cx.get("detail") or "Not read")
    else:
        _set_gate(report, "Security scan (Checkmarx) clean", "Not verified", "Not required for this ticket type")
    block = {
        "kind": "table",
        "title": proof.get("title") or "Proof",
        "tone": "neutral",
        "provenance": "derived",
        "headers": ["Check", "Result", "Detail"],
        "rows": [
            {"cells": [_esc(r["check"]), _esc(r["result"]), _esc(r["detail"])], "tone": r.get("tone") or "neutral"}
            for r in proof["rows"][:12]
        ],
        "note": "Measured from the systems this ticket type needs. Other systems are left out.",
    }
    for tab in report.get("tabs") or []:
        if tab.get("id") != "evidence":
            continue
        kept = [b for b in (tab.get("blocks") or []) if not str(b.get("title") or "").startswith("Proof")]
        kept.append(block)
        tab["blocks"] = kept
        break
    report["warnings"] = proof.get("warnings") or []
    sources = report.get("sources") or ""
    for label in proof.get("sources") or []:
        if label not in sources:
            sources = (sources + f" · {label}").strip(" ·")
    report["sources"] = sources
    return report


def build_enrich_user(key, ticket, data, base):
    local = local_disk_pack(key, ticket, data)
    live = live_mcp_pack(key, ticket)
    return (
        f"Ticket key: {key}\n\n"
        f"LOCAL DATA (on disk):\n{json.dumps(local, indent=2)[:14000]}\n\n"
        f"LIVE MCP READS:\n{json.dumps(live, indent=2)[:8000]}\n\n"
        f"BASE REPORT verdict: {json.dumps(base.get('verdict'), indent=2)}\n"
        f"BASE warnings: {json.dumps(base.get('warnings'))}\n"
    )


def merge_enrichment(base, extra, generator):
    report = deepcopy(base)
    extra = extra if isinstance(extra, dict) else {}
    summary = (extra.get("verdictSummary") or "").strip()
    if summary:
        report.setdefault("verdict", {})["summary"] = summary
    impact = (extra.get("businessImpact") or "").strip()
    for tab in report.get("tabs") or []:
        if tab.get("id") != "verdict":
            continue
        for block in tab.get("blocks") or []:
            if block.get("kind") == "callout" and block.get("title") == "Decision":
                body = block.get("body") or ""
                line = f"<p><i>{_esc(impact)}</i></p>" if impact else ""
                if line:
                    if re.search(r"<p><i>.*</i></p>\s*$", body):
                        body = re.sub(r"<p><i>.*</i></p>\s*$", line, body)
                    else:
                        body += line
                    block["body"] = body
                    block["note"] = "Business impact added by the AI intern from the ticket text on disk."
    evid_rows = extra.get("evidenceRows") if isinstance(extra.get("evidenceRows"), list) else []
    for tab in report.get("tabs") or []:
        if tab.get("id") != "evidence":
            continue
        for block in tab.get("blocks") or []:
            if block.get("kind") == "table" and "Evidence" in (block.get("title") or "Evidence chain"):
                rows = list(block.get("rows") or [])
                for row in evid_rows[:8]:
                    if not isinstance(row, dict):
                        continue
                    cells = row.get("cells") or []
                    if len(cells) < 3:
                        continue
                    rows.append({"cells": [str(c) for c in cells[:3]], "tone": row.get("tone") or "info"})
                block["rows"] = rows
    files = extra.get("files") if isinstance(extra.get("files"), list) else []
    review = extra.get("reviewFocus") if isinstance(extra.get("reviewFocus"), list) else []
    risks = extra.get("risks") if isinstance(extra.get("risks"), list) else []
    proof = extra.get("productionProof") or "No production evidence: intern has on-disk + Jira/Bitbucket reads, not Dynatrace."
    gate = extra.get("releaseGate") or "unknown"
    file_cards = []
    for f in files[:12]:
        if not isinstance(f, dict):
            continue
        badge = f.get("badge") or "Unrelated"
        file_cards.append({
            "title": f.get("path") or "unknown",
            "badge": badge,
            "badgeTone": BADGE_TONE.get(badge, "neutral"),
            "body": f.get("body") or "",
            "detail": f.get("detail"),
        })
    if not file_cards:
        file_cards.append({
            "title": "Changed files not in the last fetch",
            "badge": "Unrelated",
            "badgeTone": "warning",
            "body": "The intern had no diff/file list. Per-file assessment is skipped.",
            "detail": None,
        })
    req = sum(1 for c in file_cards if c.get("badge") == "Required")
    neu = sum(1 for c in file_cards if c.get("badge") == "Neutral cleanup")
    rsk = sum(1 for c in file_cards if c.get("badge") == "Risky")
    ai_tab = {
        "id": "ai",
        "title": "AI assessment",
        "tone": "violet",
        "blocks": [
            {
                "kind": "stats",
                "title": "Change shape",
                "tone": "violet",
                "provenance": "ai",
                "items": [
                    {"label": "Required", "value": str(req), "tone": "info"},
                    {"label": "Neutral cleanup", "value": str(neu), "tone": "neutral"},
                    {"label": "Risky", "value": str(rsk), "tone": "danger" if rsk else "neutral"},
                ],
            },
            {"kind": "cards", "title": "Per-file", "tone": "violet", "provenance": "ai", "items": file_cards},
            {
                "kind": "list",
                "title": "Review focus",
                "tone": "violet",
                "provenance": "ai",
                "items": [{"text": str(x), "tone": "violet"} for x in review[:5]] or [{"text": "No extra review focus from local data.", "tone": "neutral"}],
            },
            {"kind": "callout", "title": "Production proof", "tone": "neutral", "provenance": "ai", "body": f"<p>{_esc(proof)}</p>"},
            {
                "kind": "kv",
                "title": "Deployment",
                "tone": "violet",
                "provenance": "ai",
                "items": [
                    {"label": "Rollback", "value": "unknown", "tone": "neutral"},
                    {"label": "Release gate", "value": str(gate)[:180], "tone": "violet"},
                ],
            },
            {
                "kind": "table",
                "title": "Risks",
                "tone": "violet",
                "provenance": "ai",
                "headers": ["Risk", "Why", "Mitigation / rollback"],
                "rows": [
                    {"cells": [str(r.get("risk") or ""), str(r.get("why") or ""), str(r.get("mitigation") or "")], "tone": "warning"}
                    for r in risks[:6]
                    if isinstance(r, dict)
                ] or [{"cells": ["None inferred", "Local data had no extra risk signal", "—"], "tone": "neutral"}],
            },
        ],
    }
    tabs = list(report.get("tabs") or [])
    ids = [t.get("id") for t in tabs]
    if "ai" in ids:
        tabs = [ai_tab if t.get("id") == "ai" else t for t in tabs]
    else:
        out = []
        inserted = False
        for t in tabs:
            if t.get("id") == "sources" and not inserted:
                out.append(ai_tab)
                inserted = True
            out.append(t)
        if not inserted:
            out.append(ai_tab)
        tabs = out
    report["tabs"] = tabs
    # Run metadata stays byte-for-byte until pr_report.py mark-enriched.
    # Stamping "AI enrichment" here makes validate_report reject the whole block.
    sources = (report.get("sources") or "").replace("Deterministic — no AI, no live calls.", "").strip().rstrip(".")
    report["sources"] = sources + f" · AI intern ({generator}, local disk + MCP REST)"
    report["warnings"] = [
        "CI, Checkmarx and live Dynatrace were not queried. On-disk intern data plus read-only Jira/Bitbucket (MCP tokens) were."
    ]
    return report


def _esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def validate_and_write(key, report, base_path):
    import pr_report as pr

    t, _ = load_ticket(key)
    base = json.loads(Path(base_path).read_text(encoding="utf-8")) if base_path else None
    errs = pr.validate_report(report, t, base)
    if errs:
        raise RuntimeError("invalid enrichment: " + "; ".join(errs))
    dest = INTERN / "reports" / f"{key}.json"
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    tmp.replace(dest)


def run_pr_tool(*args):
    import subprocess

    r = subprocess.run(["python3", str(INTERN / "pr_report.py"), *args], cwd=str(INTERN.parent), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip() or f"pr_report.py exit {r.returncode}")
    return r.stdout


def enrich_report(job):
    key = job.get("key")
    if not key:
        raise RuntimeError("enrich-report missing key")
    ticket, data = load_ticket(key)
    if not ticket:
        raise RuntimeError(f"{key} not in data.json")
    report_path = INTERN / "reports" / f"{key}.json"
    if not report_path.is_file():
        run_pr_tool("base", key)
    base_copy = INTERN / "reports" / f".base-{key}.json"
    base_copy.write_text(report_path.read_text(encoding="utf-8"))
    run_pr_tool("status-add", key, str(os.getpid()))
    try:
        if stop_requested():
            raise Stopped()
        base = json.loads(report_path.read_text(encoding="utf-8"))
        proof = collect_class_proof(ticket)
        if stop_requested():
            raise Stopped()
        extra, generator = {}, None
        try:
            user = build_enrich_user(key, ticket, data, base)
            raw, generator = infer(job, ENRICH_PROMPT, user)
            extra = extract_json(raw) or {}
            if not extra:
                log(f"{key} model returned no JSON — keeping measured proof")
        except Stopped:
            raise
        except Exception as e:
            log(f"{key} model skipped: {e}")
        merged = merge_enrichment(base, extra, generator or "measured") if extra else deepcopy(base)
        apply_class_proof(merged, proof)
        validate_and_write(key, merged, str(base_copy))
        gen = f"jira-ai-intern · {generator}" if generator else "jira-ai-intern · measured"
        run_pr_tool("mark-enriched", key, "--generator", gen)
        log(f"{key} enriched via {gen} proof={','.join(proof.get('kinds') or []) or 'ci'}")
    except Exception:
        if base_copy.is_file():
            report_path.write_text(base_copy.read_text(encoding="utf-8"), encoding="utf-8")
        raise
    finally:
        try:
            base_copy.unlink()
        except OSError:
            pass
        try:
            run_pr_tool("status-remove", key)
        except Exception:
            pass


def data_writers_busy():
    now = time.time()
    for name in (".intern.lock", ".completed.lock", ".refresh.lock"):
        p = INTERN / name
        try:
            if p.is_file() and now - p.stat().st_mtime < 1200:
                return True
        except OSError:
            continue
    return False


def summarize_active(job):
    waited = 0
    while data_writers_busy() and waited < 60:
        log("summarize-active waiting for fetch lock")
        time.sleep(2)
        waited += 2
    if data_writers_busy():
        log("summarize-active skipped — fetch lock still held")
        return
    data_path = INTERN / "data.json"
    data = json.loads(data_path.read_text(encoding="utf-8"))
    changed = 0
    for t in data.get("tickets") or []:
        last = t.get("lastUpdate") or ""
        at = t.get("aiSummaryAt") or ""
        if at >= last and t.get("aiSummary"):
            continue
        key = t.get("key") or ""
        local = local_disk_pack(key, t, data)
        live = live_mcp_pack(key, t)
        user = (
            f"Ticket key: {key}\n\n"
            f"LOCAL DATA (on disk):\n{json.dumps(local, indent=2)[:8000]}\n\n"
            f"LIVE MCP READS:\n{json.dumps(live, indent=2)[:4000]}\n"
        )
        system = (
            "Write a short HTML brief for this Jira ticket using LOCAL DATA and LIVE MCP READS. "
            "Allowed tags: p b ul li code a. 1 lead paragraph + optional bullets. No invention."
        )
        try:
            raw, _gen = infer(job, system, user)
        except Exception as e:
            log(f"summary skip {t.get('key')}: {e}")
            continue
        html = (raw or "").strip()
        if html.startswith("```"):
            html = re.sub(r"^```(?:html)?", "", html).strip().rstrip("`")
        if "<" not in html:
            html = f"<p>{_esc(html)}</p>"
        t["aiSummary"] = html
        t["aiSummaryAt"] = now_iso()
        changed += 1
        if changed >= 8:
            break
    if changed:
        tmp = data_path.with_suffix(".json.ai-tmp")
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        tmp.replace(data_path)
        sync = INTERN / "local-runner" / "sync-datajs.mjs"
        if sync.is_file():
            import subprocess

            subprocess.run(["node", str(sync), str(INTERN)], cwd=str(INTERN.parent), capture_output=True)
    log(f"summarize-active wrote {changed} brief(s)")


def pull_model(job):
    model = job.get("model") or job.get("modelTag")
    if not model:
        raise RuntimeError("pull-model missing model")
    base = ollama_base(job)
    timeout = timeout_for("full", 1800)
    url = base.rstrip("/") + "/api/pull"
    req = urllib.request.Request(
        url,
        data=json.dumps({"name": model, "stream": True}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    layer_done = {}
    layer_total = {}
    last_write = 0.0
    status = "starting"

    def publish(force=False):
        nonlocal last_write
        now = time.time()
        if not force and now - last_write < 0.4:
            return
        last_write = now
        done = sum(layer_done.values())
        tot = sum(layer_total.values())
        if status == "success":
            pct = 100
        elif tot:
            pct = int(min(100, round(100 * done / tot)))
        else:
            pct = 0
        label = f"{_fmt_bytes(done)} / {_fmt_bytes(tot)}" if tot else (status or "starting")
        ai_queue.write_status({
            "ok": True,
            "state": "pulling",
            "current": {"type": "pull-model", "model": model},
            "lastError": None,
            "pulling": model,
            "pullProgress": {
                "model": model,
                "status": status,
                "completed": done,
                "total": tot,
                "percent": pct,
                "label": label,
            },
        })

    publish(force=True)
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=timeout) as r:
            while True:
                raw = r.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("error"):
                    raise RuntimeError(str(ev["error"]))
                status = ev.get("status") or status
                digest = ev.get("digest")
                if digest:
                    if ev.get("total"):
                        layer_total[digest] = int(ev["total"])
                    if "completed" in ev:
                        layer_done[digest] = int(ev.get("completed") or 0)
                publish()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")
            parsed = json.loads(detail) if detail else {}
            detail = parsed.get("error") or detail
        except Exception:
            pass
        msg = (detail or str(e)).strip()
        log(f"pull {model} failed: {msg}")
        raise RuntimeError(msg) from e
    except Exception as e:
        log(f"pull {model} failed: {e}")
        raise
    status = "success"
    publish(force=True)
    log(f"pulled {model}")


def apply_saved_model(job):
    """Cloud model, provider, and effort come from Settings at run time, not from the queued job."""
    if job.get("backend") != "cloud":
        return job
    settings = ai_queue.load_settings()
    if settings.get("aiBackend") != "cloud":
        return job
    model = (settings.get("aiCloudModel") or "").strip()
    if not model:
        return job
    out = dict(job)
    out["model"] = model
    provider = settings.get("aiCloudProvider")
    if provider in ("claude", "cursor", "gemini"):
        out["cloudProvider"] = provider
    effort = settings.get("aiCloudEffort")
    out["cloudEffort"] = effort if effort in EFFORTS else "low"
    level = settings.get("aiLevel")
    if level in ("none", "low", "moderate", "full"):
        out["level"] = level
    return out


def process_job(job):
    job = apply_saved_model(job)
    typ = job.get("type")
    if typ in ("enrich-report", "summarize-active"):
        if stop_requested():
            raise Stopped()
        level = job.get("level") or ai_queue.load_settings().get("aiLevel") or "moderate"
        if level == "none":
            log(f"skip {typ}: aiLevel none")
            return
    if typ == "enrich-report":
        enrich_report(job)
    elif typ == "summarize-active":
        summarize_active(job)
    elif typ == "pull-model":
        pull_model(job)
    else:
        raise RuntimeError(f"unknown job type {typ}")


_TAGS = {"at": 0, "base": "", "val": None}


def ollama_tags_cached(base):
    now = time.time()
    if _TAGS["val"] is not None and _TAGS["base"] == base and now - _TAGS["at"] < 12:
        return _TAGS["val"]
    val = ollama_tags(base)
    _TAGS.update({"at": now, "base": base, "val": val})
    return val


def snapshot_status(extra=None):
    prev = ai_queue.read_status() or {}
    settings = ai_queue.load_settings()
    use_host = bool(settings.get("aiUseHostOllama"))
    base = HOST_OLLAMA_URL if use_host else OLLAMA_URL
    tags = ollama_tags_cached(base)
    installed = tags if isinstance(tags, list) else []
    ollama_err = tags.get("error") if isinstance(tags, dict) else None
    patch = {
        "ok": True,
        "state": prev.get("state") or "idle",
        "current": prev.get("current"),
        "lastError": prev.get("lastError"),
        "backend": settings.get("aiBackend") or "local",
        "model": (
            settings.get("aiCloudModel")
            if (settings.get("aiBackend") or "local") == "cloud"
            else settings.get("aiLocalModel") or catalog().get("defaultLocal")
        ),
        "cloudProvider": settings.get("aiCloudProvider") if settings.get("aiCloudProvider") in ("claude", "cursor", "gemini") else "cursor",
        "cloudEffort": settings.get("aiCloudEffort") if settings.get("aiCloudEffort") in EFFORTS else "low",
        "useHostOllama": use_host,
        "ollamaOk": isinstance(tags, list),
        "ollamaError": ollama_err,
        "installedModels": installed,
        "catalog": catalog(),
        "memGb": mem_gb(),
        "pulling": prev.get("pulling"),
        "pullProgress": prev.get("pullProgress"),
    }
    if extra:
        patch.update(extra)
    if patch.get("state") != "pulling":
        patch["pulling"] = None
        patch["pullProgress"] = None
    return ai_queue.write_status(patch)


def loop():
    global ACTIVE_JOB_TYPE
    snapshot_status({"state": "idle"})
    log(f"watching {ai_queue.QUEUE_DIR}")
    while not STOP.is_set():
        job, path = ai_queue.claim_next()
        if not job:
            time.sleep(2)
            continue
        job = apply_saved_model(job)
        ACTIVE_JOB_TYPE = job.get("type")
        cur = {"type": job.get("type"), "key": job.get("key"), "model": job.get("model"), "effort": job.get("cloudEffort")}
        if job.get("type") == "pull-model":
            snapshot_status({
                "state": "pulling",
                "current": cur,
                "lastError": None,
                "pulling": job.get("model"),
                "pullProgress": {
                    "model": job.get("model"),
                    "status": "starting",
                    "completed": 0,
                    "total": 0,
                    "percent": 0,
                    "label": "starting",
                },
            })
        else:
            snapshot_status({"state": "working", "current": cur, "lastError": None, "pulling": None, "pullProgress": None})
        try:
            process_job(job)
            snapshot_status({"state": "idle", "current": None, "lastError": None, "pulling": None, "pullProgress": None})
        except Stopped:
            log(f"stopped {job.get('type')} {job.get('key') or ''}".strip())
            snapshot_status({"state": "idle", "current": None, "lastError": None, "pulling": None, "pullProgress": None})
            _release_stop_if_idle()
        except Exception as e:
            log(f"job failed: {e}\n{traceback.format_exc()}")
            snapshot_status({"state": "idle", "current": None, "lastError": str(e), "pulling": None, "pullProgress": None})
        finally:
            ai_queue.finish(path)
            ACTIVE_JOB_TYPE = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log("http " + (fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            return {}
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/api/health"):
            st = snapshot_status()
            return self._json(200, st)
        if path in ("/api/status", "/status"):
            return self._json(200, snapshot_status())
        if path in ("/api/models", "/models"):
            st = snapshot_status()
            return self._json(200, {"ok": True, "catalog": catalog(), "installed": st.get("installedModels") or [], "ollamaOk": st.get("ollamaOk"), "memGb": st.get("memGb")})
        if path in ("/api/cloud-models", "/cloud-models"):
            try:
                return self._json(200, cloud_models())
            except Exception as e:
                return self._json(200, {"ok": False, "error": str(e)[:240]})
        if path in ("/api/jobs", "/jobs"):
            jobs = ai_queue.list_jobs()
            for j in jobs:
                j.pop("_path", None)
            return self._json(200, {"ok": True, "jobs": jobs, "queued": len(jobs)})
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._read()
        if path in ("/api/jobs", "/jobs"):
            try:
                payload = ai_queue.enqueue(body)
            except Exception as e:
                return self._json(400, {"ok": False, "error": str(e)})
            return self._json(202, {"ok": True, "job": payload})
        if path in ("/api/models/pull", "/models/pull"):
            model = body.get("model") or body.get("id")
            if not model:
                return self._json(400, {"ok": False, "error": "missing model"})
            payload = ai_queue.enqueue({"type": "pull-model", "model": model, "useHostOllama": body.get("useHostOllama")})
            return self._json(202, {"ok": True, "job": payload})
        return self._json(404, {"ok": False, "error": "not found"})


def main():
    t = threading.Thread(target=loop, name="ai-queue", daemon=True)
    t.start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"listening on :{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        STOP.set()
        httpd.shutdown()


if __name__ == "__main__":
    main()
