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


class RealCatalog(unittest.TestCase):
    """The ids a real key's `GET /v1/models` returned (2026-10-08). The list once shrank to three
    models because ids were matched exactly; this pins what a real catalog must yield."""

    IDS = [
        "composer-2.5", "grok-4.5", "grok-4.6", "grok-4.7", "claude-sonnet-5", "gpt-5.6-luna", "gpt-5.4-nano",
        "gpt-5-mini", "gpt-5.4-mini", "gemini-2.5-flash", "gemini-3-flash", "gemini-3.6-flash", "gemini-3.5-flash",
        "glm-5.2", "kimi-k2.7-code",
        "auto-smart", "default", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
        "claude-haiku-4-5", "claude-sonnet-4-5", "gpt-5.1", "claude-sonnet-4",
    ]

    def test_it_yields_a_long_list_not_three(self):
        # 16 priced at or under $10 (minus the owner's exclude list), plus the include-list models
        kept, info = cp.publish(catalog(*self.IDS, "gpt-5.6-terra", "gemini-3.1-pro"))
        ids = {m["id"] for m in kept}
        self.assertGreaterEqual(len(kept), 11)
        for want in ("gpt-5.6-terra", "gemini-3.1-pro", "claude-sonnet-5", "gpt-5.6-luna", "glm-5.2", "kimi-k2.7-code"):
            self.assertIn(want, ids)
        for gone in ("grok-4.5", "gemini-2.5-flash", "gpt-5.4-nano", "claude-haiku-4-5", "gemini-3-flash", "gemini-3.6-flash"):
            self.assertNotIn(gone, ids)
        self.assertEqual(info["total"], 27)

    def test_word_order_does_not_hide_a_model(self):
        # the API says claude-haiku-4-5; Cursor's table says "Claude 4.5 Haiku"
        kept, _ = cp.publish(catalog("claude-haiku-4-5"), dict(TABLE, exclude=[]))
        self.assertEqual(kept[0]["priceName"], "Claude 4.5 Haiku")
        self.assertEqual(kept[0]["price"]["output"], 5)

    def test_expensive_claude_models_are_counted_as_over_the_cap_not_unpriced(self):
        _, info = cp.publish(catalog("claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-5", "claude-sonnet-4-5", "claude-sonnet-4"))
        self.assertEqual((info["overCap"], len(info["unpriced"])), (5, 0))

    def test_routers_are_not_unpriced_models_and_gpt_5_1_is_reported(self):
        _, info = cp.publish(catalog("default", "auto-smart", "gpt-5.1"))
        self.assertEqual(info["routed"], 2)
        self.assertEqual([u["id"] for u in info["unpriced"]], ["gpt-5.1"])

    def test_version_digits_keep_their_order(self):
        self.assertIsNone(cp.price_of({"id": "claude-haiku-5-4"}))  # 5.4 is not 4.5
        self.assertEqual(cp.price_of({"id": "claude-haiku-5-5"})["name"], "Claude Haiku 5.5")


class Curated(unittest.TestCase):
    """`exclude` is the owner's own list: priced and affordable, but never offered."""

    def test_excluded_models_are_hidden_not_priced_out(self):
        kept, info = cp.publish(catalog("grok-4.5", "grok-4.7", "gemini-2.5-flash", "gpt-5.4-nano", "gpt-5.6-luna"))
        self.assertEqual([m["id"] for m in kept], ["grok-4.7", "gpt-5.6-luna"])
        self.assertEqual((info["hidden"], info["overCap"]), (3, 0))

    def test_the_hide_list_matches_the_names_in_the_price_table(self):
        names = {m["name"] for m in TABLE["models"]}
        for hidden in TABLE["exclude"]:
            self.assertIn(hidden, names)

    def test_over_cap_models_are_named_so_a_wanted_one_can_be_found(self):
        _, info = cp.publish(catalog("claude-opus-4-5", "claude-sonnet-4"))
        self.assertEqual(sorted(o["id"] for o in info["over"]), ["claude-opus-4-5", "claude-sonnet-4"])
        self.assertEqual({o["output"] for o in info["over"]}, {25, 15})


class IncludeList(unittest.TestCase):
    """`include`: models offered although they cost more than the cap — the owner's exceptions."""

    def test_an_included_model_over_the_cap_is_offered_and_marked_as_an_exception(self):
        kept, info = cp.publish(catalog("gpt-5.6-terra", "gemini-3.1-pro", "gpt-5.5"))
        self.assertEqual(sorted(m["id"] for m in kept), ["gemini-3.1-pro", "gpt-5.6-terra"])
        self.assertTrue(all(m["exception"] for m in kept))
        self.assertEqual((info["overCap"], info["exceptions"]), (1, 2))  # gpt-5.5 stays priced out

    def test_only_models_in_the_keys_catalog_are_ever_offered(self):
        kept, _ = cp.publish(catalog("gpt-5.6-luna"))
        self.assertEqual([m["id"] for m in kept], ["gpt-5.6-luna"])  # no Terra, no Sonnet 5.5: the key lacks them

    def test_exclude_beats_include(self):
        table = dict(TABLE, include=["Grok 4.5"], exclude=["Grok 4.5"])
        kept, info = cp.publish(catalog("grok-4.5"), table)
        self.assertEqual((kept, info["hidden"]), ([], 1))

    def test_jobs_may_run_included_models_but_not_excluded_ones(self):
        for model in ("gpt-5.6-terra", "gemini-3.1-pro", "claude-sonnet-5-5", "claude-haiku-5-5", "gemini-3.8-flash"):
            self.assertTrue(cp.allowed(model), model)
        for model in ("claude-haiku-4-5", "gemini-3-flash", "grok-4.5", "gpt-5.4-nano", "gpt-5.5"):
            self.assertFalse(cp.allowed(model), model)

    def test_every_included_name_is_in_the_table(self):
        names = {m["name"] for m in TABLE["models"]}
        for name in TABLE["include"]:
            self.assertIn(name, names)


class PriceWarning(unittest.TestCase):
    """Anything at $10+ output is flagged in the UI: the data it needs must be exact."""

    def test_the_boundary_models_carry_their_exact_output_price(self):
        kept, _ = cp.publish(catalog("claude-sonnet-5", "gpt-5.6-terra", "gpt-5.6-luna"))
        out = {m["id"]: m["price"]["output"] for m in kept}
        self.assertEqual(out, {"claude-sonnet-5": 10, "gpt-5.6-terra": 12, "gpt-5.6-luna": 1.2})
        self.assertEqual(sorted(i for i, v in out.items() if v >= 10), ["claude-sonnet-5", "gpt-5.6-terra"])


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
