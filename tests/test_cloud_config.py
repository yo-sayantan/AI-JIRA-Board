#!/usr/bin/env python3
"""cloud-models.json IS the model list: what it names is what Settings offers, in its order, with its efforts and
its idea of costly."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
import cloud_config as cc  # noqa: E402

ALL = ["low", "medium", "high", "auto"]


def cfg_from(obj):
    """Load a config written to a temp file (a distinct path each time, so the mtime cache never lies)."""
    d = tempfile.mkdtemp()
    path = Path(d) / "cloud-models.json"
    path.write_text(json.dumps(obj), encoding="utf-8")
    return cc.load(path)


def cat(*rows):
    """A Cursor catalog the way list_cursor_models builds it."""
    return [{"id": i, "label": l, "efforts": e, "effortParam": "effort" if e else None, "variants": [], "aliases": []} for i, l, e in rows]


class Loading(unittest.TestCase):
    def test_the_shipped_file_loads_clean_and_lists_all_three_providers(self):
        cfg = cc.load()
        self.assertEqual(cfg["problems"], [])
        self.assertEqual(cfg["costlyOutputUsd"], 10)
        for provider in cc.PROVIDERS:
            self.assertGreaterEqual(len(cc.entries(provider, cfg)), 2, provider)

    def test_every_shipped_model_offers_all_four_efforts(self):
        for m in cc.load()["models"]:
            self.assertEqual(m["efforts"], ALL, m["name"])

    def test_efforts_default_to_all_four_and_keep_their_own_order(self):
        cfg = cfg_from({"models": [{"provider": "claude", "id": "a", "name": "A"}, {"provider": "claude", "id": "b", "name": "B", "efforts": ["auto", "low"]}]})
        self.assertEqual([m["efforts"] for m in cfg["models"]], [ALL, ["low", "auto"]])

    def test_a_bad_row_is_skipped_and_reported_never_fatal(self):
        cfg = cfg_from({"models": [
            {"provider": "nope", "name": "X"},
            {"provider": "claude", "name": "No id"},
            "junk",
            {"provider": "claude", "id": "ok", "name": "Fine", "efforts": ["low", "turbo"]},
        ]})
        self.assertEqual([m["name"] for m in cfg["models"]], ["Fine"])
        self.assertEqual(len(cfg["problems"]), 4)
        self.assertIn("turbo", " ".join(cfg["problems"]))

    def test_a_broken_file_gives_an_empty_list_and_says_why(self):
        d = tempfile.mkdtemp()
        path = Path(d) / "cloud-models.json"
        path.write_text("{ not json", encoding="utf-8")
        cfg = cc.load(path)
        self.assertEqual(cfg["models"], [])
        self.assertIn("not valid JSON", cfg["problems"][0])


class Costly(unittest.TestCase):
    MODELS = [
        {"provider": "claude", "id": "cheap", "name": "Cheap", "outputUsd": 9.99},
        {"provider": "claude", "id": "edge", "name": "Edge", "outputUsd": 10},
        {"provider": "claude", "id": "dear", "name": "Dear", "outputUsd": 25},
        {"provider": "claude", "id": "forced", "name": "Forced", "outputUsd": 1, "costly": True},
        {"provider": "claude", "id": "pardoned", "name": "Pardoned", "outputUsd": 50, "costly": False},
    ]

    def flags(self, **top):
        models, info = cc.publish("claude", cfg=cfg_from({"models": self.MODELS, **top}))
        return {m["id"]: m["costly"] for m in models}, info

    def test_costly_starts_at_the_threshold_itself(self):
        flags, _ = self.flags()
        self.assertEqual((flags["cheap"], flags["edge"], flags["dear"]), (False, True, True))

    def test_a_model_can_overrule_the_threshold_either_way(self):
        flags, _ = self.flags()
        self.assertEqual((flags["forced"], flags["pardoned"]), (True, False))

    def test_the_threshold_is_the_files_to_set(self):
        flags, info = self.flags(costlyOutputUsd=30)
        self.assertEqual([k for k, v in flags.items() if v], ["forced"])
        self.assertEqual(info["costlyUsd"], 30)
        flags, _ = self.flags(costlyOutputUsd=1)
        self.assertEqual([k for k, v in flags.items() if v], ["cheap", "edge", "dear", "forced"])

    def test_costly_models_offer_no_effort_unless_the_file_says_so(self):
        models, _ = cc.publish("claude", cfg=cfg_from({"models": self.MODELS}))
        by = {m["id"]: m for m in models}
        self.assertEqual((by["cheap"]["efforts"], by["dear"]["efforts"]), (ALL, []))
        models, _ = cc.publish("claude", cfg=cfg_from({"models": self.MODELS, "costlyShowEffort": True}))
        self.assertEqual({m["id"]: m["efforts"] for m in models}["dear"], ALL)

    def test_an_unpriced_model_is_never_costly(self):
        models, _ = cc.publish("gemini", cfg=cfg_from({"models": [{"provider": "gemini", "id": "mystery-1", "name": "Mystery"}]}))
        self.assertEqual((models[0]["price"], models[0]["costly"]), (None, False))


class Publishing(unittest.TestCase):
    def test_the_list_is_the_file_in_the_files_order_for_that_provider_only(self):
        cfg = cfg_from({"models": [
            {"provider": "claude", "id": "c2", "name": "Second claude"},
            {"provider": "gemini", "id": "g1", "name": "A gemini"},
            {"provider": "claude", "id": "c1", "name": "First claude"},
        ]})
        self.assertEqual([m["id"] for m in cc.publish("claude", cfg=cfg)[0]], ["c2", "c1"])
        self.assertEqual([m["id"] for m in cc.publish("gemini", cfg=cfg)[0]], ["g1"])
        self.assertEqual(cc.publish("cursor", cfg=cfg)[0], [])

    def test_adding_or_deleting_a_row_changes_the_list(self):
        one = {"provider": "claude", "id": "c1", "name": "One"}
        two = {"provider": "claude", "id": "c2", "name": "Two"}
        self.assertEqual(len(cc.publish("claude", cfg=cfg_from({"models": [one]}))[0]), 1)
        self.assertEqual(len(cc.publish("claude", cfg=cfg_from({"models": [one, two]}))[0]), 2)
        self.assertEqual(cc.publish("claude", cfg=cfg_from({"models": []}))[0], [])

    def test_a_missing_price_comes_from_the_price_table_and_outputusd_overrides_it(self):
        cfg = cfg_from({"models": [
            {"provider": "claude", "id": "claude-haiku-5-5", "name": "Claude Haiku 5.5"},
            {"provider": "claude", "id": "claude-haiku-5-5", "name": "Claude Haiku 5.5", "outputUsd": 99},
        ]})
        a, b = cc.publish("claude", cfg=cfg)[0]
        self.assertEqual(a["price"]["output"], 0.5)
        self.assertIsNotNone(a["price"]["cacheRead"])  # the rest of the price comes along
        self.assertEqual(b["price"]["output"], 99)
        self.assertTrue(b["costly"])


class CursorCatalog(unittest.TestCase):
    ENTRY = {"provider": "cursor", "name": "GPT-5.6 Luna", "outputUsd": 1.2}

    def test_a_name_finds_its_id_and_effort_parameter_in_the_keys_catalog(self):
        catalog = cat(("gpt-5.6-luna", "GPT-5.6 Luna", ["low", "medium"]), ("other", "Other", []))
        m, info = cc.publish("cursor", catalog, cfg_from({"models": [self.ENTRY]}))
        self.assertEqual((m[0]["id"], m[0]["inCatalog"], m[0]["effortParam"], m[0]["nativeEfforts"]), ("gpt-5.6-luna", True, "effort", ["low", "medium"]))
        self.assertEqual((info["unresolved"], info["catalogTotal"]), ([], 2))

    def test_word_order_and_punctuation_do_not_hide_a_model(self):
        catalog = cat(("claude-haiku-4-5", "Claude Haiku 4.5", []))
        m, _ = cc.publish("cursor", catalog, cfg_from({"models": [{"provider": "cursor", "name": "Claude 4.5 Haiku"}]}))
        self.assertEqual((m[0]["id"], m[0]["inCatalog"]), ("claude-haiku-4-5", True))

    def test_a_model_the_catalog_lacks_is_still_offered_and_marked_so(self):
        m, info = cc.publish("cursor", cat(("x", "X", [])), cfg_from({"models": [{**self.ENTRY, "id": "gpt-5.6-luna"}, {"provider": "cursor", "name": "Brand New 1.0"}]}))
        self.assertEqual([(r["id"], r["inCatalog"]) for r in m], [("gpt-5.6-luna", False), ("brand-new-1.0", False)])
        self.assertEqual(info["unresolved"], ["GPT-5.6 Luna", "Brand New 1.0"])

    def test_with_no_catalog_at_all_the_list_is_still_there(self):
        m, info = cc.publish("cursor", None, cfg_from({"models": [{**self.ENTRY, "id": "gpt-5.6-luna"}]}))
        self.assertEqual((m[0]["id"], m[0]["inCatalog"], info["catalogTotal"], info["unresolved"]), ("gpt-5.6-luna", None, None, []))

    def test_the_shipped_cursor_list_resolves_against_a_catalog_of_its_own_ids(self):
        cfg = cc.load()
        rows = cc.entries("cursor", cfg)
        catalog = cat(*[(cc.slug(r["name"]) if not r["id"] else r["id"], r["name"], []) for r in rows])
        m, info = cc.publish("cursor", catalog, cfg)
        self.assertEqual((len(m), info["unresolved"]), (len(rows), []))


class WorkerUse(unittest.TestCase):
    """The worker runs a model only as the file lists it, at an effort the file offers for it."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("INTERN_DIR", os.path.join(ROOT, "jira-intern"))
        sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
        import worker  # noqa: E402
        cls.worker = worker

    def test_the_effort_is_the_saved_one_when_offered_else_the_first_offered(self):
        row = {"efforts": ["low", "auto"]}
        self.assertEqual(self.worker._effort_for(row, "low"), "low")
        self.assertEqual(self.worker._effort_for(row, "high"), "low")

    def test_a_model_with_no_efforts_runs_on_auto(self):
        self.assertEqual(self.worker._effort_for({"efforts": []}, "high"), "auto")
        self.assertEqual(self.worker._effort_for(None, "high"), "auto")

    def test_the_settings_payload_is_the_file_per_provider(self):
        from unittest import mock
        keys = {"CURSOR_API_KEY": "k1", "ANTHROPIC_API_KEY": "k2", "GEMINI_API_KEY": ""}
        catalog = cat(("gpt-5.6-luna", "GPT-5.6 Luna", ["low", "high"]))
        with mock.patch.object(self.worker, "file_secret", side_effect=lambda n: keys[n]), mock.patch.object(self.worker, "list_cursor_models", return_value=catalog):
            out = self.worker._fetch_cloud_models()
        self.assertEqual(out["costlyOutputUsd"], 10)
        self.assertTrue(out["cursor"]["configured"] and out["claude"]["configured"] and not out["gemini"]["configured"])
        self.assertEqual(out["gemini"]["models"], [])
        self.assertIn("GEMINI_API_KEY", out["gemini"]["error"])
        luna = next(m for m in out["cursor"]["models"] if m["id"] == "gpt-5.6-luna")
        self.assertEqual((luna["inCatalog"], luna["costly"], luna["efforts"]), (True, False, ALL))
        self.assertEqual({m["id"] for m in out["claude"]["models"]}, {"claude-haiku-5-5", "claude-haiku-4-5"})
        # Most of the file's Cursor models are not in this one-model catalog: said plainly, still listed.
        self.assertIn("not in your key's Cursor catalog", out["cursor"]["error"])
        self.assertGreater(len(out["cursor"]["models"]), 10)

    def test_an_unreadable_cursor_catalog_still_lists_the_file(self):
        from unittest import mock
        with mock.patch.object(self.worker, "file_secret", return_value="k"), mock.patch.object(self.worker, "list_cursor_models", side_effect=RuntimeError("HTTP 401")):
            out = self.worker._fetch_cloud_models()
        self.assertIn("Couldn't read your key's Cursor catalog (HTTP 401)", out["cursor"]["error"])
        self.assertGreater(len(out["cursor"]["models"]), 10)
        self.assertIsNone(out["cursor"]["models"][0]["inCatalog"])

    def test_only_a_listed_model_may_run(self):
        from unittest import mock
        fake = {"cursor": {"models": [{"id": "gpt-5.6-luna"}]}, "claude": {"models": []}, "gemini": {"models": []}}
        with mock.patch.object(self.worker, "cloud_models", return_value=fake):
            self.assertTrue(self.worker._cloud_allowed("cursor", "gpt-5.6-luna"))
            self.assertFalse(self.worker._cloud_allowed("cursor", "gpt-5.5"))
            self.assertFalse(self.worker._cloud_allowed("claude", "gpt-5.6-luna"))
            self.assertFalse(self.worker._cloud_allowed("cursor", ""))


class Slug(unittest.TestCase):
    def test_a_name_becomes_the_id_cursor_would_use(self):
        self.assertEqual(cc.slug("GPT-5.6 Luna"), "gpt-5.6-luna")
        self.assertEqual(cc.slug("Kimi K2.7 Code"), "kimi-k2.7-code")


if __name__ == "__main__":
    unittest.main()
