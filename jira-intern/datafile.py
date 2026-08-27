#!/usr/bin/env python3
"""Single writer for the two files the board reads: data.json and data.js.

data.js is what the built app actually loads (window.__JIRA_DATA__), so any script that
updates data.json must regenerate it in the same breath. Keeping that in one place is not
cosmetic: when the archive rebuilt data.json but not data.js, the board kept showing the
previous archive and looked like the rebuild had done nothing.

local-runner/sync-datajs.mjs is the equivalent entry point for the shell runners and must
produce byte-identical output.
"""
import json
import os
import tempfile

from _config import load_config

INTERN = os.path.dirname(os.path.abspath(__file__))


def atomic_write(path, text):
    """Write to a temp file in the same dir, then os.replace() over the target — atomic on
    the same filesystem, so a reader never sees a truncated / half-written file."""
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
    atomic_write(path, json.dumps(obj, indent=2))


def _app_config():
    """The app-facing config slice, exposed so the built board picks up branding and
    thresholds at runtime off file:// without a rebuild."""
    try:
        return load_config(INTERN).get("app")
    except Exception:
        return None


def write_outputs(data):
    """Persist the full dump to data.json and data.js together."""
    atomic_dump(os.path.join(INTERN, "data.json"), data)
    js = (
        "// AUTO-GENERATED from data.json. Do not edit by hand.\n"
        "window.__JIRA_DATA__ = " + json.dumps(data, indent=2) + ";\n"
    )
    cfg = _app_config()
    if cfg is not None:
        js += "window.__JIRA_CONFIG__ = " + json.dumps(cfg, indent=2) + ";\n"
    atomic_write(os.path.join(INTERN, "data.js"), js)
