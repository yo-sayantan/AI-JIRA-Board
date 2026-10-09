#!/usr/bin/env python3
"""ai-intern/brief.py — the per-ticket AI brief: stage-aware, fact-labelled, identity-checked."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ai-intern"))
import brief  # noqa: E402

SUB = {"key": "ABC-12", "title": "Parent POM", "column": "prog", "status": "In Progress", "parentKey": "ABC-10", "parentTitle": "Maven build",
       "epic": {"key": "ABC-10", "relation": "parent"}}
STORY = {"key": "ABC-10", "title": "Maven build", "column": "rev", "status": "In Review", "epic": {"key": "ABC-1", "relation": "epic (parent)"},
         "subtasks": [{"key": "ABC-12", "title": "Parent POM", "status": "Done", "column": "done"}, {"key": "ABC-13", "title": "CI", "status": "To Do", "column": "todo"}],
         "branches": ["feature/ABC-10"], "branch": "feature/ABC-10",
         "prs": [{"id": 61, "repo": "svc", "state": "approved", "approvals": 3, "openComments": 0, "title": "ABC-10: Maven build",
                  "sourceBranch": "feature/ABC-10", "destinationBranch": "release/x", "merged": False, "url": "https://bb/pr/61"}]}


class Facts(unittest.TestCase):
    def test_a_parent_is_a_parent_ticket_never_an_epic(self):
        f = brief.build_facts(SUB)
        self.assertEqual(f["parentTicket"]["key"], "ABC-10")
        self.assertIn("not an epic", f["parentTicket"]["note"])
        self.assertNotIn("epicLink", f)  # the "epic" Jira-intern derived from the parent must not leak through

    def test_a_real_epic_link_is_kept_under_its_own_name(self):
        f = brief.build_facts(STORY)
        self.assertEqual(f["epicLink"]["key"], "ABC-1")
        self.assertNotIn("parentTicket", f)

    def test_a_ticket_in_no_epic_says_so(self):
        f = brief.build_facts({"key": "ABC-5", "column": "todo"})
        self.assertIn("epicLink", f)
        self.assertIsNone(f["epicLink"])

    def test_code_state_and_subtask_rollup(self):
        f = brief.build_facts(STORY, required_approvals=2)
        pr = f["code"]["pullRequests"][0]
        self.assertEqual((pr["number"], pr["state"], pr["approvals"], pr["from"], pr["into"]), (61, "approved", 3, "feature/ABC-10", "release/x"))
        self.assertEqual(f["code"]["requiredApprovals"], 2)
        self.assertEqual((f["subtasks"]["done"], f["subtasks"]["total"]), (1, 2))

    def test_no_code_is_stated_as_a_fact(self):
        f = brief.build_facts({"key": "ABC-5", "column": "rev"})
        self.assertIn("No branch and no pull request", f["code"]["note"])

    def test_stage_labels(self):
        self.assertIn("In Review", brief.build_facts(STORY)["stage"])
        self.assertIn("In Progress", brief.build_facts(SUB)["stage"])


class Prompt(unittest.TestCase):
    def test_review_stage_asks_for_code_state_and_epic_rules(self):
        p = brief.system_prompt(STORY)
        self.assertIn("In Review", p)
        self.assertIn("approvals against what is required", p)
        self.assertIn("NEVER an epic", p)
        self.assertIn("Every ticket key you write must appear in the packs", p)
        self.assertNotIn("short HTML brief", p)  # the v1 prompt that produced thin briefs

    def test_new_tickets_stay_short_and_wip_tickets_go_deep(self):
        p = brief.system_prompt({"column": "todo"})
        self.assertIn("60–110 words", p)
        self.assertIn("150–300", p)


class Staleness(unittest.TestCase):
    def test_v1_briefs_are_regenerated_once(self):
        old = {"aiSummary": "<p>short</p>", "aiSummaryAt": "2026-10-09T00:00:00Z", "lastUpdate": "2026-10-01T00:00:00Z"}
        self.assertTrue(brief.needs_brief(old))

    def test_current_stamped_brief_is_kept_until_the_ticket_changes(self):
        cur = {"aiSummary": brief.stamp("<p>x</p>"), "aiSummaryAt": "2026-10-09T00:00:00Z", "lastUpdate": "2026-10-01T00:00:00Z"}
        self.assertFalse(brief.needs_brief(cur))
        self.assertTrue(brief.needs_brief({**cur, "lastUpdate": "2026-10-10T00:00:00Z"}))

    def test_missing_or_json_wrapped_briefs_are_regenerated(self):
        self.assertTrue(brief.needs_brief({}))
        self.assertTrue(brief.needs_brief({"aiSummary": '{"html": "x"}', "aiSummaryAt": "9", "lastUpdate": "1"}))

    def test_stamp_is_idempotent(self):
        once = brief.stamp("<p>x</p>")
        self.assertEqual(brief.stamp(once), once)


class Scrub(unittest.TestCase):
    ALLOWED = {"ABC-10", "ABC-12", "ABC-1"}

    def test_an_invented_key_is_removed_with_its_link(self):
        out = brief.scrub('<p>See <a href="https://j/browse/ZZZ-9">ZZZ-9</a> and ABC-12 and QQQ-4.</p>', self.ALLOWED, None)
        self.assertNotIn("ZZZ-9", out)
        self.assertNotIn("QQQ-4", out)
        self.assertIn("ABC-12", out)

    def test_a_parent_called_an_epic_stops_being_one(self):
        out = brief.scrub('<p>Sub-task under parent epic <a href="u">ABC-10</a>.</p>', self.ALLOWED, None)
        self.assertNotRegex(out.lower(), r"epic\s*(<a[^>]*>)?\s*abc-10")
        self.assertIn("ABC-10", out)

    def test_the_real_epic_link_keeps_its_label(self):
        out = brief.scrub("<p>In epic ABC-1 (Release train).</p>", self.ALLOWED, "ABC-1")
        self.assertIn("epic ABC-1", out)

    def test_a_wrong_epic_is_unlabelled_even_when_a_real_one_exists(self):
        out = brief.scrub("<li><b>Epic:</b> ABC-12</li>", self.ALLOWED, "ABC-1")
        self.assertNotRegex(out, r"(?i)epic:?</b>\s*ABC-12")
        self.assertIn("ABC-12", out)

    def test_allowed_keys_come_from_every_pack(self):
        self.assertEqual(brief.allowed_keys({"a": "ABC-1 and DEF-2"}, "GHI-3", ["JKL-4"]), {"ABC-1", "DEF-2", "GHI-3", "JKL-4"})

    def test_lowercase_look_alikes_are_not_keys(self):
        self.assertEqual(brief.allowed_keys("utf-8 and sha-256"), set())


if __name__ == "__main__":
    unittest.main()
