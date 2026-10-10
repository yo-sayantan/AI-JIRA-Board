"""The cloud models the board offers — read from ai-intern/cloud-models.json, nothing else.

That file IS the list: add a model and it appears in Settings, delete one and it is gone, no code change. Each
entry names a provider (cursor · claude · gemini), the model, the efforts it may run at (low · medium · high ·
auto) and, optionally, its output price. A model is COSTLY when its output price is at or above
`costlyOutputUsd` (default 10, set in the same file) — or whatever an entry's own `costly` says. Costly models get
the ⚠ and, by default, no effort choice (`costlyShowEffort` switches that on).

Cursor entries may give just a `name` ("GPT-5.6 Luna"): the id Cursor expects is then looked up in YOUR key's
Cursor catalog (cursor_prices.py matching rules), which also supplies the model's real effort variants. An entry
with an `id` is used as written when the catalog does not list it (Cursor may then reject it, visibly).

Prices come from the entry's `outputUsd`, else the Cursor price table (cursor-prices.json, which also feeds the
guide's price page). Pure functions only, so tests/ can import it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import cursor_prices as cp

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "cloud-models.json"

PROVIDERS = ("cursor", "claude", "gemini")
EFFORT_CHOICES = ("low", "medium", "high", "auto")
DEFAULT_COSTLY_USD = 10.0
# Default maker shown in the Settings grouping when an entry names none and the price table does not know it.
MAKER = {"cursor": "Cursor", "claude": "Anthropic", "gemini": "Google"}

_CACHE = {"mtime": None, "path": None, "val": None}


def _number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def load(path: Path = CONFIG_PATH) -> dict:
    """The config, re-read when the file changes so an edit needs no restart. Bad entries are skipped and
    reported in `problems` (shown in Settings), never fatal: a typo in one row must not empty the list."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {"costlyOutputUsd": DEFAULT_COSTLY_USD, "costlyShowEffort": False, "models": [], "problems": [f"{path.name} is missing"], "checked": None}
    if _CACHE["mtime"] == mtime and _CACHE["path"] == str(path) and _CACHE["val"] is not None:
        return _CACHE["val"]
    problems, models = [], []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("the top level must be an object")
    except (ValueError, OSError) as e:
        out = {"costlyOutputUsd": DEFAULT_COSTLY_USD, "costlyShowEffort": False, "models": [], "problems": [f"{path.name} is not valid JSON: {e}"], "checked": None}
        _CACHE.update(mtime=mtime, path=str(path), val=out)
        return out
    threshold = _number(raw.get("costlyOutputUsd"))
    if threshold is None:
        threshold = DEFAULT_COSTLY_USD
        if "costlyOutputUsd" in raw:
            problems.append("costlyOutputUsd must be a number — using 10")
    for i, entry in enumerate(raw.get("models") or []):
        where = f"models[{i}]"
        if not isinstance(entry, dict):
            problems.append(f"{where} is not an object — skipped")
            continue
        provider = str(entry.get("provider") or "").lower()
        name = str(entry.get("name") or entry.get("label") or "").strip()
        model_id = str(entry.get("id") or "").strip()
        label = name or model_id or where
        if provider not in PROVIDERS:
            problems.append(f"{label}: provider must be one of {', '.join(PROVIDERS)} — skipped")
            continue
        if provider != "cursor" and not model_id:
            problems.append(f"{label}: a {provider} model needs an id — skipped")
            continue
        if not (name or model_id):
            problems.append(f"{where}: needs a name or an id — skipped")
            continue
        efforts = entry.get("efforts")
        if efforts is None:
            efforts = list(EFFORT_CHOICES)
        elif not isinstance(efforts, list):
            problems.append(f"{label}: efforts must be a list — using all")
            efforts = list(EFFORT_CHOICES)
        else:
            unknown = [e for e in efforts if e not in EFFORT_CHOICES]
            if unknown:
                problems.append(f"{label}: unknown effort {', '.join(map(str, unknown))} (use {', '.join(EFFORT_CHOICES)})")
        models.append({
            "provider": provider,
            "name": name or model_id,
            "id": model_id,
            "maker": str(entry.get("maker") or "").strip() or None,
            "outputUsd": _number(entry.get("outputUsd")),
            "costly": entry.get("costly") if isinstance(entry.get("costly"), bool) else None,
            "efforts": [e for e in EFFORT_CHOICES if e in efforts],
            "note": str(entry.get("note")) if entry.get("note") else None,
        })
    out = {
        "costlyOutputUsd": threshold,
        "costlyShowEffort": raw.get("costlyShowEffort") is True,
        "models": models,
        "problems": problems,
        "checked": raw.get("checked"),
    }
    _CACHE.update(mtime=mtime, path=str(path), val=out)
    return out


def entries(provider: str, cfg: dict | None = None) -> list:
    return [m for m in (cfg or load())["models"] if m["provider"] == provider]


def slug(name: str) -> str:
    """"GPT-5.6 Luna" → "gpt-5.6-luna": Cursor's ids are lower-case words joined by hyphens (dots kept)."""
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9.]+", "-", str(name or "").lower())).strip("-")


def _catalog_index(catalog: list) -> tuple[dict, dict, dict]:
    """(exact id → model, normalised spelling → model, loose spelling → model) over the key's Cursor catalog."""
    by_id, by_norm, by_loose = {}, {}, {}
    for m in catalog or []:
        if m.get("id"):
            by_id.setdefault(cp.norm(m["id"]), m)
        for k in cp._keys(m):
            by_norm.setdefault(k, m)
        for s in cp._spellings(m):
            k = cp.loose(s)
            if k:
                by_loose.setdefault(k, m)
    return by_id, by_norm, by_loose


def _find(entry: dict, index: tuple) -> dict | None:
    by_id, by_norm, by_loose = index
    for s in (entry["id"], entry["name"]):
        k = cp.norm(s)
        if k and k in by_id:
            return by_id[k]
    for s in (entry["id"], entry["name"]):
        k = cp.norm(s)
        if k and k in by_norm:
            return by_norm[k]
    for s in (entry["id"], entry["name"]):
        k = cp.loose(s)
        if k and k in by_loose:
            return by_loose[k]
    return None


def _price(entry: dict, model: dict | None) -> tuple[dict | None, str | None, str | None, str | None]:
    """(price, price-table name, maker, note) — the entry's outputUsd wins over the table's output rate."""
    table = cp.price_of({"id": (model or {}).get("id") or entry["id"], "label": entry["name"]})
    price = cp._usd(table) if table else {"input": None, "cacheWrite": None, "cacheRead": None, "output": None}
    if entry["outputUsd"] is not None:
        price = {**price, "output": entry["outputUsd"]}
    has_price = table is not None or entry["outputUsd"] is not None
    return (price if has_price else None), (table or {}).get("name"), (table or {}).get("provider"), (table or {}).get("note")


def publish(provider: str, catalog: list | None = None, cfg: dict | None = None):
    """(models to offer, diagnostics) for one provider, in the order the config lists them.

    `catalog` is the key's Cursor catalog (cursor only): it resolves a name to the real id and brings the model's
    effort variants. None means it could not be read — entries then run on the id they name, or a guess from the
    name, and are marked `inCatalog: False`.
    """
    cfg = cfg or load()
    index = _catalog_index(catalog) if provider == "cursor" and catalog is not None else None
    threshold = cfg["costlyOutputUsd"]
    out, unresolved, costly_n = [], [], 0
    for entry in entries(provider, cfg):
        model = _find(entry, index) if index else None
        price, price_name, table_maker, table_note = _price(entry, model)
        output = (price or {}).get("output")
        costly = entry["costly"] if entry["costly"] is not None else (output is not None and output >= threshold)
        costly_n += 1 if costly else 0
        efforts = [] if costly and not cfg["costlyShowEffort"] else list(entry["efforts"])
        if provider == "cursor":
            model_id = (model or {}).get("id") or entry["id"] or slug(entry["name"])
            in_catalog = model is not None if index else None
            if index is not None and model is None:
                unresolved.append(entry["name"])
        else:
            model_id, in_catalog = entry["id"], None
        out.append({
            "id": model_id,
            "label": entry["name"],
            "provider": entry["maker"] or table_maker or MAKER[provider],
            "price": price,
            "priceName": price_name,
            "note": entry["note"] or table_note,
            "efforts": efforts,
            "costly": bool(costly),
            "inCatalog": in_catalog,
            # Cursor's own effort variants, for the worker to pick the right one (never shown).
            "effortParam": (model or {}).get("effortParam"),
            "nativeEfforts": (model or {}).get("efforts") or [],
            "variants": (model or {}).get("variants") or [],
            "aliases": (model or {}).get("aliases") or [],
        })
    return out, {
        "shown": len(out),
        "costly": costly_n,
        "costlyUsd": threshold,
        "unresolved": unresolved,
        "catalogTotal": len(catalog) if catalog is not None else None,
        "problems": cfg["problems"],
        "pricesChecked": cp.load_prices().get("checked"),
    }
