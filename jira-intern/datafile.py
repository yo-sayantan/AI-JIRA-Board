#!/usr/bin/env python3
"""Single writer for the two files the board reads: data.json and data.js.

data.js is what the built app actually loads (window.__JIRA_DATA__), so any script that
updates data.json must regenerate it in the same breath. Keeping that in one place is not
cosmetic: when the archive rebuilt data.json but not data.js, the board kept showing the
previous archive and looked like the rebuild had done nothing.

local-runner/sync-datajs.mjs is the equivalent entry point for the shell runners and must
produce byte-identical output — hence ensure_ascii=False everywhere here: JSON.stringify
writes "é ☕" raw, and a Python dump that wrote "\\u00e9" instead changed the bytes (and the
board's ETag) on every alternate run without a single value changing.

Every writer also takes the advisory lock on .data.lock, so the daily fetch, the archive and a
single-ticket refresh — launched from any container or launcher — never interleave a
read-modify-write of data.json.
"""
import json
import os
import tempfile
import threading
from contextlib import contextmanager

try:
    import fcntl
except ImportError:  # Windows — no flock; the shell runners' pid locks still apply
    fcntl = None

from _config import load_config

INTERN = os.path.dirname(os.path.abspath(__file__))
LOCK_NAME = ".data.lock"

_lock_state = threading.local()


def lock_path(intern_dir=None):
    return os.path.join(intern_dir or INTERN, LOCK_NAME)


@contextmanager
def data_lock(intern_dir=None):
    """Exclusive advisory lock around any read-modify-write of data.json / data.js.

    flock() is per open file, so taking it twice from one thread would deadlock — writers
    nest (upsert → write_outputs), hence the per-thread depth counter makes it re-entrant.
    A no-op where fcntl is unavailable, so the module stays importable on Windows.
    """
    if fcntl is None:
        yield
        return
    depth = getattr(_lock_state, "depth", 0)
    if depth:
        _lock_state.depth = depth + 1
        try:
            yield
        finally:
            _lock_state.depth -= 1
        return
    fd = os.open(lock_path(intern_dir), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        _lock_state.depth = 1
        try:
            yield
        finally:
            _lock_state.depth = 0
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def dumps(obj, indent=2):
    """The one JSON shape every writer uses — must match JSON.stringify(obj, null, 2)."""
    return json.dumps(obj, indent=indent, ensure_ascii=False)


def atomic_write(path, text):
    """Write to a temp file in the same dir, then os.replace() over the target — atomic on
    the same filesystem, so a reader never sees a truncated / half-written file. If anything
    fails before the replace (disk full, fsync error) the target is left exactly as it was."""
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
    atomic_write(path, dumps(obj))


def read_json(path, default=None):
    """Parse a JSON file; `default` when it is missing. A corrupt file still raises."""
    if not os.path.isfile(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _app_config():
    """Safe non-secret config exposed to the built board at runtime (same keys, same order as
    sync-datajs.mjs)."""
    try:
        cfg = load_config(INTERN)
        return {
            **(cfg.get("app") or {}),
            "reports": cfg.get("reports") or {},
            "archive": cfg.get("archive") or {},
            "ai": cfg.get("ai") or {},
            "schedule": cfg.get("schedule") or {},
            "refresh": cfg.get("refresh") or {},
        }
    except Exception:
        return None


def prepend_status(note, intern_dir=None):
    """Newest-first audit log of intern runs (_STATUS.md)."""
    path = os.path.join(intern_dir or INTERN, "_STATUS.md")
    old = ""
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            old = f.read()
    atomic_write(path, f"{note}\n\n{old}")


def render_data_js(data):
    js = "// AUTO-GENERATED from data.json. Do not edit by hand.\n" "window.__JIRA_DATA__ = " + dumps(data) + ";\n"
    cfg = _app_config()
    if cfg is not None:
        js += "window.__JIRA_CONFIG__ = " + dumps(cfg) + ";\n"
    return js


def write_outputs(data, intern_dir=None):
    """Persist the full dump to data.json and data.js together, under the data lock."""
    d = intern_dir or INTERN
    with data_lock(d):
        atomic_dump(os.path.join(d, "data.json"), data)
        atomic_write(os.path.join(d, "data.js"), render_data_js(data))
