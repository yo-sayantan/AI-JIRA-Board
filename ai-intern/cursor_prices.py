"""Cursor's published model prices, and how a model is matched to its row.

cursor.com/docs/models-and-pricing lists every model with its price, under DISPLAY NAMES;
cursor-prices.json is that table (and feeds the guide's price page). WHICH models the board offers is not
decided here — that is cloud-models.json (cloud_config.py), which uses this table to fill in a price the
entry leaves out and to resolve a model's name against the ids in your key's Cursor catalog.

Matching is the fragile part: the same model is `claude-sonnet-5-5` on one docs page,
`claude-sonnet-5.5` elsewhere and "Claude Sonnet 5.5" in a display name. So models are matched on a
NORMALISED key (lower-case letters and digits only) taken from the id, display name and aliases, never
on a hand-typed id.

Pure functions only (no network; the price table is the one cached value), so tests/ can import it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRICES_PATH = HERE / "cursor-prices.json"

# A variant marker the catalog may append to a base model's id; it bills as the base model.
# "max" is deliberately NOT here: "GPT-5.1 Codex Max" is a model in its own right.
_VARIANT_SUFFIX = re.compile(r"(thinking|reasoning|high|medium|low)$")
_TABLE = {"mtime": None, "val": None}


def norm(text) -> str:
    """'GPT-5.6 Luna', 'gpt-5.6-luna' and 'gpt_5_6_luna' all become 'gpt56luna'."""
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())


def loose(text) -> str:
    """Word-order-blind key: 'claude-haiku-4-5' and 'Claude 4.5 Haiku' both become 'claude haiku|45'.

    The words are sorted; the digit groups keep their order, so 4.5 and 5.4 stay different models.
    Tried only after the exact normalised keys, so it can add matches but never change one.
    """
    tokens = re.findall(r"[a-z]+[a-z0-9]*|[0-9]+", str(text or "").lower())
    words = sorted(t for t in tokens if not t.isdigit())
    digits = "".join(t for t in tokens if t.isdigit())
    return f"{' '.join(words)}|{digits}" if words and digits else ""


def load_prices(path: Path = PRICES_PATH) -> dict:
    """The price table, re-read when the file changes so an edit needs no restart."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {"models": [], "checked": None, "source": None, "_index": {}, "_loose": {}}
    if _TABLE["mtime"] != mtime or _TABLE["val"] is None:
        data = json.loads(path.read_text(encoding="utf-8"))
        index, loose_index = {}, {}
        for entry in data.get("models") or []:
            for key in (norm(entry.get("name")), norm(entry.get("modelId"))):
                if key:
                    index.setdefault(key, entry)
            for key in (loose(entry.get("name")), loose(entry.get("modelId"))):
                if key:
                    loose_index.setdefault(key, entry)
        data["_index"] = index
        data["_loose"] = loose_index
        _TABLE.update(mtime=mtime, val=data)
    return _TABLE["val"]


def _keys(model: dict):
    """Every spelling of this catalog model worth trying, most specific first."""
    seen = []
    for s in _spellings(model):
        k = norm(s)
        if not k or k in seen:
            continue
        seen.append(k)
        base = k
        while _VARIANT_SUFFIX.search(base):  # "…-high-thinking" loses both markers
            base = _VARIANT_SUFFIX.sub("", base)
            if base and base not in seen:
                seen.append(base)
    return seen


def _spellings(model: dict):
    spellings = [model.get("id"), model.get("label") or model.get("displayName")]
    return spellings + list(model.get("aliases") or [])


def price_of(model: dict, table: dict | None = None):
    """The price-table entry for a catalog model, or None when it is not priced there."""
    table = table or load_prices()
    for key in _keys(model):
        if key in table["_index"]:
            return table["_index"][key]
    for spelling in _spellings(model):  # last resort: same words in a different order
        key = loose(spelling)
        if key and key in table["_loose"]:
            return table["_loose"][key]
    return None


def _usd(entry: dict) -> dict:
    return {
        "input": entry.get("input"),
        "cacheWrite": entry.get("cacheWrite"),
        "cacheRead": entry.get("cacheRead"),
        "output": entry.get("output"),
    }
