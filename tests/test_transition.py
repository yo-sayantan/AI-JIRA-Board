#!/usr/bin/env python3
"""Drag-and-drop gates: In Review / QA warn, Done blocks until PRs are merged and QA is done."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
from _jira import status_column  # noqa: E402
from transition import COLUMNS, evaluate, is_qa, pick_transition  # noqa: E402

OPEN_PR = {"id": 7, "state": "comments", "merged": False}
MERGED_PR = {"id": 7, "state": "merged", "merged": True}
DECLINED_PR = {"id": 8, "state": "declined", "merged": False}
QA_OPEN = {"key": "PROJ-2", "title": "QA: verify flow", "type": "QA Task", "status": "In Progress"}
QA_DONE = {"key": "PROJ-2", "title": "QA: verify flow", "type": "QA Task", "status": "Done"}


class Gates(unittest.TestCase):
    def test_review_without_pr_warns_but_moves(self):
        blocker, warnings = evaluate("rev", [], [])
        self.assertIsNone(blocker)
        self.assertTrue(any("pull request" in w for w in warnings))

    def test_review_with_only_declined_pr_still_warns(self):
        self.assertTrue(evaluate("rev", [DECLINED_PR], [])[1])

    def test_review_with_pr_is_silent(self):
        self.assertEqual(evaluate("rev", [OPEN_PR], []), (None, []))

    def test_qa_without_qa_ticket_warns(self):
        blocker, warnings = evaluate("qa", [OPEN_PR], [])
        self.assertIsNone(blocker)
        self.assertTrue(any("QA ticket" in w for w in warnings))

    def test_done_blocked_without_pr(self):
        blocker, _ = evaluate("done", [], [QA_DONE])
        self.assertIn("no merged pull request", blocker)

    def test_done_blocked_by_unmerged_pr(self):
        blocker, _ = evaluate("done", [OPEN_PR], [QA_DONE])
        self.assertIn("#7", blocker)
        self.assertIn("not merged", blocker)

    def test_done_blocked_by_open_qa(self):
        blocker, _ = evaluate("done", [MERGED_PR], [QA_OPEN])
        self.assertIn("QA not done", blocker)
        self.assertIn("PROJ-2", blocker)

    def test_done_blocked_without_qa_ticket(self):
        self.assertIn("no QA ticket", evaluate("done", [MERGED_PR], [])[0])

    def test_done_passes_when_merged_and_qa_done(self):
        self.assertEqual(evaluate("done", [MERGED_PR, DECLINED_PR], [QA_DONE]), (None, []))

    def test_todo_progress_and_blocked_have_no_gates(self):
        self.assertEqual(evaluate("todo", [], []), (None, []))
        self.assertEqual(evaluate("prog", [], []), (None, []))
        self.assertEqual(evaluate("blocked", [], []), (None, []))
        self.assertIn("blocked", COLUMNS)


class Helpers(unittest.TestCase):
    def test_is_qa_by_type_or_title(self):
        self.assertTrue(is_qa({"type": "QA Task", "title": "x"}))
        self.assertTrue(is_qa({"type": "Sub-task", "title": "Test the new endpoint"}))
        self.assertFalse(is_qa({"type": "Sub-task", "title": "Write the migration"}))

    def test_pick_transition_prefers_conventional_name(self):
        transitions = [
            {"id": "1", "to": {"name": "Ready4Review"}},
            {"id": "2", "to": {"name": "In Review"}},
            {"id": "3", "to": {"name": "Done"}},
        ]
        self.assertEqual(pick_transition(transitions, "rev")["id"], "2")
        self.assertEqual(pick_transition(transitions, "done")["id"], "3")
        self.assertIsNone(pick_transition(transitions, "qa"))

    def test_dropping_on_qa_lands_on_a_ready_status_not_qa_in_progress(self):
        transitions = [
            {"id": "1", "to": {"name": "In QA"}},
            {"id": "2", "to": {"name": "Ready for QA"}},
            {"id": "3", "to": {"name": "QA In Progress"}},
        ]
        self.assertEqual(pick_transition(transitions, "qa")["id"], "2")
        # A workflow with only in-progress QA statuses still gets a QA move.
        self.assertEqual(pick_transition(transitions[:1], "qa")["id"], "1")

    def test_blocked_transition_is_found(self):
        transitions = [{"id": "9", "to": {"name": "Blocked"}}, {"id": "2", "to": {"name": "In Progress"}}]
        self.assertEqual(pick_transition(transitions, "blocked")["id"], "9")


class StatusColumns(unittest.TestCase):
    def test_blocked_is_its_own_column(self):
        self.assertEqual(status_column("Blocked"), "blocked")
        self.assertEqual(status_column("Impeded"), "blocked")
        self.assertEqual(status_column("Blocked by vendor"), "blocked")

    def test_hold_keeps_paused_work(self):
        self.assertEqual(status_column("On Hold"), "hold")
        self.assertEqual(status_column("Waiting"), "hold")

    def test_qa_variants_all_map_to_qa(self):
        for s in ("QA", "Ready for QA", "In QA", "QA In Progress", "In Testing"):
            self.assertEqual(status_column(s), "qa", s)


class SubticketGates(unittest.TestCase):
    """A sub-ticket's work usually rides on its parent's PR: it may be closed with no PR of its own,
    but not while a PR of its own is still open."""

    def test_done_without_any_pr_or_qa_ticket_is_allowed(self):
        self.assertEqual(evaluate("done", [], [], is_subtask=True), (None, []))

    def test_done_still_blocked_by_its_own_unmerged_pr(self):
        blocker, _ = evaluate("done", [OPEN_PR], [], is_subtask=True)
        self.assertIn("#7 not merged yet", blocker)
        self.assertNotIn("no QA ticket", blocker)

    def test_done_allowed_once_its_own_pr_is_merged(self):
        self.assertEqual(evaluate("done", [MERGED_PR], [], is_subtask=True), (None, []))

    def test_an_open_qa_ticket_still_blocks_a_subticket(self):
        self.assertIn("QA not done", evaluate("done", [], [QA_OPEN], is_subtask=True)[0])

    def test_a_declined_pr_is_ignored(self):
        self.assertEqual(evaluate("done", [DECLINED_PR], [], is_subtask=True), (None, []))

    def test_review_does_not_nag_a_subticket_about_a_missing_pr(self):
        self.assertEqual(evaluate("rev", [], [], is_subtask=True), (None, []))

    def test_a_normal_ticket_is_unchanged(self):
        self.assertIn("no merged pull request", evaluate("done", [], [QA_DONE])[0])
        self.assertIn("no QA ticket", evaluate("done", [MERGED_PR], [])[0])


if __name__ == "__main__":
    unittest.main()


class OnHoldTarget(unittest.TestCase):
    """On Hold is a drop target (the shelf in the Blocked column): never blocked, but an open PR is
    called out — it will sit unreviewed while the ticket is parked."""

    def test_hold_is_a_target_from_the_shared_list(self):
        import json
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern", "move_targets.json")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(COLUMNS, tuple(json.load(f)))
        self.assertIn("hold", COLUMNS)

    def test_every_target_has_preferred_status_names(self):
        from transition import PREFERRED
        self.assertEqual(set(PREFERRED), set(COLUMNS))

    def test_an_open_pr_warns_but_does_not_block(self):
        blocker, warnings = evaluate("hold", [OPEN_PR], [])
        self.assertIsNone(blocker)
        self.assertEqual(len(warnings), 1)
        self.assertIn("#7 is still open", warnings[0])

    def test_merged_declined_or_no_pr_is_silent(self):
        self.assertEqual(evaluate("hold", [MERGED_PR], []), (None, []))
        self.assertEqual(evaluate("hold", [DECLINED_PR], []), (None, []))
        self.assertEqual(evaluate("hold", [], []), (None, []))

    def test_picks_an_on_hold_status(self):
        transitions = [
            {"id": "1", "to": {"name": "Waiting"}},
            {"id": "2", "to": {"name": "On Hold"}},
            {"id": "3", "to": {"name": "In Progress"}},
        ]
        self.assertEqual(pick_transition(transitions, "hold")["id"], "2")

    def test_the_command_line_accepts_hold(self):
        import io
        from contextlib import redirect_stdout
        from unittest import mock
        import transition
        out = io.StringIO()
        with mock.patch.object(transition, "move", return_value={"ok": True, "moved": True, "status": "On Hold", "warnings": []}), \
                mock.patch.object(transition, "load_env"), redirect_stdout(out):
            self.assertEqual(transition.main(["transition.py", "abc-1", "hold"]), 0)
        self.assertIn('"On Hold"', out.getvalue())
