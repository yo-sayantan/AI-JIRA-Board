#!/usr/bin/env python3
"""The Cursor price table and how a model is matched to its row (which models are offered: test_cloud_config.py)."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
import cursor_prices as cp  # noqa: E402

TABLE = cp.load_prices()


class Matching(unittest.TestCase):
    def test_every_spelling_of_one_model_finds_the_same_price(self):
        for spelling in ("claude-sonnet-5-5", "claude-sonnet-5.5", "Claude Sonnet 5.5", "CLAUDE_SONNET_5_5"):
            self.assertEqual(cp.price_of({"id": spelling})["name"], "Claude Sonnet 5.5", spelling)

    def test_display_name_and_alias_also_match(self):
        self.assertEqual(cp.price_of({"id": "x1", "label": "GPT-5.6 Luna"})["name"], "GPT-5.6 Luna")
        self.assertEqual(cp.price_of({"id": "x2", "label": "x2", "aliases": ["kimi-k2.7-code"]})["name"], "Kimi K2.7 Code")

    def test_variant_suffixes_bill_as_the_base_model(self):
        self.assertEqual(cp.price_of({"id": "gpt-5-high"})["name"], "GPT-5")
        self.assertEqual(cp.price_of({"id": "claude-4-sonnet-thinking"})["name"], "Claude 4 Sonnet")
        self.assertEqual(cp.price_of({"id": "claude-4.5-opus-high-thinking"})["name"], "Claude 4.5 Opus")

    def test_max_is_a_model_not_a_suffix(self):
        self.assertEqual(cp.price_of({"id": "gpt-5.1-codex-max"})["name"], "GPT-5.1 Codex Max")
        self.assertEqual(cp.price_of({"id": "gpt-5.1-codex"})["name"], "GPT-5.1 Codex")

    def test_unknown_models_are_not_guessed(self):
        self.assertIsNone(cp.price_of({"id": "gpt-9-unknown"}))


class MatchingVersions(unittest.TestCase):
    def test_version_digits_keep_their_order(self):
        self.assertIsNone(cp.price_of({"id": "claude-haiku-5-4"}))  # 5.4 is not 4.5
        self.assertEqual(cp.price_of({"id": "claude-haiku-5-5"})["name"], "Claude Haiku 5.5")

    def test_word_order_does_not_hide_a_model(self):
        # the API says claude-haiku-4-5; Cursor's table says "Claude 4.5 Haiku"
        entry = cp.price_of({"id": "claude-haiku-4-5"})
        self.assertEqual((entry["name"], entry["output"]), ("Claude 4.5 Haiku", 5))


class PriceTable(unittest.TestCase):
    def test_the_whole_cursor_table_is_on_file(self):
        self.assertGreaterEqual(len(TABLE["models"]), 55)

    def test_names_are_unique_and_every_row_is_priced(self):
        names = [m["name"] for m in TABLE["models"]]
        self.assertEqual(len(names), len(set(names)))
        for m in TABLE["models"]:
            for field in ("input", "cacheRead", "output"):
                self.assertIsInstance(m[field], (int, float), f"{m['name']} {field}")

    def test_the_file_is_valid_json_with_a_source(self):
        with open(os.path.join(ROOT, "ai-intern", "cursor-prices.json"), encoding="utf-8") as f:
            data = json.load(f)
        self.assertTrue(data["source"].startswith("https://cursor.com/"))

    def test_it_no_longer_decides_which_models_are_offered(self):
        for gone in ("maxOutputUsd", "exclude", "include", "pin"):
            self.assertNotIn(gone, TABLE, "model selection lives in cloud-models.json now")
class WorkerEffort(unittest.TestCase):
    """High is offered wherever the catalog's effort parameter lists it."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("INTERN_DIR", os.path.join(ROOT, "jira-intern"))
        sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
        import worker  # noqa: E402
        cls.worker = worker

    def test_efforts_include_high(self):
        self.assertEqual(self.worker.EFFORTS, ("low", "medium", "high"))

    def test_a_model_with_low_medium_high_max_offers_the_first_three(self):
        item = {"parameters": [{"id": "effort", "values": [{"value": v} for v in ("low", "medium", "high", "max")]}]}
        self.assertEqual(self.worker._effort_meta(item), ("effort", ["low", "medium", "high"]))

    def test_a_model_with_no_effort_parameter_offers_none(self):
        self.assertEqual(self.worker._effort_meta({"parameters": []}), (None, []))

    def test_the_chosen_variant_follows_the_requested_effort(self):
        variants = [{"params": [{"id": "effort", "value": v}]} for v in ("low", "medium", "high")]
        params, used = self.worker._variant_params({"variants": variants}, "high")
        self.assertEqual((params, used), ([{"id": "effort", "value": "high"}], "high"))

    def test_the_board_offers_auto_on_top_of_the_three(self):
        self.assertEqual(self.worker.EFFORT_CHOICES, ("low", "medium", "high", "auto"))

    def test_auto_takes_the_models_default_variant_and_asks_for_no_effort(self):
        variants = [{"params": [{"id": "effort", "value": v}], "isDefault": v == "medium"} for v in ("low", "medium", "high")]
        params, used = self.worker._variant_params({"variants": variants}, "auto")
        self.assertEqual((params, used), ([{"id": "effort", "value": "medium"}], "medium"))

    def test_a_missing_effort_falls_back_to_the_prompt(self):
        self.assertEqual(self.worker._effort_note("auto"), "")
        self.assertIn("LOW", self.worker._effort_note("low"))
        self.assertIn("HIGH", self.worker._effort_note("high"))

    def test_report_parallelism_goes_up_to_ten(self):
        self.assertEqual(self.worker.MAX_PARALLEL, 10)


if __name__ == "__main__":
    unittest.main()
