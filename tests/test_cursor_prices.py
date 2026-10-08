#!/usr/bin/env python3
"""Cursor models are offered by price: in the key's catalog AND at or under $10 per 1M output."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
import cursor_prices as cp  # noqa: E402

TABLE = cp.load_prices()


def catalog(*ids):
    """A catalog item per id, the way list_cursor_models builds them."""
    return [{"id": i, "label": i, "efforts": ["low", "high"], "aliases": []} for i in ids]


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


class Publishing(unittest.TestCase):
    def test_a_catalog_keeps_everything_at_or_under_the_cap_and_explains_the_rest(self):
        kept, info = cp.publish(catalog(
            "gpt-5.6-luna", "claude-sonnet-5.5", "glm-5.3-flash", "kimi-k2.7-code",  # priced ≤ $10
            "gpt-5.5", "claude-opus-5-5",                                            # over $10
            "grok-4.7-fast", "composer-2.5-fast",                                    # fast variants
            "brand-new-model",                                                       # no price on file
        ))
        self.assertEqual({m["id"] for m in kept}, {"gpt-5.6-luna", "claude-sonnet-5.5", "glm-5.3-flash", "kimi-k2.7-code"})
        self.assertEqual((info["total"], info["shown"], info["overCap"], info["fast"]), (9, 4, 2, 2))
        self.assertEqual(info["unpriced"], [{"id": "brand-new-model", "name": "brand-new-model"}])

    def test_boundary_is_inclusive(self):
        kept, _ = cp.publish(catalog("claude-sonnet-5-5", "gpt-5"))  # both exactly $10 out
        self.assertEqual(len(kept), 2)

    def test_offered_models_carry_price_and_maker(self):
        (m,), _ = cp.publish(catalog("claude-haiku-5-5"))
        self.assertEqual(m["provider"], "Anthropic")
        self.assertEqual(m["price"], {"input": 0.1, "cacheWrite": 0.125, "cacheRead": 0.01, "output": 0.5})
        self.assertIn("5x", m["note"])

    def test_sorted_by_maker_then_cheapest_output(self):
        kept, _ = cp.publish(catalog("claude-sonnet-5-5", "gpt-5", "claude-haiku-5-5", "gpt-5.6-luna", "composer-2.5"))
        self.assertEqual([m["id"] for m in kept], ["composer-2.5", "claude-haiku-5-5", "claude-sonnet-5-5", "gpt-5.6-luna", "gpt-5"])

    def test_an_empty_catalog_is_not_an_error(self):
        kept, info = cp.publish([])
        self.assertEqual((kept, info["total"], info["shown"]), ([], 0, 0))


class Allowed(unittest.TestCase):
    def test_priced_cheap_models_may_run_without_the_catalog(self):
        self.assertTrue(cp.allowed("gpt-5.6-luna"))
        self.assertTrue(cp.allowed("glm-5.3"))

    def test_expensive_fast_and_unknown_models_may_not(self):
        for model in ("gpt-5.5", "claude-opus-5-5", "grok-4.7-fast", "composer-2.5-fast", "brand-new-model", ""):
            self.assertFalse(cp.allowed(model), model)


class PriceTable(unittest.TestCase):
    def test_the_whole_cursor_table_is_on_file(self):
        self.assertGreaterEqual(len(TABLE["models"]), 55)
        self.assertEqual(TABLE["maxOutputUsd"], 10)

    def test_names_are_unique_and_every_row_is_priced(self):
        names = [m["name"] for m in TABLE["models"]]
        self.assertEqual(len(names), len(set(names)))
        for m in TABLE["models"]:
            for field in ("input", "cacheRead", "output"):
                self.assertIsInstance(m[field], (int, float), f"{m['name']} {field}")

    def test_a_long_list_fits_the_cost_cap(self):
        cheap = [m for m in TABLE["models"] if not m["fast"] and m["output"] <= 10]
        self.assertGreaterEqual(len(cheap), 25)
        providers = {m["provider"] for m in cheap}
        for maker in ("Anthropic", "OpenAI", "Google", "Z.ai", "Moonshot", "Cursor", "Meta"):
            self.assertIn(maker, providers)

    def test_the_file_is_valid_json_with_a_source(self):
        with open(os.path.join(ROOT, "ai-intern", "cursor-prices.json"), encoding="utf-8") as f:
            data = json.load(f)
        self.assertTrue(data["source"].startswith("https://cursor.com/"))


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

    def test_published_cursor_models_keep_only_the_efforts_they_support(self):
        kept, _ = self.worker._publish_cursor([{"id": "gpt-5.6-luna", "label": "GPT-5.6 Luna", "efforts": ["low", "high"]}])
        self.assertEqual(kept[0]["efforts"], ["low", "high"])


if __name__ == "__main__":
    unittest.main()
