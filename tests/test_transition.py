#!/usr/bin/env python3
"""Drag-and-drop rules: the QA lane, the In Review gate (a PR) and the Done gate (no open PR, a QA ticket raised)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
from _jira import status_column  # noqa: E402
from transition import COLUMNS, evaluate, is_qa, is_qa_in_progress, is_qa_ticket, lane_blocker, pick_transition  # noqa: E402

OPEN_PR = {"id": 7, "state": "comments", "merged": False}
MERGED_PR = {"id": 7, "state": "merged", "merged": True}
DECLINED_PR = {"id": 8, "state": "declined", "merged": False}
QA_OPEN = {"key": "PROJ-2", "title": "QA: verify flow", "type": "QA Task", "status": "In Progress"}
QA_DONE = {"key": "PROJ-2", "title": "QA: verify flow", "type": "QA Task", "status": "Done"}


class Gates(unittest.TestCase):
    def test_review_needs_a_pull_request(self):
        self.assertIn("no pull request raised", evaluate("rev", [], [])[0])

    def test_a_declined_pr_does_not_count_for_review(self):
        self.assertIn("no pull request", evaluate("rev", [DECLINED_PR], [])[0])

    def test_an_open_or_merged_pr_passes_review(self):
        self.assertEqual(evaluate("rev", [OPEN_PR], []), (None, []))
        self.assertEqual(evaluate("rev", [MERGED_PR], []), (None, []))

    def test_done_blocked_without_any_pr(self):
        self.assertIn("no pull request raised", evaluate("done", [], [QA_DONE])[0])

    def test_done_blocked_by_an_open_pr(self):
        blocker, _ = evaluate("done", [OPEN_PR], [QA_DONE])
        self.assertIn("#7 still open", blocker)

    def test_a_qa_ticket_only_has_to_be_raised_not_finished(self):
        self.assertEqual(evaluate("done", [MERGED_PR], [QA_OPEN]), (None, []))

    def test_done_blocked_without_qa_ticket(self):
        self.assertIn("no QA ticket raised", evaluate("done", [MERGED_PR], [])[0])

    def test_merged_or_declined_prs_both_pass_done(self):
        self.assertEqual(evaluate("done", [MERGED_PR, DECLINED_PR], [QA_DONE]), (None, []))
        self.assertEqual(evaluate("done", [DECLINED_PR], [QA_DONE]), (None, []))

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
    """A sub-ticket's work usually rides on its parent's PR: it may go to review on the parent's OPEN PR and
    close with no PR of its own (but not while one of its own is open); its parent's QA ticket counts."""

    def test_review_rides_on_the_parents_open_pr(self):
        self.assertEqual(evaluate("rev", [], [], is_subtask=True, parent_prs=[OPEN_PR]), (None, []))

    def test_review_refused_when_the_parent_has_no_open_pr(self):
        self.assertIn("its parent has no open one", evaluate("rev", [], [], is_subtask=True, parent_prs=[MERGED_PR])[0])
        self.assertIn("its parent has no open one", evaluate("rev", [], [], is_subtask=True, parent_prs=[])[0])

    def test_an_unreadable_parent_never_blocks(self):
        self.assertEqual(evaluate("rev", [], [], is_subtask=True, parent_prs=None), (None, []))
        self.assertEqual(evaluate("done", [], [], is_subtask=True, parent_qa=None), (None, []))

    def test_done_without_a_pr_of_its_own_is_allowed(self):
        self.assertEqual(evaluate("done", [], [], is_subtask=True, parent_qa=[QA_OPEN]), (None, []))

    def test_done_still_blocked_by_its_own_open_pr(self):
        self.assertIn("#7 still open", evaluate("done", [OPEN_PR], [QA_OPEN], is_subtask=True)[0])

    def test_done_needs_a_qa_ticket_on_it_or_its_parent(self):
        self.assertIn("no QA ticket raised (on it or its parent)", evaluate("done", [], [], is_subtask=True, parent_qa=[])[0])
        self.assertEqual(evaluate("done", [MERGED_PR], [QA_OPEN], is_subtask=True, parent_qa=[]), (None, []))


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

class QaLane(unittest.TestCase):
    """QA and QA In Progress hold QA tickets. A QA ticket — wherever it sits — moves only to QA · QA In
    Progress · Blocked · On Hold · Done; only a QA ticket may be moved into the lane."""

    LANE = ("qa", "qaip", "blocked", "hold", "done")
    OUT = ("todo", "prog", "rev")

    def test_a_dev_ticket_cannot_be_moved_into_qa_or_qa_in_progress(self):
        for column in ("todo", "blocked", "hold", "prog", "rev"):
            for target in ("qa", "qaip"):
                self.assertIn("Only QA tickets", lane_blocker(column, target, qa_ticket=False), (column, target))

    def test_a_qa_ticket_moves_only_within_the_lane_wherever_it_sits(self):
        for column in ("todo", "qa", "blocked"):
            for target in self.LANE:
                self.assertIsNone(lane_blocker(column, target, qa_ticket=True), (column, target))
            for target in self.OUT:
                self.assertIn("can only be moved to", lane_blocker(column, target, qa_ticket=True), (column, target))

    def test_the_lane_rule_follows_the_column_too(self):
        # Sitting in QA is enough: it is the lane's ticket even if nothing else marks it.
        self.assertIn("can only be moved to", lane_blocker("qa", "prog", qa_ticket=False))
        self.assertIn("can only be moved to", lane_blocker("qa", "todo", qa_ticket=False))

    def test_ordinary_moves_are_untouched(self):
        for target in ("todo", "blocked", "hold", "prog", "rev"):
            self.assertIsNone(lane_blocker("prog", target, qa_ticket=False), target)

    def test_is_qa_ticket_by_type_label_or_title(self):
        self.assertTrue(is_qa_ticket("QA Task", "x"))
        self.assertTrue(is_qa_ticket("Test", "x"))
        self.assertTrue(is_qa_ticket("Task", "x", ["QA"]))
        self.assertTrue(is_qa_ticket("Task", "x", ["qa-ticket"]))
        self.assertTrue(is_qa_ticket("Task", "QA: smoke test"))
        self.assertTrue(is_qa_ticket("Task", "[QA] export"))

    def test_is_qa_ticket_is_strict(self):
        self.assertFalse(is_qa_ticket("Story", "Verify the fix"))
        self.assertFalse(is_qa_ticket("Story", "Add unit tests for export"))
        self.assertFalse(is_qa_ticket("Bug", "Squash a bug", ["qa-failed", "needs-qa", "aqua"]))

    def test_qa_versus_qa_in_progress_statuses(self):
        for ready in ("QA", "Ready for QA", "Ready4QA", "Awaiting QA", "Ready for Testing"):
            self.assertFalse(is_qa_in_progress(ready), ready)
        for busy in ("QA In Progress", "In QA", "Under QA", "In Testing"):
            self.assertTrue(is_qa_in_progress(busy), busy)

    def test_each_target_picks_its_own_status(self):
        transitions = [
            {"id": "1", "to": {"name": "Ready for QA"}},
            {"id": "2", "to": {"name": "QA In Progress"}},
            {"id": "3", "to": {"name": "Done"}},
        ]
        self.assertEqual(pick_transition(transitions, "qa")["id"], "1")
        self.assertEqual(pick_transition(transitions, "qaip")["id"], "2")
        self.assertIsNone(pick_transition([{"id": "1", "to": {"name": "Ready for QA"}}], "qaip"))

    def test_qa_falls_back_to_an_in_progress_status_only_when_nothing_else_fits(self):
        self.assertEqual(pick_transition([{"id": "2", "to": {"name": "QA In Progress"}}], "qa")["id"], "2")


class Modes(unittest.TestCase):
    """move(): the lane is never forcible; --force skips the PR / QA gates; --undo skips everything."""

    def run_move(self, fields, target, mode="normal", prs=(), status="In Progress"):
        from unittest import mock
        import transition

        issue = {"id": "1", "fields": {"status": {"name": status}, "subtasks": [], "issuelinks": [], **fields}}
        moves = []

        def get(path, **_):
            if path.endswith("/transitions"):
                return {"transitions": [{"id": "9", "to": {"name": name}} for name in ("To Do", "In Progress", "In Review", "Ready for QA", "Done", "Blocked")]}
            return issue

        with mock.patch.object(transition, "jira_get", side_effect=get), \
                mock.patch.object(transition, "jira_post", side_effect=lambda p, b: moves.append(b)), \
                mock.patch.object(transition, "live_prs", return_value=list(prs)):
            return transition.move("ABC-1", target, mode), moves

    DEV = {"issuetype": {"name": "Story"}, "summary": "Build it", "labels": []}
    QA = {"issuetype": {"name": "QA Task"}, "summary": "QA: check it", "labels": []}

    def test_a_gate_refusal_is_forcible(self):
        verdict, moves = self.run_move(self.DEV, "done")
        self.assertEqual((verdict["blocked"], verdict["forcible"]), (True, True))
        self.assertEqual(moves, [])

    def test_force_skips_the_gates(self):
        verdict, moves = self.run_move(self.DEV, "done", "force")
        self.assertTrue(verdict["moved"])
        self.assertEqual(len(moves), 1)

    def test_force_never_skips_the_lane(self):
        verdict, moves = self.run_move(self.DEV, "qa", "force")
        self.assertEqual((verdict["blocked"], verdict["forcible"]), (True, False))
        self.assertEqual(moves, [])

    def test_undo_skips_everything(self):
        verdict, _ = self.run_move(self.QA, "todo", "undo", status="Ready for QA")
        self.assertTrue(verdict["moved"])

    def test_a_qa_ticket_faces_no_gate(self):
        verdict, _ = self.run_move(self.QA, "done", status="Ready for QA")
        self.assertTrue(verdict["moved"])

    def test_the_command_line_takes_one_mode_flag(self):
        import io
        from contextlib import redirect_stdout
        from unittest import mock
        import transition
        with mock.patch.object(transition, "move", return_value={"ok": True}) as move, mock.patch.object(transition, "load_env"), redirect_stdout(io.StringIO()):
            self.assertEqual(transition.main(["transition.py", "abc-1", "done", "--force"]), 0)
            move.assert_called_with("ABC-1", "done", "force")
            self.assertEqual(transition.main(["transition.py", "abc-1", "done", "--force", "--undo"]), 2)
            self.assertEqual(transition.main(["transition.py", "abc-1", "done", "--bogus"]), 2)


if __name__ == "__main__":
    unittest.main()
