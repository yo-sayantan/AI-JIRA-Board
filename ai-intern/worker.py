#!/usr/bin/env python3
"""JIRA-AI-Intern worker: HTTP control plane + file-queue consumer.

Listens on PORT (default 4322). Polls jira-intern/.ai-queue for enrich-report,
summarize-active, and pull-model jobs. Local inference is Ollama (compose
service or host.docker.internal); cloud is OpenAI / Anthropic / OpenAI-compat.
"""
from __future__ import annotations

import json
import os
import re
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTERN = Path(os.environ.get("INTERN_DIR") or str(HERE.parent / "jira-intern")).resolve()
sys.path.insert(0, str(INTERN))

import ai_queue  # noqa: E402
from _config import load_config  # noqa: E402

PORT = int(os.environ.get("PORT") or 4322)
OLLAMA_URL = os.environ.get("OLLAMA_HOST") or "http://ollama:11434"
HOST_OLLAMA_URL = os.environ.get("HOST_OLLAMA_URL") or "http://host.docker.internal:11434"
SECRETS = Path(os.environ.get("AGENT_SECRETS") or os.path.expanduser("~/.cursor/mcp-secrets.env"))
CATALOG_PATH = HERE / "models.json"
ENRICH_PROMPT = (HERE / "prompts" / "enrich.txt").read_text(encoding="utf-8")
CTX = ssl.create_default_context()
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
    env = {}
    if not SECRETS.is_file():
        return env
    try:
        for line in SECRETS.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


SECRETS_ENV = load_secrets()


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
            "model": model or "claude-3-5-haiku-latest",
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


def infer(job, system, user):
    timeout = timeout_for(job.get("level") or "moderate")
    backend = job.get("backend") or "local"
    model = job.get("model") or "qwen2.5-coder:7b"
    if backend == "cloud":
        cfg = load_config(str(INTERN))
        models = cfg.get("models") or {}
        model = job.get("model") or models.get("report") or models.get("summary") or "gpt-4o-mini"
        if model in ("auto", "", None):
            model = "gpt-4o-mini"
        openai_key = SECRETS_ENV.get("OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
        anthropic_key = SECRETS_ENV.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
        compat = os.environ.get("OPENAI_BASE_URL") or (cfg.get("ai") or {}).get("baseUrl")
        if anthropic_key and "claude" in str(model).lower():
            return chat_anthropic(model, system, user, timeout, anthropic_key), f"cloud · {model}"
        if openai_key:
            return chat_openai(model, system, user, timeout, openai_key, compat or "https://api.openai.com/v1"), f"cloud · {model}"
        if anthropic_key:
            return chat_anthropic(model, system, user, timeout, anthropic_key), f"cloud · {model}"
        raise RuntimeError("Cloud AI selected but no OPENAI_API_KEY or ANTHROPIC_API_KEY in secrets")
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
    proof = extra.get("productionProof") or "No production evidence: file-only AI intern has no Dynatrace access."
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
    for tab in tabs:
        if tab.get("id") != "sources":
            continue
        for block in tab.get("blocks") or []:
            for it in block.get("items") or []:
                if isinstance(it, dict) and it.get("label") == "AI enrichment":
                    it["value"] = f"run · {generator}"
                    it["tone"] = "violet"
    report["sources"] = (report.get("sources") or "") + f" · AI intern ({generator}, file-only)"
    report["warnings"] = [
        "CI, Checkmarx and live production telemetry were not queried (file-only AI). Those gates stay Not verified."
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
    ticket, _ = load_ticket(key)
    if not ticket:
        raise RuntimeError(f"{key} not in data.json")
    report_path = INTERN / "reports" / f"{key}.json"
    if not report_path.is_file():
        run_pr_tool("base", key)
    base_copy = INTERN / "reports" / f".base-{key}.json"
    base_copy.write_text(report_path.read_text(encoding="utf-8"))
    run_pr_tool("status-add", key, str(os.getpid()))
    try:
        base = json.loads(report_path.read_text(encoding="utf-8"))
        user = (
            f"Ticket key: {key}\n\nTICKET JSON:\n{json.dumps(compact_ticket(ticket), indent=2)[:18000]}\n\n"
            f"BASE REPORT verdict: {json.dumps(base.get('verdict'), indent=2)}\n"
            f"BASE warnings: {json.dumps(base.get('warnings'))}\n"
        )
        raw, generator = infer(job, ENRICH_PROMPT, user)
        extra = extract_json(raw)
        if not extra:
            raise RuntimeError("model did not return JSON")
        merged = merge_enrichment(base, extra, generator)
        validate_and_write(key, merged, str(base_copy))
        run_pr_tool("mark-enriched", key, "--generator", f"jira-ai-intern · {generator}")
        log(f"{key} enriched via {generator}")
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
        snippet = json.dumps(compact_ticket(t), indent=2)[:8000]
        system = (
            "Write a short HTML brief for this Jira ticket using ONLY the JSON. "
            "Allowed tags: p b ul li code a. 1 lead paragraph + optional bullets. No invention."
        )
        try:
            raw, _gen = infer(job, system, snippet)
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
    ai_queue.write_status({"ok": True, "state": "pulling", "current": {"type": "pull-model", "model": model}, "lastError": None, "pulling": model})
    http_json(base.rstrip("/") + "/api/pull", {"name": model, "stream": False}, timeout=timeout_for("full", 1800))
    log(f"pulled {model}")


def process_job(job):
    typ = job.get("type")
    if typ in ("enrich-report", "summarize-active"):
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
        "model": settings.get("aiLocalModel") or catalog().get("defaultLocal"),
        "useHostOllama": use_host,
        "ollamaOk": isinstance(tags, list),
        "ollamaError": ollama_err,
        "installedModels": installed,
        "catalog": catalog(),
        "memGb": mem_gb(),
        "pulling": prev.get("pulling"),
    }
    if extra:
        patch.update(extra)
    return ai_queue.write_status(patch)


def loop():
    snapshot_status({"state": "idle"})
    log(f"watching {ai_queue.QUEUE_DIR}")
    while not STOP.is_set():
        job, path = ai_queue.claim_next()
        if not job:
            time.sleep(2)
            continue
        cur = {"type": job.get("type"), "key": job.get("key"), "model": job.get("model")}
        snapshot_status({"state": "working", "current": cur, "lastError": None})
        try:
            process_job(job)
            snapshot_status({"state": "idle", "current": None, "lastError": None})
        except Exception as e:
            log(f"job failed: {e}\n{traceback.format_exc()}")
            snapshot_status({"state": "idle", "current": None, "lastError": str(e)})
        finally:
            ai_queue.finish(path)


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
