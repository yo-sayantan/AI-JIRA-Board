"""Which Cursor models the board offers, and what they cost.

Cursor's `GET /v1/models` returns the catalog for the API key's account and team, with ids in
Cursor's own format. cursor.com/docs/models-and-pricing lists every model with its price, under
DISPLAY NAMES. The board offers a model only when it is in the key's catalog AND priced at or
under `maxOutputUsd` per 1M output tokens (cursor-prices.json).

Joining the two is the fragile part: the same model is `claude-sonnet-5-5` on one docs page,
`claude-sonnet-5.5` elsewhere and "Claude Sonnet 5.5" in a display name. So models are matched on a
NORMALISED key (lower-case letters and digits only) taken from the catalog's id, display name and
aliases, never on a hand-typed id. A catalog model that cannot be matched is reported (`unpriced`),
not silently dropped — a silent drop is what once left the Settings list with three entries.

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
# Providers in the order the Settings dropdown groups them.
PROVIDER_ORDER = ("Cursor", "Anthropic", "OpenAI", "Google", "Z.ai", "Moonshot", "Meta")

# Cursor's automatic model pickers: whatever they route to sets the price, so none is on file.
ROUTER = re.compile(r"^(default|auto)(-|$)", re.I)

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
        return {"maxOutputUsd": 10, "models": [], "checked": None, "source": None, "_index": {}, "_loose": {}}
    if _TABLE["mtime"] != mtime or _TABLE["val"] is None:
        data = json.loads(path.read_text(encoding="utf-8"))
        data.setdefault("maxOutputUsd", 10)
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


def is_fast(model: dict) -> bool:
    return bool(re.search(r"(^|[^a-z])fast([^a-z]|$)", f"{model.get('id') or ''} {model.get('label') or ''}", re.I))


def _usd(entry: dict) -> dict:
    return {
        "input": entry.get("input"),
        "cacheWrite": entry.get("cacheWrite"),
        "cacheRead": entry.get("cacheRead"),
        "output": entry.get("output"),
    }


def publish(models: list, table: dict | None = None):
    """(models to offer, diagnostics) from the key's catalog.

    Each offered model carries `provider`, `price` and `priceName`. Sorted by provider, then
    cheapest output first. Diagnostics say what was left out and why, so the board can show
    "14 shown · 9 over $10 · 3 unpriced" instead of a list that is mysteriously short.
    """
    table = table or load_prices()
    cap = float(table.get("maxOutputUsd", 10))
    hidden_names = {norm(n) for n in table.get("exclude") or []}
    include_names = {norm(n) for n in table.get("include") or []}
    kept, over, fast, unpriced, routed, hidden = [], [], [], [], [], []
    for m in models:
        entry = price_of(m, table)
        label = m.get("label") or m.get("id")
        if entry is None and ROUTER.match(str(m.get("id") or "")):
            routed.append(m.get("id"))  # Cursor's own picker ("default", "auto-smart"): no fixed price
        elif entry is None:
            unpriced.append({"id": m.get("id"), "name": label})
        elif norm(entry.get("name")) in hidden_names:
            hidden.append({"id": m.get("id"), "name": entry.get("name")})
        elif norm(entry.get("name")) in include_names and not is_fast(m):
            # your exception: offered whatever it costs
            kept.append({**m, "provider": entry.get("provider"), "price": _usd(entry), "priceName": entry.get("name"), "note": entry.get("note"), "exception": entry.get("output") is None or entry["output"] > cap})
        elif is_fast(m) or entry.get("fast"):
            fast.append({"id": m.get("id"), "name": label})
        elif entry.get("output") is None or entry["output"] > cap:
            over.append({"id": m.get("id"), "name": entry.get("name"), "output": entry.get("output")})
        else:
            kept.append({**m, "provider": entry.get("provider"), "price": _usd(entry), "priceName": entry.get("name"), "note": entry.get("note"), "exception": False})
    rank = {p: i for i, p in enumerate(PROVIDER_ORDER)}
    kept.sort(key=lambda m: (rank.get(m["provider"], len(rank)), m["price"]["output"], str(m.get("label") or m["id"]).lower()))
    return kept, {
        "total": len(models),
        "shown": len(kept),
        "overCap": len(over),
        "over": over,
        "hidden": len(hidden),
        "exceptions": sum(1 for m in kept if m.get("exception")),
        "fast": len(fast),
        "routed": len(routed),
        "unpriced": unpriced,
        "capUsd": cap,
        "pricesChecked": table.get("checked"),
    }


def allowed(model_id: str, table: dict | None = None) -> bool:
    """May a job run `model_id`? Judged from the price table alone, so a catalog that cannot be
    reached does not block a model the board already offered. The run itself still fails
    cleanly if Cursor rejects the id."""
    table = table or load_prices()
    entry = price_of({"id": model_id}, table)
    if not entry or entry.get("fast") or is_fast({"id": model_id}) or entry.get("output") is None:
        return False
    if norm(entry.get("name")) in {norm(n) for n in table.get("exclude") or []}:
        return False
    if norm(entry.get("name")) in {norm(n) for n in table.get("include") or []}:
        return True
    return entry["output"] <= float(table.get("maxOutputUsd", 10))
