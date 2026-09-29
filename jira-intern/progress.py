#!/usr/bin/env python3
"""Live progress file for the board's refresh buttons.

Writers (daily_fetch / completed_archive) update jira-intern/.progress.json as they go.
serve.mjs reads it into /api/intern-status so the UI can fill the button left→right.
"""
import json
import os
from datetime import datetime, timezone

from datafile import atomic_write

INTERN = os.path.dirname(os.path.abspath(__file__))
PROGRESS_PATH = os.path.join(INTERN, ".progress.json")


def set_progress(job, *, done=0, total=0, phase="", current=None, pct=None):
    """Overwrite the progress snapshot. `done`/`total` drive the button fill; `phase`/`current`
    are for the label. `pct` can represent weighted multi-phase progress while done/total
    remain the truthful count for the current phase. Safe to call from many threads."""
    total = max(0, int(total or 0))
    done = max(0, min(int(done or 0), total if total else int(done or 0)))
    if pct is None:
        pct = 100.0 * done / total if total > 0 else 0.0
    pct = round(max(0.0, min(100.0, float(pct))), 1)
    payload = {
        "job": job,  # "daily" | "archive"
        "phase": phase or "",
        "done": done,
        "total": total,
        "pct": pct,
        "current": current,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    try:
        atomic_write(PROGRESS_PATH, json.dumps(payload))
    except Exception:
        pass  # never fail the fetch because the progress file couldn't write


def clear_progress():
    try:
        if os.path.isfile(PROGRESS_PATH):
            os.remove(PROGRESS_PATH)
    except Exception:
        pass
