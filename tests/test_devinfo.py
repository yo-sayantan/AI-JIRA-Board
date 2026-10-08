"""Primary branch / primary PR selection (devinfo.py): the ticket's branch is the one with the
newest commit, and the PR banners follow that branch's own PR. No network: Jira and Bitbucket
are replaced by canned payloads shaped like the real responses."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "jira-intern"))

import devinfo  # noqa: E402

REPO = "https://code.example/projects/PROJ/repos/svc"
PLAIN = "feature/PROJ-1"
MID = "feature/PROJ-1_do_the_thing"
NEWEST = "feature/PROJ-1_do_the_thing_1"


def _branch(name):
    return {
        "name": name,
        "url": f"{REPO}/commits?until=refs%2Fheads%2F{name.replace('/', '%2F')}",
        "repository": {"name": "svc", "url": f"{REPO}/browse"},
    }


def _dev_status(prs=()):
    return {"detail": [{"branches": [_branch(PLAIN), _branch(MID), _branch(NEWEST)], "pullRequests": list(prs)}]}


def _dev_pr(pid, branch, status="OPEN", updated="2026-10-07T13:39:55.022+0000"):
    return {
        "id": f"#{pid}",
        "name": f"PROJ-1: change {pid}",
        "status": status,
        "url": f"{REPO}/pull-requests/{pid}",
        "source": {"branch": branch, "repository": {"name": "svc"}},
        "destination": {"branch": "release/x"},
        "reviewers": [{"name": "A", "approved": True}, {"name": "B", "approved": True}],
        "author": {"name": "Me"},
        "lastUpdate": updated,
    }


def _commit(ms):
    return {"values": [{"authorTimestamp": ms - 5000, "committerTimestamp": ms}]}


def _bb_router(commit_ms, outgoing=None):
    """A bb_get stand-in: newest-commit times per branch, optional PRs per branch."""
    calls = []

    def bb_get(path, timeout=45):
        calls.append(path)
        if "/commits?" in path:
            for name, ms in commit_ms.items():
                if f"until=refs%2Fheads%2F{name.replace('/', '%2F')}&" in path:  # exact value, not a prefix
                    if ms is None:
                        raise RuntimeError("404 branch gone")
                    return _commit(ms)
            raise RuntimeError("unknown branch")
        if "/pull-requests?" in path and "direction=OUTGOING" in path:
            for name, values in (outgoing or {}).items():
                if f"at=refs%2Fheads%2F{name.replace('/', '%2F')}&" in path:
                    return {"values": values}
            return {"values": []}
        return {"values": []}  # comment-stat / reviewer lookups on open PRs

    bb_get.calls = calls
    return bb_get


class ChoosePrimaryTests(unittest.TestCase):
    def setUp(self):
        self.pr_plain = {"state": "approved", "id": 61, "sourceBranch": PLAIN, "updatedAt": "2026-10-07T13:39:55Z"}
        self.pr_other = {"state": "comments", "id": 62, "sourceBranch": MID, "updatedAt": "2026-10-01T00:00:00Z"}

    def test_newest_commit_wins_and_its_pr_is_the_primary(self):
        branch, pr, branches, prs = devinfo.choose_primary(
            [PLAIN, MID, NEWEST], [self.pr_plain, self.pr_other], {PLAIN: 100, MID: 200, NEWEST: 300}
        )
        self.assertEqual(branch, NEWEST)
        self.assertEqual(pr, {"state": "none"})  # the newest branch has no PR of its own
        self.assertEqual(branches, [NEWEST, PLAIN, MID])
        self.assertEqual(sorted(p["id"] for p in prs), [61, 62])  # nothing is dropped

    def test_primary_pr_comes_from_the_chosen_branch_only(self):
        branch, pr, _b, prs = devinfo.choose_primary([PLAIN, MID], [self.pr_plain, self.pr_other], {PLAIN: 100, MID: 200})
        self.assertEqual((branch, pr["id"]), (MID, 62))
        self.assertEqual([p["id"] for p in prs], [62, 61])  # chosen branch's PRs first

    def test_branches_without_a_time_never_win(self):
        branch, *_ = devinfo.choose_primary([PLAIN, MID, NEWEST], [], {MID: 50})
        self.assertEqual(branch, MID)

    def test_prior_branch_holds_when_no_commit_time_was_read(self):
        branch, pr, *_ = devinfo.choose_primary([PLAIN, MID], [self.pr_plain], {}, prior_branch=MID)
        self.assertEqual(branch, MID)
        self.assertEqual(pr, {"state": "none"})

    def test_without_times_or_prior_the_old_rule_applies(self):
        branch, pr, *_ = devinfo.choose_primary([PLAIN, MID], [self.pr_plain, self.pr_other], {})
        self.assertEqual((branch, pr["id"]), (PLAIN, 61))  # first open PR decides, as before

    def test_one_branch_never_needs_times(self):
        branch, pr, branches, prs = devinfo.choose_primary([PLAIN], [self.pr_plain])
        self.assertEqual((branch, pr["id"], branches), (PLAIN, 61, [PLAIN]))
        self.assertEqual(prs, [self.pr_plain])

    def test_legacy_pick_survives_a_pr_without_a_source_branch(self):
        orphan = {"state": "approved", "id": 7, "sourceBranch": None}
        branch, pr, *_ = devinfo.choose_primary([MID], [orphan])
        self.assertEqual((branch, pr["id"]), (MID, 7))

    def test_nothing_at_all(self):
        self.assertEqual(devinfo.choose_primary([], []), (None, {"state": "none"}, [], []))

    def test_branch_names_compare_case_insensitively(self):
        pr = {"state": "approved", "id": 1, "sourceBranch": "Feature/PROJ-1"}
        _b, got, *_ = devinfo.choose_primary(["feature/PROJ-1", MID], [pr], {"feature/PROJ-1": 9, MID: 1})
        self.assertEqual(got["id"], 1)


class FetchOneTests(unittest.TestCase):
    def fetch(self, dev_status, bb, enrich_open=True):
        with mock.patch.object(devinfo, "jira_get", return_value=dev_status), mock.patch.object(devinfo, "bb_get", bb):
            return devinfo.fetch_one("123", enrich_open)

    def test_the_reported_ticket_follows_its_newest_branch(self):
        # Jira: three branches, one open PR from the oldest. Bitbucket: the newest branch has the newest commit.
        bb = _bb_router({PLAIN: 1_000_000, MID: 2_000_000, NEWEST: 3_000_000})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb)
        self.assertEqual(info["branch"], NEWEST)
        self.assertEqual(info["branches"][0], NEWEST)
        self.assertEqual(info["pr"], {"state": "none"})
        self.assertEqual([p["id"] for p in info["prs"]], [61])  # still listed, no longer the banner

    def test_a_pr_jira_has_not_indexed_yet_is_found_on_bitbucket(self):
        new_pr = {
            "id": 62, "title": "PROJ-1: continue", "state": "OPEN", "updatedDate": 1_790_000_000_000,
            "fromRef": {"displayId": NEWEST, "repository": {"name": "svc", "slug": "svc", "project": {"key": "PROJ"}}},
            "toRef": {"displayId": "release/x"},
            "reviewers": [{"user": {"displayName": "A"}, "approved": True}],
            "author": {"user": {"displayName": "Me"}},
            "links": {"self": [{"href": f"{REPO}/pull-requests/62"}]},
        }
        bb = _bb_router({PLAIN: 1_000_000, MID: 2_000_000, NEWEST: 3_000_000}, outgoing={NEWEST: [new_pr]})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb)
        self.assertEqual(info["branch"], NEWEST)
        self.assertEqual(info["pr"]["id"], 62)
        self.assertEqual(info["pr"]["sourceBranch"], NEWEST)
        self.assertEqual([p["id"] for p in info["prs"]], [62, 61])
        self.assertTrue(any("direction=OUTGOING" in c for c in bb.calls))

    def test_a_pr_already_in_jira_is_not_fetched_twice(self):
        bb = _bb_router({PLAIN: 1, MID: 2, NEWEST: 3})
        info = self.fetch(_dev_status([_dev_pr(62, NEWEST)]), bb)
        self.assertEqual(info["pr"]["id"], 62)
        self.assertFalse(any("direction=OUTGOING" in c for c in bb.calls))

    def test_bitbucket_down_degrades_to_the_old_rule(self):
        def down(path, timeout=45):
            raise RuntimeError("connection refused")

        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), down)
        self.assertEqual((info["branch"], info["pr"]["id"]), (PLAIN, 61))

    def test_a_deleted_branch_cannot_win(self):
        bb = _bb_router({PLAIN: 5_000_000, MID: 2_000_000, NEWEST: None})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb)
        self.assertEqual(info["branch"], PLAIN)

    def test_a_ticket_with_one_branch_makes_no_bitbucket_branch_calls(self):
        single = {"detail": [{"branches": [_branch(PLAIN)], "pullRequests": [_dev_pr(61, PLAIN)]}]}
        bb = _bb_router({})
        info = self.fetch(single, bb)
        self.assertEqual((info["branch"], info["pr"]["id"]), (PLAIN, 61))
        self.assertFalse([c for c in bb.calls if "/commits?" in c])

    def test_single_ticket_refresh_still_ranks_branches(self):
        bb = _bb_router({PLAIN: 1, MID: 2, NEWEST: 3})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb, enrich_open=False)
        self.assertEqual(info["branch"], NEWEST)

    def test_a_failed_dev_status_call_is_none_not_empty(self):
        with mock.patch.object(devinfo, "jira_get", side_effect=RuntimeError("boom")):
            self.assertIsNone(devinfo.fetch_one("1"))


class SettleTests(unittest.TestCase):
    def test_settle_keeps_last_runs_branch_when_this_run_has_no_times(self):
        info = {"branches": [PLAIN, MID], "prs": [{"state": "approved", "id": 61, "sourceBranch": PLAIN}], "times": {}}
        out = devinfo.settle(info, prior_branch=MID)
        self.assertEqual((out["branch"], out["pr"]), (MID, {"state": "none"}))
        self.assertEqual(out["branches"], [MID, PLAIN])

    def test_settle_does_not_mutate_its_input(self):
        info = {"branches": [PLAIN, MID], "prs": [], "times": {MID: 9}}
        devinfo.settle(info)
        self.assertEqual(info["branches"], [PLAIN, MID])


def _pr(pid, branch, title=None, **extra):
    return {"id": pid, "state": "approved", "title": title or f"PROJ-1: change {pid}",
            "url": f"{REPO}/pull-requests/{pid}", "sourceBranch": branch, **extra}


class MentionsKeyTests(unittest.TestCase):
    def test_whole_key_only(self):
        self.assertTrue(devinfo.mentions_key("PROJ-12", "feature/PROJ-12_do_it"))
        self.assertTrue(devinfo.mentions_key("PROJ-12", "PROJ-12: fix the build"))
        self.assertFalse(devinfo.mentions_key("PROJ-12", "feature/PROJ-123_other"))  # a different ticket
        self.assertFalse(devinfo.mentions_key("PROJ-12", "XPROJ-12"))

    def test_underscore_spelling_and_case(self):
        self.assertTrue(devinfo.mentions_key("PROJ-12", "bugfix/proj_12_thing"))

    def test_nothing_to_search(self):
        self.assertFalse(devinfo.mentions_key("PROJ-12", None, ""))
        self.assertFalse(devinfo.mentions_key("", "PROJ-12"))


class ScopeToSubtaskTests(unittest.TestCase):
    """Jira links a PR to every ticket with a commit on its branch, so a parent's PR appears on all
    its sub-tasks. A sub-task keeps only code that is its own."""

    PARENT = {"branches": [PLAIN, MID, NEWEST], "prs": [_pr(61, NEWEST, "PROJ-1: the whole feature")]}

    def test_the_parents_pr_and_branch_are_not_the_subtasks(self):
        info = {"branches": [NEWEST], "prs": [_pr(61, NEWEST, "PROJ-1: the whole feature")], "times": {}}
        out = devinfo.scope_to_subtask("PROJ-2", info, self.PARENT)
        self.assertEqual((out["prs"], out["branches"]), ([], []))

    def test_a_shared_pr_naming_the_subtask_is_its_own(self):
        shared = _pr(61, NEWEST, "PROJ-1, PROJ-2: the whole feature")
        out = devinfo.scope_to_subtask("PROJ-2", {"branches": [NEWEST], "prs": [shared]}, self.PARENT)
        self.assertEqual(out["prs"], [shared])
        self.assertEqual(out["branches"], [NEWEST])

    def test_a_pr_from_a_branch_named_for_the_subtask_is_its_own(self):
        own = _pr(70, "feature/PROJ-2_parent_pom", "Parent POM")
        parent = {**self.PARENT, "prs": self.PARENT["prs"] + [own]}  # even if the parent index rolls it up
        out = devinfo.scope_to_subtask("PROJ-2", {"branches": ["feature/PROJ-2_parent_pom"], "prs": [own]}, parent)
        self.assertEqual(out["prs"], [own])

    def test_code_only_the_subtask_has_is_kept(self):
        own = _pr(70, "feature/PROJ-2_x", "no key in the title")
        info = {"branches": ["feature/PROJ-2_x", NEWEST], "prs": [own, _pr(61, NEWEST)]}
        out = devinfo.scope_to_subtask("PROJ-2", info, self.PARENT)
        self.assertEqual([p["id"] for p in out["prs"]], [70])
        self.assertEqual(out["branches"], ["feature/PROJ-2_x"])

    def test_without_the_parents_code_nothing_can_be_told_apart(self):
        info = {"branches": [NEWEST], "prs": [_pr(61, NEWEST)]}
        self.assertIs(devinfo.scope_to_subtask("PROJ-2", info, None), info)

    def test_does_not_mutate_its_input_and_keeps_other_fields(self):
        info = {"branches": [NEWEST], "prs": [_pr(61, NEWEST)], "times": {NEWEST: 5}}
        out = devinfo.scope_to_subtask("PROJ-2", info, self.PARENT)
        self.assertEqual(len(info["prs"]), 1)
        self.assertEqual(out["times"], {NEWEST: 5})

    def test_the_same_pr_number_in_another_repo_is_a_different_pr(self):
        other_repo = {**_pr(61, NEWEST), "url": "https://code.example/projects/PROJ/repos/other/pull-requests/61"}
        out = devinfo.scope_to_subtask("PROJ-2", {"branches": [NEWEST], "prs": [other_repo]}, self.PARENT)
        self.assertEqual(out["prs"], [other_repo])


class BitbucketIsTheAuthorityForBranchNames(unittest.TestCase):
    """Jira's dev-status copy of a PR's branch can be stale; Bitbucket's own record is not."""

    def _stub(self, record):
        def bb_get(path, timeout=45):
            if "/activities" in path:
                return {"values": [], "isLastPage": True}
            if record is None:
                raise RuntimeError("bitbucket down")
            return record

        return bb_get

    def test_open_pr_takes_its_branches_from_bitbucket(self):
        record = {"fromRef": {"displayId": NEWEST}, "toRef": {"displayId": "release/aws"}, "reviewers": []}
        with mock.patch.object(devinfo, "bb_get", self._stub(record)):
            pr = devinfo._to_pr(_dev_pr(61, PLAIN))  # Jira says PLAIN
        self.assertEqual((pr["sourceBranch"], pr["destinationBranch"]), (NEWEST, "release/aws"))

    def test_bitbucket_down_keeps_jiras_value(self):
        with mock.patch.object(devinfo, "bb_get", self._stub(None)):
            pr = devinfo._to_pr(_dev_pr(61, PLAIN))
        self.assertEqual((pr["sourceBranch"], pr["destinationBranch"]), (PLAIN, "release/x"))

    def test_reviewer_needs_work_still_read_from_the_same_record(self):
        record = {"fromRef": {"displayId": PLAIN}, "reviewers": [{"status": "NEEDS_WORK"}]}
        with mock.patch.object(devinfo, "bb_get", self._stub(record)):
            self.assertEqual(devinfo._to_pr(_dev_pr(61, PLAIN))["state"], "changes")

    def test_without_enrichment_no_bitbucket_call_is_made(self):
        with mock.patch.object(devinfo, "bb_get", side_effect=AssertionError("no call expected")):
            self.assertEqual(devinfo._to_pr(_dev_pr(61, PLAIN), enrich_open=False)["sourceBranch"], PLAIN)

    def test_a_merged_pr_is_not_looked_up(self):
        with mock.patch.object(devinfo, "bb_get", side_effect=AssertionError("no call expected")):
            self.assertEqual(devinfo._to_pr(_dev_pr(61, PLAIN, status="MERGED"))["sourceBranch"], PLAIN)


if __name__ == "__main__":
    unittest.main()
