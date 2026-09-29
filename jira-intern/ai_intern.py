#!/usr/bin/env python3
"""JIRA AI Intern — the AI passes for PR Readiness Reports, in their own container.

    python3 ai_intern.py            (the JIRA-AI-Intern container runs this via local-runner/ai-intern.sh)

WHAT IT DOES. The board's container cannot run any AI, so pr-report.sh inside it writes the
deterministic base report and leaves a marker in reports/.enrich/<KEY>. This loop watches that
folder and enriches each report the way the board's Settings → AI usage says:

  local   a model served by Ollama — the bundled JIRA-LLM container (CPU-only, slow, fully
          contained) or a natively installed Ollama on the Mac via AI_LOCAL_ENDPOINT. Any .gguf
          dropped into jira-intern/models/ is registered with the runtime automatically.
  cloud   Claude (Messages API) or any OpenAI-compatible chat endpoint. Keys come from the
          mounted secrets file (ANTHROPIC_API_KEY / OPENAI_API_KEY). Fast, costs tokens.
  off     nothing is handed off in the first place; stale markers are discarded.

THE CONTRACT. Small models cannot rewrite a whole report reliably, so the model is asked for an
ADDITIVE JSON patch — an "AI assessment" tab, the two gate rows it may fill, extra evidence and
scope rows, a business-impact line — and this file merges it into the base deterministically.
pr_report.py then validates that nothing derived changed (verdict, score, counts, tab order) and
stamps the report enriched; anything invalid restores the base. Never a torn file.

FILES IT WRITES (all under jira-intern/reports/, shared with the board through the bind mount):
  .enricher.alive     heartbeat, rewritten every 5 s — the board shows "AI Intern running"
  .ai-status.json     what it can see: mode, runtime, models, key presence, current task, last result
  <KEY>.json          the enriched report (via pr_report.py's validate + mark-enriched)
Standard library only — nothing to install in the image.
"""
import hashlib
import html
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")
QUEUE = os.path.join(REPORTS, ".enrich")
ALIVE = os.path.join(REPORTS, ".enricher.alive")
STATUS = os.path.join(REPORTS, ".ai-status.json")
SETTINGS = os.path.join(HERE, ".settings.json")
MODELS_DIR = os.path.join(HERE, "models")
REGISTRY = os.path.join(MODELS_DIR, ".registry.json")
LOG_DIR = os.path.join(HERE, "logs")
LOG = os.path.join(LOG_DIR, "ai-intern.log")
PROMPT_FILE = os.path.join(HERE, "prompts", "pr-readiness-llm-prompt.md")
PY = os.path.join(HERE, "pr_report.py")
SYNC = os.path.join(HERE, "local-runner", "sync-reports.mjs")

LOCAL_ENDPOINT = os.environ.get("AI_LOCAL_ENDPOINT", "http://jira-llm:11434").rstrip("/")
OPENAI_BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
ANTHROPIC_BASE = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
POLL_SECONDS = float(os.environ.get("AI_POLL_SECONDS", "4"))

KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")
TONES = {"success", "warning", "danger", "info", "neutral", "violet"}
BLOCK_KINDS = {"callout", "stats", "table", "cards", "list", "timeline", "links", "kv"}
GATE_ROWS = {"ci": "CI green", "security": "Security scan (Checkmarx) clean"}

# Effort (Settings → AI usage) scales how long a model may take and how much evidence it is shown.
EFFORT = {
    "low": {"local_timeout": 1800, "cloud_timeout": 300, "max_tokens": 6000, "anthropic": "low", "diff_local": 12_000, "diff_cloud": 60_000},
    "moderate": {"local_timeout": 3600, "cloud_timeout": 600, "max_tokens": 10000, "anthropic": "medium", "diff_local": 24_000, "diff_cloud": 120_000},
    "full": {"local_timeout": 7200, "cloud_timeout": 900, "max_tokens": 16000, "anthropic": "high", "diff_local": 36_000, "diff_cloud": 240_000},
}
# The largest user message a local model is shown (bytes) — beyond Ollama's context the runtime
# would silently drop the START of the prompt, i.e. the instructions.
LOCAL_PROMPT_BUDGET = 48_000

# The additive patch the model must return. Also handed to Ollama as `format`, which enforces it at
# the token level; the cloud providers get it in the prompt and the parser is forgiving.
PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": ["string", "null"], "description": "One sentence for verdict.summary, or null."},
        "impact": {"type": ["string", "null"], "description": "≤25 words: who is affected and what changes when this ships, citing an evidence row."},
        "gates": {
            "type": "object",
            "properties": {
                "ci": {"type": "object", "properties": {"state": {"type": "string", "enum": ["Pass", "Fail", "Not verified"]}, "evidence": {"type": "string"}}, "required": ["state"]},
                "security": {"type": "object", "properties": {"state": {"type": "string", "enum": ["Pass", "Fail", "Not verified"]}, "evidence": {"type": "string"}}, "required": ["state"]},
            },
        },
        "aiTab": {
            "type": "object",
            "properties": {
                "summary": {"type": ["string", "null"]},
                "blocks": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["blocks"],
        },
        "evidenceRows": {
            "type": "array",
            "items": {"type": "object", "properties": {"source": {"type": "string"}, "observed": {"type": "string"}, "conclusion": {"type": "string"}, "tone": {"type": "string"}}, "required": ["source", "observed", "conclusion"]},
        },
        "scopeRows": {
            "type": "array",
            "items": {"type": "object", "properties": {"item": {"type": "string"}, "state": {"type": "string"}, "owner": {"type": "string"}, "action": {"type": "string"}, "tone": {"type": "string"}}, "required": ["item", "state", "action"]},
        },
        "resolvedWarnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["aiTab"],
}

INSECURE_TLS = ssl._create_unverified_context()  # corporate Bitbucket behind a private CA; cloud APIs stay verified


# ── small utilities ───────────────────────────────────────────────────────────
def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, obj):
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def esc(s):
    return html.escape(str(s or ""), quote=False)


def clip(v, n):
    s = "" if v is None else str(v)
    return s if len(s) <= n else s[: n - 1] + "…"


def tone_of(v, default):
    return v if v in TONES else default


def http(method, url, body=None, headers=None, timeout=60, ctx=None, raw=None):
    """One JSON round-trip with urllib. `raw` sends a file object instead of a JSON body."""
    hdrs = {"Accept": "application/json"}
    hdrs.update(headers or {})
    data = None
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        payload = r.read()
        if not payload:
            return {}
        try:
            return json.loads(payload)
        except ValueError:
            return {"_raw": payload.decode("utf-8", "replace")}


def http_error_text(e):
    if isinstance(e, urllib.error.HTTPError):
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            detail = ""
        return f"HTTP {e.code} {e.reason} {detail}".strip()
    return f"{type(e).__name__}: {e}"


def run_py(*args, timeout=120):
    p = subprocess.run([sys.executable, PY, *args], cwd=HERE, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


# ── settings & status ─────────────────────────────────────────────────────────
def settings():
    """AI usage = None is the off switch (as in the board's Settings); the mode only says which runtime."""
    s = read_json(SETTINGS, {}) or {}
    raw_level = s.get("aiLevel")
    level = raw_level if raw_level in EFFORT else "moderate"
    mode = s.get("aiMode") if s.get("aiMode") in ("local", "cloud") else "cloud"
    if raw_level == "none" or s.get("aiMode") == "off":
        mode = "off"
    return {
        "mode": mode,
        "level": level,
        "localModel": (s.get("aiLocalModel") or "").strip(),
        "provider": s.get("aiCloudProvider") if s.get("aiCloudProvider") in ("anthropic", "openai") else "anthropic",
        "cloudModel": (s.get("aiCloudModel") or "claude-opus-5").strip(),
    }


def vm_info():
    mem = None
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem = round(int(line.split()[1]) / 1_048_576, 1)  # kB → GB
                    break
    except OSError:
        pass
    return {"memGB": mem, "cpus": os.cpu_count()}


STATE = {
    "pid": os.getpid(),
    "startedAt": now_iso(),
    "vm": vm_info(),
    "mode": "off",
    "effort": "moderate",
    "provider": None,
    "model": None,
    "runtime": {"ok": False, "endpoint": None, "models": [], "registered": {}, "keys": {}, "error": None},
    "current": None,
    "queue": [],
    "last": None,
}
STATE_LOCK = threading.Lock()


def write_status():
    with STATE_LOCK:
        snap = dict(STATE)
    snap["updatedAt"] = now_iso()
    try:
        os.makedirs(REPORTS, exist_ok=True)
        write_json_atomic(STATUS, snap)
    except OSError:
        pass


def heartbeat_loop():
    while True:
        try:
            os.makedirs(REPORTS, exist_ok=True)
            with open(ALIVE, "w") as f:
                f.write(f"{os.getpid()} {now_iso()}\n")
            write_status()
        except OSError:
            pass
        time.sleep(5)


def set_state(**kw):
    with STATE_LOCK:
        STATE.update(kw)


def set_runtime(**kw):
    with STATE_LOCK:
        STATE["runtime"].update(kw)


# ── local runtime (Ollama) ────────────────────────────────────────────────────
def ollama_models():
    tags = http("GET", LOCAL_ENDPOINT + "/api/tags", timeout=20)
    return [m.get("name") for m in tags.get("models") or [] if m.get("name")]


def model_name_for(filename):
    base = re.sub(r"\.gguf$", "", filename, flags=re.I).lower()
    base = re.sub(r"[^a-z0-9._-]+", "-", base).strip("-.")
    return base or "model"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_blob(digest, path, size):
    url = f"{LOCAL_ENDPOINT}/api/blobs/sha256:{digest}"
    try:
        http("HEAD", url, timeout=20)
        return
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    with open(path, "rb") as f:
        http("POST", url, raw=f, headers={"Content-Type": "application/octet-stream", "Content-Length": str(size)}, timeout=3600)


def register_gguf_models(models_now):
    """Register every .gguf in jira-intern/models/ with the runtime, once per file version."""
    if not os.path.isdir(MODELS_DIR):
        return {}
    reg = read_json(REGISTRY, {}) or {}
    present = set(models_now) | {m.split(":")[0] for m in models_now}
    changed = False
    for fn in sorted(os.listdir(MODELS_DIR)):
        if not fn.lower().endswith(".gguf"):
            continue
        path = os.path.join(MODELS_DIR, fn)
        try:
            st = os.stat(path)
        except OSError:
            continue
        name = model_name_for(fn)
        entry = reg.get(fn) or {}
        unchanged = entry.get("size") == st.st_size and entry.get("mtime") == int(st.st_mtime)
        if unchanged and name in present:
            continue
        try:
            log(f"registering {fn} with the local runtime as '{name}' (hashing…)")
            digest = entry.get("sha256") if unchanged and entry.get("sha256") else sha256_file(path)
            ensure_blob(digest, path, st.st_size)
            http("POST", LOCAL_ENDPOINT + "/api/create", {"model": name, "files": {fn: f"sha256:{digest}"}, "stream": False}, timeout=1800)
            reg[fn] = {"size": st.st_size, "mtime": int(st.st_mtime), "sha256": digest, "model": name, "registeredAt": now_iso()}
            changed = True
            log(f"'{name}' is ready")
        except Exception as e:  # noqa: BLE001 — one bad file must not stop the others
            reg[fn] = {**entry, "size": st.st_size, "mtime": int(st.st_mtime), "error": http_error_text(e)}
            changed = True
            log(f"could not register {fn}: {http_error_text(e)} — fallback: docker exec JIRA-LLM ollama create {name} -f <Modelfile with FROM /models/{fn}>")
    if changed:
        try:
            write_json_atomic(REGISTRY, reg)
        except OSError:
            pass
    return {fn: e.get("model") or model_name_for(fn) for fn, e in reg.items() if not e.get("error")}


def probe_runtime(cfg):
    keys = {"anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")), "openai": bool(os.environ.get("OPENAI_API_KEY"))}
    if cfg["mode"] == "local":
        try:
            models = ollama_models()
            registered = register_gguf_models(models)
            models = ollama_models() if registered else models
            set_runtime(ok=True, endpoint=LOCAL_ENDPOINT, models=models, registered=registered, keys=keys, error=None)
        except Exception as e:  # noqa: BLE001
            set_runtime(ok=False, endpoint=LOCAL_ENDPOINT, models=[], keys=keys, error=f"local runtime unreachable at {LOCAL_ENDPOINT}: {http_error_text(e)}")
    elif cfg["mode"] == "cloud":
        have = keys.get(cfg["provider"], False)
        endpoint = ANTHROPIC_BASE if cfg["provider"] == "anthropic" else OPENAI_BASE
        set_runtime(ok=have, endpoint=endpoint, models=[], keys=keys,
                    error=None if have else f"no {'ANTHROPIC_API_KEY' if cfg['provider'] == 'anthropic' else 'OPENAI_API_KEY'} in the secrets file")
    else:
        set_runtime(ok=False, endpoint=None, models=[], keys=keys, error=None)


def model_available(cfg):
    """The local model the user picked, resolved against what the runtime lists (name or name:latest)."""
    want = cfg["localModel"]
    if not want:
        return None
    with STATE_LOCK:
        have = list(STATE["runtime"].get("models") or [])
    for m in have:
        if m == want or m.split(":")[0] == want or m == want + ":latest":
            return m
    return None


# ── the model calls ───────────────────────────────────────────────────────────
def call_ollama(model, system, user, effort):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": False,
        "format": PATCH_SCHEMA,
        "think": False,
        "keep_alive": "15m",
        "options": {"temperature": 0, "num_ctx": 16384, "num_predict": min(EFFORT[effort]["max_tokens"], 8000)},
    }
    r = http("POST", LOCAL_ENDPOINT + "/api/chat", body, timeout=EFFORT[effort]["local_timeout"])
    return ((r.get("message") or {}).get("content") or ""), {"eval": r.get("eval_count"), "prompt": r.get("prompt_eval_count")}


def anthropic_supports_effort(model):
    return bool(re.match(r"^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])", model))


def call_anthropic(model, system, user, effort):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    body = {"model": model, "max_tokens": EFFORT[effort]["max_tokens"], "system": system, "messages": [{"role": "user", "content": user}]}
    if anthropic_supports_effort(model):
        body["output_config"] = {"effort": EFFORT[effort]["anthropic"]}
    r = http("POST", ANTHROPIC_BASE + "/v1/messages", body,
             headers={"x-api-key": key, "anthropic-version": "2023-06-01"}, timeout=EFFORT[effort]["cloud_timeout"])
    if r.get("stop_reason") == "refusal":
        raise RuntimeError("the model declined this request (stop_reason=refusal)")
    text = "".join(b.get("text", "") for b in r.get("content") or [] if b.get("type") == "text")
    if r.get("stop_reason") == "max_tokens":
        raise RuntimeError("output truncated at max_tokens — raise the effort level")
    usage = r.get("usage") or {}
    return text, {"in": usage.get("input_tokens"), "out": usage.get("output_tokens")}


def call_openai(model, system, user, effort):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "response_format": {"type": "json_object"}}
    hdrs = {"Authorization": f"Bearer {key}"}
    try:
        r = http("POST", OPENAI_BASE + "/chat/completions", body, headers=hdrs, timeout=EFFORT[effort]["cloud_timeout"])
    except urllib.error.HTTPError as e:
        if e.code != 400:
            raise
        body.pop("response_format", None)  # some gateways reject it — the prompt still demands JSON
        r = http("POST", OPENAI_BASE + "/chat/completions", body, headers=hdrs, timeout=EFFORT[effort]["cloud_timeout"])
    choice = (r.get("choices") or [{}])[0]
    text = ((choice.get("message") or {}).get("content")) or ""
    usage = r.get("usage") or {}
    return text, {"in": usage.get("prompt_tokens"), "out": usage.get("completion_tokens")}


def extract_json(text):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        pass
    i, j = t.find("{"), t.rfind("}")
    if i >= 0 and j > i:
        return json.loads(t[i : j + 1])
    raise ValueError("no JSON object in the model output")


# ── evidence: PR changes and diffs from Bitbucket (the same REST the fetch uses) ─
def bitbucket_evidence(ctx, budget):
    endpoints = ctx.get("endpoints") or {}
    bb = (endpoints.get("bitbucket") or "").rstrip("/")
    tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN")
    ticket = ctx.get("ticket") or {}
    prs = [p for p in (ticket.get("prs") or ([ticket.get("pr")] if ticket.get("pr") else [])) if isinstance(p, dict) and p.get("url")]
    if not prs:
        return "No pull-request URLs on the ticket — assess from the ticket metadata only."
    if not bb or not tok:
        return "Bitbucket diffs unavailable (no BITBUCKET_PAT / endpoint in the container) — assess from the PR metadata in the ticket only; mark file-level claims 'Not verified'."
    hdrs = {"Authorization": f"Bearer {tok}"}
    parts = []
    per_pr = max(4000, budget // min(3, len(prs)))
    for p in prs[:3]:
        m = re.search(r"/projects/([^/]+)/repos/([^/]+)/pull-requests/(\d+)", p["url"])
        if not m:
            continue
        proj, slug, pid = m.groups()
        base = f"{bb}/rest/api/1.0/projects/{proj}/repos/{slug}/pull-requests/{pid}"
        try:
            ch = http("GET", base + "/changes?limit=100", headers=hdrs, timeout=60, ctx=INSECURE_TLS)
            files = [f"{(c.get('path') or {}).get('toString', '?')} ({c.get('type', '?')})" for c in ch.get("values") or []]
        except Exception as e:  # noqa: BLE001
            files = [f"(changed-files list unavailable: {http_error_text(e)})"]
        try:
            d = http("GET", base + "/diff?contextLines=1&withComments=false", headers=hdrs, timeout=120, ctx=INSECURE_TLS)
            diff_text = render_diff(d, per_pr)
        except Exception as e:  # noqa: BLE001
            diff_text = f"(diff unavailable: {http_error_text(e)})"
        parts.append(
            f"## PR #{pid} · {slug} · {p.get('state', '?')} · {clip(p.get('title'), 120)}\n"
            f"Changed files ({len(files)}):\n" + "\n".join(files[:80]) + "\n\nDiff (truncated to fit):\n" + diff_text
        )
    return "\n\n".join(parts) or "No recognisable Bitbucket PR URLs."


def render_diff(d, budget):
    out, used = [], 0
    for df in d.get("diffs") or []:
        path = ((df.get("destination") or df.get("source") or {}).get("toString")) or "?"
        chunk = [f"### {path}"]
        size = 0
        for hunk in df.get("hunks") or []:
            for seg in hunk.get("segments") or []:
                prefix = {"ADDED": "+", "REMOVED": "-"}.get(seg.get("type"), " ")
                for ln in seg.get("lines") or []:
                    line = prefix + (ln.get("line") or "")
                    chunk.append(line)
                    size += len(line) + 1
                    if size > 3000:
                        break
                if size > 3000:
                    break
            if size > 3000:
                chunk.append("… (file diff truncated)")
                break
        text = "\n".join(chunk)
        if used + len(text) > budget:
            out.append(f"… ({len(d.get('diffs') or []) - len(out)} more files not shown)")
            break
        out.append(text)
        used += len(text)
    return "\n".join(out) or "(empty diff)"


# ── prompt ────────────────────────────────────────────────────────────────────
def slim_ticket(t, local):
    """The ticket object, trimmed to what a report needs — descriptions and comment threads are the bulk."""
    t = dict(t or {})
    t.pop("aiSummary", None)
    if t.get("description"):
        t["description"] = clip(re.sub(r"<[^>]+>", " ", t["description"]), 1800 if local else 6000)
    comments = t.get("comments") or []
    keep = 4 if local else 10
    t["comments"] = [{"author": c.get("author"), "when": c.get("when"), "body": clip(re.sub(r"<[^>]+>", " ", c.get("body") or ""), 500)} for c in comments[-keep:]]
    subs = []
    for s in t.get("subtasks") or []:
        subs.append({k: s.get(k) for k in ("key", "title", "status", "column", "assignee", "prs") if k in s})
    if subs:
        t["subtasks"] = subs
    return t


def build_messages(ctx, base, evidence, cfg):
    system = open(PROMPT_FILE, encoding="utf-8").read() if os.path.isfile(PROMPT_FILE) else "Return only a JSON object matching the schema."
    local = cfg["mode"] == "local"
    ticket = slim_ticket(ctx.get("ticket"), local)
    user = (
        f"TODAY: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}. A pull request counts as approved with ≥ {ctx.get('requiredApprovals', 2)} approvals.\n\n"
        f"=== TICKET (from Jira, via the board's data) ===\n{json.dumps(ticket, ensure_ascii=False)}\n\n"
        f"=== DETERMINISTIC BASE REPORT (you may only ADD to it; return the patch, not the report) ===\n{json.dumps(base, ensure_ascii=False)}\n\n"
        f"=== EVIDENCE FROM BITBUCKET ===\n{evidence}\n\n"
        f"=== OUTPUT SCHEMA (return exactly one JSON object shaped like this, nothing else) ===\n{json.dumps(PATCH_SCHEMA)}\n"
    )
    if local and len(user) > LOCAL_PROMPT_BUDGET:
        cut = len(user) - LOCAL_PROMPT_BUDGET
        evidence2 = evidence[: max(2000, len(evidence) - cut)] + "\n… (evidence truncated to fit the local model's context)"
        return build_messages(ctx, base, evidence2, {**cfg, "mode": "local-final"})
    return system, user


# ── merge the patch into the base report ─────────────────────────────────────
def sanitize_items(kind, items):
    out = []
    for it in (items or [])[:20]:
        if not isinstance(it, dict):
            continue
        if kind == "stats" and it.get("label") is not None and it.get("value") is not None:
            out.append({"label": clip(it["label"], 60), "value": clip(it["value"], 80), "tone": tone_of(it.get("tone"), "neutral"), "hint": clip(it.get("hint"), 160) or None})
        elif kind == "cards" and it.get("title") and isinstance(it.get("body"), str):
            out.append({"title": clip(it["title"], 140), "badge": clip(it.get("badge"), 40) or None, "badgeTone": tone_of(it.get("badgeTone"), "violet"),
                        "body": it["body"][:2000], "detail": clip(it.get("detail"), 300) or None, "href": it.get("href") if str(it.get("href") or "").startswith("http") else None})
        elif kind == "list" and it.get("text"):
            out.append({"text": clip(it["text"], 400), "tone": tone_of(it.get("tone"), "violet")})
        elif kind == "timeline" and it.get("label"):
            out.append({"when": clip(it.get("when"), 20) or None, "label": clip(it["label"], 160), "detail": clip(it.get("detail"), 300) or None, "tone": tone_of(it.get("tone"), "violet")})
        elif kind == "links" and it.get("label") and str(it.get("href") or "").startswith("http"):
            out.append({"label": clip(it["label"], 120), "href": str(it["href"])[:500]})
        elif kind == "kv" and it.get("label") is not None and it.get("value") is not None:
            out.append({"label": clip(it["label"], 60), "value": clip(it["value"], 300), "tone": tone_of(it.get("tone"), "neutral"), "href": it.get("href") if str(it.get("href") or "").startswith("http") else None})
    return out


def sanitize_block(b):
    if not isinstance(b, dict) or b.get("kind") not in BLOCK_KINDS:
        return None
    kind = b["kind"]
    out = {"kind": kind, "title": clip(b.get("title") or "AI assessment", 120), "tone": tone_of(b.get("tone"), "violet"), "provenance": "ai"}
    if b.get("note"):
        out["note"] = clip(b["note"], 200)
    if kind == "callout":
        body = b.get("body")
        if not isinstance(body, str) or not body.strip():
            return None
        out["body"] = body[:4000]
    elif kind == "table":
        headers = [clip(h, 60) for h in (b.get("headers") or []) if h is not None][:8]
        rows = []
        for r in (b.get("rows") or [])[:30]:
            cells = r.get("cells") if isinstance(r, dict) else r
            if not isinstance(cells, list) or not headers:
                continue
            cells = [clip(c, 300) for c in cells][: len(headers)]
            cells += [""] * (len(headers) - len(cells))
            rows.append({"cells": cells, "tone": tone_of(r.get("tone") if isinstance(r, dict) else None, "neutral")})
        if not headers or not rows:
            return None
        out["headers"], out["rows"] = headers, rows
    else:
        items = sanitize_items(kind, b.get("items"))
        if not items:
            return None
        out["items"] = items
        if kind == "list" and b.get("ordered"):
            out["ordered"] = True
    return out


def find_block(tabs, tab_id, title):
    for tb in tabs:
        if tb.get("id") == tab_id:
            for blk in tb.get("blocks") or []:
                if blk.get("title") == title:
                    return blk
    return None


def apply_patch(base, patch, provider, model):
    r = json.loads(json.dumps(base))  # deep copy
    tabs = r.get("tabs") or []
    notes = []

    gates = patch.get("gates") if isinstance(patch.get("gates"), dict) else {}
    gate_table = find_block(tabs, "verdict", "Gate checklist")
    if gate_table:
        for key, row_name in GATE_ROWS.items():
            g = gates.get(key) if isinstance(gates.get(key), dict) else None
            if not g or g.get("state") not in ("Pass", "Fail"):
                continue
            for row in gate_table.get("rows") or []:
                cells = row.get("cells") or []
                if cells and cells[0] == row_name:
                    cells[1] = g["state"]
                    cells[2] = clip(g.get("evidence") or "stated by the AI pass", 200)
                    row["tone"] = "success" if g["state"] == "Pass" else "warning"
                    notes.append(f"gate {row_name} → {g['state']}")

    impact = patch.get("impact")
    if isinstance(impact, str) and impact.strip():
        decision = find_block(tabs, "verdict", "Decision")
        if decision and isinstance(decision.get("body"), str):
            body = decision["body"]
            idx = body.rfind("<p><i>")
            if idx >= 0 and body.rstrip().endswith("</i></p>"):
                decision["body"] = body[:idx] + f"<p><i>{esc(clip(impact, 260))}</i></p>"
                notes.append("impact line")

    summary = patch.get("summary")
    if isinstance(summary, str) and summary.strip():
        r.setdefault("verdict", {})["summary"] = clip(summary, 300)

    ev = find_block(tabs, "evidence", "Evidence chain")
    if ev and isinstance(patch.get("evidenceRows"), list):
        n = len(ev.get("headers") or [])
        for row in patch["evidenceRows"][:12]:
            if not isinstance(row, dict) or not row.get("source"):
                continue
            cells = [clip(row.get("source"), 80), clip(row.get("observed"), 300), clip(row.get("conclusion"), 300)][:n]
            cells += [""] * (n - len(cells))
            ev.setdefault("rows", []).append({"cells": cells, "tone": tone_of(row.get("tone"), "violet")})
        notes.append(f"{min(12, len(patch['evidenceRows']))} evidence rows")

    scope = find_block(tabs, "scope", "What still blocks closure")
    if scope and isinstance(patch.get("scopeRows"), list):
        n = len(scope.get("headers") or [])
        for row in patch["scopeRows"][:8]:
            if not isinstance(row, dict) or not row.get("item"):
                continue
            cells = [clip(row.get("item"), 120), clip(row.get("state"), 60), clip(row.get("owner") or "—", 60), clip(row.get("action"), 200), "No"][:n]
            cells += [""] * (n - len(cells))
            scope.setdefault("rows", []).append({"cells": cells, "tone": tone_of(row.get("tone"), "info")})
        notes.append(f"{min(8, len(patch['scopeRows']))} scope rows")

    ai_tab = patch.get("aiTab") if isinstance(patch.get("aiTab"), dict) else {}
    blocks = [b for b in (sanitize_block(x) for x in (ai_tab.get("blocks") or [])[:14]) if b]
    if blocks:
        tab = {"id": "ai", "title": "AI assessment", "tone": "violet", "summary": clip(ai_tab.get("summary"), 240) or None, "blocks": blocks}
        tabs = [tb for tb in tabs if tb.get("id") != "ai"]
        idx = next((i for i, tb in enumerate(tabs) if tb.get("id") == "sources"), len(tabs))
        tabs.insert(idx, tab)
        r["tabs"] = tabs
        notes.append(f"AI tab with {len(blocks)} blocks")

    resolved = {w for w in (patch.get("resolvedWarnings") or []) if isinstance(w, str)}
    if resolved:
        r["warnings"] = [w for w in (r.get("warnings") or []) if w not in resolved]

    r["sources"] = f"{base.get('sources') or 'Jira · Bitbucket'} · AI: {provider} {model}"
    return r, notes


# ── one hand-off ──────────────────────────────────────────────────────────────
def process(key, cfg):
    effort = cfg["level"]
    if cfg["mode"] == "local":
        provider, model = "local", model_available(cfg)
    else:
        provider, model = cfg["provider"], cfg["cloudModel"]
    set_state(current=key, provider=provider, model=model)
    run_py("status-add", key, str(os.getpid()))
    base_copy = os.path.join(REPORTS, f".base-{key}.json")
    started = time.time()
    try:
        code, out, err = run_py("context", key)
        if code != 0:
            raise RuntimeError(f"context: {err.strip() or out.strip() or code}")
        ctx = json.loads(out)
        report_path = os.path.join(REPORTS, f"{key}.json")
        if not os.path.isfile(report_path):
            code, out, err = run_py("base", key)
            if code != 0:
                raise RuntimeError(f"no base report: {err.strip() or code}")
        base = read_json(report_path)
        if not base:
            raise RuntimeError("base report unreadable")
        shutil.copyfile(report_path, base_copy)

        budget = EFFORT[effort]["diff_local" if cfg["mode"] == "local" else "diff_cloud"]
        evidence = bitbucket_evidence(ctx, budget)
        system, user = build_messages(ctx, base, evidence, cfg)
        log(f"{key}: asking {provider} {model} (effort {effort}, prompt {len(user)//1000} kB)")

        if cfg["mode"] == "local":
            text, usage = call_ollama(model, system, user, effort)
        elif provider == "anthropic":
            text, usage = call_anthropic(model, system, user, effort)
        else:
            text, usage = call_openai(model, system, user, effort)
        try:
            patch = extract_json(text)
        except ValueError:
            log(f"{key}: output was not JSON — asking once more")
            retry_user = user + "\n\nYour previous answer was not a JSON object. Return ONLY the JSON object, no prose, no code fences."
            if cfg["mode"] == "local":
                text, usage = call_ollama(model, system, retry_user, effort)
            elif provider == "anthropic":
                text, usage = call_anthropic(model, system, retry_user, effort)
            else:
                text, usage = call_openai(model, system, retry_user, effort)
            patch = extract_json(text)
        if not isinstance(patch, dict):
            raise ValueError("model returned a JSON value that is not an object")

        enriched, notes = apply_patch(base, patch, provider, model)
        write_json_atomic(report_path, enriched)
        code, out, err = run_py("validate", key, "--base", base_copy)
        if code != 0:
            raise RuntimeError(f"enriched report rejected: {(err or out).strip()[:300]}")
        run_py("mark-enriched", key)
        rep = read_json(report_path) or enriched
        rep["generator"] = f"ai-intern · {provider} · {model}"
        write_json_atomic(report_path, rep)
        secs = int(time.time() - started)
        detail = f"{', '.join(notes) or 'no additions'} · {secs}s · tokens {usage}"
        log(f"{key}: enriched ({detail})")
        set_state(last={"key": key, "ok": True, "at": now_iso(), "detail": detail})
    except Exception as e:  # noqa: BLE001 — restore the base, report, move on
        msg = http_error_text(e) if isinstance(e, urllib.error.URLError) else f"{type(e).__name__}: {e}"
        log(f"{key}: FAILED — {msg}\n{traceback.format_exc(limit=3)}")
        if os.path.isfile(base_copy):
            try:
                shutil.copyfile(base_copy, os.path.join(REPORTS, f"{key}.json"))
            except OSError:
                pass
        set_state(last={"key": key, "ok": False, "at": now_iso(), "detail": clip(msg, 400)})
    finally:
        for p in (base_copy, os.path.join(REPORTS, f".ctx-{key}.json")):
            try:
                os.remove(p)
            except OSError:
                pass
        run_py("status-remove", key)
        set_state(current=None)
        if os.path.isfile(SYNC) and shutil.which("node"):
            subprocess.run(["node", SYNC, HERE], cwd=HERE, capture_output=True, timeout=120)


def pending_keys():
    try:
        names = sorted(os.listdir(QUEUE))
    except OSError:
        return []
    return [n for n in names if KEY_RE.match(n)]


def waiting_reason(cfg):
    """Why a hand-off cannot be served right now (None = go ahead). The marker stays queued."""
    with STATE_LOCK:
        rt = dict(STATE["runtime"])
    if cfg["mode"] == "local":
        if not rt.get("ok"):
            return rt.get("error") or "local runtime unreachable"
        if not cfg["localModel"]:
            return "no local model chosen in Settings → AI usage"
        if not model_available(cfg):
            return f"model '{cfg['localModel']}' is not available in the local runtime (models: {', '.join(rt.get('models') or []) or 'none'})"
        return None
    if cfg["mode"] == "cloud":
        return None if rt.get("ok") else (rt.get("error") or "cloud key missing")
    return None


def main():
    os.makedirs(QUEUE, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    log(f"AI Intern started (pid {os.getpid()}) — VM {STATE['vm']}, local runtime {LOCAL_ENDPOINT}")

    # Self-heal: a report left half-written by a killed run sits next to its saved base.
    for fn in os.listdir(REPORTS) if os.path.isdir(REPORTS) else []:
        if fn.startswith(".base-") and fn.endswith(".json"):
            key = fn[len(".base-") : -len(".json")]
            code, _, _ = run_py("validate", key, "--base", os.path.join(REPORTS, fn))
            if code != 0:
                shutil.copyfile(os.path.join(REPORTS, fn), os.path.join(REPORTS, f"{key}.json"))
                log(f"restored {key} from its saved base (previous enrichment was interrupted)")
            os.remove(os.path.join(REPORTS, fn))

    last_probe = 0.0
    last_wait_log = ""
    waiting_since = None  # when the current "cannot serve" reason first appeared
    GRACE = 120  # seconds a hand-off may wait for a runtime that is still coming up
    while True:
        cfg = settings()
        set_state(mode=cfg["mode"], effort=cfg["level"],
                  provider="local" if cfg["mode"] == "local" else (cfg["provider"] if cfg["mode"] == "cloud" else None),
                  model=(cfg["localModel"] or None) if cfg["mode"] == "local" else (cfg["cloudModel"] if cfg["mode"] == "cloud" else None))
        if time.time() - last_probe > 30:
            probe_runtime(cfg)
            last_probe = time.time()
        keys = pending_keys()
        set_state(queue=keys)
        if keys:
            if cfg["mode"] == "off":
                for k in keys:
                    os.remove(os.path.join(QUEUE, k))
                log(f"AI usage is None — discarded {len(keys)} stale hand-off(s): {', '.join(keys)}")
            else:
                reason = waiting_reason(cfg)
                if reason:
                    if reason != last_wait_log:
                        log(f"{len(keys)} hand-off(s) waiting — {reason}")
                        last_wait_log = reason
                        waiting_since = time.time()
                    set_runtime(error=reason)
                    # A runtime that is merely starting deserves a moment; a missing key or model does not
                    # fix itself. Past the grace period the reports go back to the board deterministic,
                    # with the reason in their footer, instead of showing "generating" indefinitely.
                    if waiting_since and time.time() - waiting_since > GRACE:
                        for k in keys:
                            try:
                                os.remove(os.path.join(QUEUE, k))
                            except OSError:
                                pass
                            run_py("status-remove", k)
                        set_state(last={"key": keys[-1], "ok": False, "at": now_iso(), "detail": clip(reason, 400)})
                        log(f"gave up on {len(keys)} hand-off(s) after {GRACE}s — {reason}")
                        waiting_since = None
                else:
                    last_wait_log = ""
                    waiting_since = None
                    key = keys[0]
                    try:
                        os.remove(os.path.join(QUEUE, key))
                    except OSError:
                        pass
                    process(key, cfg)
                    probe_runtime(cfg)
                    last_probe = time.time()
                    continue  # straight on to the next one
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
