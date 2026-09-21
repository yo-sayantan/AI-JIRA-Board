#!/usr/bin/env python3
"""File-based job queue for JIRA-AI-Intern.

The board (serve.mjs) and the intern worker share jira-intern/.ai-queue/*.json.
Jobs are one JSON object per file; the intern claims by renaming to .running.

  python3 ai_queue.py enqueue --type enrich-report --key FIDM-1
  python3 ai_queue.py keys
  python3 ai_queue.py status
"""
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE_DIR = os.path.join(HERE, ".ai-queue")
STATUS_FILE = os.path.join(HERE, ".ai-status.json")
SETTINGS_FILE = os.path.join(HERE, ".settings.json")

VALID_TYPES = ("enrich-report", "summarize-active", "pull-model")
VALID_BACKENDS = ("local", "cloud")
VALID_LEVELS = ("none", "low", "moderate", "full")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_settings():
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _ensure_queue():
    os.makedirs(QUEUE_DIR, exist_ok=True)


def enqueue(job):
    _ensure_queue()
    jtype = job.get("type")
    if jtype not in VALID_TYPES:
        raise ValueError(f"bad type {jtype}")
    settings = load_settings()
    backend = job.get("backend") or settings.get("aiBackend") or "local"
    payload = {
        "id": job.get("id") or f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}",
        "type": jtype,
        "key": (job.get("key") or "").upper() or None,
        "modelTag": job.get("modelTag") or job.get("model"),
        "level": job.get("level") or settings.get("aiLevel") or "moderate",
        "backend": backend,
        "model": job.get("model") or (
            settings.get("aiCloudModel") if backend == "cloud"
            else settings.get("aiLocalModel") or "qwen2.5-coder:7b"
        ),
        "useHostOllama": bool(job.get("useHostOllama", settings.get("aiUseHostOllama"))),
        "enqueuedAt": now_iso(),
    }
    if payload["backend"] not in VALID_BACKENDS:
        payload["backend"] = "local"
    if payload["level"] not in VALID_LEVELS:
        payload["level"] = "moderate"
    path = os.path.join(QUEUE_DIR, f"{payload['id']}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return payload


def list_jobs():
    _ensure_queue()
    out = []
    for name in sorted(os.listdir(QUEUE_DIR)):
        if not name.endswith(".json") or name.startswith("."):
            continue
        path = os.path.join(QUEUE_DIR, name)
        try:
            with open(path, encoding="utf-8") as f:
                job = json.load(f)
            job["_path"] = path
            out.append(job)
        except Exception:
            continue
    return out


def queued_keys():
    keys = []
    for job in list_jobs():
        if job.get("type") == "enrich-report" and job.get("key"):
            keys.append(job["key"])
        if job.get("type") == "pull-model" and job.get("model"):
            keys.append(f"pull:{job['model']}")
    st = read_status()
    cur = (st or {}).get("current") or {}
    if cur.get("type") == "enrich-report" and cur.get("key"):
        keys.append(cur["key"])
    return list(dict.fromkeys(keys))


def claim_next():
    """Atomically take the oldest job. Returns (job, running_path) or (None, None)."""
    _ensure_queue()
    for job in list_jobs():
        src = job.get("_path")
        if not src:
            continue
        dst = src + ".running"
        try:
            os.rename(src, dst)
        except OSError:
            continue
        job["_path"] = dst
        return job, dst
    return None, None


def finish(running_path):
    if running_path and os.path.isfile(running_path):
        try:
            os.remove(running_path)
        except OSError:
            pass


def read_status():
    try:
        with open(STATUS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_status(patch):
    cur = read_status() or {}
    cur.update(patch)
    cur["updatedAt"] = now_iso()
    cur["queued"] = len(list_jobs())
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cur, f, indent=2)
        f.write("\n")
    os.replace(tmp, STATUS_FILE)
    return cur


def main(argv):
    if len(argv) < 2:
        print("usage: ai_queue.py enqueue|keys|status|list …", file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "enqueue":
        job = {}
        args = argv[2:]
        i = 0
        while i < len(args):
            a = args[i]
            if a in ("--type", "--key", "--level", "--backend", "--model", "--modelTag") and i + 1 < len(args):
                job[a[2:]] = args[i + 1]
                i += 2
                continue
            if a == "--host-ollama":
                job["useHostOllama"] = True
                i += 1
                continue
            i += 1
        payload = enqueue(job)
        print(payload["id"])
        return 0
    if cmd == "keys":
        for k in queued_keys():
            print(k)
        return 0
    if cmd == "list":
        json.dump(list_jobs(), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    if cmd == "status":
        json.dump(read_status() or {"ok": False, "state": "down"}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
